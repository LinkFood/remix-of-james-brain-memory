/**
 * ct-claude-book-writer — scan armed trade ideas, fire the ones whose
 * entry_trigger has evaluated true, expire the rest.
 *
 * Flow (every heartbeat):
 *   1. SELECT ct_trade_ideas WHERE status='armed' AND trader='claude' AND
 *      expires_at > now().
 *   2. For each idea, load the instrument's current spot (heartbeat →
 *      gex_timeseries fallback). Evaluate the entry_trigger:
 *        - price_cross + condition=above/below  → spot >/< level
 *        - break_above                          → crossed above over last 2 HBs
 *        - break_below                          → crossed below over last 2 HBs
 *        - touch_level                          → spot within 0.1% of level
 *        - time_gate                            → now >= entry_trigger.time
 *   3. On trigger fire: insert a ct_trades row, flip idea to 'filled', link
 *      trade_id, bump ct_book trades_count for Claude today.
 *   4. Armed + expired (expires_at <= now): mark 'expired' with reason.
 *
 * Auth: service role only. Called by pg_cron every 2 min RTH.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';

interface TradeIdea {
  id: string;
  hypothesis_id: string | null;
  instrument: string;
  contract_type: string;
  strike: number | null;
  expiry: string | null;
  direction: 'long' | 'short';
  entry_trigger: {
    type: string;
    level?: number;
    condition?: string;
    time?: string;
  };
  entry_price_target: number | null;
  stop_pct: number;
  target_pct: number;
  size_pct: number;
  horizon: string;
  rationale: string;
  armed_at: string;
  expires_at: string;
}

/** Get the latest spot for a ticker from heartbeats → gex_timeseries fallback. */
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

/** Pull two most recent spot readings for a ticker — used by break_above/below. */
async function recentSpots(supabase: SupabaseClient, ticker: string): Promise<number[]> {
  const out: number[] = [];
  const { data: hbRows } = await supabase
    .from('ct_heartbeats')
    .select('current_reads, created_at')
    .order('created_at', { ascending: false })
    .limit(4);
  for (const hb of hbRows ?? []) {
    const reads = hb.current_reads as Record<string, unknown> | null;
    if (!reads || typeof reads !== 'object') continue;
    const per = reads[ticker] as Record<string, unknown> | undefined;
    const spot = per && typeof per === 'object' ? (per.spot ?? per.price ?? per.underlying_price) : undefined;
    const p = typeof spot === 'number' ? spot : typeof spot === 'string' ? parseFloat(spot) : NaN;
    if (Number.isFinite(p)) out.push(p);
    if (out.length >= 2) break;
  }
  if (out.length < 2) {
    const { data: gex } = await supabase
      .from('ct_gex_timeseries')
      .select('underlying_price, snapshot_at')
      .eq('ticker', ticker)
      .order('snapshot_at', { ascending: false })
      .limit(4);
    for (const g of gex ?? []) {
      const p = g.underlying_price;
      if (typeof p === 'number' && Number.isFinite(p)) out.push(p);
      if (out.length >= 2) break;
    }
  }
  return out;
}

interface TriggerEval {
  fired: boolean;
  reason: string;
}

