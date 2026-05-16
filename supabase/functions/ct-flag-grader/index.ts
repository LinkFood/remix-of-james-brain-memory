/**
 * ct-flag-grader — unified flag grading for Co-Trader.
 *
 * Job A — grade expired flags (all sources)
 *   For each ct_flags row with status IN ('active','conviction') and
 *   horizon_ts <= now(), grade per source rules:
 *
 *     specialist        — underlying-axis. Use stored entry/target +
 *                         configured target_threshold_pct. Existing logic.
 *
 *     james_star        — underlying-axis with default 24h horizon. WIN if
 *                         underlying moves >= +1.5% in stated direction within
 *                         24h, LOSS if move >= -1% against direction, partial
 *                         otherwise. Neutral direction → no grade.
 *
 *     signature_alarm   — contract-axis. Use ct_contract_tracks.peak_contract_pct
 *                         within window. WIN if peak >= +50% (default), partial
 *                         if 0-50%, LOSS if drawdown beyond. Stored in `notes`
 *                         since price_change_pct is underlying-axis.
 *
 * Job B — T+1 OI confirmation upgrades active specialist flags to conviction
 *         when the option's OI delta confirms institutional sponsorship.
 *
 * Auth: service role only.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { recordDecision } from '../_shared/decisionJournal.ts';
import { isMarketOpen } from '../_shared/marketClock.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type FlagStatus = 'active' | 'conviction' | 'graded' | 'invalidated';
type Direction = 'bullish' | 'bearish' | 'neutral';
type Outcome = 'win' | 'partial' | 'loss' | 'invalidated_early';
type FlagSource = 'specialist' | 'james_star' | 'signature_alarm' | 'detector_alarm';

interface FlagRow {
  id: string;
  source: FlagSource;
  specialist_ticker: string | null;
  instrument: string;
  option_symbol: string | null;
  strike: number | null;
  expiry: string | null;
  side: string | null;
  direction: Direction;
  score: number;
  tags: string[] | null;
  horizon_ts: string;
  entry_price: number | null;
  target_price: number | null;
  status: FlagStatus;
  confirmed_t1: boolean;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Defaults for non-specialist sources — pulled from ct_config when present.
// ---------------------------------------------------------------------------
type DteBucket = '0dte' | '1_3d' | '4_14d' | '15_45d' | '46d_plus';

interface AlarmBucketThresholds {
  winPct: number;       // peak% threshold for win
  lossPct: number;      // drawdown% threshold for loss
}

interface SourceDefaults {
  // james_star (underlying-axis)
  jamesWinPct: number;       // >= this in direction = win
  jamesLossPct: number;      // <= -this against direction = loss
  // signature_alarm + detector_alarm (contract-axis) — DTE-bucketed thresholds
  // calibrated 2026-05-02 against 1,395 grades / 4-day window.
  alarmBuckets: Record<DteBucket, AlarmBucketThresholds>;
}

const DEFAULT_ALARM_BUCKETS: Record<DteBucket, AlarmBucketThresholds> = {
  '0dte':     { winPct: 50, lossPct: 30 },
  '1_3d':     { winPct: 50, lossPct: 30 },
  '4_14d':    { winPct: 40, lossPct: 25 },
  '15_45d':   { winPct: 30, lossPct: 20 },
  '46d_plus': { winPct: 20, lossPct: 15 },
};

const DEFAULT_SOURCE_DEFAULTS: SourceDefaults = {
  jamesWinPct: 1.5,
  jamesLossPct: 1.0,
  alarmBuckets: DEFAULT_ALARM_BUCKETS,
};

/**
 * Map DTE-at-fire-time to a bucket label. DTE = days(expiry - flag.created_at).
 * Negative DTE (e.g., expiry already passed when flag fired — anomaly) clamps
 * to 0DTE.
 */
function bucketForDte(dte: number | null): DteBucket {
  if (dte == null || !Number.isFinite(dte) || dte <= 0) return '0dte';
  if (dte <= 3) return '1_3d';
  if (dte <= 14) return '4_14d';
  if (dte <= 45) return '15_45d';
  return '46d_plus';
}

