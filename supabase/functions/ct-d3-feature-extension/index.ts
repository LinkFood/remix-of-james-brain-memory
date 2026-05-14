// ct-d3-feature-extension — D3 nightly autonomous capture.
//
// Promotes scripts/d3_experiment/run_experiment.ts (analysis-mode terminal
// orchestrator) to autonomous mode. Cron 5 21 * * 1-5 UTC. Closes cascade #51
// (manual-experiment-cadence-doesnt-survive-captain-life-cadence) structurally.
//
// Tenet 26 read: capture is autonomous-shaped (reads wakeups, calls feature
// loaders, writes rows; zero analysis logic). Hartigan dip + per-ticker logistic
// regression for the D3 fork-pick stays in terminal-Claude. Promoting the capture
// step to autonomous mode does NOT promote analysis.
//
// Architecture: feature_reconstruction.ts is copied alongside (same-dir import,
// supabase deploy bundles it). Orchestrator inlined here per the ct-correlation-
// compute precedent for multi-file edge functions.
//
// Idempotency: generation_id of the form d3_cron_${YYYY_MM_DD}_${ISO_TS}.
// UNIQUE(generation_id, ticker, wakeup_at) on the table; each fire's timestamp
// is unique so re-fires would collide only on intra-second duplication (the
// makeGenerationId timestamp covers ms precision).

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import {
  reconstructFeatures,
  type FeatureVector,
  type Wakeup,
} from './feature_reconstruction.ts';

type AnyClient = SupabaseClient;

const TICKERS_DEFAULT = [
  'NVDA', 'AAPL', 'AMZN', 'TSLA', 'IWM',
  'GOOGL', 'META', 'QQQ', 'SPY', 'MSFT',
];

const BATCH_SIZE = 25;
const WRITE_CHUNK = 100;

// ---------------------------------------------------------------------------
// generation_id format: d3_cron_${YYYY_MM_DD}_${ISO_TS}
// Distinguishes autonomous-cron captures from manual back-fill / validation
// captures in the corpus. Read by d3_capture_freshness_weeknights warden
// invariant via LIKE 'd3_cron_%'.
// ---------------------------------------------------------------------------

function utcDateTag(now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `${y}_${m}_${d}`;
}

function makeGenerationId(now: Date): string {
  const ts = now.toISOString().replace(/[:.]/g, '-');
  return `d3_cron_${utcDateTag(now)}_${ts}`;
}

// ---------------------------------------------------------------------------
// Wakeup pull (mirrors scripts/d3_experiment/run_experiment.ts).
// ---------------------------------------------------------------------------

interface SpecialistReadRow {
  id: number;
  ticker: string;
  updated_at: string;
  conviction: number | null;
  direction_lean: string | null;
}

