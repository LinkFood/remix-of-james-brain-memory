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
type FlagSource = 'specialist' | 'james_star' | 'signature_alarm';

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
interface SourceDefaults {
  // james_star (underlying-axis)
  jamesWinPct: number;       // >= this in direction = win
  jamesLossPct: number;      // <= -this against direction = loss
  // signature_alarm (contract-axis)
  alarmWinPct: number;       // >= this peak% = win
  alarmLossPct: number;      // drawdown >= this = loss
}

const DEFAULT_SOURCE_DEFAULTS: SourceDefaults = {
  jamesWinPct: 1.5,
  jamesLossPct: 1.0,
  alarmWinPct: 50,
  alarmLossPct: 30,
};

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
// Signature-alarm outcome — contract-axis from ct_contract_tracks.
// ---------------------------------------------------------------------------
function computeAlarmOutcome(peakPct: number | null, drawdownPct: number | null, defaults: SourceDefaults): Outcome {
  // peakPct is fractional (0.5 = +50%) per ct_contract_tracks convention.
  const peak = peakPct == null ? 0 : peakPct * 100;
  const drawdown = drawdownPct == null ? 0 : drawdownPct * 100;
  if (peak >= defaults.alarmWinPct) return 'win';
  if (drawdown >= defaults.alarmLossPct) return 'loss';
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
  const out = { ...DEFAULT_SOURCE_DEFAULTS };
  const { data } = await supabase
    .from('ct_config')
    .select('key, value')
    .in('key', [
      'grader.james_win_pct',
      'grader.james_loss_pct',
      'grader.alarm_win_pct',
      'grader.alarm_loss_pct',
    ]);
  for (const row of data ?? []) {
    const v = row.value;
    const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
    if (!Number.isFinite(n) || n < 0) continue;
    if (row.key === 'grader.james_win_pct') out.jamesWinPct = n;
    else if (row.key === 'grader.james_loss_pct') out.jamesLossPct = n;
    else if (row.key === 'grader.alarm_win_pct') out.alarmWinPct = n;
    else if (row.key === 'grader.alarm_loss_pct') out.alarmLossPct = n;
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

async function writeSpecialistMemorySafe(
  supabase: SupabaseClient,
  flag: FlagRow,
  outcome: Outcome,
  alphaPct: number | null,
): Promise<void> {
  if (!flag.specialist_ticker) return;
  try {
    const alphaStr = alphaPct === null ? 'n/a' : alphaPct.toFixed(2);
    const optSym = flag.option_symbol ?? flag.instrument;
    const summary = `${flag.direction} ${optSym} @ score ${flag.score} → ${outcome} (alpha ${alphaStr}%)`;
    const importance = outcome === 'win' ? 8 : outcome === 'loss' ? 7 : 5;

    const { error } = await supabase
      .from('ct_specialist_memory')
      .insert({
        specialist_ticker: flag.specialist_ticker,
        flag_id: flag.id,
        memory_type: 'graded_flag',
        summary,
        importance,
      });
    if (error) console.warn(`[ct-flag-grader] memory write ${flag.id}: ${error.message}`);
  } catch (e) {
    console.warn(`[ct-flag-grader] memory write threw: ${e instanceof Error ? e.message : String(e)}`);
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
): Promise<{ peak_contract_pct: number | null; max_drawdown_pct: number | null } | null> {
  const flagTs = new Date(flagCreatedAt).getTime();
  const lo = new Date(flagTs - 60 * 60 * 1000).toISOString();
  const hi = new Date(flagTs + 6 * 60 * 60 * 1000).toISOString();
  const { data } = await supabase
    .from('ct_contract_tracks')
    .select('peak_contract_pct, max_drawdown_pct, print_time')
    .eq('option_symbol', optionSymbol)
    .gte('print_time', lo)
    .lte('print_time', hi)
    .order('print_time', { ascending: true })
    .limit(20);
  if (!data || data.length === 0) return null;
  // Pick closest to flag.created_at
  let best: { peak_contract_pct: number | null; max_drawdown_pct: number | null } | null = null;
  let bestDelta = Infinity;
  for (const row of data) {
    const delta = Math.abs(new Date(row.print_time as string).getTime() - flagTs);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = {
        peak_contract_pct: row.peak_contract_pct == null ? null : Number(row.peak_contract_pct),
        max_drawdown_pct: row.max_drawdown_pct == null ? null : Number(row.max_drawdown_pct),
      };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Job A — grade expired flags across all sources.
// ---------------------------------------------------------------------------
async function gradeExpiredFlags(
  supabase: SupabaseClient,
  targetThresholdPct: number,
  sourceDefaults: SourceDefaults,
): Promise<{ graded: number; skipped: number; bySource: Record<string, number>; errors: string[] }> {
  const nowIso = new Date().toISOString();
  const { data: flags, error } = await supabase
    .from('ct_flags')
    .select('id, source, specialist_ticker, instrument, option_symbol, strike, expiry, side, direction, score, tags, horizon_ts, entry_price, target_price, status, confirmed_t1, created_at')
    .in('status', ['active', 'conviction'])
    .lte('horizon_ts', nowIso)
    .limit(200);

  if (error) {
    return { graded: 0, skipped: 0, bySource: {}, errors: [`fetch: ${error.message}`] };
  }
  if (!flags || flags.length === 0) {
    return { graded: 0, skipped: 0, bySource: {}, errors: [] };
  }

  const errors: string[] = [];
  const bySource: Record<string, number> = {};
  let graded = 0;
  let skipped = 0;

  const nowDate = new Date();
  const nowOpen = isMarketOpen(nowDate);

  for (const row of flags as FlagRow[]) {
    try {
      const horizonOpen = isMarketOpen(row.horizon_ts);
      // Trading-clock gate: don't bake stale Friday-close prices into outcomes.
      if (!nowOpen && !horizonOpen) {
        skipped += 1;
        continue;
      }

      const tickerForPrice = row.specialist_ticker ?? row.instrument;
      let outcome: Outcome;
      let entryPx: number | null = null;
      let exitPx: number | null = null;
      let priceChangePct: number | null = null;
      let alphaPct: number | null = null;
      let notes = '';

      if (row.source === 'signature_alarm') {
        // Contract-axis grading: read peak / drawdown from ct_contract_tracks.
        if (!row.option_symbol) {
          skipped += 1;
          continue;
        }
        const track = await loadContractTrack(supabase, row.option_symbol, row.created_at);
        if (!track) {
          skipped += 1;
          console.warn(`[ct-flag-grader] alarm ${row.id}: no contract track`);
          continue;
        }
        outcome = computeAlarmOutcome(track.peak_contract_pct, track.max_drawdown_pct, sourceDefaults);
        const peakStr = track.peak_contract_pct == null ? 'n/a' : (track.peak_contract_pct * 100).toFixed(1) + '%';
        const ddStr = track.max_drawdown_pct == null ? 'n/a' : (track.max_drawdown_pct * 100).toFixed(1) + '%';
        notes = `signature_alarm contract-axis: peak=${peakStr} drawdown=${ddStr} (win>=${sourceDefaults.alarmWinPct}% loss>=${sourceDefaults.alarmLossPct}%)`;
      } else {
        // specialist + james_star both grade on underlying spot move.
        entryPx = row.entry_price ?? null;
        if (entryPx === null || !Number.isFinite(entryPx)) {
          entryPx = await nearestClose(supabase, tickerForPrice, row.created_at);
        }
        exitPx = await nearestClose(supabase, tickerForPrice, row.horizon_ts);
        if (entryPx === null || exitPx === null || entryPx <= 0) {
          skipped += 1;
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

      // Pattern + memory writes only fire for specialist flags — they're the
      // only source whose signatures aggregate into ct_flag_patterns.
      if (row.source === 'specialist') {
        await updatePatternSafe(supabase, row.id, outcome, alphaPct);
        await writeSpecialistMemorySafe(supabase, row, outcome, alphaPct);
      }

      graded += 1;
      bySource[row.source] = (bySource[row.source] ?? 0) + 1;
    } catch (e) {
      errors.push(`${row.id}: ${e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200)}`);
    }
  }

  return { graded, skipped, bySource, errors };
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
    reasoning: `target=${targetThresholdPct}% — graded ${jobA.graded} (${JSON.stringify(jobA.bySource)})/skipped ${jobA.skipped}, oi_upgrades ${jobB.upgraded}/still_active ${jobB.still_active}, errors ${jobA.errors.length + jobB.errors.length}`,
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
    conviction_upgraded_count: jobB.upgraded,
    still_active_count: jobB.still_active,
    errors: [...jobA.errors, ...jobB.errors].slice(0, 20),
  }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
