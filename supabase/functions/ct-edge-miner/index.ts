/**
 * ct-edge-miner — Co-Trader Edge Attribution Engine, Layer 2.
 *
 * Mines ct_print_grades (snapshot, frozen) + ct_print_tracks (lifetime,
 * continuous) into ct_signatures (the library) and ct_edge_daily (the daily
 * attribution ledger).
 *
 * Modes (?mode=):
 *   daily     [default] — build today's ct_edge_daily + roll forward
 *                         ct_signatures from today's grades + track updates.
 *   backfill  — rebuild a specific session_date (?session_date=YYYY-MM-DD).
 *               Same logic; lets us seed the library from history.
 *
 * Why
 *   Snapshot horizons (30m/2h/eod/plus1d) catch fast-feedback patterns.
 *   But options theses often play out over days/weeks — snapshot misses,
 *   track captures. Combining both lets us distinguish quick-hit edge
 *   ("ATM ask call at open") from slow-burn edge ("OTM-far put 30+DTE
 *   bid in midday — realizes 2 weeks later").
 *
 * signature_key (canonical, lowercase, colon-separated):
 *   {ticker}:{side}:{dte_bucket}:{moneyness}:{aggression}:{time_bucket}
 *
 * Tenets
 *   3  built to evolve         — library grows daily, no curation
 *   4  ground-up, no band-aids — handle missing parallel-agent tables via
 *                                try/catch → empty/0; never crash
 *   13 ungated signal access   — every dimension first-class, equal weight
 *
 * Auth: service_role only.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------
const TRADING_DAY_END_UTC_HOUR = 20;                  // ~4PM ET close (DST-naive — close enough)
const TRADING_DAY_START_UTC_HOUR = 13;                // ~9AM ET open
const FETCH_GRADE_LIMIT = 5000;                       // per-day grade pull cap
const FETCH_TRACK_LIMIT = 5000;
const TOP_N_SIGNATURES = 10;
const SIGNATURE_HORIZON_FOR_SNAPSHOT = '2h';          // 2h is the primary snapshot horizon for signature aggregation

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type Side = 'call' | 'put';
type Aggression = 'ask' | 'bid' | 'mid';
type DteBucket = '0dte' | '0-7' | '8-30' | '30+';
type Moneyness = 'ITM' | 'ATM' | 'OTM-near' | 'OTM-far';
type TimeBucket = 'open' | 'midday' | 'close' | 'afterhours';
type SnapshotHorizon = '30m' | '2h' | 'eod';

interface GradeRow {
  alert_id: string;
  ticker: string;
  horizon: string;
  print_time: string;
  predicted_direction: 'up' | 'down';
  predicted_source: string;
  grade: 'WIN' | 'LOSS' | 'FLAT';
}

interface FlowAlertRow {
  alert_id: string;
  ticker: string;
  side: string | null;
  is_ask: boolean | null;
  is_bid: boolean | null;
  strike: number | null;
  expiry: string | null;
  underlying_price: number | null;
  executed_at: string | null;
  ingested_at: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw: any;
}

interface TrackRow {
  alert_id: string;
  ticker: string;
  print_time: string;
  track_status: string;
  peak_favorable_pct: number | null;
  peak_favorable_at: string | null;
  realized_at?: string | null;
  expired_at?: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [k: string]: any;
}

interface SignatureDims {
  ticker: string;
  side: Side;
  dte_bucket: DteBucket;
  moneyness: Moneyness | null;
  aggression: Aggression;
  time_bucket: TimeBucket;
}

interface SignatureAccum {
  key: string;
  dims: SignatureDims;
  // snapshot (from today's grades, primary horizon)
  snapshot_win: number;
  snapshot_loss: number;
  snapshot_flat: number;
  // lifetime (from today's track activity)
  lifetime_realized: number;
  lifetime_failing: number;
  lifetime_flat: number;
  lifetime_expired_unrealized: number;
  days_to_realization: number[];
}

interface PromotionConfig {
  min_sample: number;
  min_edge: number;
  slow_burn_days: number;
}

// ---------------------------------------------------------------------------
// Dimension extraction
// ---------------------------------------------------------------------------
function bucketDte(printTime: Date, expiry: string | null): DteBucket {
  if (!expiry) return '30+';
  const exp = new Date(expiry);
  if (Number.isNaN(exp.getTime())) return '30+';
  const dteDays = Math.floor((exp.getTime() - printTime.getTime()) / 86_400_000);
  if (dteDays <= 0) return '0dte';
  if (dteDays <= 7) return '0-7';
  if (dteDays <= 30) return '8-30';
  return '30+';
}

function bucketMoneyness(
  side: Side,
  strike: number | null,
  underlying: number | null,
): Moneyness | null {
  if (strike == null || underlying == null || underlying <= 0) return null;
  const ratio = strike / underlying;
  // ATM = within 1% of underlying
  if (Math.abs(ratio - 1) <= 0.01) return 'ATM';
  if (side === 'call') {
    if (ratio < 1) return 'ITM';
    if (ratio <= 1.05) return 'OTM-near';
    return 'OTM-far';
  } else {
    if (ratio > 1) return 'ITM';
    if (ratio >= 0.95) return 'OTM-near';
    return 'OTM-far';
  }
}

function bucketTimeOfDay(printTime: Date): TimeBucket {
  // Use UTC hours; 13-15 UTC = 9-11 ET (open), 15-18 UTC = 11-2 ET (midday),
  // 18-20 UTC = 2-4 ET (close), else afterhours. DST-approximate.
  const h = printTime.getUTCHours();
  if (h >= 13 && h < 15) return 'open';
  if (h >= 15 && h < 18) return 'midday';
  if (h >= 18 && h < 21) return 'close';
  return 'afterhours';
}

function inferAggression(alert: FlowAlertRow): Aggression {
  if (alert.is_ask === true) return 'ask';
  if (alert.is_bid === true) return 'bid';
  const askPrem = Number(alert.raw?.total_ask_side_prem ?? NaN);
  const bidPrem = Number(alert.raw?.total_bid_side_prem ?? NaN);
  if (Number.isFinite(askPrem) && Number.isFinite(bidPrem)) {
    if (askPrem > bidPrem * 1.1) return 'ask';
    if (bidPrem > askPrem * 1.1) return 'bid';
  }
  return 'mid';
}

function makeSignatureKey(d: SignatureDims): string {
  const parts = [
    d.ticker.toLowerCase(),
    d.side,
    d.dte_bucket,
    d.moneyness ?? 'unknown',
    d.aggression,
    d.time_bucket,
  ];
  return parts.join(':');
}

function buildDimsFromAlert(alert: FlowAlertRow, printTime: Date): SignatureDims | null {
  const side = (alert.side ?? '').toLowerCase();
  if (side !== 'call' && side !== 'put') return null;
  const ticker = (alert.ticker ?? '').trim();
  if (!ticker) return null;

  // Underlying for moneyness — try alert.underlying_price first, fall back to raw.
  const underlying = alert.underlying_price != null
    ? Number(alert.underlying_price)
    : Number(alert.raw?.underlying_price ?? alert.raw?.spot ?? NaN);
  const strike = alert.strike != null ? Number(alert.strike) : Number(alert.raw?.strike ?? NaN);

  return {
    ticker,
    side: side as Side,
    dte_bucket: bucketDte(printTime, alert.expiry ?? alert.raw?.expiry ?? null),
    moneyness: bucketMoneyness(
      side as Side,
      Number.isFinite(strike) ? strike : null,
      Number.isFinite(underlying) ? underlying : null,
    ),
    aggression: inferAggression(alert),
    time_bucket: bucketTimeOfDay(printTime),
  };
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------
function sessionDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function dayBoundsUTC(sessionDate: string): { startISO: string; endISO: string } {
  const start = new Date(`${sessionDate}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 86_400_000);
  return { startISO: start.toISOString(), endISO: end.toISOString() };
}

// ---------------------------------------------------------------------------
// Config loader
// ---------------------------------------------------------------------------
async function loadPromotionConfig(supabase: SupabaseClient): Promise<PromotionConfig> {
  const defaults: PromotionConfig = { min_sample: 20, min_edge: 0.15, slow_burn_days: 3 };
  try {
    const { data, error } = await supabase
      .from('ct_config')
      .select('key, value')
      .in('key', [
        'signature_promotion_min_sample',
        'signature_promotion_min_edge',
        'signature_slow_burn_days',
      ]);
    if (error || !data) return defaults;
    const out = { ...defaults };
    for (const row of data) {
      const v = row.value;
      const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
      if (!Number.isFinite(n)) continue;
      if (row.key === 'signature_promotion_min_sample') out.min_sample = Math.max(1, Math.floor(n));
      else if (row.key === 'signature_promotion_min_edge') out.min_edge = n;
      else if (row.key === 'signature_slow_burn_days') out.slow_burn_days = Math.max(1, Math.floor(n));
    }
    return out;
  } catch {
    return defaults;
  }
}

// ---------------------------------------------------------------------------
// Regime classifier — pulls SPY 5m bars for the day, computes daily return
// + realized vol (std of 5m returns). Classifies trend/chop × low-vol/high-vol.
// ---------------------------------------------------------------------------
async function computeRegimeTag(
  supabase: SupabaseClient,
  sessionDate: string,
): Promise<string> {
  try {
    const { startISO, endISO } = dayBoundsUTC(sessionDate);
    let bars: Array<{ ts: string; close: number }> = [];
    const primary = await supabase
      .from('ct_price_bars')
      .select('ts, close')
      .eq('ticker', 'SPY')
      .eq('timeframe', '5m')
      .gte('ts', startISO)
      .lt('ts', endISO)
      .order('ts', { ascending: true })
      .limit(1000);
    if (!primary.error && primary.data && primary.data.length >= 5) {
      bars = primary.data as Array<{ ts: string; close: number }>;
    } else {
      const fallback = await supabase
        .from('ct_price_bars')
        .select('ts, close')
        .eq('ticker', 'SPY')
        .eq('timeframe', '1m')
        .gte('ts', startISO)
        .lt('ts', endISO)
        .order('ts', { ascending: true })
        .limit(2000);
      if (fallback.error || !fallback.data || fallback.data.length < 5) return 'unknown';
      bars = fallback.data as Array<{ ts: string; close: number }>;
    }
    if (bars.length < 5) return 'unknown';

    const closes = bars.map((b) => Number(b.close)).filter((x) => Number.isFinite(x) && x > 0);
    if (closes.length < 5) return 'unknown';

    const dailyReturn = (closes[closes.length - 1] - closes[0]) / closes[0];

    // 5m return std
    const rets: number[] = [];
    for (let i = 1; i < closes.length; i++) {
      rets.push((closes[i] - closes[i - 1]) / closes[i - 1]);
    }
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
    const realizedVol = Math.sqrt(variance);

    // Classification: trend if |daily| >= 0.003 (0.3%), low vol if std < 0.0008 (0.08% per 5m).
    const isTrend = Math.abs(dailyReturn) >= 0.003;
    const isLowVol = realizedVol < 0.0008;

    if (!isTrend) return isLowVol ? 'chop_low_vol' : 'chop';
    const dir = dailyReturn > 0 ? 'up' : 'down';
    return `trend_${dir}_${isLowVol ? 'low_vol' : 'high_vol'}`;
  } catch (e) {
    console.warn(`[ct-edge-miner] regime classify failed: ${(e as Error).message}`);
    return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// Signature accumulator — builds an in-memory map keyed by signature_key
// from today's grades + track updates, then flushes to ct_signatures.
// ---------------------------------------------------------------------------
function getOrCreateAccum(
  map: Map<string, SignatureAccum>,
  dims: SignatureDims,
): SignatureAccum {
  const key = makeSignatureKey(dims);
  let entry = map.get(key);
  if (!entry) {
    entry = {
      key,
      dims,
      snapshot_win: 0,
      snapshot_loss: 0,
      snapshot_flat: 0,
      lifetime_realized: 0,
      lifetime_failing: 0,
      lifetime_flat: 0,
      lifetime_expired_unrealized: 0,
      days_to_realization: [],
    };
    map.set(key, entry);
  }
  return entry;
}

function median(arr: number[]): number | null {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// ---------------------------------------------------------------------------
// Mine grades for a session: pull ct_print_grades graded today (graded_at
// within session), JOIN to ct_flow_alerts for dimensions, accumulate.
// ---------------------------------------------------------------------------
async function mineSnapshotGrades(
  supabase: SupabaseClient,
  sessionDate: string,
  accum: Map<string, SignatureAccum>,
): Promise<{ totalGraded: number; wins: number; losses: number; flats: number; byTicker: Record<string, number>; byTime: Record<string, number>; byDte: Record<string, number> }> {
  const stats = {
    totalGraded: 0, wins: 0, losses: 0, flats: 0,
    byTicker: {} as Record<string, number>,
    byTime: {} as Record<string, number>,
    byDte: {} as Record<string, number>,
  };
  const { startISO, endISO } = dayBoundsUTC(sessionDate);

  // Pull today's grades for the primary signature horizon.
  const { data: grades, error: gErr } = await supabase
    .from('ct_print_grades')
    .select('alert_id, ticker, horizon, print_time, predicted_direction, predicted_source, grade, graded_at')
    .eq('horizon', SIGNATURE_HORIZON_FOR_SNAPSHOT)
    .gte('graded_at', startISO)
    .lt('graded_at', endISO)
    .limit(FETCH_GRADE_LIMIT);

  if (gErr) {
    console.warn(`[ct-edge-miner] grade fetch error: ${gErr.message}`);
    return stats;
  }
  if (!grades || grades.length === 0) return stats;

  // Also pull all-horizon counts for snapshot_total_graded (used in ct_edge_daily totals).
  const { data: allGrades } = await supabase
    .from('ct_print_grades')
    .select('grade')
    .gte('graded_at', startISO)
    .lt('graded_at', endISO)
    .limit(FETCH_GRADE_LIMIT * 4);
  if (allGrades) {
    for (const g of allGrades) {
      stats.totalGraded += 1;
      if (g.grade === 'WIN') stats.wins += 1;
      else if (g.grade === 'LOSS') stats.losses += 1;
      else stats.flats += 1;
    }
  }

  // Bulk fetch flow alerts by alert_id for dimension extraction.
  const alertIds = (grades as GradeRow[]).map((g) => g.alert_id);
  const alertMap = await fetchAlertsByIds(supabase, alertIds);

  for (const g of grades as GradeRow[]) {
    const alert = alertMap.get(g.alert_id);
    if (!alert) continue;
    const printTime = new Date(g.print_time);
    if (Number.isNaN(printTime.getTime())) continue;
    const dims = buildDimsFromAlert(alert, printTime);
    if (!dims) continue;

    const entry = getOrCreateAccum(accum, dims);
    if (g.grade === 'WIN') entry.snapshot_win += 1;
    else if (g.grade === 'LOSS') entry.snapshot_loss += 1;
    else entry.snapshot_flat += 1;

    stats.byTicker[dims.ticker] = (stats.byTicker[dims.ticker] || 0) + 1;
    stats.byTime[dims.time_bucket] = (stats.byTime[dims.time_bucket] || 0) + 1;
    stats.byDte[dims.dte_bucket] = (stats.byDte[dims.dte_bucket] || 0) + 1;
  }

  return stats;
}

async function fetchAlertsByIds(
  supabase: SupabaseClient,
  alertIds: string[],
): Promise<Map<string, FlowAlertRow>> {
  const out = new Map<string, FlowAlertRow>();
  const uniq = Array.from(new Set(alertIds.filter(Boolean)));
  const chunkSize = 200;
  for (let i = 0; i < uniq.length; i += chunkSize) {
    const slice = uniq.slice(i, i + chunkSize);
    const { data, error } = await supabase
      .from('ct_flow_alerts')
      .select('alert_id, ticker, side, is_ask, is_bid, strike, expiry, underlying_price, executed_at, ingested_at, raw')
      .in('alert_id', slice);
    if (error) {
      console.warn(`[ct-edge-miner] alert fetch chunk error: ${error.message}`);
      continue;
    }
    for (const a of (data ?? []) as FlowAlertRow[]) {
      if (a.alert_id) out.set(a.alert_id, a);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mine track updates for a session. Tracks may not exist (parallel agent
// hasn't shipped yet) — try/catch → empty.
// ---------------------------------------------------------------------------
interface TrackMineStats {
  realized_today: number;
  new_peaks_today: number;
  expired_today: number;
  slow_burn_pays: Array<{ alert_id: string; ticker: string; signature_key: string; print_time: string; days_to_realization: number; peak_favorable_pct: number | null }>;
}

async function mineTrackUpdates(
  supabase: SupabaseClient,
  sessionDate: string,
  accum: Map<string, SignatureAccum>,
  config: PromotionConfig,
): Promise<TrackMineStats> {
  const stats: TrackMineStats = {
    realized_today: 0,
    new_peaks_today: 0,
    expired_today: 0,
    slow_burn_pays: [],
  };

  const { startISO, endISO } = dayBoundsUTC(sessionDate);

  // Fetch tracks with activity today: last_tracked_at OR peak_favorable_at
  // within today. ct_print_tracks (migration 20260425000020) has no
  // realized_at/expired_at — we derive "happened today" from
  // last_tracked_at + track_status. If the table doesn't exist yet, return
  // empty stats so the parallel-agent rollout doesn't crash us.
  let tracks: TrackRow[] = [];
  try {
    const { data, error } = await supabase
      .from('ct_print_tracks')
      .select('alert_id, ticker, side, strike, expiry, dte_at_print, print_time, predicted_direction, predicted_source, peak_favorable_pct, peak_favorable_at, first_cross_threshold_at, track_status, tracking_until, last_tracked_at')
      .gte('last_tracked_at', startISO)
      .lt('last_tracked_at', endISO)
      .limit(FETCH_TRACK_LIMIT);
    if (error) throw error;
    tracks = (data ?? []) as TrackRow[];
  } catch (e) {
    console.warn(`[ct-edge-miner] ct_print_tracks not queryable yet: ${(e as Error).message}`);
    return stats;
  }

  if (tracks.length === 0) return stats;

  const alertIds = tracks.map((t) => t.alert_id).filter(Boolean);
  const alertMap = await fetchAlertsByIds(supabase, alertIds);

  const dayStart = new Date(startISO);
  const dayEnd = new Date(endISO);

  for (const t of tracks) {
    try {
      const alert = alertMap.get(t.alert_id);
      if (!alert) continue;
      const printTime = new Date(t.print_time ?? alert.executed_at ?? alert.ingested_at);
      if (Number.isNaN(printTime.getTime())) continue;
      const dims = buildDimsFromAlert(alert, printTime);
      if (!dims) continue;
      const entry = getOrCreateAccum(accum, dims);

      const status = (t.track_status ?? '').toUpperCase();
      const peakAt = t.peak_favorable_at ? new Date(t.peak_favorable_at as string) : null;
      const peakAtToday = peakAt && peakAt >= dayStart && peakAt < dayEnd;

      // ct_print_tracks has no realized_at/expired_at — derive "today's
      // terminal transition" from last_tracked_at + track_status. last_tracked_at
      // is bumped on every grader sweep; if it's today AND status is terminal,
      // we attribute that transition to today.
      const lastTrackedAt = t.last_tracked_at ? new Date(t.last_tracked_at as string) : null;
      const transitionedToday = lastTrackedAt && lastTrackedAt >= dayStart && lastTrackedAt < dayEnd;

      // first_cross_threshold_at is when the print first paid off — track_status
      // flips to REALIZED on that sweep. We attribute REALIZED to the day
      // first_cross_threshold_at falls in (NOT last_tracked_at, which gets
      // bumped on every sweep and would double-count old wins).
      const firstCrossAt = t.first_cross_threshold_at ? new Date(t.first_cross_threshold_at as string) : null;
      const realizedToday = status === 'REALIZED' && firstCrossAt && firstCrossAt >= dayStart && firstCrossAt < dayEnd;

      if (peakAtToday) stats.new_peaks_today += 1;

      if (realizedToday) {
        entry.lifetime_realized += 1;
        stats.realized_today += 1;
        const realizedAt = firstCrossAt!;
        const days = Math.max(0, (realizedAt.getTime() - printTime.getTime()) / 86_400_000);
        entry.days_to_realization.push(days);
        if (days >= config.slow_burn_days) {
          stats.slow_burn_pays.push({
            alert_id: t.alert_id,
            ticker: dims.ticker,
            signature_key: makeSignatureKey(dims),
            print_time: printTime.toISOString(),
            days_to_realization: Number(days.toFixed(2)),
            peak_favorable_pct: t.peak_favorable_pct == null ? null : Number(t.peak_favorable_pct),
          });
        }
      } else if (status === 'FAILING' && transitionedToday) {
        entry.lifetime_failing += 1;
      } else if (status === 'FLAT' && transitionedToday) {
        entry.lifetime_flat += 1;
      } else if (status === 'EXPIRED' && transitionedToday) {
        entry.lifetime_expired_unrealized += 1;
        stats.expired_today += 1;
      }
    } catch (e) {
      console.warn(`[ct-edge-miner] track row skip: ${(e as Error).message}`);
    }
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Flush accumulator to ct_signatures. UPSERT additive — read existing row,
// add today's deltas, recompute hit rates + edge_score + promotion.
// ---------------------------------------------------------------------------
async function flushSignatures(
  supabase: SupabaseClient,
  accum: Map<string, SignatureAccum>,
  config: PromotionConfig,
): Promise<{ inserted: number; updated: number; promoted: number; demoted: number }> {
  const stats = { inserted: 0, updated: 0, promoted: 0, demoted: 0 };
  if (accum.size === 0) return stats;

  // Read existing rows for keys we touched.
  const keys = Array.from(accum.keys());
  const existing = new Map<string, Record<string, unknown>>();
  const chunkSize = 200;
  for (let i = 0; i < keys.length; i += chunkSize) {
    const slice = keys.slice(i, i + chunkSize);
    const { data, error } = await supabase
      .from('ct_signatures')
      .select('*')
      .in('signature_key', slice);
    if (error) {
      console.warn(`[ct-edge-miner] existing sig fetch error: ${error.message}`);
      continue;
    }
    for (const row of (data ?? [])) {
      existing.set(row.signature_key as string, row as Record<string, unknown>);
    }
  }

  // Build merged rows.
  const upserts: Array<Record<string, unknown>> = [];
  for (const [key, e] of accum.entries()) {
    const prior = existing.get(key);
    const priorN = (k: string) => Number((prior?.[k] as number) ?? 0);
    const priorMedians: number[] = []; // we don't store the raw list; merge as weighted avg via existing median + new samples

    const snapshot_win = priorN('snapshot_win') + e.snapshot_win;
    const snapshot_loss = priorN('snapshot_loss') + e.snapshot_loss;
    const snapshot_flat = priorN('snapshot_flat') + e.snapshot_flat;
    const lifetime_realized = priorN('lifetime_realized') + e.lifetime_realized;
    const lifetime_failing = priorN('lifetime_failing') + e.lifetime_failing;
    const lifetime_flat = priorN('lifetime_flat') + e.lifetime_flat;
    const lifetime_expired_unrealized = priorN('lifetime_expired_unrealized') + e.lifetime_expired_unrealized;

    const snapshot_decisive = snapshot_win + snapshot_loss;
    const snapshot_hit_rate = snapshot_decisive > 0 ? snapshot_win / snapshot_decisive : null;

    const lifetime_decisive = lifetime_realized + lifetime_failing;
    const lifetime_hit_rate = lifetime_decisive > 0 ? lifetime_realized / lifetime_decisive : null;

    // edge_score: prefer lifetime when sample is rich; else snapshot.
    let edge_hit: number | null = null;
    let edge_n = 0;
    if (lifetime_decisive >= 20 && lifetime_hit_rate !== null) {
      edge_hit = lifetime_hit_rate;
      edge_n = lifetime_decisive;
    } else if (snapshot_decisive > 0 && snapshot_hit_rate !== null) {
      edge_hit = snapshot_hit_rate;
      edge_n = snapshot_decisive;
    }
    const edge_score = edge_hit !== null && edge_n > 0
      ? Number(((edge_hit - 0.5) * Math.sqrt(edge_n)).toFixed(4))
      : null;

    const sample_count = snapshot_win + snapshot_loss + snapshot_flat
      + lifetime_realized + lifetime_failing + lifetime_flat + lifetime_expired_unrealized;

    // Median days-to-realization: blend new samples with prior median if any.
    let median_days: number | null = null;
    if (e.days_to_realization.length > 0) {
      const newMedian = median(e.days_to_realization);
      const priorMedian = prior?.median_days_to_realization;
      const priorRealized = priorN('lifetime_realized');
      if (priorMedian == null || priorRealized === 0) {
        median_days = newMedian;
      } else {
        // Weighted blend (rough — exact median requires raw samples; this is good enough for a daily roll).
        const blended = (Number(priorMedian) * priorRealized + (newMedian ?? 0) * e.days_to_realization.length)
          / (priorRealized + e.days_to_realization.length);
        median_days = Number(blended.toFixed(2));
      }
    } else if (prior?.median_days_to_realization != null) {
      median_days = Number(prior.median_days_to_realization);
    }

    // Promotion: |edge_score| >= min_edge AND edge_n >= min_sample.
    const decisiveForPromotion = lifetime_decisive >= 20 ? lifetime_decisive : snapshot_decisive;
    const promoted = edge_score !== null
      && Math.abs(edge_score) >= config.min_edge
      && decisiveForPromotion >= config.min_sample;

    if (prior?.promoted === true && !promoted) stats.demoted += 1;
    if (!prior?.promoted && promoted) stats.promoted += 1;

    const promotion_notes = promoted
      ? `auto:edge=${edge_score} src=${lifetime_decisive >= 20 ? 'lifetime' : 'snapshot'} n=${decisiveForPromotion}`
      : null;

    upserts.push({
      signature_key: key,
      ticker: e.dims.ticker,
      side: e.dims.side,
      dte_bucket: e.dims.dte_bucket,
      moneyness: e.dims.moneyness,
      aggression: e.dims.aggression,
      time_bucket: e.dims.time_bucket,
      snapshot_horizon: SIGNATURE_HORIZON_FOR_SNAPSHOT,
      snapshot_win,
      snapshot_loss,
      snapshot_flat,
      snapshot_hit_rate: snapshot_hit_rate == null ? null : Number(snapshot_hit_rate.toFixed(4)),
      lifetime_realized,
      lifetime_failing,
      lifetime_flat,
      lifetime_expired_unrealized,
      lifetime_hit_rate: lifetime_hit_rate == null ? null : Number(lifetime_hit_rate.toFixed(4)),
      median_days_to_realization: median_days,
      sample_count,
      edge_score,
      last_updated_at: new Date().toISOString(),
      promoted,
      promotion_notes,
    });

    if (prior) stats.updated += 1; else stats.inserted += 1;
  }

  // Upsert in chunks.
  for (let i = 0; i < upserts.length; i += 200) {
    const chunk = upserts.slice(i, i + 200);
    const { error } = await supabase
      .from('ct_signatures')
      .upsert(chunk, { onConflict: 'signature_key' });
    if (error) {
      console.warn(`[ct-edge-miner] upsert chunk error: ${error.message}`);
    }
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Top-N attribution lists for ct_edge_daily.
// ---------------------------------------------------------------------------
async function topSignaturesToday(
  supabase: SupabaseClient,
  todaysKeys: string[],
): Promise<{ winners: Array<Record<string, unknown>>; losers: Array<Record<string, unknown>> }> {
  if (todaysKeys.length === 0) return { winners: [], losers: [] };

  const winners: Array<Record<string, unknown>> = [];
  const losers: Array<Record<string, unknown>> = [];

  const chunkSize = 200;
  const all: Array<Record<string, unknown>> = [];
  for (let i = 0; i < todaysKeys.length; i += chunkSize) {
    const slice = todaysKeys.slice(i, i + chunkSize);
    const { data } = await supabase
      .from('ct_signatures')
      .select('signature_key, ticker, side, dte_bucket, moneyness, aggression, time_bucket, edge_score, sample_count, snapshot_hit_rate, lifetime_hit_rate, snapshot_win, snapshot_loss, lifetime_realized, lifetime_failing, promoted')
      .in('signature_key', slice);
    if (data) all.push(...(data as Array<Record<string, unknown>>));
  }

  const scored = all
    .filter((r) => r.edge_score != null)
    .map((r) => ({ ...r, _abs: Math.abs(Number(r.edge_score)) }));

  scored.sort((a, b) => Number(b.edge_score) - Number(a.edge_score));
  for (const r of scored.slice(0, TOP_N_SIGNATURES)) {
    if (Number(r.edge_score) > 0) {
      const { _abs, ...row } = r;
      void _abs;
      winners.push(row);
    }
  }

  scored.sort((a, b) => Number(a.edge_score) - Number(b.edge_score));
  for (const r of scored.slice(0, TOP_N_SIGNATURES)) {
    if (Number(r.edge_score) < 0) {
      const { _abs, ...row } = r;
      void _abs;
      losers.push(row);
    }
  }

  return { winners, losers };
}

// ---------------------------------------------------------------------------
// Main session run
// ---------------------------------------------------------------------------
interface SessionRunResult {
  session_date: string;
  regime_tag: string;
  signatures_seen: number;
  signatures_inserted: number;
  signatures_updated: number;
  signatures_promoted_now: number;
  signatures_demoted_now: number;
  snapshot_total_graded: number;
  snapshot_wins: number;
  snapshot_losses: number;
  snapshot_flats: number;
  tracks_realized_today: number;
  tracks_new_peaks_today: number;
  tracks_expired_today: number;
  slow_burn_pays_count: number;
  errors: string[];
}

async function runSession(
  supabase: SupabaseClient,
  sessionDate: string,
): Promise<SessionRunResult> {
  const errors: string[] = [];
  const config = await loadPromotionConfig(supabase);
  const accum = new Map<string, SignatureAccum>();

  // Snapshot mining
  let snapshotStats;
  try {
    snapshotStats = await mineSnapshotGrades(supabase, sessionDate, accum);
  } catch (e) {
    errors.push(`mineSnapshotGrades: ${(e as Error).message.slice(0, 200)}`);
    snapshotStats = { totalGraded: 0, wins: 0, losses: 0, flats: 0, byTicker: {}, byTime: {}, byDte: {} };
  }

  // Track mining (handles missing table)
  let trackStats: TrackMineStats;
  try {
    trackStats = await mineTrackUpdates(supabase, sessionDate, accum, config);
  } catch (e) {
    errors.push(`mineTrackUpdates: ${(e as Error).message.slice(0, 200)}`);
    trackStats = { realized_today: 0, new_peaks_today: 0, expired_today: 0, slow_burn_pays: [] };
  }

  // Flush
  let flushStats = { inserted: 0, updated: 0, promoted: 0, demoted: 0 };
  try {
    flushStats = await flushSignatures(supabase, accum, config);
  } catch (e) {
    errors.push(`flushSignatures: ${(e as Error).message.slice(0, 200)}`);
  }

  // Regime
  const regime_tag = await computeRegimeTag(supabase, sessionDate);

  // Top signatures (winners/losers) restricted to keys touched today.
  const todaysKeys = Array.from(accum.keys());
  const { winners, losers } = await topSignaturesToday(supabase, todaysKeys);

  const snapshot_hit_rate = (snapshotStats.wins + snapshotStats.losses) > 0
    ? Number((snapshotStats.wins / (snapshotStats.wins + snapshotStats.losses)).toFixed(4))
    : null;

  // Build ct_edge_daily row
  const edgeDailyRow = {
    session_date: sessionDate,
    regime_tag,
    snapshot_total_graded: snapshotStats.totalGraded,
    snapshot_wins: snapshotStats.wins,
    snapshot_losses: snapshotStats.losses,
    snapshot_flats: snapshotStats.flats,
    snapshot_hit_rate,
    tracks_realized_today: trackStats.realized_today,
    tracks_new_peaks_today: trackStats.new_peaks_today,
    tracks_expired_today: trackStats.expired_today,
    top_winning_signatures: winners,
    top_losing_signatures: losers,
    slow_burn_pays_today: trackStats.slow_burn_pays,
    by_ticker: snapshotStats.byTicker,
    by_time_bucket: snapshotStats.byTime,
    by_dte_bucket: snapshotStats.byDte,
    computed_at: new Date().toISOString(),
  };

  const { error: edErr } = await supabase
    .from('ct_edge_daily')
    .upsert(edgeDailyRow, { onConflict: 'session_date' });
  if (edErr) {
    errors.push(`ct_edge_daily upsert: ${edErr.message.slice(0, 200)}`);
  }

  return {
    session_date: sessionDate,
    regime_tag,
    signatures_seen: accum.size,
    signatures_inserted: flushStats.inserted,
    signatures_updated: flushStats.updated,
    signatures_promoted_now: flushStats.promoted,
    signatures_demoted_now: flushStats.demoted,
    snapshot_total_graded: snapshotStats.totalGraded,
    snapshot_wins: snapshotStats.wins,
    snapshot_losses: snapshotStats.losses,
    snapshot_flats: snapshotStats.flats,
    tracks_realized_today: trackStats.realized_today,
    tracks_new_peaks_today: trackStats.new_peaks_today,
    tracks_expired_today: trackStats.expired_today,
    slow_burn_pays_count: trackStats.slow_burn_pays.length,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Entry point
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

  const url = new URL(req.url);
  let bodyJson: Record<string, unknown> = {};
  try {
    const txt = await req.text();
    if (txt) bodyJson = JSON.parse(txt);
  } catch { /* ignore */ }

  const mode = (
    (url.searchParams.get('mode') ?? bodyJson.mode ?? 'daily') as string
  ).toLowerCase();
  const explicitDate = (url.searchParams.get('session_date')
    ?? (bodyJson.session_date as string | undefined)) ?? null;

  let sessionDate: string;
  if (mode === 'backfill' && explicitDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(explicitDate)) {
      return new Response(JSON.stringify({ error: 'session_date must be YYYY-MM-DD' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    sessionDate = explicitDate;
  } else {
    sessionDate = sessionDateStr(new Date());
  }

  const startedAt = Date.now();
  const result = await runSession(supabase, sessionDate);
  const elapsed_ms = Date.now() - startedAt;

  return new Response(JSON.stringify({ ok: true, mode, elapsed_ms, ...result }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
