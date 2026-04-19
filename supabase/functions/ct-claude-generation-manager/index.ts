/**
 * ct-claude-generation-manager — Wave N.4
 *
 * The generational lifecycle brain (Tenet 14). Runs hourly during RTH + once
 * at week-close. Responsible for:
 *
 *   1. Ensuring at least one generation is always 'active' — bootstraps Gen 1
 *      if the table is empty (safety against a nuked seed).
 *   2. Detecting the four fire conditions against the active generation:
 *        - target_hit            → SUCCESS: close as 'succeeded' + compound-start next
 *        - survival_breach       → balance <= survival_floor
 *        - performance_floor     → days_elapsed > target_days AND balance < target
 *        - hallucination_cascade → count(hallucination_flag) in gen > threshold
 *        - time_cap              → days_elapsed > target_days + 1 (safety net)
 *   3. On every fire:
 *        - Mark generation status ('fired' or 'succeeded'), fire_reason,
 *          ended_at, ending_balance, total_return_pct, days_lived.
 *        - Force-close all open Claude trades (close_reason='generation_fired_<reason>'
 *          with last-known spot as close_price). Skip on target_hit — winners
 *          close naturally.
 *        - Cancel all armed trade ideas (status='cancelled',
 *          cancelled_reason='generation fired: <reason>'). Skip on target_hit.
 *        - Fire-and-forget ct-claude-cio-review to distill lessons; store
 *          inbound lessons_applied array on the fired generation (best effort —
 *          the CIO run completes asynchronously and writes its own artifacts).
 *        - Create the new generation. Starting balance compounds forward from
 *          the fired generation's ending_balance if target_hit; otherwise
 *          resets to claude_starting_balance_usd.
 *        - Reset Claude's ct_book today-row to the new generation's starting
 *          balance (fresh sheet: starting=ending=hwm=new_start, trades_count=0,
 *          realized_pnl=0, wins=losses=0).
 *        - Log ct_claude_decisions decision_type='reflection' with the
 *          generation transition.
 *
 * Auth: service role only. Called by pg_cron + trigger_ct_claude_generation_manager().
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { getConfig } from '../_shared/configCache.ts';
import { recordDecision } from '../_shared/decisionJournal.ts';

interface Generation {
  id: string;
  generation_number: number;
  started_at: string;
  ended_at: string | null;
  status: string;
  fire_reason: string | null;
  starting_balance_usd: number;
  target_balance_usd: number;
  survival_floor_usd: number;
  target_days: number;
  ending_balance_usd: number | null;
  total_trades: number;
  wins: number;
  losses: number;
  hallucinations_flagged: number;
}

interface FireEvaluation {
  should_fire: boolean;
  status: 'succeeded' | 'fired' | null;
  fire_reason:
    | 'target_hit'
    | 'survival_breach'
    | 'performance_floor'
    | 'hallucination_cascade'
    | 'time_cap'
    | null;
  reason_detail: string;
  balance: number;
  days_elapsed: number;
  hallucination_count: number;
}

/** Last spot for a ticker from heartbeats → gex fallback. Used to set a
 *  realistic close_price when force-closing open trades on a fire. */
async function resolveSpot(supabase: SupabaseClient, ticker: string): Promise<number | null> {
  const { data: hbRows } = await supabase
    .from('ct_heartbeats')
    .select('current_reads')
    .order('created_at', { ascending: false })
    .limit(1);
  const reads = hbRows?.[0]?.current_reads as Record<string, unknown> | null | undefined;
  if (reads && typeof reads === 'object') {
    const per = reads[ticker] as Record<string, unknown> | undefined;
    const spot = per && typeof per === 'object' ? (per.spot ?? per.price ?? per.underlying_price) : undefined;
    const p = typeof spot === 'number' ? spot : typeof spot === 'string' ? parseFloat(spot) : NaN;
    if (Number.isFinite(p)) return p;
  }
  const { data: gex } = await supabase
    .from('ct_gex_timeseries')
    .select('underlying_price')
    .eq('ticker', ticker)
    .order('snapshot_at', { ascending: false })
    .limit(1);
  const up = gex?.[0]?.underlying_price;
  if (typeof up === 'number' && Number.isFinite(up)) return up;
  return null;
}

