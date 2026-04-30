/**
 * ct-detector-flow-stack-v1 (flow_stack_v1) — heatmap concentration alarm.
 *
 * Reads the latest ct_flow_heatmap_snapshots cell per (ticker, expiry_bucket_week),
 * compares it against the trailing 7d distribution of that same ticker's cells
 * across ALL its expiry_bucket_weeks. When abs(z-score) >= std_dev_threshold,
 * fire a flag with direction inferred from the sign of
 * aggressive_directional_premium_decay (the chosen metric).
 *
 * SHADOW MODE — writes ct_flags rows, no Slack push. Lifecycle promotion
 * (tenet 10) deferred until ≥1 week of baseline + manual review.
 *
 * Auth: service_role only.
 *
 * Returns: {
 *   ok, detector_id, status, tickers_evaluated, flags_fired,
 *   skipped_insufficient_baseline, duration_ms, errors
 * }
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { loadDetector } from '../_shared/detectorRegistry.ts';
import { recentlyAlarmed } from '../_shared/detectorState.ts';
import { getWatchlist } from '../_shared/watchlist.ts';

const DETECTOR_ID = 'flow_stack_v1';
const METRIC = 'aggressive_directional_premium_decay';

interface SnapshotRow {
  id: number;
  snapshot_at: string;
  ticker: string;
  expiry_bucket_week: string;
  aggressive_directional_premium_decay: number | string | null;
  expiry_date: string;
  total_premium: number | string | null;
  net_signed_premium: number | string | null;
  aggressive_directional_premium_raw: number | string | null;
  voi_unusual_score: number | string | null;
  source_alert_count: number | null;
}

interface Stats {
  ok: boolean;
  detector_id: string;
  status: string | null;
  tickers_evaluated: number;
  flags_fired: number;
  flags_deduped: number;
  skipped_insufficient_baseline: number;
  cells_evaluated: number;
  duration_ms: number;
  errors: string[];
}

function asNum(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function meanStd(xs: number[]): { mean: number; std: number; n: number } {
  const n = xs.length;
  if (n === 0) return { mean: 0, std: 0, n: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  if (n < 2) return { mean, std: 0, n };
  const variance = xs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (n - 1);
  return { mean, std: Math.sqrt(variance), n };
}

/**
 * Latest snapshot per (ticker, expiry_bucket_week) for one ticker.
 * Pulls a generous window (last 60min) and reduces in-memory — DISTINCT ON
 * via PostgREST is awkward, and the volume is small (≤ ~10 cells/ticker).
 */
async function loadLatestCells(
  supabase: SupabaseClient,
  ticker: string,
  windowMinutes: number,
): Promise<SnapshotRow[]> {
  const sinceIso = new Date(Date.now() - windowMinutes * 60_000).toISOString();
  const { data, error } = await supabase
    .from('ct_flow_heatmap_snapshots')
    .select(
      'id, snapshot_at, ticker, expiry_bucket_week, expiry_date, total_premium, net_signed_premium, aggressive_directional_premium_raw, aggressive_directional_premium_decay, voi_unusual_score, source_alert_count',
    )
    .eq('ticker', ticker)
    .gte('snapshot_at', sinceIso)
    .order('snapshot_at', { ascending: false })
    .limit(1000);
  if (error) {
    console.warn(`[flow_stack_v1] latest cells ${ticker} failed:`, error.message);
    return [];
  }
  if (!data || data.length === 0) return [];
  // Reduce to latest per expiry_bucket_week
  const seen = new Map<string, SnapshotRow>();
  for (const row of data as SnapshotRow[]) {
    const key = row.expiry_bucket_week;
    if (!seen.has(key)) seen.set(key, row);
  }
  return Array.from(seen.values());
}

/**
 * Trailing N-day distribution of the metric for one ticker, across ALL
 * its expiry_bucket_week cells (per spec: "ALL its expiry_bucket_week cells").
 * Paginated via .range to bypass the 1000-row PostgREST cap.
 */
async function loadBaseline(
  supabase: SupabaseClient,
  ticker: string,
  baselineDays: number,
): Promise<number[]> {
  const sinceIso = new Date(Date.now() - baselineDays * 86_400_000).toISOString();
  const out: number[] = [];
  const PAGE = 1000;
  const MAX_PAGES = 20; // hard cap → 20k baseline samples max
  for (let p = 0; p < MAX_PAGES; p++) {
    const offset = p * PAGE;
    const end = offset + PAGE - 1;
    const { data, error } = await supabase
      .from('ct_flow_heatmap_snapshots')
      .select(`${METRIC}, snapshot_at`)
      .eq('ticker', ticker)
      .gte('snapshot_at', sinceIso)
      .order('snapshot_at', { ascending: false })
      .range(offset, end);
    if (error) {
      console.warn(`[flow_stack_v1] baseline ${ticker} p=${p} failed:`, error.message);
      break;
    }
    if (!data || data.length === 0) break;
    for (const r of data as Array<Record<string, unknown>>) {
      const v = asNum(r[METRIC] as number | string | null | undefined);
      if (v !== null) out.push(v);
    }
    if (data.length < PAGE) break;
  }
  return out;
}

