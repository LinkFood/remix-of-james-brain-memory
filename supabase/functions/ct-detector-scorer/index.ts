/**
 * ct-detector-scorer — score the 0-score detector_alarm flags.
 *
 * Picks up ct_flags rows where source='detector_alarm' AND score_breakdown
 * IS NULL — score_breakdown null vs non-null is the actual "has been scored"
 * signal; score=0 alone is a legitimate scored value (no edge across any
 * component) and using it as the picker re-scores those rows forever.
 * Computes a 0-100 conviction score from 5 components, writes score +
 * score_breakdown + pulse_* back. Does NOT push Slack — the existing
 * ct-slack-push-flag path gates on score >= ct_config.slack_threshold and
 * reads back the row we wrote.
 *
 * Score components (0-100):
 *   40 sig_class    — ct_signature_magnitude_stats match on the inferred
 *                     <ticker>:<side>:<dte_bucket>:<predicted_source> label.
 *                     predicted_source inferred from flag.direction + flag.side
 *                     since the detector already wrote the directional read.
 *                     RPC label is LOWER(ticker) — match the casing exactly
 *                     (memory feedback_match_rpc_label_casing).
 *   25 cluster      — distinct detector_id count for the same option_symbol
 *                     within ±10min of flag.created_at. Cross-detector
 *                     confirmation IS the "stack" signal (tenet 8 portfolio).
 *   15 voi          — Volume/OI ratio on the source ct_flow_alerts row
 *                     matched by ticker+strike+expiry+side and ingested_at
 *                     within ±5min of flag.created_at. Clipped at 10x.
 *   10 premium      — premium ladder from same matched alert row.
 *   10 pulse_fit    — readPulseContext at flag.created_at; direction-aligned
 *                     trend = full, anti-aligned = 0, chop = 5, unknown = 5.
 *
 * Sort detector flags DESC by created_at (memory feedback_create_query_sort_desc).
 *
 * Auth: service_role only — cron-only function. No Slack, no UI.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { readPulseContext } from '../_shared/pulseContext.ts';

const BATCH_LIMIT = 200;
const TIME_WINDOW_MIN_VOI = 5;       // ct_flow_alerts match window
const TIME_WINDOW_MIN_CLUSTER = 10;  // cross-detector cluster window
const SIG_LOOKBACK_DAYS = 7;
const SIG_RPC_MIN_N = 3;             // ct_signature_magnitude_stats has HAVING n >= p_min_n

// Component weights — sum to 100.
const W_SIG = 40;
const W_CLUSTER = 25;
const W_VOI = 15;
const W_PREMIUM = 10;
const W_PULSE = 10;

type Direction = 'bullish' | 'bearish' | 'neutral';

interface DetectorFlag {
  id: string;
  detector_id: string | null;
  instrument: string;
  option_symbol: string | null;
  strike: number | null;
  expiry: string | null;       // 'YYYY-MM-DD'
  side: string | null;         // 'call' | 'put'
  direction: Direction;
  created_at: string;
}

interface FlowAlertRow {
  alert_id: string;
  volume: number | null;
  open_interest: number | null;
  premium: number | null;
  ingested_at: string;
}

interface SigStat {
  signature_label: string;
  median_peak_pct: number | string;
  n_tracks: number;
}

interface Stats {
  ok: boolean;
  flags_picked: number;
  flags_scored: number;
  flags_failed: number;
  score_distribution: Record<string, number>;
  components_summary: {
    sig_hits: number;
    voi_hits: number;
    cluster_hits: number;
    pulse_aligned: number;
    pulse_anti: number;
    pulse_chop_or_unknown: number;
  };
  errors: string[];
}

// ---------------------------------------------------------------------------
// dteBucket — must match ct_signature_magnitude_stats SQL CASE on dte_at_print
// (0=0dte, 1-7=short, 8-30=mid, else long).
// ---------------------------------------------------------------------------
function dteBucket(printTime: Date, expiry: string | null): string {
  if (!expiry) return 'long';
  const m = expiry.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return 'long';
  const exp = Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10), 20, 0, 0);
  const days = Math.floor((exp - printTime.getTime()) / (24 * 3600_000));
  if (!Number.isFinite(days)) return 'long';
  if (days <= 0) return '0dte';
  if (days <= 7) return 'short';
  if (days <= 30) return 'mid';
  return 'long';
}

// ---------------------------------------------------------------------------
// inferPredictedSource — derive the same label shape ct_print-grader writes
// into ct_contract_tracks.predicted_source from the flag's direction+side.
// Detector already committed to a direction; we round-trip it back to the
// aggressive_<ask|bid>_<call|put> label that ct_signature_magnitude_stats
// keys on.
// ---------------------------------------------------------------------------
function inferPredictedSource(direction: Direction, side: string): string | null {
  if (side !== 'call' && side !== 'put') return null;
  if (direction === 'bullish') return side === 'call' ? 'aggressive_ask_call' : 'aggressive_bid_put';
  if (direction === 'bearish') return side === 'call' ? 'aggressive_bid_call' : 'aggressive_ask_put';
  return null;
}

// ct_signature_magnitude_stats RPC source SQL has LOWER(ticker), but the live
// RPC actually returns labels with the ticker case as stored in
// ct_contract_tracks (UPPER on Mag7+SPY/QQQ/IWM). Inspected output 2026-04-28
// confirmed labels like "NVDA:call:short:aggressive_ask_call" — match observed
// output, not the SQL definition (memory feedback_match_rpc_label_casing).
function buildSignatureLabel(ticker: string, side: string, bucket: string, source: string): string {
  return `${ticker.toUpperCase()}:${side}:${bucket}:${source}`;
}

// ---------------------------------------------------------------------------
// loadSigStats — single RPC, cache as Map keyed by signature_label.
// ---------------------------------------------------------------------------
async function loadSigStats(supabase: SupabaseClient): Promise<Map<string, SigStat>> {
  const since = new Date(Date.now() - SIG_LOOKBACK_DAYS * 24 * 3600_000).toISOString();
  const { data } = await supabase.rpc('ct_signature_magnitude_stats', {
    p_since: since,
    p_min_n: SIG_RPC_MIN_N,
  });
  const map = new Map<string, SigStat>();
  if (!Array.isArray(data)) return map;
  for (const row of data as SigStat[]) map.set(row.signature_label, row);
  return map;
}

// ---------------------------------------------------------------------------
// matchSourceAlert — find the ct_flow_alerts row that produced this flag.
// Detectors synthesize OCC option_symbol from ticker+expiry+side+strike, but
// ct_flow_alerts.option_symbol is null on every row. Match by the underlying
// fields + ingested_at within a tight window of flag.created_at.
//
// Returns the most-recent alert (by ingested_at DESC) within the window so we
// pick the print that most-likely triggered the alarm.
// ---------------------------------------------------------------------------
async function matchSourceAlert(
  supabase: SupabaseClient,
  flag: DetectorFlag,
): Promise<FlowAlertRow | null> {
  if (!flag.expiry || flag.strike == null || !flag.side) return null;
  const flagTs = new Date(flag.created_at).getTime();
  if (!Number.isFinite(flagTs)) return null;
  const lo = new Date(flagTs - TIME_WINDOW_MIN_VOI * 60_000).toISOString();
  const hi = new Date(flagTs + TIME_WINDOW_MIN_VOI * 60_000).toISOString();

  const { data, error } = await supabase
    .from('ct_flow_alerts')
    .select('alert_id, volume, open_interest, premium, ingested_at')
    .eq('ticker', flag.instrument)
    .eq('side', flag.side)
    .eq('strike', flag.strike)
    .eq('expiry', flag.expiry)
    .gte('ingested_at', lo)
    .lte('ingested_at', hi)
    .order('ingested_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return data as FlowAlertRow;
}

// ---------------------------------------------------------------------------
// countClusterDetectors — distinct detector_id count for the same
// option_symbol within ±TIME_WINDOW_MIN_CLUSTER of flag.created_at, including
// THIS flag (so a single-detector hit counts as 1 — proportional scoring
// kicks in at 2+).
// ---------------------------------------------------------------------------
async function countClusterDetectors(
  supabase: SupabaseClient,
  optionSymbol: string,
  createdAt: string,
): Promise<number> {
  const flagTs = new Date(createdAt).getTime();
  if (!Number.isFinite(flagTs)) return 1;
  const lo = new Date(flagTs - TIME_WINDOW_MIN_CLUSTER * 60_000).toISOString();
  const hi = new Date(flagTs + TIME_WINDOW_MIN_CLUSTER * 60_000).toISOString();

  const { data, error } = await supabase
    .from('ct_flags')
    .select('detector_id')
    .eq('source', 'detector_alarm')
    .eq('option_symbol', optionSymbol)
    .gte('created_at', lo)
    .lte('created_at', hi);
  if (error || !data) return 1;
  const set = new Set<string>();
  for (const r of data) {
    if (typeof r.detector_id === 'string' && r.detector_id.length > 0) set.add(r.detector_id);
  }
  return Math.max(1, set.size);
}

// ---------------------------------------------------------------------------
// Component scorers — each returns the awarded points (clipped to its weight).
// ---------------------------------------------------------------------------

// 40 pts. Median peak % carries 70% of the weight; n_tracks carries 30%.
// Median: 0% → 0pts, ≥200% → full credit on the median axis.
// n_tracks: 3 → 0pts on n axis, ≥30 → full credit on n axis.
function scoreSigClass(stat: SigStat | undefined): { points: number; details: Record<string, unknown> } {
  if (!stat) return { points: 0, details: { matched: false } };
  const median = typeof stat.median_peak_pct === 'string'
    ? parseFloat(stat.median_peak_pct)
    : Number(stat.median_peak_pct);
  const n = Number(stat.n_tracks);
  if (!Number.isFinite(median) || !Number.isFinite(n)) {
    return { points: 0, details: { matched: false } };
  }
  const medianAxis = Math.max(0, Math.min(1, median / 2.0));        // 200% peak = full
  const nAxis = Math.max(0, Math.min(1, (n - 3) / 27));              // 30 = full
  const points = W_SIG * (medianAxis * 0.7 + nAxis * 0.3);
  return {
    points: Math.round(points * 10) / 10,
    details: {
      matched: true,
      label: stat.signature_label,
      median_peak_pct: median,
      n_tracks: n,
    },
  };
}

// 25 pts. 1 detector = 0, 2 = half, 3+ = full. Linear ramp.
function scoreCluster(detectorCount: number): { points: number; details: Record<string, unknown> } {
  let points = 0;
  if (detectorCount >= 3) points = W_CLUSTER;
  else if (detectorCount >= 2) points = W_CLUSTER * 0.5;
  return { points, details: { distinct_detectors: detectorCount } };
}

// 15 pts. V/OI ratio clipped at 10x. ratio>=10 → full, ratio==1 → 1.5pts.
function scoreVoi(alert: FlowAlertRow | null): { points: number; details: Record<string, unknown> } {
  if (!alert) return { points: 0, details: { matched: false } };
  const v = alert.volume == null ? null : Number(alert.volume);
  const oi = alert.open_interest == null ? null : Number(alert.open_interest);
  if (v == null || oi == null || !Number.isFinite(v) || !Number.isFinite(oi) || oi <= 0) {
    return { points: 0, details: { matched: true, voi_ratio: null } };
  }
  const ratio = v / oi;
  const clipped = Math.min(10, ratio);
  const points = W_VOI * (clipped / 10);
  return {
    points: Math.round(points * 10) / 10,
    details: { matched: true, volume: v, open_interest: oi, voi_ratio: Math.round(ratio * 100) / 100 },
  };
}

// 10 pts. >=$200k full, $100k half, <$50k 0, linear in between.
function scorePremium(alert: FlowAlertRow | null): { points: number; details: Record<string, unknown> } {
  if (!alert) return { points: 0, details: { matched: false } };
  const prem = alert.premium == null ? null : Number(alert.premium);
  if (prem == null || !Number.isFinite(prem)) {
    return { points: 0, details: { matched: true, premium: null } };
  }
  let points = 0;
  if (prem >= 200_000) points = W_PREMIUM;
  else if (prem >= 100_000) points = W_PREMIUM * 0.5 + W_PREMIUM * 0.5 * (prem - 100_000) / 100_000;
  else if (prem >= 50_000) points = W_PREMIUM * 0.5 * (prem - 50_000) / 50_000;
  return {
    points: Math.round(points * 10) / 10,
    details: { matched: true, premium: prem },
  };
}

// 10 pts. Direction aligned with pulse trend = full. Anti-aligned = 0.
// Chop = 5 (modest credit for "no opposing pressure"). Unknown = 5.
function scorePulseFit(
  direction: Direction,
  pulse: { regime: string; slope5min: number | null },
): { points: number; details: Record<string, unknown> } {
  const { regime, slope5min } = pulse;
  if (regime === 'unknown') return { points: 5, details: { regime, aligned: null } };
  if (regime === 'chop') return { points: 5, details: { regime, aligned: null } };
  let aligned: boolean | null = null;
  if (direction === 'bullish') aligned = regime === 'trending_up';
  else if (direction === 'bearish') aligned = regime === 'trending_down';
  else return { points: 5, details: { regime, aligned: null } };
  return {
    points: aligned ? W_PULSE : 0,
    details: { regime, slope5min, aligned },
  };
}

// ---------------------------------------------------------------------------
// Bucket score for distribution telemetry.
// ---------------------------------------------------------------------------
function scoreBucket(score: number): string {
  if (score >= 80) return '80-100';
  if (score >= 60) return '60-79';
  if (score >= 40) return '40-59';
  if (score >= 20) return '20-39';
  return '0-19';
}

// ---------------------------------------------------------------------------
// Sweep.
// ---------------------------------------------------------------------------
async function runSweep(supabase: SupabaseClient): Promise<Stats> {
  const stats: Stats = {
    ok: true,
    flags_picked: 0,
    flags_scored: 0,
    flags_failed: 0,
    score_distribution: { '0-19': 0, '20-39': 0, '40-59': 0, '60-79': 0, '80-100': 0 },
    components_summary: {
      sig_hits: 0,
      voi_hits: 0,
      cluster_hits: 0,
      pulse_aligned: 0,
      pulse_anti: 0,
      pulse_chop_or_unknown: 0,
    },
    errors: [],
  };

  // DESC sort — feedback_create_query_sort_desc. ASC + .limit on a growing
  // backlog freezes the scan window on the oldest N rows; once score=0 rows
  // accumulate behind the limit window, new flags starve.
  // score_breakdown IS NULL is the true "unscored" predicate — score=0 alone
  // is a valid scored value (no edge on any component) and using it as the
  // picker re-scores those rows on every run.
  const { data: flags, error } = await supabase
    .from('ct_flags')
    .select('id, detector_id, instrument, option_symbol, strike, expiry, side, direction, created_at')
    .eq('source', 'detector_alarm')
    .is('score_breakdown', null)
    .order('created_at', { ascending: false })
    .limit(BATCH_LIMIT);
  if (error) {
    stats.errors.push(`pick: ${error.message}`);
    stats.ok = false;
    return stats;
  }
  const picked = (flags ?? []) as DetectorFlag[];
  stats.flags_picked = picked.length;
  if (picked.length === 0) return stats;

  const sigStats = await loadSigStats(supabase);

  for (const f of picked) {
    try {
      const ticker = (f.instrument ?? '').toUpperCase();
      const side = (f.side ?? '').toLowerCase();
      const direction = (f.direction ?? 'neutral') as Direction;

      // Component 1 — sig_class.
      let sigPart = { points: 0, details: { matched: false } as Record<string, unknown> };
      if ((side === 'call' || side === 'put') && (direction === 'bullish' || direction === 'bearish')) {
        const source = inferPredictedSource(direction, side);
        if (source) {
          const printTime = new Date(f.created_at);
          const bucket = dteBucket(printTime, f.expiry);
          const label = buildSignatureLabel(ticker, side, bucket, source);
          sigPart = scoreSigClass(sigStats.get(label));
          if (sigPart.details.matched) stats.components_summary.sig_hits += 1;
        }
      }

      // Component 2 — cluster.
      let clusterPart = { points: 0, details: { distinct_detectors: 1 } as Record<string, unknown> };
      if (f.option_symbol) {
        const clusterCount = await countClusterDetectors(supabase, f.option_symbol, f.created_at);
        clusterPart = scoreCluster(clusterCount);
        if (clusterCount >= 2) stats.components_summary.cluster_hits += 1;
      }

      // Components 3 + 4 share the matched alert lookup.
      const alert = await matchSourceAlert(supabase, f);
      const voiPart = scoreVoi(alert);
      const premiumPart = scorePremium(alert);
      if (voiPart.details.matched && (voiPart.details as { voi_ratio?: number | null }).voi_ratio != null) {
        stats.components_summary.voi_hits += 1;
      }

      // Component 5 — pulse fit. Read pulse at flag time.
      const pulse = await readPulseContext(supabase, ticker, new Date(f.created_at));
      const pulsePart = scorePulseFit(direction, pulse);
      const aligned = (pulsePart.details as { aligned: boolean | null }).aligned;
      if (aligned === true) stats.components_summary.pulse_aligned += 1;
      else if (aligned === false) stats.components_summary.pulse_anti += 1;
      else stats.components_summary.pulse_chop_or_unknown += 1;

      const totalRaw = sigPart.points + clusterPart.points + voiPart.points + premiumPart.points + pulsePart.points;
      const total = Math.max(0, Math.min(100, Math.round(totalRaw)));

      const breakdown = {
        sig_class: { weight: W_SIG, points: sigPart.points, ...sigPart.details },
        cluster:   { weight: W_CLUSTER, points: clusterPart.points, ...clusterPart.details },
        voi:       { weight: W_VOI, points: voiPart.points, ...voiPart.details },
        premium:   { weight: W_PREMIUM, points: premiumPart.points, ...premiumPart.details },
        pulse_fit: { weight: W_PULSE, points: pulsePart.points, ...pulsePart.details },
        scored_at: new Date().toISOString(),
        scorer: 'ct-detector-scorer/v1',
      };

      const { error: updErr } = await supabase
        .from('ct_flags')
        .update({
          score: total,
          score_breakdown: breakdown,
          pulse_net_premium_at_fire: pulse.netPremium,
          pulse_slope_5min_at_fire: pulse.slope5min,
          pulse_regime_at_fire: pulse.regime,
          updated_at: new Date().toISOString(),
        })
        .eq('id', f.id);
      if (updErr) {
        stats.errors.push(`update ${f.id}: ${updErr.message}`);
        stats.flags_failed += 1;
        continue;
      }

      stats.flags_scored += 1;
      stats.score_distribution[scoreBucket(total)] += 1;
    } catch (e) {
      stats.flags_failed += 1;
      stats.errors.push(`flag ${f.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Entry.
// ---------------------------------------------------------------------------
serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  const corsHeaders = getCorsHeaders(req);
  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const startedAt = Date.now();
  try {
    const stats = await runSweep(supabase);
    return new Response(JSON.stringify({ ...stats, elapsed_ms: Date.now() - startedAt }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      elapsed_ms: Date.now() - startedAt,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
