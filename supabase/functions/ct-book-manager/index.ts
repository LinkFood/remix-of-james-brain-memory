/**
 * ct-book-manager — every 15min during market hours (14:00-19:45 UTC).
 *
 * For every ct_trades row with status='open' (or 'planned' on first tick
 * which we flip to 'open' at current fill), Claude reviews the live tape
 * and decides per position: HOLD / CUT / SCALE_IN / SCALE_OUT / FLIP.
 * Hard stops + targets are checked deterministically FIRST (Claude
 * doesn't get to argue with a stop).
 *
 * Auth: service role only.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { callClaude, CLAUDE_MODELS, parseTextContent, ClaudeError } from '../_shared/anthropic.ts';
import { getCurrentPrice } from '../_shared/ctGrader.ts';

const SYSTEM_PROMPT = `You manage a live paper book. 15min has passed. Each open trade has current price, unrealized P&L, and a reason it was opened.

For each trade emit ONE action:
  - HOLD: thesis intact, no change. Default if nothing changed.
  - CUT: close the trade now. Use when thesis is invalidated but stop not hit.
  - SCALE_OUT: reduce size (trim to lock profit). delta_size_pct = negative (e.g. -10).
  - SCALE_IN: add to winner. Only if conviction ≥4 AND room in book. delta_size_pct = positive.
  - FLIP: close + open opposite side. Only on clear thesis inversion with new signal.

Return EXACTLY:
{
  "actions": [
    {
      "trade_id": "uuid",
      "action": "hold" | "cut" | "scale_out" | "scale_in" | "flip",
      "delta_size_pct": -10 | null,
      "rationale": "one sentence"
    }
  ]
}

HARD RULES:
- Default to HOLD. Churning the book eats edge.
- Don't argue with a winner unless structure changed.
- Never CUT just because you're uncomfortable — only on thesis invalidation.
- SCALE_IN only after you're already in the green.`;

interface OpenTrade {
  id: string;
  instrument: string;
  side: 'long' | 'short';
  size_pct: number;
  entry_price: number;
  stop_price: number | null;
  target_price: number | null;
  thesis: string;
  conviction: number;
  opened_at: string | null;
  status: string;
}

interface Action {
  trade_id: string;
  action: 'hold' | 'cut' | 'scale_out' | 'scale_in' | 'flip';
  delta_size_pct: number | null;
  rationale: string;
}

function unrealizedPct(side: 'long' | 'short', entry: number, current: number): number {
  const raw = ((current - entry) / entry) * 100;
  return side === 'long' ? raw : -raw;
}

async function checkHardStops(
  supabase: SupabaseClient,
  trade: OpenTrade,
  currentPrice: number,
): Promise<boolean> {
  const hitStop = trade.stop_price != null && (
    (trade.side === 'long' && currentPrice <= trade.stop_price) ||
    (trade.side === 'short' && currentPrice >= trade.stop_price)
  );
  const hitTarget = trade.target_price != null && (
    (trade.side === 'long' && currentPrice >= trade.target_price) ||
    (trade.side === 'short' && currentPrice <= trade.target_price)
  );
  if (!hitStop && !hitTarget) return false;

  const pct = unrealizedPct(trade.side, trade.entry_price, currentPrice);
  const reason = hitStop ? 'stop_hit' : 'target_hit';
  await supabase.from('ct_trades').update({
    status: 'closed',
    close_price: currentPrice,
    closed_at: new Date().toISOString(),
    close_reason: reason,
    realized_pnl_pct: +pct.toFixed(3),
    realized_pnl_usd: null, // computed at EOD
  }).eq('id', trade.id);
  await supabase.from('ct_trade_actions').insert({
    trade_id: trade.id, action: 'cut', price: currentPrice,
    rationale: `deterministic ${reason} @ ${currentPrice}`,
  });
  return true;
}

serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  const corsHeaders = getCorsHeaders(req);
  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const sessionDate = new Date().toISOString().slice(0, 10);

  // Flip any 'planned' trades to 'open' at current (fill) price on the first tick
  const { data: planned } = await supabase
    .from('ct_trades')
    .select('id, instrument, side, size_pct, entry_price, stop_price, target_price, thesis, conviction, opened_at, status')
    .eq('session_date', sessionDate)
    .eq('status', 'planned');

  for (const t of (planned ?? []) as OpenTrade[]) {
    const fill = await getCurrentPrice(t.instrument);
    if (fill == null) continue;
    // Gap check: if the 9:30 fill has already blown past the planned stop
    // or overshot the planned target, cancel the trade honestly rather than
    // pretending we entered at fill (which would zero-out the overnight
    // move and mask whether Claude's thesis was right). "You couldn't have
    // been in the trade before the gap — you missed it."
    const gapPastTarget = t.target_price != null && (
      (t.side === 'long' && fill >= t.target_price) ||
      (t.side === 'short' && fill <= t.target_price)
    );
    const gapPastStop = t.stop_price != null && (
      (t.side === 'long' && fill <= t.stop_price) ||
      (t.side === 'short' && fill >= t.stop_price)
    );
    if (gapPastTarget || gapPastStop) {
      const reason = gapPastTarget ? 'gap_past_target' : 'gap_past_stop';
      // Compute the overnight move from planned entry to fill so we can
      // LOG the size of the missed move (for post-mortem), but don't
      // credit it to P&L since we wouldn't have been filled there.
      const plannedEntry = t.entry_price;
      const overnightPct = ((fill - plannedEntry) / plannedEntry) * 100 * (t.side === 'short' ? -1 : 1);
      await supabase.from('ct_trades').update({
        status: 'cancelled',
        close_price: fill,
        closed_at: new Date().toISOString(),
        close_reason: reason,
        realized_pnl_pct: 0,
      }).eq('id', t.id);
      await supabase.from('ct_trade_actions').insert({
        trade_id: t.id,
        action: 'cancel',
        price: fill,
        rationale: `${reason}: planned entry ${plannedEntry}, fill ${fill}, overnight move ${overnightPct.toFixed(2)}% (not captured — couldn't have entered before gap)`,
      });
      continue;
    }
    await supabase.from('ct_trades').update({
      status: 'open',
      entry_price: fill,     // reset to actual fill
      opened_at: new Date().toISOString(),
    }).eq('id', t.id);
  }

  // Pull current open book
  const { data: openTrades } = await supabase
    .from('ct_trades')
    .select('id, instrument, side, size_pct, entry_price, stop_price, target_price, thesis, conviction, opened_at, status')
    .eq('session_date', sessionDate)
    .eq('status', 'open');

  const open = (openTrades ?? []) as OpenTrade[];
  if (open.length === 0) {
    return new Response(JSON.stringify({ ok: true, open: 0, note: 'no live trades' }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Fetch current prices + deterministic stop/target hits
  const priceMap: Record<string, number> = {};
  for (const t of open) {
    const p = await getCurrentPrice(t.instrument);
    if (p == null) continue;
    priceMap[t.id] = p;
    await checkHardStops(supabase, t, p);
  }

  // Re-pull open after stops/targets
  const { data: stillOpen } = await supabase
    .from('ct_trades')
    .select('id, instrument, side, size_pct, entry_price, stop_price, target_price, thesis, conviction, opened_at, status')
    .eq('session_date', sessionDate)
    .eq('status', 'open');

  const live = (stillOpen ?? []) as OpenTrade[];
  if (live.length === 0) {
    return new Response(JSON.stringify({ ok: true, closed_by_stops: open.length, open: 0 }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Context for Claude
  const [heartbeat, flow, biases] = await Promise.all([
    supabase.from('ct_heartbeats').select('status_line, current_reads, created_at').order('created_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('ct_flow_alerts').select('ticker, side, premium, executed_at').gte('ingested_at', new Date(Date.now() - 30 * 60_000).toISOString()).in('ticker', live.map(l => l.instrument)).order('premium', { ascending: false }).limit(20),
    supabase.from('ct_biases').select('pattern, severity').eq('active', true).order('severity', { ascending: false }).limit(3),
  ]);

  const userMessage = JSON.stringify({
    open_trades: live.map(t => ({
      trade_id: t.id,
      instrument: t.instrument,
      side: t.side,
      size_pct: t.size_pct,
      entry_price: t.entry_price,
      current_price: priceMap[t.id] ?? null,
      unrealized_pct: priceMap[t.id] != null ? +unrealizedPct(t.side, t.entry_price, priceMap[t.id]).toFixed(2) : null,
      stop_price: t.stop_price,
      target_price: t.target_price,
      thesis: t.thesis,
      conviction: t.conviction,
      opened_at: t.opened_at,
    })),
    latest_market_state: heartbeat.data ?? null,
    recent_flow_last_30min: flow.data ?? [],
    known_biases: biases.data ?? [],
    note: 'Review each open trade. Emit ONE action per trade_id per the system schema. Return ONLY the JSON.',
  });

  let claudeText = '';
  try {
    const res = await callClaude({
      model: CLAUDE_MODELS.haiku,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
      max_tokens: 1200,
      temperature: 0.1,
    });
    claudeText = parseTextContent(res);
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const cleaned = claudeText.replace(/^\s*```(?:json)?\s*/, '').replace(/\s*```\s*$/, '').trim();
  let parsed: { actions?: Action[] };
  try { parsed = JSON.parse(cleaned); } catch {
    return new Response(JSON.stringify({ error: 'invalid json', raw: claudeText.slice(0, 300) }), {
      status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  let closed = 0, scaled = 0, held = 0, flipped = 0;
  const now = new Date().toISOString();
  for (const a of parsed.actions ?? []) {
    const trade = live.find(t => t.id === a.trade_id);
    if (!trade) continue;
    const price = priceMap[trade.id];
    if (price == null) continue;

    if (a.action === 'hold') {
      await supabase.from('ct_trade_actions').insert({ trade_id: trade.id, action: 'hold', price, rationale: a.rationale });
      held++;
    } else if (a.action === 'cut') {
      const pct = unrealizedPct(trade.side, trade.entry_price, price);
      await supabase.from('ct_trades').update({
        status: 'closed', close_price: price, closed_at: now, close_reason: 'manual_cut', realized_pnl_pct: +pct.toFixed(3),
      }).eq('id', trade.id);
      await supabase.from('ct_trade_actions').insert({ trade_id: trade.id, action: 'cut', price, rationale: a.rationale });
      closed++;
    } else if (a.action === 'scale_out') {
      const delta = Math.abs(a.delta_size_pct ?? 10);
      const newSize = Math.max(0, trade.size_pct - delta);
      if (newSize === 0) {
        const pct = unrealizedPct(trade.side, trade.entry_price, price);
        await supabase.from('ct_trades').update({ status: 'closed', close_price: price, closed_at: now, close_reason: 'scaled_to_zero', realized_pnl_pct: +pct.toFixed(3) }).eq('id', trade.id);
        closed++;
      } else {
        await supabase.from('ct_trades').update({ size_pct: newSize }).eq('id', trade.id);
        scaled++;
      }
      await supabase.from('ct_trade_actions').insert({ trade_id: trade.id, action: 'scale_out', price, delta_size_pct: -delta, rationale: a.rationale });
    } else if (a.action === 'scale_in') {
      const delta = Math.abs(a.delta_size_pct ?? 10);
      const newSize = Math.min(40, trade.size_pct + delta);
      await supabase.from('ct_trades').update({ size_pct: newSize }).eq('id', trade.id);
      await supabase.from('ct_trade_actions').insert({ trade_id: trade.id, action: 'scale_in', price, delta_size_pct: delta, rationale: a.rationale });
      scaled++;
    } else if (a.action === 'flip') {
      const pct = unrealizedPct(trade.side, trade.entry_price, price);
      await supabase.from('ct_trades').update({ status: 'closed', close_price: price, closed_at: now, close_reason: 'flipped', realized_pnl_pct: +pct.toFixed(3) }).eq('id', trade.id);
      await supabase.from('ct_trades').insert({
        session_date: sessionDate,
        instrument: trade.instrument,
        side: trade.side === 'long' ? 'short' : 'long',
        size_pct: trade.size_pct,
        size_usd: 0, // recomputed at EOD
        entry_price: price,
        stop_price: null,
        target_price: null,
        thesis: `flipped from ${trade.side}: ${a.rationale}`,
        horizon: 'intraday',
        conviction: 3,
        status: 'open',
        opened_at: now,
      });
      await supabase.from('ct_trade_actions').insert({ trade_id: trade.id, action: 'flip', price, rationale: a.rationale });
      flipped++;
    }
  }

  return new Response(JSON.stringify({ ok: true, held, closed, scaled, flipped, reviewed: live.length }), {
    status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
