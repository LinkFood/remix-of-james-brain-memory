/**
 * ct-claude-cash-decay — Wave N.4
 *
 * Daily 20:00 UTC (post session close). Bleeds a small % from Claude's cash
 * balance every day so sitting in cash has a cost (Tenet 14: cost of inaction).
 * Prevents paralysis: Claude cannot "stay flat forever" without watching his
 * runway erode.
 *
 * Logic:
 *   1. Load active generation (skip if none).
 *   2. Compute Claude's cash:
 *        cash = ending_balance − sum(open trade notional at current spot)
 *      Notional = size_usd (already baseline × size_pct). We use size_usd
 *      directly — it's the capital deployed to that position.
 *   3. Apply decay: new_balance = ending_balance − (cash × pct / 100)
 *   4. Update today's ct_book row ending_balance + realized_pnl (decay books
 *      as a realized loss against the balance).
 *   5. Log a ct_claude_decisions reflection row.
 *   6. If the decay pushes balance below survival_floor, delegate to
 *      generation-manager via _ct_post_with_body RPC.
 *
 * Auth: service role only. Called by pg_cron at 20:00 UTC weekdays +
 * trigger_ct_claude_cash_decay() manual RPC.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { getConfig } from '../_shared/configCache.ts';
import { recordDecision } from '../_shared/decisionJournal.ts';

async function getClaudeBookToday(supabase: SupabaseClient) {
  const sessionDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
  const { data } = await supabase
    .from('ct_book')
    .select('id, session_date, starting_balance, ending_balance, realized_pnl, high_water_mark')
    .eq('trader', 'claude')
    .eq('session_date', sessionDate)
    .maybeSingle();
  return { book: data, session_date: sessionDate };
}

async function sumOpenPositionNotional(supabase: SupabaseClient): Promise<number> {
  const { data } = await supabase
    .from('ct_trades')
    .select('size_usd')
    .eq('trader', 'claude')
    .eq('status', 'open');
  if (!data) return 0;
  return data.reduce((acc, row) => acc + Number(row.size_usd ?? 0), 0);
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

  const baseDecayPct = Number(await getConfig<number>('claude_cash_decay_daily_pct', 0.5));

  // Inaction multiplier — volume mode. If Claude hasn't opened a new trade
  // in 48h of RTH, decay doubles; 72h triples. Keeps "sit flat" from being
  // the optimal policy during the learning phase.
  const inactionMultiplier = await (async () => {
    const h48 = new Date(Date.now() - 48 * 3600_000).toISOString();
    const h72 = new Date(Date.now() - 72 * 3600_000).toISOString();
    const [{ count: c48 }, { count: c72 }] = await Promise.all([
      supabase.from('ct_trades').select('id', { count: 'exact', head: true })
        .eq('trader', 'claude').gte('opened_at', h48),
      supabase.from('ct_trades').select('id', { count: 'exact', head: true })
        .eq('trader', 'claude').gte('opened_at', h72),
    ]);
    if ((c72 ?? 0) === 0) return 3;  // 72h flat
    if ((c48 ?? 0) === 0) return 2;  // 48h flat
    return 1;
  })();

  const decayPct = +(baseDecayPct * inactionMultiplier).toFixed(3);

  // 1. Active generation gate.
  const { data: activeGen } = await supabase
    .from('ct_claude_generations')
    .select('id, generation_number, survival_floor_usd')
    .eq('status', 'active')
    .order('generation_number', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!activeGen) {
    return new Response(JSON.stringify({
      ok: true, skipped: true, reason: 'no active generation', duration_ms: Date.now() - startedAt,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  // 2. Book + positions.
  const { book, session_date } = await getClaudeBookToday(supabase);
  if (!book) {
    return new Response(JSON.stringify({
      ok: true, skipped: true, reason: `no ct_book row for claude ${session_date}`, duration_ms: Date.now() - startedAt,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const ending = Number((book as Record<string, unknown>).ending_balance ?? (book as Record<string, unknown>).starting_balance ?? 0);
  const startingBalance = Number((book as Record<string, unknown>).starting_balance ?? ending);
  const prevRealized    = Number((book as Record<string, unknown>).realized_pnl ?? 0);
  const prevHwm         = Number((book as Record<string, unknown>).high_water_mark ?? ending);
  const bookId          = String((book as Record<string, unknown>).id);

  const notional = await sumOpenPositionNotional(supabase);
  const cash     = Math.max(0, ending - notional);
  const decayUsd = +(cash * decayPct / 100).toFixed(2);

  if (decayUsd <= 0) {
    await recordDecision(supabase, {
      decision_type: 'reflection',
      model_tier: 'none',
      reasoning: `Cash decay skipped: no uninvested cash to decay. ending_balance=${ending}, open_notional=${notional}.`,
      outcome: 'no_cash',
      context_snapshot: {
        source: 'ct-claude-cash-decay',
        generation_id: activeGen.id,
        ending_balance: ending,
        open_notional: notional,
        decay_daily_pct: decayPct,
      },
    });
    return new Response(JSON.stringify({
      ok: true, decay_usd: 0, cash, ending_before: ending, ending_after: ending, duration_ms: Date.now() - startedAt,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const newEnding   = +(ending - decayUsd).toFixed(2);
  const newRealized = +(prevRealized - decayUsd).toFixed(2);
  const newHwm      = Math.max(prevHwm, newEnding);

  const { error: updErr } = await supabase
    .from('ct_book')
    .update({
      ending_balance: newEnding,
      realized_pnl: newRealized,
      high_water_mark: newHwm,
    })
    .eq('id', bookId);
  if (updErr) {
    return new Response(JSON.stringify({ ok: false, error: `book update failed: ${updErr.message}` }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  await recordDecision(supabase, {
    decision_type: 'reflection',
    model_tier: 'none',
    reasoning: `cash decay applied: $${decayUsd} on $${cash.toFixed(2)} cash (cash_decay=${decayPct}%/day). ending ${ending} → ${newEnding}.`,
    outcome: 'cash_decay_applied',
    context_snapshot: {
      source: 'ct-claude-cash-decay',
      generation_id: activeGen.id,
      generation_number: activeGen.generation_number,
      session_date,
      starting_balance: startingBalance,
      ending_before: ending,
      ending_after: newEnding,
      cash,
      open_notional: notional,
      decay_daily_pct: decayPct,
      decay_usd: decayUsd,
    },
  });

  // 3. If we just breached survival, delegate to generation-manager.
  const survivalFloor = Number(activeGen.survival_floor_usd ?? 0);
  let survivalBreachHandoff = false;
  if (newEnding <= survivalFloor) {
    survivalBreachHandoff = true;
    const { error: dispatchErr } = await supabase.rpc('trigger_ct_claude_generation_manager');
    if (dispatchErr) {
      console.warn('[ct-claude-cash-decay] gen-manager dispatch failed:', dispatchErr.message);
    }
  }

  const body = {
    ok: true,
    session_date,
    generation_id: activeGen.id,
    generation_number: activeGen.generation_number,
    decay_daily_pct: decayPct,
    ending_before: ending,
    ending_after: newEnding,
    decay_usd: decayUsd,
    cash,
    open_notional: notional,
    survival_floor: survivalFloor,
    survival_breach_handoff: survivalBreachHandoff,
    duration_ms: Date.now() - startedAt,
  };
  console.log('[ct-claude-cash-decay]', JSON.stringify(body));
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
