/**
 * ct-flag-grader — Co-Trader v2 Phase 2b.
 *
 * Closes the self-learning loop: every 30 min, grade flags whose horizon
 * has passed AND upgrade T+1-OI-confirmed flags to 'conviction'.
 *
 * Job A — grade expired flags
 *   For each ct_flags row with status IN ('active','conviction') and
 *   horizon_ts <= now():
 *     1. Resolve entry price (flag.entry_price or nearest ct_price_bars close
 *        at flag.created_at, ±30min slop).
 *     2. Resolve exit price (nearest ct_price_bars close at flag.horizon_ts,
 *        ±30min slop).
 *     3. Resolve SPY entry + exit for alpha_pct.
 *     4. Compute outcome (win / partial / loss) from direction + change vs
 *        configured target_threshold_pct.
 *     5. Upsert ct_flag_grades, mark flag.status='graded'.
 *     6. Fire-and-forget: update ct_flag_patterns (signature hash + running
 *        hit rate) + insert ct_specialist_memory row.
 *
 * Job B — T+1 OI confirmation
 *   For each ct_flags row with status='active', confirmed_t1=false,
 *   created_at <= now() - 1d, and horizon_ts > now() + 4h:
 *     1. Look up OI delta for flag.option_symbol from ct_oi_snapshots
 *        (T+1 open slot vs prior-day captures).
 *     2. If delta >= 500 OR delta > 25% of prior OI: promote to 'conviction',
 *        set confirmed_t1=true.
 *     3. Otherwise leave active; Claude still grades at horizon.
 *
 * Auth: service role only.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { recordDecision } from '../_shared/decisionJournal.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type FlagStatus = 'active' | 'conviction' | 'graded' | 'invalidated';
type Direction = 'bullish' | 'bearish' | 'neutral';
type Outcome = 'win' | 'partial' | 'loss' | 'invalidated_early';

interface FlagRow {
  id: string;
  specialist_ticker: string;
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
// Price lookup — nearest ct_price_bars close within ±30min slop.
// Returns null on miss.
// ---------------------------------------------------------------------------
async function nearestClose(
  supabase: SupabaseClient,
  ticker: string,
  ts: string,
): Promise<number | null> {
  const target = new Date(ts);
  const lo = new Date(target.getTime() - 30 * 60 * 1000).toISOString();
  const hi = new Date(target.getTime() + 30 * 60 * 1000).toISOString();

  // Try 1m first (preferred resolution), then 5m, then 15m, then 1h as fallback.
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

    // Pick the bar closest to target_ts
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
    if (best !== null && Number.isFinite(best.close)) {
      return best.close;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Outcome logic
// ---------------------------------------------------------------------------
function computeOutcome(direction: Direction, changePct: number, targetPct: number): Outcome {
  if (direction === 'neutral') {
    // Neutral = range-bound thesis. Win if |change| <= target, loss if beyond.
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
// Config lookup — target_threshold_pct
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

// ---------------------------------------------------------------------------
// Pattern update — delegated to SQL helper ct_update_flag_pattern.
// Fire-and-forget, never blocks grading.
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
// Specialist memory write — fire-and-forget.
// ---------------------------------------------------------------------------
async function writeSpecialistMemorySafe(
  supabase: SupabaseClient,
  flag: FlagRow,
  outcome: Outcome,
  alphaPct: number | null,
): Promise<void> {
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
        // embedding left NULL — backfill will fill later.
      });
    if (error) console.warn(`[ct-flag-grader] memory write ${flag.id}: ${error.message}`);
  } catch (e) {
    console.warn(`[ct-flag-grader] memory write threw: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---------------------------------------------------------------------------
// Job A — grade expired flags
// ---------------------------------------------------------------------------
async function gradeExpiredFlags(
  supabase: SupabaseClient,
  targetThresholdPct: number,
): Promise<{ graded: number; skipped: number; errors: string[] }> {
  const nowIso = new Date().toISOString();
  const { data: flags, error } = await supabase
    .from('ct_flags')
    .select('id, specialist_ticker, instrument, option_symbol, strike, expiry, side, direction, score, tags, horizon_ts, entry_price, target_price, status, confirmed_t1, created_at')
    .in('status', ['active', 'conviction'])
    .lte('horizon_ts', nowIso)
    .limit(100);

  if (error) {
    return { graded: 0, skipped: 0, errors: [`fetch: ${error.message}`] };
  }
  if (!flags || flags.length === 0) {
    return { graded: 0, skipped: 0, errors: [] };
  }

  const errors: string[] = [];
  let graded = 0;
  let skipped = 0;

  for (const row of flags as FlagRow[]) {
    try {
      // Resolve entry price: prefer stored, else nearest bar at created_at.
      let entryPx: number | null = row.entry_price ?? null;
      if (entryPx === null || !Number.isFinite(entryPx)) {
        entryPx = await nearestClose(supabase, row.instrument, row.created_at);
      }
      // Resolve exit price: nearest bar at horizon_ts.
      const exitPx = await nearestClose(supabase, row.instrument, row.horizon_ts);

      if (entryPx === null || exitPx === null || entryPx <= 0) {
        skipped += 1;
        console.warn(`[ct-flag-grader] skip ${row.id}: price unavailable (entry=${entryPx}, exit=${exitPx})`);
        continue;
      }

      const priceChangePct = ((exitPx - entryPx) / entryPx) * 100;

      // SPY baseline for alpha (best-effort; null on miss).
      let spyChangePct: number | null = null;
      const spyEntry = await nearestClose(supabase, 'SPY', row.created_at);
      const spyExit = await nearestClose(supabase, 'SPY', row.horizon_ts);
      if (spyEntry !== null && spyExit !== null && spyEntry > 0) {
        spyChangePct = ((spyExit - spyEntry) / spyEntry) * 100;
      }
      const alphaPct = spyChangePct === null ? null : priceChangePct - spyChangePct;

      const outcome = computeOutcome(row.direction, priceChangePct, targetThresholdPct);

      const { error: gradeErr } = await supabase
        .from('ct_flag_grades')
        .upsert({
          flag_id: row.id,
          specialist_ticker: row.specialist_ticker,
          outcome,
          price_at_horizon: exitPx,
          price_change_pct: Number(priceChangePct.toFixed(4)),
          spy_change_pct: spyChangePct === null ? null : Number(spyChangePct.toFixed(4)),
          alpha_pct: alphaPct === null ? null : Number(alphaPct.toFixed(4)),
          notes: `entry=${entryPx.toFixed(4)} exit=${exitPx.toFixed(4)} target=${targetThresholdPct}%`,
        }, { onConflict: 'flag_id' });

      if (gradeErr) {
        errors.push(`grade ${row.id}: ${gradeErr.message.slice(0, 200)}`);
        continue;
      }

      const { error: updErr } = await supabase
        .from('ct_flags')
        .update({ status: 'graded' })
        .eq('id', row.id);
      if (updErr) {
        errors.push(`flag update ${row.id}: ${updErr.message.slice(0, 200)}`);
      }

      // Fire-and-forget pattern + memory (don't block grading).
      await updatePatternSafe(supabase, row.id, outcome, alphaPct);
      await writeSpecialistMemorySafe(supabase, row, outcome, alphaPct);

      graded += 1;
    } catch (e) {
      errors.push(`${row.id}: ${e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200)}`);
    }
  }

  return { graded, skipped, errors };
}

// ---------------------------------------------------------------------------
// Job B — T+1 OI confirmation
// ---------------------------------------------------------------------------
async function confirmT1OI(
  supabase: SupabaseClient,
): Promise<{ upgraded: number; still_active: number; errors: string[] }> {
  const nowIso = new Date().toISOString();
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const fourHoursOut = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();

  const { data: flags, error } = await supabase
    .from('ct_flags')
    .select('id, specialist_ticker, instrument, option_symbol, created_at, horizon_ts, confirmed_t1, status')
    .eq('status', 'active')
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
      // T+1 date = created_at date + 1d (UTC)
      const createdDate = new Date(row.created_at);
      const t1Date = new Date(createdDate.getTime() + 24 * 60 * 60 * 1000)
        .toISOString().slice(0, 10);

      // Look up T+1 open snapshot for this option_symbol.
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
        // No T+1 OI read yet (maybe pre-market or snapshot missed). Leave active.
        stillActive += 1;
        continue;
      }

      const snap = snaps[0];
      const oiDelta = typeof snap.oi_delta_1d === 'number' ? snap.oi_delta_1d : null;
      const oiNow = typeof snap.oi === 'number' ? snap.oi : 0;
      const oiPrior = oiDelta !== null ? oiNow - oiDelta : null;

      // Confirmation rule: delta >= 500 OR delta > 25% of prior OI.
      let confirmed = false;
      if (oiDelta !== null && oiDelta >= 500) {
        confirmed = true;
      } else if (oiDelta !== null && oiPrior !== null && oiPrior > 0 && oiDelta / oiPrior > 0.25) {
        confirmed = true;
      }

      if (confirmed) {
        const { error: updErr } = await supabase
          .from('ct_flags')
          .update({ status: 'conviction', confirmed_t1: true })
          .eq('id', row.id);
        if (updErr) {
          errors.push(`upgrade ${row.id}: ${updErr.message.slice(0, 200)}`);
        } else {
          upgraded += 1;
        }
      } else {
        // Leave confirmed_t1=false; Claude still grades at horizon.
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

  // Job A first: grade expired flags.
  const jobA = await gradeExpiredFlags(supabase, targetThresholdPct);

  // Job B: T+1 OI confirmation upgrades.
  const jobB = await confirmT1OI(supabase);

  const elapsedMs = Date.now() - startedAt;

  // Record a single decision-journal row per run for auditability.
  await recordDecision(supabase, {
    decision_type: 'flag_grader_run',
    model_tier: 'deterministic',
    reasoning: `target=${targetThresholdPct}% — graded ${jobA.graded}, skipped ${jobA.skipped}, oi_upgrades ${jobB.upgraded}, still_active ${jobB.still_active}, errors ${jobA.errors.length + jobB.errors.length}`,
    outcome: jobA.graded > 0 || jobB.upgraded > 0 ? 'progress' : 'noop',
  });

  return new Response(JSON.stringify({
    ok: true,
    elapsed_ms: elapsedMs,
    target_threshold_pct: targetThresholdPct,
    graded_count: jobA.graded,
    skipped_count: jobA.skipped,
    conviction_upgraded_count: jobB.upgraded,
    still_active_count: jobB.still_active,
    errors: [...jobA.errors, ...jobB.errors].slice(0, 20),
  }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
