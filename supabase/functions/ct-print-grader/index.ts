/**
 * ct-print-grader — Co-Trader Edge Attribution Engine, Layer 1.
 *
 * TWO PASSES per invocation. Both are idempotent.
 *
 * Pass 1 — Snapshot grading (frozen). Writes ct_print_grades rows at
 *   30m / 2h / eod / plus1d horizons against UNDERLYING price movement.
 *   Once written, never updated. Fast feedback for short-horizon signals.
 *
 * Pass 2 — Lifetime tracking (update-in-place). Writes ct_print_tracks
 *   rows that update every sweep, capturing peak favorable / adverse moves
 *   continuously until contract expiry (or 30-day cap from ct_config).
 *   Captures slow-burn winners that fixed horizons miss — a 30DTE call
 *   that sits flat for 3 weeks then 5x's.
 *
 * Why both
 *   The score-the-print scorer learned to detect VOLATILITY (MFE ≈ MAE
 *   across 4,300+ events) instead of DIRECTION. Pass 1 gives ground truth
 *   at fixed horizons; Pass 2 gives ground truth across the full lifetime
 *   of the contract. Together they answer: "did the underlying actually
 *   move the way this print implied — at the snapshot, AND ever?"
 *
 * Auth: service_role only.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';

// ---------------------------------------------------------------------------
// Tunables (cron header / safety rails — NOT thresholds; thresholds live in ct_config)
// ---------------------------------------------------------------------------
// Caps tuned for the 150s Edge Function wall. The grader runs every 30 min
// so making forward progress every sweep matters more than maxing one sweep.
//
// SCAN_LIMIT is the raw fetch — we filter already-processed rows in memory
// (cheap) so the WORK_LIMIT is what bounds price-lookup cost.
const PASS1_SCAN_LIMIT = 600;            // Pass 1 alert fetch
const PASS1_WORK_LIMIT = 80;             // Pass 1 max alerts to actually grade
const PASS2_NEW_SCAN_LIMIT = 800;        // Pass 2 fetch for create
const PASS2_NEW_WORK_LIMIT = 150;        // Pass 2 max new tracks
const MAX_TRACKS_PER_RUN = 150;          // Pass 2 update cap (LRU on last_tracked_at)
const PASS2_CONTRACT_NEW_WORK_LIMIT = 150; // Pass 2 max new contract tracks per sweep
const PRICE_LOOKUP_SLOP_MS = 30 * 60_000; // ±30 min slop for nearest-bar
// All timeframes that exist in ct_price_bars today. Single query asks for
// any of them; we pick the closest match by ts. Faster than 3 sequential
// queries per lookup.
const ACTIVE_TIMEFRAMES = ['1m', '5m'] as const;
const GRADING_METHOD = 'underlying_v1';
const HORIZONS: HorizonName[] = ['30m', '2h', 'eod', 'plus1d'];

type HorizonName = '30m' | '2h' | 'eod' | 'plus1d';
type Direction = 'up' | 'down';
type Grade = 'WIN' | 'LOSS' | 'FLAT';
type TrackStatus = 'WORKING' | 'REALIZED' | 'FAILING' | 'FLAT' | 'EXPIRED';
type DteBucket = '0dte' | 'short' | 'mid' | 'long';

interface FlowAlertRow {
  alert_id: string;
  ticker: string;
  side: string | null;
  is_ask: boolean | null;
  is_bid: boolean | null;
  strike: number | null;
  expiry: string | null;
  executed_at: string | null;
  ingested_at: string;
  // Optional — present in Pass 2 contract-track creation queries only.
  option_symbol?: string | null;
  price?: number | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw: any;
}

// ---------------------------------------------------------------------------
// OCC-symbol synthesis. ct_flow_alerts.option_symbol is null on every row
// (UW shape change), so we build it from ticker + expiry + side + strike.
// Format: {TICKER}{YYMMDD}{C|P}{strike*1000 zero-padded to 8 chars}.
// No "O:" prefix — UW REST endpoints accept the bare OCC string.
// Returns null if any required field is missing or the strike/expiry
// are unusable (the caller skips the row in that case).
// ---------------------------------------------------------------------------
function buildOccSymbol(
  ticker: string | null | undefined,
  expiry: string | null | undefined, // 'YYYY-MM-DD'
  side: string | null | undefined,   // 'call' | 'put'
  strike: number | null | undefined,
): string | null {
  if (!ticker || !expiry || strike == null || !Number.isFinite(strike) || strike <= 0) return null;
  const sideStr = (side ?? '').toLowerCase();
  if (sideStr !== 'call' && sideStr !== 'put') return null;
  const sideChar = sideStr === 'put' ? 'P' : 'C';
  const m = expiry.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const yymmdd = `${m[1].slice(2)}${m[2]}${m[3]}`;
  const strikeInt = Math.round(strike * 1000);
  if (!Number.isFinite(strikeInt) || strikeInt < 0) return null;
  const strikeStr = String(strikeInt).padStart(8, '0');
  return `${ticker.toUpperCase()}${yymmdd}${sideChar}${strikeStr}`;
}

interface DirectionInference {
  direction: Direction;
  source: string;
}

interface SnapshotThresholds {
  '30m': number;
  '2h': number;
  eod: number;
  plus1d: number;
}

interface DteThresholds {
  '0dte': number;
  short: number;   // 1-7 DTE
  mid: number;     // 8-30 DTE
  long: number;    // 30+ DTE
}

interface TrackingConfig {
  maxDays: number;
}

// ---------------------------------------------------------------------------
// Direction inference — return null if undeterminable (mid-print or unknown side).
// ---------------------------------------------------------------------------
function inferDirection(row: FlowAlertRow): DirectionInference | null {
  const side = (row.side ?? '').toLowerCase();
  if (side !== 'call' && side !== 'put') return null;

  const raw = row.raw ?? {};
  const askPremRaw = raw['total_ask_side_prem'];
  const bidPremRaw = raw['total_bid_side_prem'];
  const askPrem = askPremRaw == null ? null : Number(askPremRaw);
  const bidPrem = bidPremRaw == null ? null : Number(bidPremRaw);
  const askPremValid = askPrem !== null && Number.isFinite(askPrem);
  const bidPremValid = bidPrem !== null && Number.isFinite(bidPrem);

  // Mid-print check: both sides effectively zero — no directional signal.
  if (askPremValid && bidPremValid && askPrem < 1 && bidPrem < 1) {
    return null;
  }

  // Determine ask-vs-bid pressure.
  let aggressiveAsk = false;
  let aggressiveBid = false;
  let sourceTag: 'ask' | 'bid' | null = null;

  if (row.is_ask === true) {
    aggressiveAsk = true;
    sourceTag = 'ask';
  } else if (row.is_bid === true) {
    aggressiveBid = true;
    sourceTag = 'bid';
  } else if (askPremValid && bidPremValid) {
    if (askPrem > bidPrem) {
      aggressiveAsk = true;
      sourceTag = 'ask';
    } else if (bidPrem > askPrem) {
      aggressiveBid = true;
      sourceTag = 'bid';
    } else {
      return null; // tied, no edge
    }
  } else if (askPremValid && askPrem > 0 && (!bidPremValid || bidPrem === 0)) {
    aggressiveAsk = true;
    sourceTag = 'ask';
  } else if (bidPremValid && bidPrem > 0 && (!askPremValid || askPrem === 0)) {
    aggressiveBid = true;
    sourceTag = 'bid';
  } else {
    return null;
  }

  // Map side + ask/bid → direction.
  let direction: Direction;
  if (aggressiveAsk) {
    direction = side === 'call' ? 'up' : 'down';
  } else if (aggressiveBid) {
    // call selling = bearish; put selling = bullish
    direction = side === 'call' ? 'down' : 'up';
  } else {
    return null;
  }

  const source = `aggressive_${sourceTag}_${side}`;
  return { direction, source };
}

// ---------------------------------------------------------------------------
// Horizon-time computation.
// 'eod' = same trading-day 20:00 UTC (~4PM ET, ignoring DST nuance — close
// enough for grading; we always grade at-or-after, so 1m bar will exist
// during RTH and we fall back forward if not).
// 'plus1d' = next calendar day 20:00 UTC (weekend prints will simply wait
// for Monday's close bar).
// ---------------------------------------------------------------------------
function computeHorizonTime(printTime: Date, horizon: HorizonName): Date {
  switch (horizon) {
    case '30m':
      return new Date(printTime.getTime() + 30 * 60_000);
    case '2h':
      return new Date(printTime.getTime() + 2 * 3600_000);
    case 'eod': {
      const eod = new Date(Date.UTC(
        printTime.getUTCFullYear(),
        printTime.getUTCMonth(),
        printTime.getUTCDate(),
        20, 0, 0, 0,
      ));
      // If print itself is after 20:00 UTC, push to next day's close.
      if (eod.getTime() <= printTime.getTime()) {
        eod.setUTCDate(eod.getUTCDate() + 1);
      }
      return eod;
    }
    case 'plus1d': {
      const next = new Date(Date.UTC(
        printTime.getUTCFullYear(),
        printTime.getUTCMonth(),
        printTime.getUTCDate() + 1,
        20, 0, 0, 0,
      ));
      // If print is after 20:00 UTC same day, +1d should still give next day close.
      if (next.getTime() <= printTime.getTime() + 24 * 3600_000) {
        // ensure at least 24h ahead
        next.setUTCDate(next.getUTCDate() + 1);
      }
      return next;
    }
  }
}

// ---------------------------------------------------------------------------
// Nearest-close lookups.
// "before" = nearest bar at-or-before target (price at print).
// "after"  = nearest bar at-or-after target (price at horizon).
// "any"    = nearest bar in either direction (used for live tracking where
//            "now" may be after-hours and the most recent close is what we
//            have — Pass 2).
// Tries 1m → 5m → 15m → 1h fallbacks.
// ---------------------------------------------------------------------------
// Single-query nearest-close lookups. Asks for any active timeframe in the
// window, then picks the bar closest to target. One roundtrip per lookup.
async function nearestCloseAtOrBefore(
  supabase: SupabaseClient,
  ticker: string,
  ts: Date,
): Promise<number | null> {
  const target = ts.getTime();
  const lo = new Date(target - PRICE_LOOKUP_SLOP_MS).toISOString();
  const hi = new Date(target).toISOString();
  const { data, error } = await supabase
    .from('ct_price_bars')
    .select('close, ts')
    .eq('ticker', ticker)
    .in('timeframe', ACTIVE_TIMEFRAMES as unknown as string[])
    .gte('ts', lo)
    .lte('ts', hi)
    .order('ts', { ascending: false })
    .limit(1);
  if (error || !data || data.length === 0) return null;
  const px = Number(data[0].close);
  return Number.isFinite(px) && px > 0 ? px : null;
}

async function nearestCloseAtOrAfter(
  supabase: SupabaseClient,
  ticker: string,
  ts: Date,
): Promise<number | null> {
  const target = ts.getTime();
  const lo = new Date(target).toISOString();
  const hi = new Date(target + PRICE_LOOKUP_SLOP_MS).toISOString();
  const { data, error } = await supabase
    .from('ct_price_bars')
    .select('close, ts')
    .eq('ticker', ticker)
    .in('timeframe', ACTIVE_TIMEFRAMES as unknown as string[])
    .gte('ts', lo)
    .lte('ts', hi)
    .order('ts', { ascending: true })
    .limit(1);
  if (error || !data || data.length === 0) return null;
  const px = Number(data[0].close);
  return Number.isFinite(px) && px > 0 ? px : null;
}

// Latest available close per ticker — Pass 2 calls this once per ticker
// per sweep (cached). Up to 1 day stale.
async function latestClose(
  supabase: SupabaseClient,
  ticker: string,
): Promise<{ close: number; ts: string } | null> {
  const cutoff = new Date(Date.now() - 24 * 3600_000).toISOString();
  const { data, error } = await supabase
    .from('ct_price_bars')
    .select('close, ts')
    .eq('ticker', ticker)
    .in('timeframe', ACTIVE_TIMEFRAMES as unknown as string[])
    .gte('ts', cutoff)
    .order('ts', { ascending: false })
    .limit(1);
  if (error || !data || data.length === 0) return null;
  const px = Number(data[0].close);
  if (!Number.isFinite(px) || px <= 0) return null;
  return { close: px, ts: data[0].ts as string };
}

// ---------------------------------------------------------------------------
// ct_config thresholds — read once per invocation.
// ---------------------------------------------------------------------------
async function loadSnapshotThresholds(supabase: SupabaseClient): Promise<SnapshotThresholds> {
  const defaults: SnapshotThresholds = {
    '30m': 0.001,
    '2h': 0.003,
    eod: 0.005,
    plus1d: 0.008,
  };
  const keys = [
    'print_grade_threshold_30m',
    'print_grade_threshold_2h',
    'print_grade_threshold_eod',
    'print_grade_threshold_plus1d',
    // Spec-aligned aliases — fall back to these if the originals are missing.
    'grade_threshold_snapshot_30m',
    'grade_threshold_snapshot_2h',
    'grade_threshold_snapshot_eod',
  ];
  const { data, error } = await supabase
    .from('ct_config')
    .select('key, value')
    .in('key', keys);
  if (error || !data) return defaults;
  const out: SnapshotThresholds = { ...defaults };
  for (const row of data) {
    const v = row.value;
    const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
    if (!Number.isFinite(n) || n < 0) continue;
    if (row.key === 'print_grade_threshold_30m' || row.key === 'grade_threshold_snapshot_30m') out['30m'] = n;
    else if (row.key === 'print_grade_threshold_2h' || row.key === 'grade_threshold_snapshot_2h') out['2h'] = n;
    else if (row.key === 'print_grade_threshold_eod' || row.key === 'grade_threshold_snapshot_eod') out.eod = n;
    else if (row.key === 'print_grade_threshold_plus1d') out.plus1d = n;
  }
  return out;
}

async function loadDteThresholds(supabase: SupabaseClient): Promise<DteThresholds> {
  const defaults: DteThresholds = {
    '0dte': 0.003,
    short: 0.005,
    mid: 0.010,
    long: 0.020,
  };
  const keys = [
    'grade_threshold_0dte',
    'grade_threshold_short',
    'grade_threshold_mid',
    'grade_threshold_long',
  ];
  const { data, error } = await supabase
    .from('ct_config')
    .select('key, value')
    .in('key', keys);
  if (error || !data) return defaults;
  const out: DteThresholds = { ...defaults };
  for (const row of data) {
    const v = row.value;
    const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
    if (!Number.isFinite(n) || n < 0) continue;
    if (row.key === 'grade_threshold_0dte') out['0dte'] = n;
    else if (row.key === 'grade_threshold_short') out.short = n;
    else if (row.key === 'grade_threshold_mid') out.mid = n;
    else if (row.key === 'grade_threshold_long') out.long = n;
  }
  return out;
}

async function loadTrackingConfig(supabase: SupabaseClient): Promise<TrackingConfig> {
  const defaults: TrackingConfig = { maxDays: 30 };
  const { data, error } = await supabase
    .from('ct_config')
    .select('value')
    .eq('key', 'grade_tracking_max_days')
    .maybeSingle();
  if (error || !data) return defaults;
  const v = data.value;
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
  if (!Number.isFinite(n) || n < 1) return defaults;
  return { maxDays: Math.floor(n) };
}

function dteBucket(dte: number | null): DteBucket {
  if (dte === null || !Number.isFinite(dte)) return 'long';
  if (dte <= 0) return '0dte';
  if (dte <= 7) return 'short';
  if (dte <= 30) return 'mid';
  return 'long';
}

function thresholdForDte(dte: number | null, t: DteThresholds): number {
  switch (dteBucket(dte)) {
    case '0dte': return t['0dte'];
    case 'short': return t.short;
    case 'mid': return t.mid;
    case 'long': return t.long;
  }
}

// ---------------------------------------------------------------------------
// Print-time resolution. ct_flow_alerts.executed_at is NULL on most rows —
// fall back to raw.created_at, raw.start_time (epoch ms), then ingested_at.
// ---------------------------------------------------------------------------
function resolvePrintTime(a: FlowAlertRow): Date | null {
  if (a.executed_at) {
    const d = new Date(a.executed_at);
    if (!Number.isNaN(d.getTime())) return d;
  }
  const raw = a.raw ?? {};
  if (typeof raw.created_at === 'string') {
    const d = new Date(raw.created_at);
    if (!Number.isNaN(d.getTime())) return d;
  }
  if (raw.start_time != null) {
    const ms = Number(raw.start_time);
    if (Number.isFinite(ms) && ms > 0) {
      const d = new Date(ms);
      if (!Number.isNaN(d.getTime())) return d;
    }
  }
  if (a.ingested_at) {
    const d = new Date(a.ingested_at);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Already-graded lookup for a batch of alert ids.
// Returns a Set of "alert_id|horizon" keys that already have a grade row.
// ---------------------------------------------------------------------------
async function fetchExistingGradeKeys(
  supabase: SupabaseClient,
  alertIds: string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  if (alertIds.length === 0) return out;

  const chunkSize = 200;
  for (let i = 0; i < alertIds.length; i += chunkSize) {
    const slice = alertIds.slice(i, i + chunkSize);
    const { data, error } = await supabase
      .from('ct_print_grades')
      .select('alert_id, horizon')
      .in('alert_id', slice)
      .eq('grading_method', GRADING_METHOD);
    if (error) {
      console.warn(`[ct-print-grader] existing grade lookup: ${error.message}`);
      continue;
    }
    for (const row of (data ?? [])) {
      out.add(`${row.alert_id}|${row.horizon}`);
    }
  }
  return out;
}

async function fetchExistingTrackIds(
  supabase: SupabaseClient,
  alertIds: string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  if (alertIds.length === 0) return out;
  const chunkSize = 200;
  for (let i = 0; i < alertIds.length; i += chunkSize) {
    const slice = alertIds.slice(i, i + chunkSize);
    const { data, error } = await supabase
      .from('ct_print_tracks')
      .select('alert_id')
      .in('alert_id', slice);
    if (error) {
      console.warn(`[ct-print-grader] existing track lookup: ${error.message}`);
      continue;
    }
    for (const row of (data ?? [])) {
      if (row.alert_id) out.add(row.alert_id as string);
    }
  }
  return out;
}

// Sibling of fetchExistingTrackIds for ct_contract_tracks. Same chunked
// pattern (PostgREST `in.()` clause limit safety).
async function fetchExistingContractTrackIds(
  supabase: SupabaseClient,
  alertIds: string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  if (alertIds.length === 0) return out;
  const chunkSize = 200;
  for (let i = 0; i < alertIds.length; i += chunkSize) {
    const slice = alertIds.slice(i, i + chunkSize);
    const { data, error } = await supabase
      .from('ct_contract_tracks')
      .select('alert_id')
      .in('alert_id', slice);
    if (error) {
      console.warn(`[ct-print-grader] existing contract track lookup: ${error.message}`);
      continue;
    }
    for (const row of (data ?? [])) {
      if (row.alert_id) out.add(row.alert_id as string);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Grade computation.
// ---------------------------------------------------------------------------
function classify(direction: Direction, actualMovePct: number, threshold: number): Grade {
  const magnitude = Math.abs(actualMovePct);
  if (magnitude < threshold) return 'FLAT';
  const movedUp = actualMovePct > 0;
  const predictedUp = direction === 'up';
  return movedUp === predictedUp ? 'WIN' : 'LOSS';
}

// ---------------------------------------------------------------------------
// Pass 1 — Snapshot grading.
// ---------------------------------------------------------------------------
interface Pass1Stats {
  scanned: number;
  graded: number;
  skipped_no_direction: number;
  skipped_no_print_time: number;
  skipped_no_price: number;
  skipped_horizon_future: number;
  skipped_already_graded: number;
  errors: string[];
}

async function runSnapshotPass(
  supabase: SupabaseClient,
  thresholds: SnapshotThresholds,
): Promise<Pass1Stats> {
  const stats: Pass1Stats = {
    scanned: 0,
    graded: 0,
    skipped_no_direction: 0,
    skipped_no_print_time: 0,
    skipped_no_price: 0,
    skipped_horizon_future: 0,
    skipped_already_graded: 0,
    errors: [],
  };

  const now = new Date();
  const cutoff = new Date(now.getTime() - 30 * 60_000).toISOString();

  const { data: alerts, error } = await supabase
    .from('ct_flow_alerts')
    .select('alert_id, ticker, side, is_ask, is_bid, strike, expiry, executed_at, ingested_at, raw')
    .or(`executed_at.lte.${cutoff},and(executed_at.is.null,ingested_at.lte.${cutoff})`)
    .order('ingested_at', { ascending: true })
    .limit(PASS1_SCAN_LIMIT);

  if (error) {
    stats.errors.push(`pass1 fetch: ${error.message}`);
    return stats;
  }
  if (!alerts || alerts.length === 0) return stats;
  stats.scanned = alerts.length;

  const alertIds = alerts.map((a) => a.alert_id).filter((x): x is string => !!x);
  const existing = await fetchExistingGradeKeys(supabase, alertIds);

  // Filter to alerts that have at least one ungraded horizon — these are the
  // ones worth touching with a price lookup. Cap at PASS1_WORK_LIMIT so the
  // sweep stays under the 150s wall.
  const workable = (alerts as FlowAlertRow[]).filter((a) => {
    if (!a.alert_id) return false;
    let ungradedCount = 0;
    for (const h of HORIZONS) {
      if (!existing.has(`${a.alert_id}|${h}`)) ungradedCount += 1;
    }
    return ungradedCount > 0;
  }).slice(0, PASS1_WORK_LIMIT);

  const toInsert: Record<string, unknown>[] = [];

  for (const a of workable as FlowAlertRow[]) {
    try {
      if (!a.alert_id) continue;
      const printTime = resolvePrintTime(a);
      if (!printTime) {
        stats.skipped_no_print_time += HORIZONS.length;
        continue;
      }

      const dir = inferDirection(a);
      if (!dir) {
        stats.skipped_no_direction += HORIZONS.length;
        continue;
      }

      let entryPx: number | null = null;
      let entryPxLoaded = false;

      for (const horizon of HORIZONS) {
        const key = `${a.alert_id}|${horizon}`;
        if (existing.has(key)) {
          stats.skipped_already_graded += 1;
          continue;
        }

        const horizonTime = computeHorizonTime(printTime, horizon);
        if (horizonTime.getTime() > now.getTime()) {
          stats.skipped_horizon_future += 1;
          continue;
        }

        if (!entryPxLoaded) {
          entryPx = await nearestCloseAtOrBefore(supabase, a.ticker, printTime);
          entryPxLoaded = true;
        }
        if (entryPx === null) {
          stats.skipped_no_price += 1;
          continue;
        }

        const exitPx = await nearestCloseAtOrAfter(supabase, a.ticker, horizonTime);
        if (exitPx === null) {
          stats.skipped_no_price += 1;
          continue;
        }

        const move = (exitPx - entryPx) / entryPx;
        const threshold =
          horizon === '30m' ? thresholds['30m'] :
          horizon === '2h' ? thresholds['2h'] :
          horizon === 'eod' ? thresholds.eod :
          thresholds.plus1d;
        const grade = classify(dir.direction, move, threshold);

        toInsert.push({
          alert_id: a.alert_id,
          ticker: a.ticker,
          horizon,
          print_time: printTime.toISOString(),
          horizon_time: horizonTime.toISOString(),
          predicted_direction: dir.direction,
          predicted_source: dir.source,
          underlying_at_print: Number(entryPx.toFixed(4)),
          underlying_at_horizon: Number(exitPx.toFixed(4)),
          actual_move_pct: Number(move.toFixed(6)),
          grade,
          magnitude_pct: Number(Math.abs(move).toFixed(6)),
          threshold_used: threshold,
          grading_method: GRADING_METHOD,
        });
      }
    } catch (e) {
      stats.errors.push(`p1 ${a.alert_id}: ${e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200)}`);
    }
  }

  // Bulk insert in chunks. Use upsert with ignoreDuplicates so concurrent
  // sweeps don't deadlock on (alert_id, horizon, grading_method) collisions.
  const chunkSize = 100;
  for (let i = 0; i < toInsert.length; i += chunkSize) {
    const slice = toInsert.slice(i, i + chunkSize);
    const { error: insErr, count } = await supabase
      .from('ct_print_grades')
      .upsert(slice, {
        onConflict: 'alert_id,horizon,grading_method',
        ignoreDuplicates: true,
        count: 'exact',
      });
    if (insErr) {
      stats.errors.push(`p1 bulk-insert: ${insErr.message.slice(0, 200)}`);
      continue;
    }
    stats.graded += count ?? 0;
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Pass 2 — Lifetime tracking.
//
// Two sub-jobs:
//   2a. Create ct_print_tracks rows for ct_flow_alerts that don't have one yet.
//   2b. Update existing WORKING tracks: pull latest underlying, recompute
//       current_move_pct + peak_favorable_pct + peak_adverse_pct, advance
//       track_status, set first_cross_threshold_at if crossed for the first
//       time.
//   2c. Mark tracks where tracking_until <= now as EXPIRED.
// ---------------------------------------------------------------------------
interface Pass2Stats {
  tracks_created: number;
  tracks_updated: number;
  tracks_expired: number;
  skipped_no_direction: number;
  skipped_no_print_time: number;
  skipped_no_price: number;
  // Contract-axis tracking (mirror of ct_print_tracks but on contract price).
  contract_tracks_created: number;
  skipped_no_symbol: number;              // option_symbol missing AND synthesis failed
  skipped_no_strike_or_expiry: number;    // synthesis input incomplete
  errors: string[];
}

async function createMissingTracks(
  supabase: SupabaseClient,
  trackingCfg: TrackingConfig,
  stats: Pass2Stats,
): Promise<void> {
  // Pull a batch of recent alerts. We DO NOT require the snapshot cutoff
  // here — even brand-new prints get tracked from the start. Scan widely,
  // then work on at most PASS2_NEW_WORK_LIMIT genuinely-new alerts.
  const { data: alerts, error } = await supabase
    .from('ct_flow_alerts')
    .select('alert_id, ticker, side, is_ask, is_bid, strike, expiry, executed_at, ingested_at, raw')
    .order('ingested_at', { ascending: true })
    .limit(PASS2_NEW_SCAN_LIMIT);

  if (error) {
    stats.errors.push(`p2 create-fetch: ${error.message}`);
    return;
  }
  if (!alerts || alerts.length === 0) return;

  const alertIds = alerts.map((a) => a.alert_id).filter((x): x is string => !!x);
  const existing = await fetchExistingTrackIds(supabase, alertIds);

  // Filter to alerts that don't already have a track and cap to work limit.
  const workable = (alerts as FlowAlertRow[])
    .filter((a) => !!a.alert_id && !existing.has(a.alert_id))
    .slice(0, PASS2_NEW_WORK_LIMIT);

  const toCreate: Record<string, unknown>[] = [];
  const maxMs = trackingCfg.maxDays * 24 * 3600_000;

  for (const a of workable as FlowAlertRow[]) {
    try {
      if (!a.alert_id) continue;
      const side = (a.side ?? '').toLowerCase();
      if (side !== 'call' && side !== 'put') continue;

      const printTime = resolvePrintTime(a);
      if (!printTime) {
        stats.skipped_no_print_time += 1;
        continue;
      }

      const dir = inferDirection(a);
      if (!dir) {
        stats.skipped_no_direction += 1;
        continue;
      }

      // tracking_until = LEAST(expiry-end-of-day, print_time + maxDays)
      let trackingUntilMs = printTime.getTime() + maxMs;
      if (a.expiry) {
        // Expiry is a date; treat as 21:00 UTC (~5PM ET) end-of-day expiry.
        const expDate = new Date(a.expiry + 'T21:00:00Z');
        if (!Number.isNaN(expDate.getTime())) {
          trackingUntilMs = Math.min(trackingUntilMs, expDate.getTime());
        }
      }
      // Don't track in the past — ensure at least 1h forward.
      if (trackingUntilMs < printTime.getTime() + 3600_000) {
        trackingUntilMs = printTime.getTime() + 3600_000;
      }
      const trackingUntil = new Date(trackingUntilMs);

      const dteAtPrint = a.expiry
        ? Math.max(0, Math.floor((new Date(a.expiry + 'T21:00:00Z').getTime() - printTime.getTime()) / (24 * 3600_000)))
        : null;

      // Underlying at print (best-effort; null on miss — fill on next sweep).
      const underlyingAtPrint = await nearestCloseAtOrBefore(supabase, a.ticker, printTime);

      toCreate.push({
        alert_id: a.alert_id,
        ticker: a.ticker,
        side,
        strike: a.strike ?? null,
        expiry: a.expiry ?? null,
        dte_at_print: dteAtPrint,
        print_time: printTime.toISOString(),
        predicted_direction: dir.direction,
        predicted_source: dir.source,
        underlying_at_print: underlyingAtPrint === null ? null : Number(underlyingAtPrint.toFixed(4)),
        current_underlying: underlyingAtPrint === null ? null : Number(underlyingAtPrint.toFixed(4)),
        current_move_pct: 0,
        peak_favorable_pct: 0,
        peak_adverse_pct: 0,
        track_status: 'WORKING',
        tracking_until: trackingUntil.toISOString(),
        sweep_count: 0,
        grading_method: GRADING_METHOD,
      });
    } catch (e) {
      stats.errors.push(`p2 create ${a.alert_id}: ${e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200)}`);
    }
  }

  if (toCreate.length === 0) return;

  // Chunked insert ON CONFLICT DO NOTHING (race-safe).
  const chunkSize = 200;
  for (let i = 0; i < toCreate.length; i += chunkSize) {
    const slice = toCreate.slice(i, i + chunkSize);
    const { error: insErr, count } = await supabase
      .from('ct_print_tracks')
      .upsert(slice, { onConflict: 'alert_id', ignoreDuplicates: true, count: 'exact' });
    if (insErr) {
      stats.errors.push(`p2 create-insert: ${insErr.message.slice(0, 200)}`);
      continue;
    }
    stats.tracks_created += count ?? slice.length;
  }
}

// ---------------------------------------------------------------------------
// Pass 2 contract-axis: create ct_contract_tracks rows for ct_flow_alerts
// that don't have one yet.
//
// Mirrors createMissingTracks but on the contract-price axis. Three key
// differences:
//   1. option_symbol is NOT NULL on ct_contract_tracks. ct_flow_alerts.
//      option_symbol is NULL on every row today (UW shape change), so we
//      synthesize via buildOccSymbol. If synthesis fails (missing strike
//      or expiry), the row is skipped — partial-data prints just don't
//      get a contract track. No harm done.
//   2. entry_contract_price comes from ct_flow_alerts.price (per-share
//      premium at print). If null, we leave entry null and tag
//      entry_source='estimated_mid' so Phase B can backfill on first quote.
//   3. tracking_until extends 1 DAY past expiry (intentional — captures
//      the final settlement quote that posts after close on expiry day).
//      Underlying tracker stops AT expiry because the underlying keeps
//      trading regardless; the contract does not.
//
// NO POLLING happens here — Phase B (ct-contract-poller) handles updates.
// This function only seeds entries on creation.
// ---------------------------------------------------------------------------
async function createMissingContractTracks(
  supabase: SupabaseClient,
  trackingCfg: TrackingConfig,
  stats: Pass2Stats,
): Promise<void> {
  const { data: alerts, error } = await supabase
    .from('ct_flow_alerts')
    .select('alert_id, ticker, side, is_ask, is_bid, strike, expiry, executed_at, ingested_at, option_symbol, price, raw')
    .order('ingested_at', { ascending: true })
    .limit(PASS2_NEW_SCAN_LIMIT);

  if (error) {
    stats.errors.push(`p2 contract create-fetch: ${error.message}`);
    return;
  }
  if (!alerts || alerts.length === 0) return;

  const alertIds = alerts.map((a) => a.alert_id).filter((x): x is string => !!x);
  const existing = await fetchExistingContractTrackIds(supabase, alertIds);

  // Filter to alerts that don't already have a contract track and cap to
  // work limit. Same semantics as createMissingTracks but against
  // ct_contract_tracks.
  const workable = (alerts as FlowAlertRow[])
    .filter((a) => !!a.alert_id && !existing.has(a.alert_id))
    .slice(0, PASS2_CONTRACT_NEW_WORK_LIMIT);

  const toCreate: Record<string, unknown>[] = [];
  const maxMs = trackingCfg.maxDays * 24 * 3600_000;

  for (const a of workable as FlowAlertRow[]) {
    try {
      if (!a.alert_id) continue;
      const side = (a.side ?? '').toLowerCase();
      if (side !== 'call' && side !== 'put') continue;

      const printTime = resolvePrintTime(a);
      if (!printTime) {
        stats.skipped_no_print_time += 1;
        continue;
      }

      const dir = inferDirection(a);
      if (!dir) {
        stats.skipped_no_direction += 1;
        continue;
      }

      // Resolve OCC symbol — prefer the raw column, fall back to synthesis.
      // Today every row falls into synthesis; leaving the precedence in
      // place so this code keeps working if/when UW restores the field.
      let optionSymbol: string | null = a.option_symbol ?? null;
      if (!optionSymbol) {
        // Synthesis input check first so we can split the skip counters.
        if (a.strike == null || !a.expiry) {
          stats.skipped_no_strike_or_expiry += 1;
          continue;
        }
        optionSymbol = buildOccSymbol(a.ticker, a.expiry, side, a.strike);
        if (!optionSymbol) {
          stats.skipped_no_symbol += 1;
          continue;
        }
      }

      // tracking_until = LEAST(expiry+1d at 21:00 UTC, print_time + maxDays).
      // The +1d on expiry is intentional — see migration header. Captures
      // final settlement quote that posts after close on expiry day.
      let trackingUntilMs = printTime.getTime() + maxMs;
      if (a.expiry) {
        const expPlus1 = new Date(a.expiry + 'T21:00:00Z');
        if (!Number.isNaN(expPlus1.getTime())) {
          expPlus1.setUTCDate(expPlus1.getUTCDate() + 1);
          trackingUntilMs = Math.min(trackingUntilMs, expPlus1.getTime());
        }
      }
      // Don't track in the past — guarantee at least 1h forward.
      if (trackingUntilMs < printTime.getTime() + 3600_000) {
        trackingUntilMs = printTime.getTime() + 3600_000;
      }
      const trackingUntil = new Date(trackingUntilMs);

      const dteAtPrint = a.expiry
        ? Math.max(0, Math.floor((new Date(a.expiry + 'T21:00:00Z').getTime() - printTime.getTime()) / (24 * 3600_000)))
        : null;

      // Entry contract price from ct_flow_alerts.price. If null, leave
      // entry null + source='estimated_mid' so Phase B knows to backfill.
      const priceRaw = a.price;
      const entryPrice = priceRaw != null && Number.isFinite(Number(priceRaw)) && Number(priceRaw) > 0
        ? Number(priceRaw)
        : null;
      const entrySource = entryPrice !== null ? 'flow_alert_price' : 'estimated_mid';

      toCreate.push({
        alert_id: a.alert_id,
        option_symbol: optionSymbol,
        ticker: a.ticker,
        side,
        strike: a.strike ?? null,
        expiry: a.expiry ?? null,
        dte_at_print: dteAtPrint,
        print_time: printTime.toISOString(),
        predicted_direction: dir.direction,
        predicted_source: dir.source,
        entry_contract_price: entryPrice === null ? null : Number(entryPrice.toFixed(4)),
        entry_source: entrySource,
        current_contract_price: entryPrice === null ? null : Number(entryPrice.toFixed(4)),
        current_contract_pct: entryPrice === null ? null : 0,
        peak_contract_pct: 0,
        max_drawdown_pct: 0,
        track_status: 'WORKING',
        tracking_until: trackingUntil.toISOString(),
        sweep_count: 0,
        grading_method: 'contract_v1',
      });
    } catch (e) {
      stats.errors.push(`p2 contract create ${a.alert_id}: ${e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200)}`);
    }
  }

  if (toCreate.length === 0) return;

  const chunkSize = 200;
  for (let i = 0; i < toCreate.length; i += chunkSize) {
    const slice = toCreate.slice(i, i + chunkSize);
    const { error: insErr, count } = await supabase
      .from('ct_contract_tracks')
      .upsert(slice, { onConflict: 'alert_id', ignoreDuplicates: true, count: 'exact' });
    if (insErr) {
      stats.errors.push(`p2 contract create-insert: ${insErr.message.slice(0, 200)}`);
      continue;
    }
    stats.contract_tracks_created += count ?? slice.length;
  }
}

async function expireDueTracks(
  supabase: SupabaseClient,
  stats: Pass2Stats,
): Promise<void> {
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from('ct_print_tracks')
    .update({ track_status: 'EXPIRED', last_tracked_at: nowIso })
    .eq('track_status', 'WORKING')
    .lte('tracking_until', nowIso)
    .select('id');
  if (error) {
    stats.errors.push(`p2 expire: ${error.message.slice(0, 200)}`);
    return;
  }
  stats.tracks_expired += (data ?? []).length;
}

async function updateWorkingTracks(
  supabase: SupabaseClient,
  dteThresholds: DteThresholds,
  stats: Pass2Stats,
): Promise<void> {
  const nowIso = new Date().toISOString();
  const { data: tracks, error } = await supabase
    .from('ct_print_tracks')
    .select('id, alert_id, ticker, dte_at_print, predicted_direction, underlying_at_print, peak_favorable_pct, peak_adverse_pct, peak_favorable_at, peak_adverse_at, first_cross_threshold_at, sweep_count, tracking_until')
    .eq('track_status', 'WORKING')
    .gt('tracking_until', nowIso)
    .order('last_tracked_at', { ascending: true })
    .limit(MAX_TRACKS_PER_RUN);

  if (error) {
    stats.errors.push(`p2 update-fetch: ${error.message.slice(0, 200)}`);
    return;
  }
  if (!tracks || tracks.length === 0) return;

  // Cache latest close per ticker.
  const latestCache = new Map<string, { close: number; ts: string } | null>();
  async function getLatest(ticker: string): Promise<{ close: number; ts: string } | null> {
    if (latestCache.has(ticker)) return latestCache.get(ticker) ?? null;
    const v = await latestClose(supabase, ticker);
    latestCache.set(ticker, v);
    return v;
  }

  for (const t of tracks) {
    try {
      const ticker = t.ticker as string;
      const direction = t.predicted_direction as Direction;
      let entryPx: number | null = t.underlying_at_print === null || t.underlying_at_print === undefined
        ? null : Number(t.underlying_at_print);

      // Backfill entry price if it was null at create time.
      const printTimeIso = (t as unknown as { print_time?: string }).print_time;
      if ((entryPx === null || !Number.isFinite(entryPx) || entryPx <= 0) && printTimeIso) {
        entryPx = await nearestCloseAtOrBefore(supabase, ticker, new Date(printTimeIso));
      }
      if (entryPx === null || !Number.isFinite(entryPx) || entryPx <= 0) {
        // Still no entry price — bump sweep_count + last_tracked_at, keep WORKING.
        await supabase
          .from('ct_print_tracks')
          .update({
            sweep_count: (t.sweep_count ?? 0) + 1,
            last_tracked_at: nowIso,
          })
          .eq('id', t.id);
        stats.skipped_no_price += 1;
        continue;
      }

      const latest = await getLatest(ticker);
      if (!latest) {
        await supabase
          .from('ct_print_tracks')
          .update({
            sweep_count: (t.sweep_count ?? 0) + 1,
            last_tracked_at: nowIso,
          })
          .eq('id', t.id);
        stats.skipped_no_price += 1;
        continue;
      }

      const currentMove = (latest.close - entryPx) / entryPx;
      const signedFavorable = direction === 'up' ? currentMove : -currentMove;
      const favorableMag = Math.max(0, signedFavorable);
      const adverseMag = Math.max(0, -signedFavorable);

      const prevFav = Number(t.peak_favorable_pct ?? 0);
      const prevAdv = Number(t.peak_adverse_pct ?? 0);
      const prevFirstCross = t.first_cross_threshold_at ?? null;

      const newFav = favorableMag > prevFav ? favorableMag : prevFav;
      const newAdv = adverseMag > prevAdv ? adverseMag : prevAdv;

      const dteThreshold = thresholdForDte(t.dte_at_print as number | null, dteThresholds);
      let firstCrossAt = prevFirstCross;
      if (!prevFirstCross && newFav >= dteThreshold) {
        firstCrossAt = nowIso;
      }

      // Status state machine — order matters.
      let status: TrackStatus = 'WORKING';
      if (newFav >= dteThreshold) {
        status = 'REALIZED';
      } else if (newAdv >= 2 * dteThreshold && newFav < dteThreshold) {
        status = 'FAILING';
      } else {
        status = 'FLAT';
      }
      // Only flip out of WORKING if we actually have a meaningful read.
      // If both peaks are still 0 (just-created), keep WORKING.
      if (newFav === 0 && newAdv === 0) {
        status = 'WORKING';
      }

      const update: Record<string, unknown> = {
        current_underlying: Number(latest.close.toFixed(4)),
        current_move_pct: Number(currentMove.toFixed(6)),
        peak_favorable_pct: Number(newFav.toFixed(6)),
        peak_adverse_pct: Number(newAdv.toFixed(6)),
        sweep_count: (t.sweep_count ?? 0) + 1,
        last_tracked_at: nowIso,
        track_status: status,
      };
      // Only set entry price if we just resolved it (back-fill case).
      if (t.underlying_at_print === null || t.underlying_at_print === undefined) {
        update.underlying_at_print = Number(entryPx.toFixed(4));
      }
      if (newFav > prevFav) {
        update.peak_favorable_at = nowIso;
      }
      if (newAdv > prevAdv) {
        update.peak_adverse_at = nowIso;
      }
      if (firstCrossAt && firstCrossAt !== prevFirstCross) {
        update.first_cross_threshold_at = firstCrossAt;
      }

      const { error: updErr } = await supabase
        .from('ct_print_tracks')
        .update(update)
        .eq('id', t.id);
      if (updErr) {
        stats.errors.push(`p2 update ${t.alert_id}: ${updErr.message.slice(0, 200)}`);
        continue;
      }
      stats.tracks_updated += 1;
    } catch (e) {
      stats.errors.push(`p2 update ${t.alert_id}: ${e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200)}`);
    }
  }
}

async function runTrackPass(
  supabase: SupabaseClient,
  dteThresholds: DteThresholds,
  trackingCfg: TrackingConfig,
): Promise<Pass2Stats> {
  const stats: Pass2Stats = {
    tracks_created: 0,
    tracks_updated: 0,
    tracks_expired: 0,
    skipped_no_direction: 0,
    skipped_no_print_time: 0,
    skipped_no_price: 0,
    contract_tracks_created: 0,
    skipped_no_symbol: 0,
    skipped_no_strike_or_expiry: 0,
    errors: [],
  };

  // Order: create first (so brand-new prints get a sweep this run), then
  // update working set, then expire matured tracks. Expiring last lets a
  // track that just hit tracking_until still record one final peak.
  // Contract-track creation runs alongside underlying-track creation —
  // both are insert-only and operate on disjoint tables.
  await createMissingTracks(supabase, trackingCfg, stats);
  await createMissingContractTracks(supabase, trackingCfg, stats);
  await updateWorkingTracks(supabase, dteThresholds, stats);
  await expireDueTracks(supabase, stats);

  return stats;
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

  const startedAt = Date.now();

  // Load all thresholds up-front (one set of small reads).
  const [snapshotThresholds, dteThresholds, trackingCfg] = await Promise.all([
    loadSnapshotThresholds(supabase),
    loadDteThresholds(supabase),
    loadTrackingConfig(supabase),
  ]);

  // Run both passes. Errors in one don't kill the other.
  const pass1 = await runSnapshotPass(supabase, snapshotThresholds);
  const pass2 = await runTrackPass(supabase, dteThresholds, trackingCfg);

  const elapsedMs = Date.now() - startedAt;

  return new Response(JSON.stringify({
    ok: true,
    elapsed_ms: elapsedMs,
    grading_method: GRADING_METHOD,
    snapshots_graded: pass1.graded,
    tracks_created: pass2.tracks_created,
    tracks_updated: pass2.tracks_updated,
    tracks_expired: pass2.tracks_expired,
    pass1: {
      scanned: pass1.scanned,
      graded: pass1.graded,
      skipped: {
        no_direction: pass1.skipped_no_direction,
        no_print_time: pass1.skipped_no_print_time,
        no_price: pass1.skipped_no_price,
        horizon_future: pass1.skipped_horizon_future,
        already_graded: pass1.skipped_already_graded,
      },
    },
    pass2: {
      tracks_created: pass2.tracks_created,
      tracks_updated: pass2.tracks_updated,
      tracks_expired: pass2.tracks_expired,
      contract_tracks_created: pass2.contract_tracks_created,
      skipped: {
        no_direction: pass2.skipped_no_direction,
        no_print_time: pass2.skipped_no_print_time,
        no_price: pass2.skipped_no_price,
        no_symbol: pass2.skipped_no_symbol,
        no_strike_or_expiry: pass2.skipped_no_strike_or_expiry,
      },
    },
    thresholds: {
      snapshot: snapshotThresholds,
      dte: dteThresholds,
      tracking_max_days: trackingCfg.maxDays,
    },
    errors: [...pass1.errors, ...pass2.errors].slice(0, 20),
  }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