async function pullWakeupsForTicker(
  supabase: AnyClient,
  ticker: string,
  startIso: string,
  endIso: string,
): Promise<Wakeup[]> {
  const out: Wakeup[] = [];
  const PAGE = 1000;
  let from = 0;
  for (let pageIdx = 0; pageIdx < 20; pageIdx++) {
    const { data, error } = await supabase
      .from('ct_specialist_reads')
      .select('id, ticker, updated_at, conviction, direction_lean')
      .eq('ticker', ticker)
      .gte('updated_at', startIso)
      .lte('updated_at', endIso)
      .order('updated_at', { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`pull_wakeups[${ticker}] page ${pageIdx}: ${error.message}`);
    const batch = (data ?? []) as SpecialistReadRow[];
    for (const r of batch) {
      out.push({
        ticker: r.ticker,
        wakeup_at: r.updated_at,
        conviction: typeof r.conviction === 'number' ? r.conviction : 0,
        read_id: String(r.id),
      });
    }
    if (batch.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

async function pullWakeups(
  supabase: AnyClient,
  tickers: string[],
  startIso: string,
  endIso: string,
): Promise<Wakeup[]> {
  const all: Wakeup[] = [];
  for (const t of tickers) {
    const rows = await pullWakeupsForTicker(supabase, t, startIso, endIso);
    all.push(...rows);
  }
  all.sort((a, b) => Date.parse(a.wakeup_at) - Date.parse(b.wakeup_at));
  return all;
}

// ---------------------------------------------------------------------------
// Cluster + writer
// ---------------------------------------------------------------------------

function assignCluster(conviction: number): 'low' | 'mid' | 'high' {
  if (conviction <= 45) return 'low';
  if (conviction >= 55) return 'high';
  return 'mid';
}

interface ObservationRow extends FeatureVector {
  generation_id: string;
  ticker: string;
  wakeup_at: string;
  read_id: string;
  conviction: number;
  cluster: 'low' | 'mid' | 'high';
  reconstruction_error_flags: Record<string, string[]>;
}

async function writeObservations(
  supabase: AnyClient,
  rows: ObservationRow[],
): Promise<{ written: number; errors: string[] }> {
  const errors: string[] = [];
  let written = 0;
  for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
    const chunk = rows.slice(i, i + WRITE_CHUNK);
    const payload = chunk.map((r) => ({
      generation_id: r.generation_id,
      ticker: r.ticker,
      wakeup_at: r.wakeup_at,
      read_id: r.read_id,
      conviction: r.conviction,
      cluster: r.cluster,
      f1_flow_pulse_unusual: r.f1_flow_pulse_unusual,
      f2_heatmap_front_week_value: r.f2_heatmap_front_week_value,
      f3_regime: r.f3_regime,
      f4_news_count: r.f4_news_count,
      f4_news_max_severity: r.f4_news_max_severity,
      f5_event_recency_present: r.f5_event_recency_present,
      f6_signature_alarm_count: r.f6_signature_alarm_count,
      f7_has_0dte_today: r.f7_has_0dte_today,
      f8_last_flag_outcome: r.f8_last_flag_outcome,
      reconstruction_error_flags: r.reconstruction_error_flags,
    }));
    const { error } = await (supabase
      .from('ct_d3_feature_observations') as unknown as {
        upsert: (v: unknown[], opts: { onConflict: string }) => Promise<{ error: { message: string } | null }>;
      })
      .upsert(payload as unknown[], { onConflict: 'generation_id,ticker,wakeup_at' });
    if (error) errors.push(`chunk_${i}:${error.message}`);
    else written += chunk.length;
  }
  return { written, errors };
}

// ---------------------------------------------------------------------------
// Batch processor
// ---------------------------------------------------------------------------

async function processBatch(
  supabase: AnyClient,
  batch: Wakeup[],
  generationId: string,
): Promise<ObservationRow[]> {
  return Promise.all(
    batch.map(async (w) => {
      const { features, errors } = await reconstructFeatures(supabase, w);
      return {
        generation_id: generationId,
        ticker: w.ticker,
        wakeup_at: w.wakeup_at,
        read_id: w.read_id,
        conviction: w.conviction,
        cluster: assignCluster(w.conviction),
        reconstruction_error_flags: errors.length > 0 ? { errors } : {},
        ...features,
      } as ObservationRow;
    }),
  );
}

// ---------------------------------------------------------------------------
// Distribution summary (compact — for return payload, not stdout)
// ---------------------------------------------------------------------------

interface DistributionSummary {
  total: number;
  with_errors: number;
  per_ticker: Record<string, number>;
  cluster_count: Record<string, number>;
  f1_true_pct: number;
  f5_present_pct: number;
  f7_true_pct: number;
}

function summarize(rows: ObservationRow[]): DistributionSummary {
  const dist: DistributionSummary = {
    total: rows.length,
    with_errors: 0,
    per_ticker: {},
    cluster_count: {},
    f1_true_pct: 0,
    f5_present_pct: 0,
    f7_true_pct: 0,
  };
  let f1True = 0, f5True = 0, f7True = 0;
  for (const r of rows) {
    dist.per_ticker[r.ticker] = (dist.per_ticker[r.ticker] ?? 0) + 1;
    dist.cluster_count[r.cluster] = (dist.cluster_count[r.cluster] ?? 0) + 1;
    if ((r.reconstruction_error_flags?.errors ?? []).length > 0) dist.with_errors++;
    if (r.f1_flow_pulse_unusual === true) f1True++;
    if (r.f5_event_recency_present) f5True++;
    if (r.f7_has_0dte_today) f7True++;
  }
  const n = Math.max(rows.length, 1);
  dist.f1_true_pct = (f1True / n) * 100;
  dist.f5_present_pct = (f5True / n) * 100;
  dist.f7_true_pct = (f7True / n) * 100;
  return dist;
}

// ---------------------------------------------------------------------------
// Serve
// ---------------------------------------------------------------------------

const URL_ENV = Deno.env.get('SUPABASE_URL') ?? 'https://rvhyotvklfowklzjahdd.supabase.co';
const KEY_ENV = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  const corsHeaders = getCorsHeaders(req);

  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }),
      { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  if (!KEY_ENV) {
    return new Response(JSON.stringify({ error: 'SUPABASE_SERVICE_ROLE_KEY not set' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const body = await req.json().catch(() => ({})) as { window_hours?: number; tickers?: string[] };
  const windowHours = Math.min(Math.max(body.window_hours ?? 24, 1), 168);
  const tickers = Array.isArray(body.tickers) && body.tickers.length > 0
    ? body.tickers.map((t) => t.toUpperCase())
    : TICKERS_DEFAULT;

  const now = new Date();
  const generationId = makeGenerationId(now);
  const endIso = now.toISOString();
  const startIso = new Date(now.getTime() - windowHours * 60 * 60 * 1000).toISOString();

  const supabase = createClient(URL_ENV, KEY_ENV) as unknown as AnyClient;

  const t0 = Date.now();
  let wakeups: Wakeup[];
  try {
    wakeups = await pullWakeups(supabase, tickers, startIso, endIso);
  } catch (err) {
    return new Response(JSON.stringify({
      ok: false,
      stage: 'pull_wakeups',
      error: err instanceof Error ? err.message : 'unknown',
      generation_id: generationId,
    }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  if (wakeups.length === 0) {
    return new Response(JSON.stringify({
      ok: true,
      generation_id: generationId,
      window: { start: startIso, end: endIso, hours: windowHours },
      total_wakeups: 0,
      rows_written: 0,
      summary: null,
      elapsed_ms: Date.now() - t0,
      note: 'no_wakeups_in_window',
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const allRows: ObservationRow[] = [];
  for (let i = 0; i < wakeups.length; i += BATCH_SIZE) {
    const batch = wakeups.slice(i, i + BATCH_SIZE);
    const rows = await processBatch(supabase, batch, generationId);
    allRows.push(...rows);
  }

  const summary = summarize(allRows);
  const { written, errors: writeErrors } = await writeObservations(supabase, allRows);

  return new Response(JSON.stringify({
    ok: writeErrors.length === 0,
    generation_id: generationId,
    window: { start: startIso, end: endIso, hours: windowHours },
    total_wakeups: wakeups.length,
    rows_written: written,
    write_errors: writeErrors,
    summary,
    elapsed_ms: Date.now() - t0,
  }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});