async function evaluateTrigger(supabase: SupabaseClient, idea: TradeIdea, spot: number | null): Promise<TriggerEval> {
  const t = idea.entry_trigger;
  const now = Date.now();
  if (t.type === 'time_gate') {
    if (!t.time) return { fired: false, reason: 'time_gate missing time' };
    const fireAt = Date.parse(t.time);
    if (!Number.isFinite(fireAt)) return { fired: false, reason: 'time_gate bad time' };
    return { fired: now >= fireAt, reason: now >= fireAt ? 'time reached' : 'time not reached' };
  }
  if (spot == null) return { fired: false, reason: 'no spot' };
  const level = t.level;
  if (typeof level !== 'number') return { fired: false, reason: 'no trigger level' };

  if (t.type === 'price_cross') {
    if (t.condition === 'above') return { fired: spot > level, reason: `spot ${spot} vs > ${level}` };
    if (t.condition === 'below') return { fired: spot < level, reason: `spot ${spot} vs < ${level}` };
    return { fired: false, reason: 'price_cross bad condition' };
  }
  if (t.type === 'touch_level') {
    const delta = Math.abs(spot - level) / level;
    return { fired: delta <= 0.001, reason: `|spot - level|/level = ${(delta * 100).toFixed(3)}% vs 0.1%` };
  }
  if (t.type === 'break_above') {
    const pair = await recentSpots(supabase, idea.instrument);
    if (pair.length < 2) return { fired: false, reason: 'need 2 recent spots' };
    const [curr, prev] = pair;
    return { fired: prev <= level && curr > level, reason: `prev ${prev} → curr ${curr} vs ${level}` };
  }
  if (t.type === 'break_below') {
    const pair = await recentSpots(supabase, idea.instrument);
    if (pair.length < 2) return { fired: false, reason: 'need 2 recent spots' };
    const [curr, prev] = pair;
    return { fired: prev >= level && curr < level, reason: `prev ${prev} → curr ${curr} vs ${level}` };
  }
  return { fired: false, reason: `unknown trigger type ${t.type}` };
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

  // Safety gate: if Claude is circuit-broken today, DO NOT fire any new
  // trades. Existing positions are managed by ct-claude-book-exit-watcher
  // (intentionally NOT gated — stops/targets must still close).
  {
    const { data: haltRows } = await supabase.rpc('is_claude_trading_halted');
    const halt = Array.isArray(haltRows) ? haltRows[0] : null;
    if (halt && halt.halted === true) {
      const reason = `circuit breaker active: ${halt.breaker_type} — ${halt.reason}`;
      await supabase.from('ct_claude_decisions').insert({
        decision_type: 'no_trade',
        model_tier:    'none',
        reasoning:     reason,
        outcome:       'skipped: circuit_breaker_active',
        context_snapshot: {
          source:       'ct-claude-book-writer',
          breaker_type: halt.breaker_type,
          tripped_at:   halt.tripped_at,
        },
      });
      return new Response(JSON.stringify({
        ok: true,
        halted: true,
        breaker_type: halt.breaker_type,
        reason,
        duration_ms: Date.now() - startedAt,
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
  }

  const nowIso = new Date().toISOString();

  // 1) Expire stale ideas first.
  const { data: staleRows, error: staleErr } = await supabase
    .from('ct_trade_ideas')
    .update({ status: 'expired', cancelled_reason: 'expired: trigger not met' })
    .eq('status', 'armed')
    .eq('trader', 'claude')
    .lte('expires_at', nowIso)
    .select('id');
  if (staleErr) {
    console.warn('[ct-claude-book-writer] expire failed:', staleErr.message);
  }
  const expiredCount = staleRows?.length ?? 0;

  // 2) Pull live armed ideas.
  const { data: ideas, error: ideasErr } = await supabase
    .from('ct_trade_ideas')
    .select('id, hypothesis_id, instrument, contract_type, strike, expiry, direction, entry_trigger, entry_price_target, stop_pct, target_pct, size_pct, horizon, rationale, armed_at, expires_at')
    .eq('status', 'armed')
    .eq('trader', 'claude')
    .gt('expires_at', nowIso)
    .order('armed_at', { ascending: true });
  if (ideasErr) {
    return new Response(JSON.stringify({ ok: false, error: `ideas load: ${ideasErr.message}` }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (!ideas || ideas.length === 0) {
    return new Response(JSON.stringify({
      ok: true, filled: 0, evaluated: 0, expired: expiredCount, duration_ms: Date.now() - startedAt,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  // Session date — America/New_York date boundary matches the seeded ct_book row.
  const sessionDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());

  // Resolve Claude's current book balance for sizing.
  const { data: bookRow } = await supabase
    .from('ct_book')
    .select('id, starting_balance, ending_balance')
    .eq('trader', 'claude')
    .eq('session_date', sessionDate)
    .maybeSingle();
  const bookBalance = (bookRow?.ending_balance as number | undefined)
    ?? (bookRow?.starting_balance as number | undefined)
    ?? 100000;

  const results: Array<{ idea_id: string; outcome: string; reason?: string; trade_id?: string }> = [];
  let filled = 0;

  for (const rawIdea of ideas as TradeIdea[]) {
    const idea = rawIdea;
    const spot = await resolveSpot(supabase, idea.instrument);
    const evalResult = await evaluateTrigger(supabase, idea, spot);

    if (!evalResult.fired) {
      results.push({ idea_id: idea.id, outcome: 'waiting', reason: evalResult.reason });
      continue;
    }

    // Fire: compute fill. For time_gate or missing spot, use entry_price_target.
    const entryPrice = spot ?? idea.entry_price_target;
    if (entryPrice == null || !Number.isFinite(entryPrice)) {
      results.push({ idea_id: idea.id, outcome: 'no_entry_price' });
      continue;
    }

    const sizeUsd = +(bookBalance * (idea.size_pct / 100)).toFixed(2);
    const isLong = idea.direction === 'long';
    const stopPrice = +(entryPrice * (1 + (isLong ? idea.stop_pct : -idea.stop_pct) / 100)).toFixed(4);
    const targetPrice = +(entryPrice * (1 + (isLong ? idea.target_pct : -idea.target_pct) / 100)).toFixed(4);

    // Pull hypothesis info for thesis text + conviction.
    let thesis = idea.rationale;
    let conviction = 3;
    if (idea.hypothesis_id) {
      const { data: hyp } = await supabase
        .from('ct_hypotheses')
        .select('claim, confidence')
        .eq('id', idea.hypothesis_id)
        .maybeSingle();
      if (hyp) {
        thesis = (hyp.claim as string) ?? idea.rationale;
        const c = hyp.confidence as number;
        conviction = Math.max(1, Math.min(5, Math.round(c * 10 / 2))); // confidence 0-1 → 1-5
        if (Number.isFinite(c)) {
          // Direct mapping: conviction = round(confidence * 10) clipped 1-5.
          conviction = Math.max(1, Math.min(5, Math.round(c * 10)));
        }
      }
    }

    const tradeRow = {
      trader:          'claude',
      session_date:    sessionDate,
      instrument:      idea.instrument,
      side:            idea.direction,
      size_pct:        idea.size_pct,
      size_usd:        sizeUsd,
      entry_price:     entryPrice,
      stop_price:      stopPrice,
      target_price:    targetPrice,
      thesis,
      thesis_theme:    idea.hypothesis_id ?? 'claude-autonomous',
      horizon:         idea.horizon === 'session' ? 'intraday' : idea.horizon,
      conviction,
      status:          'open',
      opened_at:       new Date().toISOString(),
      hypothesis_id:   idea.hypothesis_id,
      trade_idea_id:   idea.id,
      prompt_version:  'ct-trade-engine-v1',
    };

    const { data: insertedTrade, error: tradeErr } = await supabase
      .from('ct_trades')
      .insert(tradeRow)
      .select('id')
      .single();

    if (tradeErr || !insertedTrade) {
      results.push({ idea_id: idea.id, outcome: 'trade_insert_failed', reason: tradeErr?.message ?? 'no data' });
      continue;
    }

    const { error: updErr } = await supabase
      .from('ct_trade_ideas')
      .update({
        status:       'filled',
        triggered_at: new Date().toISOString(),
        filled_at:    new Date().toISOString(),
        trade_id:     insertedTrade.id,
      })
      .eq('id', idea.id);
    if (updErr) {
      console.warn(`[ct-claude-book-writer] idea update failed for ${idea.id}:`, updErr.message);
    }

    filled++;
    results.push({ idea_id: idea.id, outcome: 'filled', trade_id: insertedTrade.id });
  }

  // Bump Claude's book trades_count once for the batch.
  if (filled > 0 && bookRow?.id) {
    const { data: currentBook } = await supabase
      .from('ct_book')
      .select('trades_count')
      .eq('id', bookRow.id)
      .maybeSingle();
    const prev = (currentBook?.trades_count as number | undefined) ?? 0;
    await supabase.from('ct_book').update({ trades_count: prev + filled }).eq('id', bookRow.id);
  }

  const body = {
    ok: true,
    evaluated: ideas.length,
    filled,
    expired: expiredCount,
    session_date: sessionDate,
    book_balance: bookBalance,
    results,
    duration_ms: Date.now() - startedAt,
  };
  console.log('[ct-claude-book-writer]', JSON.stringify(body));
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