/** Claude's latest book ending_balance (or starting fallback, or seeded). */
async function resolveClaudeBalance(
  supabase: SupabaseClient,
  fallback: number,
): Promise<{ balance: number; session_date: string | null; book_id: string | null }> {
  const { data: book } = await supabase
    .from('ct_book')
    .select('id, session_date, starting_balance, ending_balance')
    .eq('trader', 'claude')
    .order('session_date', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!book) return { balance: fallback, session_date: null, book_id: null };
  const end = book.ending_balance as number | null;
  const start = book.starting_balance as number | null;
  const balance = end ?? start ?? fallback;
  return {
    balance,
    session_date: (book.session_date as string | null) ?? null,
    book_id: (book.id as string | null) ?? null,
  };
}

/** Count hallucination_flag=true decisions scoped to this generation. */
async function countHallucinations(
  supabase: SupabaseClient,
  generation_id: string,
): Promise<number> {
  const { count } = await supabase
    .from('ct_claude_decisions')
    .select('id', { count: 'exact', head: true })
    .eq('generation_id', generation_id)
    .eq('hallucination_flag', true);
  return count ?? 0;
}

/** Evaluate fire conditions in priority order. Target first (compound reward
 *  beats any concurrent tripwire), then survival, then hallucination, then
 *  performance floor, then time cap. */
function evaluateFire(
  gen: Generation,
  balance: number,
  hallucinationCount: number,
  hallucinationThreshold: number,
): FireEvaluation {
  const daysElapsed = Math.floor((Date.now() - Date.parse(gen.started_at)) / 86_400_000);
  const base: Omit<FireEvaluation, 'should_fire' | 'status' | 'fire_reason' | 'reason_detail'> = {
    balance,
    days_elapsed: daysElapsed,
    hallucination_count: hallucinationCount,
  };

  if (balance >= gen.target_balance_usd && daysElapsed <= gen.target_days) {
    return {
      ...base,
      should_fire: true,
      status: 'succeeded',
      fire_reason: 'target_hit',
      reason_detail: `balance ${balance} >= target ${gen.target_balance_usd} in ${daysElapsed}/${gen.target_days} days`,
    };
  }

  if (balance <= gen.survival_floor_usd) {
    return {
      ...base,
      should_fire: true,
      status: 'fired',
      fire_reason: 'survival_breach',
      reason_detail: `balance ${balance} <= survival floor ${gen.survival_floor_usd}`,
    };
  }

  if (hallucinationCount >= hallucinationThreshold) {
    return {
      ...base,
      should_fire: true,
      status: 'fired',
      fire_reason: 'hallucination_cascade',
      reason_detail: `${hallucinationCount} hallucination_flag decisions >= threshold ${hallucinationThreshold}`,
    };
  }

  if (daysElapsed > gen.target_days && balance < gen.target_balance_usd) {
    return {
      ...base,
      should_fire: true,
      status: 'fired',
      fire_reason: 'performance_floor',
      reason_detail: `day ${daysElapsed} > ${gen.target_days} and balance ${balance} < target ${gen.target_balance_usd}`,
    };
  }

  if (daysElapsed > gen.target_days + 1) {
    return {
      ...base,
      should_fire: true,
      status: 'fired',
      fire_reason: 'time_cap',
      reason_detail: `day ${daysElapsed} > ${gen.target_days + 1} safety cap`,
    };
  }

  return {
    ...base,
    should_fire: false,
    status: null,
    fire_reason: null,
    reason_detail: `within window: day ${daysElapsed}/${gen.target_days}, balance ${balance} in (${gen.survival_floor_usd}, ${gen.target_balance_usd})`,
  };
}

/** Force-close all Claude open trades on a fire. close_price = last-known spot
 *  (fallback to entry_price if spot unresolvable — zero PnL is safer than a
 *  hallucinated close). Grades are NOT inserted here — a forced generational
 *  close is not a thesis outcome; it's an exit under duress. */