async function evaluateTicker(
  supabase: SupabaseClient,
  ticker: string,
  cfg: {
    stdDevThreshold: number;
    minBaselineSamples: number;
    evaluationWindowMinutes: number;
    baselineWindowDays: number;
    dedupeMin: number;
  },
  stats: Stats,
): Promise<void> {
  const baseline = await loadBaseline(supabase, ticker, cfg.baselineWindowDays);
  if (baseline.length < cfg.minBaselineSamples) {
    stats.skipped_insufficient_baseline += 1;
    return;
  }
  const { mean, std } = meanStd(baseline);
  if (!Number.isFinite(std) || std <= 0) {
    stats.skipped_insufficient_baseline += 1;
    return;
  }

  const cells = await loadLatestCells(supabase, ticker, cfg.evaluationWindowMinutes);
  if (cells.length === 0) return;

  for (const cell of cells) {
    stats.cells_evaluated += 1;
    const value = asNum(cell.aggressive_directional_premium_decay);
    if (value === null) continue;

    const z = (value - mean) / std;
    if (!Number.isFinite(z) || Math.abs(z) < cfg.stdDevThreshold) continue;

    // Dedupe key: per (detector, ticker, expiry_bucket_week). recentlyAlarmed
    // matches on option_symbol — we synthesize a synthetic key for that field.
    const dedupeKey = `${ticker}::stack::${cell.expiry_bucket_week}`;
    if (await recentlyAlarmed(supabase, DETECTOR_ID, dedupeKey, cfg.dedupeMin)) {
      stats.flags_deduped += 1;
      continue;
    }

    const direction: 'bullish' | 'bearish' = z > 0 ? 'bullish' : 'bearish';
    const score = Math.max(0, Math.min(100, Math.round(Math.abs(z) * 10)));

    const breakdown = {
      detector: DETECTOR_ID,
      metric: METRIC,
      expiry_bucket_week: cell.expiry_bucket_week,
      value_at_fire: value,
      z_score: Number(z.toFixed(4)),
      baseline_mean: Number(mean.toFixed(6)),
      baseline_std: Number(std.toFixed(6)),
      baseline_samples: baseline.length,
      heatmap_state_at_fire: {
        snapshot_id: cell.id,
        snapshot_at: cell.snapshot_at,
        ticker: cell.ticker,
        expiry_date: cell.expiry_date,
        expiry_bucket_week: cell.expiry_bucket_week,
        total_premium: asNum(cell.total_premium),
        net_signed_premium: asNum(cell.net_signed_premium),
        aggressive_directional_premium_raw: asNum(cell.aggressive_directional_premium_raw),
        aggressive_directional_premium_decay: value,
        voi_unusual_score: asNum(cell.voi_unusual_score),
        source_alert_count: cell.source_alert_count ?? null,
      },
    };

    const thesis = `${ticker} flow stack on ${cell.expiry_bucket_week} — z=${z.toFixed(2)} (${direction}). Decay-weighted directional premium ${value.toFixed(0)} vs trailing ${cfg.baselineWindowDays}d mean ${mean.toFixed(0)} ± ${std.toFixed(0)} (n=${baseline.length}).`;

    const { error: flagErr } = await supabase
      .from('ct_flags')
      .insert({
        source: 'detector_alarm',
        detector_id: DETECTOR_ID,
        specialist_ticker: null,
        instrument: ticker,
        option_symbol: dedupeKey, // synthetic — used by recentlyAlarmed dedupe
        strike: null,
        expiry: cell.expiry_bucket_week,
        side: null,
        direction,
        score,
        score_breakdown: breakdown,
        tags: ['detector_alarm', DETECTOR_ID, `bucket:${cell.expiry_bucket_week}`],
        thesis,
        horizon_hours: 24,
        // horizon_ts auto-fills via trigger
        entry_price: null,
        target_price: null,
        invalidation_price: null,
        status: 'active',
        source_flow_ids: null,
      });
    if (flagErr) {
      stats.errors.push(`flag insert ${ticker} ${cell.expiry_bucket_week}: ${flagErr.message}`);
      continue;
    }
    stats.flags_fired += 1;
  }
}

async function runSweep(supabase: SupabaseClient): Promise<Stats> {
  const stats: Stats = {
    ok: true,
    detector_id: DETECTOR_ID,
    status: null,
    tickers_evaluated: 0,
    flags_fired: 0,
    flags_deduped: 0,
    skipped_insufficient_baseline: 0,
    cells_evaluated: 0,
    duration_ms: 0,
    errors: [],
  };

  const detector = await loadDetector(supabase, DETECTOR_ID);
  if (!detector) {
    stats.ok = false;
    stats.errors.push('detector not found or retired');
    return stats;
  }
  stats.status = detector.status;

  const cfgRaw = detector.config as Record<string, unknown>;
  const cfg = {
    stdDevThreshold: typeof cfgRaw.std_dev_threshold === 'number' ? cfgRaw.std_dev_threshold : 2.5,
    minBaselineSamples: typeof cfgRaw.min_baseline_samples === 'number' ? cfgRaw.min_baseline_samples : 50,
    evaluationWindowMinutes: typeof cfgRaw.evaluation_window_minutes === 'number' ? cfgRaw.evaluation_window_minutes : 5,
    baselineWindowDays: typeof cfgRaw.baseline_window_days === 'number' ? cfgRaw.baseline_window_days : 7,
    dedupeMin: typeof cfgRaw.dedupe_min === 'number' ? cfgRaw.dedupe_min : 60,
  };

  const watchlist = await getWatchlist(supabase);
  for (const ticker of watchlist) {
    try {
      await evaluateTicker(supabase, ticker, cfg, stats);
      stats.tickers_evaluated += 1;
    } catch (e) {
      stats.errors.push(`ticker ${ticker}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return stats;
}

serve(async (req: Request) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  const corsHeaders = getCorsHeaders(req);

  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'service_role required' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const startedAt = Date.now();
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  try {
    const stats = await runSweep(supabase);
    stats.duration_ms = Date.now() - startedAt;
    return new Response(JSON.stringify(stats), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(
      JSON.stringify({
        ok: false,
        detector_id: DETECTOR_ID,
        error: e instanceof Error ? e.message : String(e),
        duration_ms: Date.now() - startedAt,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