function computeDteFromFlag(expiry: string | null, createdAt: string): number | null {
  if (!expiry) return null;
  try {
    const expDate = new Date(expiry.length > 10 ? expiry : `${expiry}T00:00:00Z`);
    const cre = new Date(createdAt);
    if (isNaN(expDate.getTime()) || isNaN(cre.getTime())) return null;
    return Math.round((expDate.getTime() - cre.getTime()) / 86_400_000);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Price lookup — nearest ct_price_bars close within ±30min slop.
// ---------------------------------------------------------------------------
async function nearestClose(
  supabase: SupabaseClient,
  ticker: string,
  ts: string,
  slopMs: number = 30 * 60 * 1000,
): Promise<number | null> {
  const target = new Date(ts);
  const lo = new Date(target.getTime() - slopMs).toISOString();
  const hi = new Date(target.getTime() + slopMs).toISOString();

  const timeframes = ['1m', '5m', '15m', '1h'] as const;
  for (const tf of timeframes) {
    const { data, error } = await supabase
      .from('ct_price_bars')
      .select('close, ts')
      .eq('ticker', ticker)
      .eq('timeframe', tf)
      .gte('ts', lo)
      .lte('ts', hi)
      .order('ts', { ascending: true })
      .limit(50);
    if (error) {
      console.warn(`[ct-flag-grader] price lookup ${ticker}/${tf}: ${error.message}`);
      continue;
    }
    if (!data || data.length === 0) continue;

    let best: { close: number; ts: string } | null = null;
    let bestDelta = Infinity;
    for (const row of data) {
      const rowTs = new Date(row.ts as string).getTime();
      const delta = Math.abs(rowTs - target.getTime());
      if (delta < bestDelta) {
        bestDelta = delta;
        best = { close: Number(row.close), ts: row.ts as string };
      }
    }
    if (best !== null && Number.isFinite(best.close)) return best.close;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Specialist outcome — uses configured target_threshold_pct.
// ---------------------------------------------------------------------------
function computeSpecialistOutcome(direction: Direction, changePct: number, targetPct: number): Outcome {
  if (direction === 'neutral') {
    if (Math.abs(changePct) <= targetPct) return 'win';
    return 'loss';
  }
  const dir = direction === 'bullish' ? 1 : -1;
  const signed = changePct * dir;
  if (signed >= targetPct) return 'win';
  if (signed > 0) return 'partial';
  return 'loss';
}

// ---------------------------------------------------------------------------
// James star outcome — directional thresholds.
// ---------------------------------------------------------------------------
function computeJamesOutcome(direction: Direction, changePct: number, defaults: SourceDefaults): Outcome {
  // Neutral stars can't be directionally graded — call partial so they at
  // least leave a row indicating the horizon passed.
  if (direction === 'neutral') return 'partial';
  const dir = direction === 'bullish' ? 1 : -1;
  const signed = changePct * dir;
  if (signed >= defaults.jamesWinPct) return 'win';
  if (signed <= -defaults.jamesLossPct) return 'loss';
  return 'partial';
}

// ---------------------------------------------------------------------------
// Signature-alarm + detector_alarm outcome — contract-axis from
// ct_contract_tracks, DTE-bucketed thresholds (calibrated 2026-05-02).
// ---------------------------------------------------------------------------
function computeAlarmOutcome(
  peakPct: number | null,
  drawdownPct: number | null,
  bucket: DteBucket,
  defaults: SourceDefaults,
): Outcome {
  // peakPct is fractional (0.5 = +50%) per ct_contract_tracks convention.
  const peak = peakPct == null ? 0 : peakPct * 100;
  const drawdown = drawdownPct == null ? 0 : drawdownPct * 100;
  const thresholds = defaults.alarmBuckets[bucket];
  if (peak >= thresholds.winPct) return 'win';
  if (drawdown >= thresholds.lossPct) return 'loss';
  if (peak > 0) return 'partial';
  return 'invalidated_early';
}

// ---------------------------------------------------------------------------
// Config loaders
// ---------------------------------------------------------------------------
async function getTargetThreshold(supabase: SupabaseClient): Promise<number> {
  const { data, error } = await supabase
    .from('ct_config')
    .select('value')
    .eq('key', 'grader.target_threshold_pct')
    .maybeSingle();
  if (error || !data) return 0.5;
  const v = data.value;
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 0.5;
}

async function getSourceDefaults(supabase: SupabaseClient): Promise<SourceDefaults> {
  // Deep-clone the alarm buckets so per-call mutations don't leak globally.
  const out: SourceDefaults = {
    jamesWinPct: DEFAULT_SOURCE_DEFAULTS.jamesWinPct,
    jamesLossPct: DEFAULT_SOURCE_DEFAULTS.jamesLossPct,
    alarmBuckets: {
      '0dte':     { ...DEFAULT_ALARM_BUCKETS['0dte'] },
      '1_3d':     { ...DEFAULT_ALARM_BUCKETS['1_3d'] },
      '4_14d':    { ...DEFAULT_ALARM_BUCKETS['4_14d'] },
      '15_45d':   { ...DEFAULT_ALARM_BUCKETS['15_45d'] },
      '46d_plus': { ...DEFAULT_ALARM_BUCKETS['46d_plus'] },
    },
  };
  const winKeys = ['0dte', '1_3d', '4_14d', '15_45d', '46d_plus'].map(b => `grader.alarm_win_pct.${b}`);
  const lossKeys = ['0dte', '1_3d', '4_14d', '15_45d', '46d_plus'].map(b => `grader.alarm_loss_pct.${b}`);
  const { data } = await supabase
    .from('ct_config')
    .select('key, value')
    .in('key', [
      'grader.james_win_pct',
      'grader.james_loss_pct',
      ...winKeys,
      ...lossKeys,
    ]);
  for (const row of data ?? []) {
    const v = row.value;
    const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
    if (!Number.isFinite(n) || n < 0) continue;
    if (row.key === 'grader.james_win_pct') out.jamesWinPct = n;
    else if (row.key === 'grader.james_loss_pct') out.jamesLossPct = n;
    else {
      const winMatch = /^grader\.alarm_win_pct\.(0dte|1_3d|4_14d|15_45d|46d_plus)$/.exec(row.key);
      const lossMatch = /^grader\.alarm_loss_pct\.(0dte|1_3d|4_14d|15_45d|46d_plus)$/.exec(row.key);
      if (winMatch) out.alarmBuckets[winMatch[1] as DteBucket].winPct = n;
      else if (lossMatch) out.alarmBuckets[lossMatch[1] as DteBucket].lossPct = n;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pattern + memory writes — specialist-only side effects.
// ---------------------------------------------------------------------------
async function updatePatternSafe(
  supabase: SupabaseClient,
  flagId: string,
  outcome: Outcome,
  alpha: number | null,
): Promise<void> {
  try {
    const { error } = await supabase.rpc('ct_update_flag_pattern', {
      p_flag_id: flagId,
      p_outcome: outcome,
      p_alpha: alpha,
    });
    if (error) console.warn(`[ct-flag-grader] pattern update ${flagId}: ${error.message}`);
  } catch (e) {
    console.warn(`[ct-flag-grader] pattern update threw: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---------------------------------------------------------------------------
// Contract-track lookup — closest track for option_symbol around print_time
// nearest to flag.created_at. Returns peak/drawdown fractions (0.5 = +50%).
// ---------------------------------------------------------------------------
async function loadContractTrack(
  supabase: SupabaseClient,
  optionSymbol: string,
  flagCreatedAt: string,
  flagHorizonTs: string,
): Promise<{ peak_contract_pct: number | null; max_drawdown_pct: number | null } | null> {
  // Use the MAX peak across all tracks for this option_symbol in the flag's
  // actionable window: 1h before created through horizon. Print-grader creates
  // a new track per print of the same contract, so an option_symbol typically
  // has 2-18 tracks. Taking MAX captures the contract's actual best move,
  // regardless of which track sample observed it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase.rpc as any)('ct_max_peak_for_flag', {
    p_option_symbol: optionSymbol,
    p_flag_created: flagCreatedAt,
    p_flag_horizon: flagHorizonTs,
  });
  if (error || !data || (Array.isArray(data) ? data.length === 0 : !data)) return null;
  const row = Array.isArray(data) ? data[0] : data;
  if (row == null || (row.track_count ?? 0) === 0) return null;
  return {
    peak_contract_pct: row.peak_contract_pct == null ? null : Number(row.peak_contract_pct),
    max_drawdown_pct: row.max_drawdown_pct == null ? null : Number(row.max_drawdown_pct),
  };
}

// ---------------------------------------------------------------------------
// Terminal ungradeable transition — moves a flag out of the candidate pool
// permanently when a STRUCTURAL skip path is hit (Ship 1 HOL class-kill).
// Skip-without-status-transition was the immortality mechanism: a flag the
// grader could never grade re-occupied the oldest-200 ASC slots forever and
// starved everything behind it. NOT used for the market_closed skip — that
// path is transient and self-heals on the next RTH run, so those flags
// correctly stay 'active'.
// ---------------------------------------------------------------------------
async function markUngradeable(
  supabase: SupabaseClient,
  flagId: string,
  reason: string,
): Promise<void> {
  const { error } = await supabase
    .from('ct_flags')
    .update({ status: 'ungradeable', ungradeable_reason: reason })
    .eq('id', flagId);
  if (error) {
    console.warn(`[ct-flag-grader] mark ungradeable ${flagId} (${reason}): ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Job A — grade expired flags across all sources.
// ---------------------------------------------------------------------------
async function gradeExpiredFlags(
  supabase: SupabaseClient,
  targetThresholdPct: number,
  sourceDefaults: SourceDefaults,
): Promise<{ graded: number; skipped: number; ungradeable: number; bySource: Record<string, number>; errors: string[] }> {
  const nowIso = new Date().toISOString();
  // ASC by horizon_ts: oldest expired flags get graded first so the backlog
  // actually drains. Without ORDER BY, postgres returns whatever the planner
  // chooses — typically the most recent rows — and pre-existing backlog from
  // days ago never gets touched.
  const { data: flags, error } = await supabase
    .from('ct_flags')
    .select('id, source, specialist_ticker, instrument, option_symbol, strike, expiry, side, direction, score, tags, horizon_ts, entry_price, target_price, status, confirmed_t1, created_at')
    .in('status', ['active', 'conviction'])
    .lte('horizon_ts', nowIso)
    .order('horizon_ts', { ascending: true })
    .limit(200);

  if (error) {
    return { graded: 0, skipped: 0, ungradeable: 0, bySource: {}, errors: [`fetch: ${error.message}`] };
  }
  if (!flags || flags.length === 0) {
    return { graded: 0, skipped: 0, ungradeable: 0, bySource: {}, errors: [] };
  }

  const errors: string[] = [];
  const bySource: Record<string, number> = {};
  let graded = 0;
  let skipped = 0;
  let ungradeable = 0;

  const nowDate = new Date();
  const nowOpen = isMarketOpen(nowDate);

  for (const row of flags as FlagRow[]) {
    try {
      const tickerForPrice = row.specialist_ticker ?? row.instrument;
      let outcome: Outcome;
      let entryPx: number | null = null;
      let exitPx: number | null = null;
      let priceChangePct: number | null = null;
      let alphaPct: number | null = null;
      let notes = '';

      // Contract-axis grading covers ANY flag whose `entry_price` represents an
      // option contract price rather than the underlying spot — i.e. anything
      // with an option_symbol fired off contract activity (signature_alarm,
      // detector_alarm). Underlying-axis (specialist, james_star) follows
      // below. Without this branch, detector_alarm flags were graded against
      // the underlying close — entry $11.25 (option) vs exit $426 (MSFT spot)
      // produced absurd "+3693% win" outcomes that polluted the pattern table.
      if (row.source === 'signature_alarm' || row.source === 'detector_alarm') {
        // Contract-axis grading: read peak / drawdown from ct_contract_tracks.
        // Note: NO trading-clock gate here — peak_contract_pct is already
        // computed from intraday option-quote polling and doesn't depend on
        // ct_price_bars freshness.
        if (!row.option_symbol) {
          await markUngradeable(supabase, row.id, 'no_option_symbol');
          ungradeable += 1;
          continue;
        }
        const track = await loadContractTrack(supabase, row.option_symbol, row.created_at, row.horizon_ts);
        if (!track) {
          await markUngradeable(supabase, row.id, 'no_contract_track');
          ungradeable += 1;
          console.warn(`[ct-flag-grader] ${row.source} ${row.id}: no contract track`);
          continue;
        }
        const dte = computeDteFromFlag(row.expiry, row.created_at);
        const bucket = bucketForDte(dte);
        const thresholds = sourceDefaults.alarmBuckets[bucket];
        outcome = computeAlarmOutcome(track.peak_contract_pct, track.max_drawdown_pct, bucket, sourceDefaults);
        const peakStr = track.peak_contract_pct == null ? 'n/a' : (track.peak_contract_pct * 100).toFixed(1) + '%';
        const ddStr = track.max_drawdown_pct == null ? 'n/a' : (track.max_drawdown_pct * 100).toFixed(1) + '%';
        const dteStr = dte == null ? 'n/a' : `${dte}d`;
        notes = `${row.source} contract-axis: peak=${peakStr} drawdown=${ddStr} dte=${dteStr} bucket=${bucket} (win>=${thresholds.winPct}% loss>=${thresholds.lossPct}%)`;
      } else {
        // specialist + james_star both grade on underlying spot move.
        // Trading-clock gate applies HERE only — underlying-axis grading reads
        // ct_price_bars, which doesn't tick outside RTH. Grading a flag whose
        // horizon fell during a market-closed window using stale Friday-close
        // prices on both ends produces a fake-zero outcome.
        const horizonOpen = isMarketOpen(row.horizon_ts);
        if (!nowOpen && !horizonOpen) {
          skipped += 1;
          continue;
        }
        // ALWAYS fetch underlying spot from price_bars — never trust
        // row.entry_price for underlying-axis grading. Specialist flags
        // historically stored the option price in entry_price, which gets
        // compared against underlying close at horizon and produces absurd
        // 100x+ outcomes (e.g., entry $1.50 vs exit $674 → +44893%). The
        // spot at created_at is the right anchor.
        entryPx = await nearestClose(supabase, tickerForPrice, row.created_at);
        exitPx = await nearestClose(supabase, tickerForPrice, row.horizon_ts);
        if (entryPx === null || exitPx === null || entryPx <= 0) {
          await markUngradeable(supabase, row.id, 'price_unavailable');
          ungradeable += 1;
          console.warn(`[ct-flag-grader] skip ${row.id} (${row.source}): price unavailable (entry=${entryPx}, exit=${exitPx})`);
          continue;
        }
        priceChangePct = ((exitPx - entryPx) / entryPx) * 100;

        // SPY baseline for alpha.
        const spyEntry = await nearestClose(supabase, 'SPY', row.created_at);
        const spyExit = await nearestClose(supabase, 'SPY', row.horizon_ts);
        let spyChangePct: number | null = null;
        if (spyEntry !== null && spyExit !== null && spyEntry > 0) {
          spyChangePct = ((spyExit - spyEntry) / spyEntry) * 100;
        }
        alphaPct = spyChangePct === null ? null : priceChangePct - spyChangePct;

        if (row.source === 'james_star') {
          outcome = computeJamesOutcome(row.direction, priceChangePct, sourceDefaults);
          notes = `james_star underlying-axis: entry=${entryPx.toFixed(4)} exit=${exitPx.toFixed(4)} change=${priceChangePct.toFixed(2)}% (win>=${sourceDefaults.jamesWinPct}% loss>=${sourceDefaults.jamesLossPct}%)`;
        } else {
          outcome = computeSpecialistOutcome(row.direction, priceChangePct, targetThresholdPct);
          notes = `specialist: entry=${entryPx.toFixed(4)} exit=${exitPx.toFixed(4)} target=${targetThresholdPct}%`;
        }
      }

      const { error: gradeErr } = await supabase
        .from('ct_flag_grades')
        .upsert({
          flag_id: row.id,
          specialist_ticker: row.specialist_ticker ?? row.instrument,
          outcome,
          price_at_horizon: exitPx,
          price_change_pct: priceChangePct == null ? null : Number(priceChangePct.toFixed(4)),
          spy_change_pct: null,
          alpha_pct: alphaPct === null ? null : Number(alphaPct.toFixed(4)),
          notes,
        }, { onConflict: 'flag_id' });

      if (gradeErr) {
        errors.push(`grade ${row.id} (${row.source}): ${gradeErr.message.slice(0, 200)}`);
        continue;
      }

      const { error: updErr } = await supabase
        .from('ct_flags')
        .update({ status: 'graded' })
        .eq('id', row.id);
      if (updErr) {
        errors.push(`flag update ${row.id}: ${updErr.message.slice(0, 200)}`);
      }

      // Pattern updates only fire for specialist flags — they're the only
      // source whose signatures aggregate into ct_flag_patterns. NOTE: do NOT
      // write to ct_specialist_memory — that table is dead-by-design in v2.
      // The specialist recall organ sources from ct_specialist_reads +
      // ct_flag_grades. Reactivating the writer fires the
      // `specialist_memory_table_dead` warden invariant.
      if (row.source === 'specialist') {
        await updatePatternSafe(supabase, row.id, outcome, alphaPct);
      }

      graded += 1;
      bySource[row.source] = (bySource[row.source] ?? 0) + 1;
    } catch (e) {
      errors.push(`${row.id}: ${e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200)}`);
    }
  }

  return { graded, skipped, ungradeable, bySource, errors };
}

// ---------------------------------------------------------------------------
// Job B — T+1 OI confirmation (specialist-only).
// ---------------------------------------------------------------------------
async function confirmT1OI(
  supabase: SupabaseClient,
): Promise<{ upgraded: number; still_active: number; errors: string[] }> {
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const fourHoursOut = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();

  const { data: flags, error } = await supabase
    .from('ct_flags')
    .select('id, specialist_ticker, instrument, option_symbol, created_at, horizon_ts, confirmed_t1, status')
    .eq('status', 'active')
    .eq('source', 'specialist')
    .eq('confirmed_t1', false)
    .not('option_symbol', 'is', null)
    .lte('created_at', oneDayAgo)
    .gte('horizon_ts', fourHoursOut)
    .limit(100);

  if (error) {
    return { upgraded: 0, still_active: 0, errors: [`fetch: ${error.message}`] };
  }
  if (!flags || flags.length === 0) {
    return { upgraded: 0, still_active: 0, errors: [] };
  }

  const errors: string[] = [];
  let upgraded = 0;
  let stillActive = 0;

  for (const row of flags as Array<Pick<FlagRow, 'id' | 'specialist_ticker' | 'instrument' | 'option_symbol' | 'created_at' | 'horizon_ts' | 'confirmed_t1' | 'status'>>) {
    try {
      const optSym = row.option_symbol!;
      const createdDate = new Date(row.created_at);
      const t1Date = new Date(createdDate.getTime() + 24 * 60 * 60 * 1000)
        .toISOString().slice(0, 10);

      const { data: snaps, error: snapErr } = await supabase
        .from('ct_oi_snapshots')
        .select('oi, oi_delta_1d, snap_date, snap_slot')
        .eq('option_symbol', optSym)
        .eq('snap_date', t1Date)
        .eq('snap_slot', 'open')
        .limit(1);

      if (snapErr) {
        errors.push(`oi fetch ${row.id}: ${snapErr.message.slice(0, 200)}`);
        continue;
      }
      if (!snaps || snaps.length === 0) {
        stillActive += 1;
        continue;
      }

      const snap = snaps[0];
      const oiDelta = typeof snap.oi_delta_1d === 'number' ? snap.oi_delta_1d : null;
      const oiNow = typeof snap.oi === 'number' ? snap.oi : 0;
      const oiPrior = oiDelta !== null ? oiNow - oiDelta : null;

      let confirmed = false;
      if (oiDelta !== null && oiDelta >= 500) confirmed = true;
      else if (oiDelta !== null && oiPrior !== null && oiPrior > 0 && oiDelta / oiPrior > 0.25) confirmed = true;

      if (confirmed) {
        const { error: updErr } = await supabase
          .from('ct_flags')
          .update({ status: 'conviction', confirmed_t1: true })
          .eq('id', row.id);
        if (updErr) errors.push(`upgrade ${row.id}: ${updErr.message.slice(0, 200)}`);
        else upgraded += 1;
      } else {
        stillActive += 1;
      }
    } catch (e) {
      errors.push(`${row.id}: ${e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200)}`);
    }
  }

  return { upgraded, still_active: stillActive, errors };
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

  const targetThresholdPct = await getTargetThreshold(supabase);
  const sourceDefaults = await getSourceDefaults(supabase);

  const jobA = await gradeExpiredFlags(supabase, targetThresholdPct, sourceDefaults);
  const jobB = await confirmT1OI(supabase);

  const elapsedMs = Date.now() - startedAt;

  await recordDecision(supabase, {
    decision_type: 'flag_grader_run',
    model_tier: 'deterministic',
    reasoning: `target=${targetThresholdPct}% — graded ${jobA.graded} (${JSON.stringify(jobA.bySource)})/skipped ${jobA.skipped}/ungradeable ${jobA.ungradeable}, oi_upgrades ${jobB.upgraded}/still_active ${jobB.still_active}, errors ${jobA.errors.length + jobB.errors.length}`,
    outcome: jobA.graded > 0 || jobB.upgraded > 0 ? 'progress' : 'noop',
  });

  return new Response(JSON.stringify({
    ok: true,
    elapsed_ms: elapsedMs,
    target_threshold_pct: targetThresholdPct,
    source_defaults: sourceDefaults,
    graded_count: jobA.graded,
    graded_by_source: jobA.bySource,
    skipped_count: jobA.skipped,
    ungradeable_count: jobA.ungradeable,
    conviction_upgraded_count: jobB.upgraded,
    still_active_count: jobB.still_active,
    errors: [...jobA.errors, ...jobB.errors].slice(0, 20),
  }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