async function forceCloseOpenTrades(
  supabase: SupabaseClient,
  reason: string,
): Promise<{ closed: number; details: Array<Record<string, unknown>> }> {
  const { data: trades, error } = await supabase
    .from('ct_trades')
    .select('id, instrument, side, size_usd, entry_price')
    .eq('trader', 'claude')
    .eq('status', 'open');
  if (error || !trades || trades.length === 0) return { closed: 0, details: [] };

  const details: Array<Record<string, unknown>> = [];
  for (const t of trades) {
    const spot = await resolveSpot(supabase, t.instrument as string);
    const closePrice = spot ?? (t.entry_price as number);
    const entry = t.entry_price as number;
    const isLong = (t.side as string) === 'long';
    const pnlPct = isLong
      ? ((closePrice / entry) - 1) * 100
      : ((entry / closePrice) - 1) * 100;
    const pnlUsd = +((t.size_usd as number) * pnlPct / 100).toFixed(2);
    const { error: updErr } = await supabase
      .from('ct_trades')
      .update({
        status: 'closed',
        close_price: closePrice,
        closed_at: new Date().toISOString(),
        close_reason: `generation_fired_${reason}`,
        realized_pnl_pct: +pnlPct.toFixed(4),
        realized_pnl_usd: pnlUsd,
      })
      .eq('id', t.id as string);
    if (updErr) {
      console.warn(`[ct-claude-generation-manager] force close failed for ${t.id}:`, updErr.message);
      continue;
    }
    details.push({ trade_id: t.id, instrument: t.instrument, close_price: closePrice, pnl_usd: pnlUsd });
  }
  return { closed: details.length, details };
}

/** Cancel all armed trade ideas on a fire. */
async function cancelArmedIdeas(
  supabase: SupabaseClient,
  reason: string,
): Promise<number> {
  const { data, error } = await supabase
    .from('ct_trade_ideas')
    .update({ status: 'cancelled', cancelled_reason: `generation fired: ${reason}` })
    .eq('trader', 'claude')
    .eq('status', 'armed')
    .select('id');
  if (error) {
    console.warn('[ct-claude-generation-manager] cancel armed failed:', error.message);
    return 0;
  }
  return data?.length ?? 0;
}

/** Fire-and-forget CIO review. Does not await the response. */
function fireCioReview(supabase: SupabaseClient, firedGenerationId: string): void {
  supabase
    .rpc('_ct_post_with_body', {
      _fn: 'ct-claude-cio-review',
      _body: { trigger: 'generation_fired', fired_generation_id: firedGenerationId },
    })
    .then(({ error }) => {
      if (error) console.warn('[ct-claude-generation-manager] CIO review dispatch failed:', error.message);
    })
    .catch((e) => console.warn('[ct-claude-generation-manager] CIO review threw:', e?.message ?? e));
}

/** Reset Claude's ct_book row for today to match the new generation's starting
 *  balance. Creates the row if missing (first trading day of new gen). */
async function resetBookForNewGeneration(
  supabase: SupabaseClient,
  startingBalance: number,
): Promise<string | null> {
  const sessionDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
  const { data: existing } = await supabase
    .from('ct_book')
    .select('id')
    .eq('trader', 'claude')
    .eq('session_date', sessionDate)
    .maybeSingle();
  if (existing) {
    await supabase
      .from('ct_book')
      .update({
        starting_balance: startingBalance,
        ending_balance: startingBalance,
        high_water_mark: startingBalance,
        trades_count: 0,
        wins: 0,
        losses: 0,
        realized_pnl: 0,
      })
      .eq('id', existing.id as string);
    return existing.id as string;
  }
  const { data: inserted } = await supabase
    .from('ct_book')
    .insert({
      trader: 'claude',
      session_date: sessionDate,
      starting_balance: startingBalance,
      ending_balance: startingBalance,
      high_water_mark: startingBalance,
      trades_count: 0,
      wins: 0,
      losses: 0,
      realized_pnl: 0,
    })
    .select('id')
    .single();
  return (inserted?.id as string | undefined) ?? null;
}

serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  const corsHeaders = getCorsHeaders(req);

  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'Service role required' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
  const startedAt = Date.now();

  const startingBalanceCfg = Number(await getConfig<number>('claude_starting_balance_usd', 50000));
  const targetDeltaCfg     = Number(await getConfig<number>('claude_generation_target_usd', 10000));
  const targetDaysCfg      = Number(await getConfig<number>('claude_generation_days', 14));
  const survivalFloorCfg   = Number(await getConfig<number>('claude_survival_threshold_usd', 30000));
  const hallucinationThreshold = Number(await getConfig<number>('claude_hallucination_cascade_threshold', 10));

  // 1. Load active generation or bootstrap.
  let { data: activeRow } = await supabase
    .from('ct_claude_generations')
    .select('*')
    .eq('status', 'active')
    .order('generation_number', { ascending: false })
    .limit(1)
    .maybeSingle();

  let bootstrapped = false;
  if (!activeRow) {
    // Pick generation_number = max + 1 (or 1 if empty).
    const { data: last } = await supabase
      .from('ct_claude_generations')
      .select('id, generation_number')
      .order('generation_number', { ascending: false })
      .limit(1)
      .maybeSingle();
    const nextNumber = ((last?.generation_number as number | null) ?? 0) + 1;
    const predecessorId = (last?.id as string | null) ?? null;
    const { data: inserted, error } = await supabase
      .from('ct_claude_generations')
      .insert({
        generation_number: nextNumber,
        starting_balance_usd: startingBalanceCfg,
        target_balance_usd: startingBalanceCfg + targetDeltaCfg,
        survival_floor_usd: survivalFloorCfg,
        target_days: targetDaysCfg,
        status: 'active',
        predecessor_id: predecessorId,
      })
      .select('*')
      .single();
    if (error || !inserted) {
      return new Response(JSON.stringify({ ok: false, error: `bootstrap failed: ${error?.message ?? 'no data'}` }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    activeRow = inserted;
    bootstrapped = true;
    await resetBookForNewGeneration(supabase, startingBalanceCfg);
    await recordDecision(supabase, {
      decision_type: 'reflection',
      model_tier: 'none',
      reasoning: `Generation ${nextNumber} bootstrapped: no active generation found. Starting $${startingBalanceCfg}, target $${startingBalanceCfg + targetDeltaCfg} in ${targetDaysCfg} days.`,
      outcome: 'bootstrapped',
      context_snapshot: {
        source: 'ct-claude-generation-manager',
        generation_number: nextNumber,
        predecessor_id: predecessorId,
      },
    });
  }

  const gen = activeRow as unknown as Generation;

  // 2. Evaluate fire conditions.
  const { balance, book_id } = await resolveClaudeBalance(supabase, gen.starting_balance_usd);
  const hallucinationCount = await countHallucinations(supabase, gen.id);
  const evalResult = evaluateFire(gen, balance, hallucinationCount, hallucinationThreshold);

  if (!evalResult.should_fire) {
    const body = {
      ok: true,
      bootstrapped,
      active_generation: {
        id: gen.id,
        number: gen.generation_number,
        started_at: gen.started_at,
        days_elapsed: evalResult.days_elapsed,
        target_days: gen.target_days,
        balance,
        target_balance_usd: gen.target_balance_usd,
        survival_floor_usd: gen.survival_floor_usd,
        hallucination_count: hallucinationCount,
      },
      fire_check: evalResult,
      duration_ms: Date.now() - startedAt,
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // 3. FIRE. Close the current gen, cleanup, new gen, book reset, log.
  const fireReason = evalResult.fire_reason!;
  const newStatus  = evalResult.status!;
  const targetHit  = fireReason === 'target_hit';

  const daysLived    = evalResult.days_elapsed;
  const totalReturnPct = gen.starting_balance_usd > 0
    ? +(((balance / gen.starting_balance_usd) - 1) * 100).toFixed(4)
    : 0;

  const { error: closeGenErr } = await supabase
    .from('ct_claude_generations')
    .update({
      status: newStatus,
      fire_reason: fireReason,
      ended_at: new Date().toISOString(),
      ending_balance_usd: balance,
      total_return_pct: totalReturnPct,
      days_lived: daysLived,
      hallucinations_flagged: hallucinationCount,
    })
    .eq('id', gen.id);
  if (closeGenErr) {
    return new Response(JSON.stringify({ ok: false, error: `close gen failed: ${closeGenErr.message}` }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Force-close trades + cancel armed ideas — ONLY on fires, not on target_hit
  // (successful runs should let existing positions play out naturally).
  let forceClosed = { closed: 0, details: [] as Array<Record<string, unknown>> };
  let armedCancelled = 0;
  if (!targetHit) {
    forceClosed = await forceCloseOpenTrades(supabase, fireReason);
    armedCancelled = await cancelArmedIdeas(supabase, fireReason);
  }

  // Fire-and-forget CIO distillation.
  fireCioReview(supabase, gen.id);

  // Create the new generation. On success, compound the starting balance
  // forward (new_start = ending_balance; new_target = ending + target_delta).
  // On fire, reset to configured starting_balance.
  const newStart  = targetHit ? balance : startingBalanceCfg;
  const newTarget = targetHit ? balance + targetDeltaCfg : startingBalanceCfg + targetDeltaCfg;
  const newNumber = gen.generation_number + 1;

  const { data: newGenRow, error: newGenErr } = await supabase
    .from('ct_claude_generations')
    .insert({
      generation_number: newNumber,
      starting_balance_usd: newStart,
      target_balance_usd: newTarget,
      survival_floor_usd: survivalFloorCfg,
      target_days: targetDaysCfg,
      status: 'active',
      predecessor_id: gen.id,
    })
    .select('*')
    .single();
  if (newGenErr || !newGenRow) {
    return new Response(JSON.stringify({ ok: false, error: `new gen insert failed: ${newGenErr?.message ?? 'no data'}` }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const newBookId = await resetBookForNewGeneration(supabase, newStart);

  await recordDecision(supabase, {
    decision_type: 'reflection',
    model_tier: 'none',
    reasoning: `Generation ${newNumber} started: predecessor ${gen.generation_number} (${gen.id}) ${newStatus} for ${fireReason}. ${evalResult.reason_detail}. New stakes: start $${newStart} → target $${newTarget} in ${targetDaysCfg} days. Survival floor $${survivalFloorCfg}. ${targetHit ? 'Compounded forward.' : 'Reset to baseline.'}`,
    outcome: `generation_${newStatus}`,
    context_snapshot: {
      source: 'ct-claude-generation-manager',
      predecessor_generation_id: gen.id,
      predecessor_generation_number: gen.generation_number,
      fire_reason: fireReason,
      ending_balance_usd: balance,
      total_return_pct: totalReturnPct,
      days_lived: daysLived,
      hallucination_count: hallucinationCount,
      force_closed_trades: forceClosed.closed,
      armed_cancelled: armedCancelled,
      new_generation_id: newGenRow.id,
      new_generation_number: newNumber,
      new_starting_balance_usd: newStart,
      new_target_balance_usd: newTarget,
      book_id_prev: book_id,
      book_id_new: newBookId,
    },
  });

  const body = {
    ok: true,
    bootstrapped,
    fired_generation: {
      id: gen.id,
      number: gen.generation_number,
      status: newStatus,
      fire_reason: fireReason,
      ending_balance_usd: balance,
      total_return_pct: totalReturnPct,
      days_lived: daysLived,
      hallucination_count: hallucinationCount,
    },
    cleanup: {
      force_closed_trades: forceClosed.closed,
      force_closed_detail: forceClosed.details,
      armed_cancelled: armedCancelled,
    },
    new_generation: {
      id: newGenRow.id,
      number: newNumber,
      starting_balance_usd: newStart,
      target_balance_usd: newTarget,
      target_days: targetDaysCfg,
      survival_floor_usd: survivalFloorCfg,
    },
    cio_review_dispatched: true,
    fire_check: evalResult,
    duration_ms: Date.now() - startedAt,
  };
  console.log('[ct-claude-generation-manager]', JSON.stringify(body));
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
