/**
 * ct-backtest-harness — pure-data calibration engine for the signature alarm.
 *
 * Replays the SAME tier evaluator that ct-signature-watcher uses (imported
 * from _shared/alarmTiering.ts) over a window of ct_flow_alerts, cross-
 * references each candidate to ground truth in ct_contract_tracks, and
 * returns a scorecard JSON: precision, recall, lift, catch-rate, top missed
 * winners, top false alarms.
 *
 * Zero LLM calls. Read-only. Does NOT write ct_flags or ct_signature_alarm_log.
 *
 * Iteration cost = $0 → terminal-Claude tunes thresholds, re-invokes,
 * compares scorecards. The data engine for tonight's calibration session.
 *
 * Auth: service_role only.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import {
  evaluateTier,
  loadTierThresholds,
  loadScoresBulk,
  whyNoTier,
  type AlarmTier,
  type TierThresholds,
} from '../_shared/alarmTiering.ts';
import {
  detectClusterFromContext,
  type ClusterConfig,
  type ClusterMatch,
  type FlowAlertLite,
} from '../_shared/clusterDetector.ts';
import {
  loadDteEligibility,
  ticker0DteEligibleOn,
  type DteEligibilityMap,
} from '../_shared/dteEligibility.ts';

const PAGE_SIZE = 1000;          // PostgREST cap.
const HARNESS_SCAN_LIMIT = 8000; // Single window upper bound; chunk via date if exceeded.

type DteBucket = '0dte' | 'short' | 'mid' | 'long';
type GroundTruth = 'winner' | 'loser' | 'neutral' | 'no_track';
type FullTier = 'gold' | 'silver' | 'bronze' | 'cluster_alarm';

interface FlowAlertRow {
  alert_id: string;
  ticker: string;
  side: string | null;
  is_ask: boolean | null;
  is_bid: boolean | null;
  strike: number | null;
  expiry: string | null;
  premium: number | null;
  price: number | null;
  underlying_price: number | null;
  executed_at: string | null;
  ingested_at: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw: any;
}

interface ContractTrackRow {
  alert_id: string;
  peak_contract_pct: number | string | null;
  max_drawdown_pct: number | string | null;
  track_status: string | null;
}

interface SignatureStat {
  signature_label: string;
  ticker: string;
  side: string;
  dte_bucket: string;
  predicted_source: string;
  n_tracks: number;
  median_peak_pct: number | string;
}

interface TierBucket {
  fired: number;
  winners: number;
  losers: number;
  neutral: number;
  no_track: number;
  hit_rate: number;
  lift_vs_base: number;
  pnl_avg_peak_pct: number;
  pnl_total_peak_pct: number;
}

// ---------------------------------------------------------------------------
// Helpers — kept in lockstep with ct-print-grader / ct-signature-watcher.
// ---------------------------------------------------------------------------
function inferPredictedSource(row: FlowAlertRow): string | null {
  const side = (row.side ?? '').toLowerCase();
  if (side !== 'call' && side !== 'put') return null;
  const raw = row.raw ?? {};
  const askPrem = raw['total_ask_side_prem'] == null ? null : Number(raw['total_ask_side_prem']);
  const bidPrem = raw['total_bid_side_prem'] == null ? null : Number(raw['total_bid_side_prem']);
  const askValid = askPrem !== null && Number.isFinite(askPrem);
  const bidValid = bidPrem !== null && Number.isFinite(bidPrem);
  if (askValid && bidValid && askPrem < 1 && bidPrem < 1) return null;
  let tag: 'ask' | 'bid' | null = null;
  if (row.is_ask === true) tag = 'ask';
  else if (row.is_bid === true) tag = 'bid';
  else {
    // Mirror ct-print-grader / ct-signature-watcher: RepeatedHits* IS
    // accumulation by definition; without this the 9:33 NVDA 0DTE +475%
    // print is mis-tagged as bear (caught 2026-04-24).
    const alertRule = typeof raw['alert_rule'] === 'string' ? raw['alert_rule'] : '';
    if (alertRule.startsWith('RepeatedHits')) {
      tag = side === 'call' ? 'ask' : 'bid';
    } else if (askValid && bidValid) {
      if (askPrem > bidPrem) tag = 'ask';
      else if (bidPrem > askPrem) tag = 'bid';
      else return null;
    } else if (askValid && askPrem > 0 && (!bidValid || bidPrem === 0)) tag = 'ask';
    else if (bidValid && bidPrem > 0 && (!askValid || askPrem === 0)) tag = 'bid';
    else return null;
  }
  return `aggressive_${tag}_${side}`;
}

function dteBucket(dte: number | null): DteBucket {
  if (dte === null || !Number.isFinite(dte)) return 'long';
  if (dte <= 0) return '0dte';
  if (dte <= 7) return 'short';
  if (dte <= 30) return 'mid';
  return 'long';
}

function computeDte(printTime: Date, expiry: string | null): number | null {
  if (!expiry) return null;
  const m = expiry.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const exp = Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10), 20, 0, 0);
  const days = Math.floor((exp - printTime.getTime()) / (24 * 3600_000));
  return Number.isFinite(days) ? days : null;
}

function resolvePrintTime(a: FlowAlertRow): Date {
  if (a.executed_at) {
    const d = new Date(a.executed_at);
    if (!Number.isNaN(d.getTime())) return d;
  }
  const raw = a.raw ?? {};
  if (typeof raw.created_at === 'string') {
    const d = new Date(raw.created_at);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date(a.ingested_at);
}

// Label casing must match ct_signature_magnitude_stats RPC output exactly.
function buildSignatureLabel(ticker: string, side: string, bucket: DteBucket, source: string): string {
  return `${ticker.toUpperCase()}:${side}:${bucket}:${source}`;
}

const DEFAULT_WATCHLIST = ['SPY','QQQ','IWM','AAPL','MSFT','GOOGL','AMZN','META','NVDA','TSLA'];

async function loadWatchlist(supabase: SupabaseClient): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('ct_config')
    .select('value')
    .eq('key', 'watcher.watchlist')
    .maybeSingle();
  if (error || !data?.value) return new Set(DEFAULT_WATCHLIST);
  const arr = data.value as unknown;
  if (!Array.isArray(arr)) return new Set(DEFAULT_WATCHLIST);
  const set = new Set<string>();
  for (const t of arr) if (typeof t === 'string' && t.length > 0) set.add(t.toUpperCase());
  return set.size > 0 ? set : new Set(DEFAULT_WATCHLIST);
}

async function loadSignatureStats(
  supabase: SupabaseClient,
  thresholds: TierThresholds,
  asOf: Date,
): Promise<Map<string, SignatureStat>> {
  // Use the END of the window as "now" so historical replays use the same
  // signature stats they would have seen at decision time. Approximation —
  // the RPC currently always returns "as of now"; passing p_since reduces
  // lookback drift but doesn't fully isolate the past from the future.
  const since = new Date(asOf.getTime() - thresholds.lookbackDays * 24 * 3600_000).toISOString();
  const { data, error } = await supabase.rpc('ct_signature_magnitude_stats', {
    p_since: since,
    p_min_n: thresholds.rpcMinN,
  });
  if (error || !data) return new Map();
  const map = new Map<string, SignatureStat>();
  for (const row of data as SignatureStat[]) map.set(row.signature_label, row);
  return map;
}

// ---------------------------------------------------------------------------
// Paginated window scan over ct_flow_alerts, executed_at-based.
// ---------------------------------------------------------------------------
async function fetchWindowAlerts(
  supabase: SupabaseClient,
  startIso: string,
  endIso: string,
  tickers: string[],
): Promise<FlowAlertRow[]> {
  // executed_at is NULL on every row (UW shape change) — window by ingested_at
  // to match what ct-signature-watcher actually sees. resolvePrintTime() inside
  // the loop pulls the true print time from raw.created_at for DTE / display.
  const all: FlowAlertRow[] = [];
  for (let offset = 0; offset < HARNESS_SCAN_LIMIT; offset += PAGE_SIZE) {
    const end = Math.min(offset + PAGE_SIZE - 1, HARNESS_SCAN_LIMIT - 1);
    const { data, error } = await supabase
      .from('ct_flow_alerts')
      .select('alert_id, ticker, side, is_ask, is_bid, strike, expiry, premium, price, underlying_price, executed_at, ingested_at, raw')
      .gte('ingested_at', startIso)
      .lte('ingested_at', endIso)
      .in('ticker', tickers)
      .order('ingested_at', { ascending: true })
      .range(offset, end);
    if (error) throw new Error(`flow_alerts page ${offset}: ${error.message}`);
    if (!data || data.length === 0) break;
    all.push(...(data as FlowAlertRow[]));
    if (data.length < PAGE_SIZE) break;
  }
  return all;
}

async function fetchContractTracks(
  supabase: SupabaseClient,
  alertIds: string[],
): Promise<Map<string, ContractTrackRow>> {
  const out = new Map<string, ContractTrackRow>();
  if (alertIds.length === 0) return out;
  const CHUNK = 200;
  for (let i = 0; i < alertIds.length; i += CHUNK) {
    const chunk = alertIds.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from('ct_contract_tracks')
      .select('alert_id, peak_contract_pct, max_drawdown_pct, track_status')
      .in('alert_id', chunk);
    if (error) throw new Error(`contract_tracks chunk ${i}: ${error.message}`);
    if (!data) continue;
    for (const r of data as ContractTrackRow[]) out.set(r.alert_id, r);
  }
  return out;
}

function classifyGroundTruth(
  track: ContractTrackRow | undefined,
  winThresh: number,
  lossThresh: number,
): { gt: GroundTruth; peak: number | null; drawdown: number | null } {
  if (!track) return { gt: 'no_track', peak: null, drawdown: null };
  const peak = track.peak_contract_pct == null
    ? null
    : (typeof track.peak_contract_pct === 'string' ? parseFloat(track.peak_contract_pct) : Number(track.peak_contract_pct));
  const dd = track.max_drawdown_pct == null
    ? null
    : (typeof track.max_drawdown_pct === 'string' ? parseFloat(track.max_drawdown_pct) : Number(track.max_drawdown_pct));
  const peakVal = peak != null && Number.isFinite(peak) ? peak : null;
  const ddVal = dd != null && Number.isFinite(dd) ? dd : null;
  if (peakVal != null && peakVal >= winThresh) return { gt: 'winner', peak: peakVal, drawdown: ddVal };
  if (ddVal != null && ddVal >= lossThresh) return { gt: 'loser', peak: peakVal, drawdown: ddVal };
  return { gt: 'neutral', peak: peakVal, drawdown: ddVal };
}

function emptyBucket(): TierBucket {
  return {
    fired: 0, winners: 0, losers: 0, neutral: 0, no_track: 0,
    hit_rate: 0, lift_vs_base: 0, pnl_avg_peak_pct: 0, pnl_total_peak_pct: 0,
  };
}

function bumpBucket(b: TierBucket, gt: GroundTruth, peak: number | null) {
  b.fired += 1;
  if (gt === 'winner') {
    b.winners += 1;
    if (peak != null) b.pnl_total_peak_pct += peak;
  } else if (gt === 'loser') b.losers += 1;
  else if (gt === 'neutral') b.neutral += 1;
  else b.no_track += 1;
}

function finalizeBucket(b: TierBucket, baseRate: number) {
  const denom = b.winners + b.losers + b.neutral;
  b.hit_rate = denom > 0 ? b.winners / denom : 0;
  b.lift_vs_base = baseRate > 0 ? b.hit_rate / baseRate : 0;
  b.pnl_avg_peak_pct = b.winners > 0 ? b.pnl_total_peak_pct / b.winners : 0;
}

interface AlertRecord {
  alert: FlowAlertRow;
  printTime: Date;
  dte: number | null;
  bucket: DteBucket;
  side: string;
  source: string | null;
  signatureLabel: string | null;
  sigMedian: number | null;
  sigN: number | null;
  score: number | null;
  tier: AlarmTier;
  cluster: ClusterMatch | null;
  fired: FullTier | null;       // first tier that fired (or cluster_alarm)
  why_missed: string | null;    // populated when tier==null
  gt: GroundTruth;
  peak: number | null;
  drawdown: number | null;
  skip_reason: string | null;
}

// ---------------------------------------------------------------------------
// Main backtest sweep.
// ---------------------------------------------------------------------------
async function runBacktest(
  supabase: SupabaseClient,
  startIso: string,
  endIso: string,
  tickerFilter: string[] | null,
  thresholds: TierThresholds,
  clusterCfg: ClusterConfig | null,
  winThresh: number,
  lossThresh: number,
): Promise<Record<string, unknown>> {
  const errors: string[] = [];
  const watchlist = await loadWatchlist(supabase);
  const tickerList = (tickerFilter && tickerFilter.length > 0)
    ? tickerFilter.map((t) => t.toUpperCase())
    : Array.from(watchlist);

  // Pull alerts in window. Total count first (estimated) for the response.
  // Window keys on ingested_at since executed_at is NULL on every row.
  const { count: totalAlertsCount } = await supabase
    .from('ct_flow_alerts')
    .select('alert_id', { count: 'estimated', head: true })
    .gte('ingested_at', startIso)
    .lte('ingested_at', endIso);

  const alerts = await fetchWindowAlerts(supabase, startIso, endIso, tickerList);

  const eligibility: DteEligibilityMap = await loadDteEligibility(supabase);

  // End-of-window signature stats. Intentionally one snapshot per run, not
  // per-alert — the watcher does the same thing in production.
  const asOf = new Date(endIso);
  const sigStats = await loadSignatureStats(supabase, thresholds, asOf);

  // Bulk score lookup — N+1 would otherwise dominate the runtime.
  const alertIds = alerts.map((a) => a.alert_id).filter(Boolean);
  const scores = await loadScoresBulk(supabase, alertIds);

  // Bulk ground truth lookup.
  const tracks = await fetchContractTracks(supabase, alertIds);

  // First pass: classify every alert.
  const records: AlertRecord[] = [];
  for (const a of alerts) {
    const printTime = resolvePrintTime(a);
    const ticker = (a.ticker ?? '').toUpperCase();
    const side = (a.side ?? '').toLowerCase();
    const dte = computeDte(printTime, a.expiry);
    const bucket = dteBucket(dte);
    const source = inferPredictedSource(a);
    const signatureLabel = source ? buildSignatureLabel(ticker, side, bucket, source) : null;

    let skip: string | null = null;
    if (side !== 'call' && side !== 'put') skip = 'no_direction';
    else if (!source) skip = 'no_predicted_source';
    else if (a.strike == null || !Number.isFinite(Number(a.strike))) skip = 'no_strike';
    else if (!a.expiry) skip = 'no_expiry';
    else if (bucket === '0dte' && !ticker0DteEligibleOn(ticker, eligibility, printTime)) {
      skip = '0dte_ineligible';
    }

    const stat = signatureLabel ? sigStats.get(signatureLabel) : undefined;
    const sigMedian = stat
      ? (typeof stat.median_peak_pct === 'string' ? parseFloat(stat.median_peak_pct) : Number(stat.median_peak_pct))
      : null;
    const sigN = stat?.n_tracks ?? null;
    const validSigMedian = sigMedian != null && Number.isFinite(sigMedian) ? sigMedian : null;
    const score = scores.get(a.alert_id) ?? null;

    let tier: AlarmTier = null;
    let why: string | null = null;
    if (skip == null) {
      tier = evaluateTier(score, validSigMedian, sigN, thresholds);
      if (tier == null) why = whyNoTier(score, validSigMedian, sigN, thresholds);
    } else {
      why = skip;
    }

    const track = tracks.get(a.alert_id);
    const { gt, peak, drawdown } = classifyGroundTruth(track, winThresh, lossThresh);

    records.push({
      alert: a,
      printTime,
      dte,
      bucket,
      side,
      source,
      signatureLabel,
      sigMedian: validSigMedian,
      sigN,
      score,
      tier,
      cluster: null,
      fired: tier,
      why_missed: why,
      gt,
      peak,
      drawdown,
      skip_reason: skip,
    });
  }

  // Second pass: cluster detector (optional). In-memory variant — partition
  // pre-loaded records by ticker, then check candidates against the same-ticker
  // window slice. No DB round-trips here; per-alert work is O(window_size).
  if (clusterCfg && clusterCfg.enabled) {
    const byTicker = new Map<string, FlowAlertLite[]>();
    for (const r of records) {
      const t = (r.alert.ticker ?? '').toUpperCase();
      if (!t) continue;
      if (!byTicker.has(t)) byTicker.set(t, []);
      byTicker.get(t)!.push({
        alert_id: r.alert.alert_id,
        ticker: t,
        side: r.alert.side,
        strike: r.alert.strike,
        executed_at: r.alert.executed_at,
        ingested_at: r.alert.ingested_at,
        underlying_price: r.alert.underlying_price,
      });
    }
    for (const r of records) {
      if (r.fired != null) continue;
      if (r.skip_reason && r.skip_reason !== 'no_predicted_source') continue;
      try {
        const ticker = (r.alert.ticker ?? '').toUpperCase();
        const slice = byTicker.get(ticker) ?? [];
        const m = detectClusterFromContext({
          alert_id: r.alert.alert_id,
          ticker,
          side: r.alert.side,
          strike: r.alert.strike,
          executed_at: r.alert.executed_at,
          ingested_at: r.alert.ingested_at,
          underlying_price: r.alert.underlying_price,
        }, slice, clusterCfg);
        if (m && m.side === r.side) {
          r.cluster = m;
          r.fired = 'cluster_alarm';
          r.why_missed = null;
        }
      } catch (e) {
        errors.push(`cluster ${r.alert.alert_id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // Aggregate ground truth across the full window (alerts in tickerList only).
  let actual_winners = 0, actual_losers = 0, actual_neutral = 0, actual_no_track = 0;
  for (const r of records) {
    if (r.gt === 'winner') actual_winners += 1;
    else if (r.gt === 'loser') actual_losers += 1;
    else if (r.gt === 'neutral') actual_neutral += 1;
    else actual_no_track += 1;
  }
  const denomBase = actual_winners + actual_losers + actual_neutral;
  const baseRate = denomBase > 0 ? actual_winners / denomBase : 0;

  // Per-tier buckets.
  const buckets: Record<FullTier, TierBucket> = {
    gold: emptyBucket(),
    silver: emptyBucket(),
    bronze: emptyBucket(),
    cluster_alarm: emptyBucket(),
  };
  const combined = emptyBucket();

  for (const r of records) {
    if (r.fired == null) continue;
    bumpBucket(buckets[r.fired], r.gt, r.peak);
    bumpBucket(combined, r.gt, r.peak);
  }
  for (const k of Object.keys(buckets) as FullTier[]) finalizeBucket(buckets[k], baseRate);
  finalizeBucket(combined, baseRate);
  // catch_rate_winners = of actual winners in window, what % did we alarm on (any tier).
  const catchRate = actual_winners > 0 ? combined.winners / actual_winners : 0;

  // Top 10 missed winners (actual_winner with fired==null), sorted by peak DESC.
  const missed = records
    .filter((r) => r.gt === 'winner' && r.fired == null)
    .sort((a, b) => (b.peak ?? 0) - (a.peak ?? 0))
    .slice(0, 10)
    .map((r) => ({
      alert_id: r.alert.alert_id,
      ticker: r.alert.ticker,
      side: r.side,
      strike: r.alert.strike,
      expiry: r.alert.expiry,
      dte_at_print: r.dte,
      print_time: r.printTime.toISOString(),
      score: r.score,
      sig_median: r.sigMedian,
      sig_n: r.sigN,
      sig_label: r.signatureLabel,
      peak_contract_pct: r.peak,
      max_drawdown_pct: r.drawdown,
      why_missed: r.why_missed,
    }));

  // Top 10 false alarms (fired but ground truth was loser/neutral).
  // Sort by tier severity DESC then by drawdown DESC.
  const tierOrder: Record<FullTier, number> = { gold: 4, silver: 3, cluster_alarm: 2, bronze: 1 };
  const falseAlarms = records
    .filter((r) => r.fired != null && (r.gt === 'loser' || r.gt === 'neutral'))
    .sort((a, b) => {
      const ta = tierOrder[a.fired as FullTier];
      const tb = tierOrder[b.fired as FullTier];
      if (tb !== ta) return tb - ta;
      return (b.drawdown ?? 0) - (a.drawdown ?? 0);
    })
    .slice(0, 10)
    .map((r) => ({
      alert_id: r.alert.alert_id,
      ticker: r.alert.ticker,
      side: r.side,
      strike: r.alert.strike,
      expiry: r.alert.expiry,
      dte_at_print: r.dte,
      print_time: r.printTime.toISOString(),
      score: r.score,
      tier: r.fired,
      peak_contract_pct: r.peak,
      max_drawdown_pct: r.drawdown,
      ground_truth: r.gt,
      why_fired: r.cluster
        ? `cluster_unanimity=${(r.cluster.unanimityPct * 100).toFixed(0)}% n=${r.cluster.printCount}`
        : 'tier_evaluator_passed',
    }));

  return {
    ok: true,
    config: {
      start_iso: startIso,
      end_iso: endIso,
      ticker_filter: tickerList,
      thresholds,
      cluster_detector: clusterCfg,
      win_threshold_pct: winThresh,
      loss_threshold_pct: lossThresh,
    },
    window: {
      start_iso: startIso,
      end_iso: endIso,
      total_alerts: totalAlertsCount ?? null,
      watchlist_alerts: alerts.length,
    },
    ground_truth: {
      actual_winners,
      actual_losers,
      actual_neutral,
      actual_no_track,
    },
    per_tier: {
      gold: buckets.gold,
      silver: buckets.silver,
      bronze: buckets.bronze,
      ...(clusterCfg && clusterCfg.enabled ? { cluster_alarm: buckets.cluster_alarm } : {}),
    },
    combined: {
      ...combined,
      catch_rate_winners: catchRate,
    },
    base_rate: { pct_winners: baseRate },
    top_missed_winners: missed,
    top_false_alarms: falseAlarms,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Entry point.
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
  let body: Record<string, unknown> = {};
  try {
    const text = await req.text();
    if (text && text.length > 0) body = JSON.parse(text);
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: `bad JSON: ${e instanceof Error ? e.message : String(e)}` }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const startIso = body.start_iso as string | undefined;
  const endIso = body.end_iso as string | undefined;
  if (!startIso || !endIso) {
    return new Response(JSON.stringify({ ok: false, error: 'start_iso and end_iso required' }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const tickerFilter = Array.isArray(body.ticker_filter) ? (body.ticker_filter as string[]) : null;
  const thresholdOverrides = (body.thresholds && typeof body.thresholds === 'object')
    ? body.thresholds as Partial<TierThresholds>
    : undefined;
  const winThresh = typeof body.win_threshold_pct === 'number' ? body.win_threshold_pct : 0.50;
  const lossThresh = typeof body.loss_threshold_pct === 'number' ? body.loss_threshold_pct : 0.50;

  let clusterCfg: ClusterConfig | null = null;
  if (body.cluster_detector && typeof body.cluster_detector === 'object') {
    const c = body.cluster_detector as Record<string, unknown>;
    clusterCfg = {
      enabled: c.enabled === true,
      windowMin: typeof c.window_min === 'number' ? c.window_min : 5,
      minPrints: typeof c.min_prints === 'number' ? c.min_prints : 3,
      strikeBandPct: typeof c.strike_band_pct === 'number' ? c.strike_band_pct : 0.02,
      minUnanimityPct: typeof c.min_unanimity_pct === 'number' ? c.min_unanimity_pct : 0.80,
    };
  }

  try {
    const thresholds = await loadTierThresholds(supabase, thresholdOverrides);
    const result = await runBacktest(
      supabase,
      startIso,
      endIso,
      tickerFilter,
      thresholds,
      clusterCfg,
      winThresh,
      lossThresh,
    );
    return new Response(JSON.stringify({
      ...result,
      elapsed_ms: Date.now() - startedAt,
    }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      elapsed_ms: Date.now() - startedAt,
    }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
