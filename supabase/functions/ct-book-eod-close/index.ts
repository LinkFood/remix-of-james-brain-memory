/**
 * ct-book-eod-close — 4:00 PM ET weekday. Close the book.
 *
 * 1. Close any still-open ct_trades at current (last market) price.
 * 2. Compute realized P&L in % and USD.
 * 3. Update ct_book: ending_balance, realized_pnl, trades_count, wins/losses,
 *    max_drawdown_pct, goal_hit, high_water_mark.
 * 4. Ask Claude for a 2-sentence recap (what worked / what didn't / tomorrow).
 * 5. Write ct_daily_recaps.
 *
 * Auth: service role only.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { callClaude, CLAUDE_MODELS, parseTextContent } from '../_shared/anthropic.ts';
import { getCurrentPrice } from '../_shared/ctGrader.ts';
import { logClaudeUsage } from '../_shared/claudeUsageLog.ts';
import { POST_MORTEM_SYSTEM } from '../_shared/ctPrompts.ts';

const RECAP_SYSTEM = `You just closed a trading day. Given the session's trades (entry/exit/P&L/thesis), write a brutally honest EOD recap.

Return EXACTLY:
{
  "recap": "2-sentence plain English — what today was",
  "what_worked": "one sentence — best decision",
  "what_didnt": "one sentence — worst decision or biggest miss",
  "tomorrow_posture": "one sentence — going-in bias for tomorrow"
}

Rules:
- No hedging. If you lost, say "I lost because X."
- "What didn't" must name a specific mistake, not "market was choppy."
- Tomorrow_posture is a real commitment, not "I'll stay flexible."`;

function unrealizedPct(side: 'long' | 'short', entry: number, current: number): number {
  const raw = ((current - entry) / entry) * 100;
  return side === 'long' ? raw : -raw;
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
  const now = new Date().toISOString();

  // Close any still-open trades at current price
  const { data: stillOpen } = await supabase
    .from('ct_trades')
    .select('id, instrument, side, size_pct, size_usd, entry_price')
    .eq('session_date', sessionDate)
    .eq('status', 'open');

  for (const t of stillOpen ?? []) {
    const price = await getCurrentPrice(t.instrument as string);
    if (price == null) continue;
    const pct = unrealizedPct(t.side as 'long' | 'short', t.entry_price as number, price);
    await supabase.from('ct_trades').update({
      status: 'closed', close_price: price, closed_at: now, close_reason: 'eod_flat', realized_pnl_pct: +pct.toFixed(3),
    }).eq('id', t.id);
  }

  // Pull all of today's closed trades for P&L accounting
  const { data: allTrades } = await supabase
    .from('ct_trades')
    .select('id, instrument, side, size_pct, size_usd, entry_price, close_price, close_reason, realized_pnl_pct, thesis, opened_at, closed_at')
    .eq('session_date', sessionDate)
    .eq('status', 'closed');

  const trades = allTrades ?? [];
  const { data: book } = await supabase
    .from('ct_book')
    .select('id, starting_balance, high_water_mark')
    .eq('session_date', sessionDate)
    .maybeSingle();

  const startingBalance = (book?.starting_balance as number | undefined) ?? 10000;

  // Each trade's $ P&L = (size_pct/100) * starting_balance * (realized_pnl_pct/100)
  let realizedUsd = 0;
  let wins = 0, losses = 0;
  for (const t of trades) {
    const pct = (t.realized_pnl_pct as number) ?? 0;
    const sizePct = (t.size_pct as number) ?? 0;
    const usd = (sizePct / 100) * startingBalance * (pct / 100);
    realizedUsd += usd;
    if (pct > 0) wins++;
    else if (pct < 0) losses++;

    // Backfill size_usd + realized_pnl_usd per trade
    await supabase.from('ct_trades').update({
      size_usd: +((sizePct / 100) * startingBalance).toFixed(2),
      realized_pnl_usd: +usd.toFixed(2),
    }).eq('id', t.id);
  }

  const endingBalance = startingBalance + realizedUsd;
  const goalHit = realizedUsd > 0;
  const hwm = Math.max((book?.high_water_mark as number | undefined) ?? 10000, endingBalance);
  const drawdownPct = hwm > 0 ? ((hwm - endingBalance) / hwm) * 100 : 0;

  await supabase.from('ct_book').update({
    ending_balance: +endingBalance.toFixed(2),
    realized_pnl: +realizedUsd.toFixed(2),
    unrealized_pnl: 0,
    trades_count: trades.length,
    wins, losses,
    max_drawdown_pct: +drawdownPct.toFixed(3),
    goal_hit: goalHit,
    high_water_mark: +hwm.toFixed(2),
    updated_at: now,
  }).eq('session_date', sessionDate);

  // Recap via Claude (skip if no trades)
  let recapPayload: { recap: string; what_worked: string; what_didnt: string; tomorrow_posture: string } | null = null;
  if (trades.length > 0) {
    const userMessage = JSON.stringify({
      session_date: sessionDate,
      starting_balance: startingBalance,
      ending_balance: +endingBalance.toFixed(2),
      realized_usd: +realizedUsd.toFixed(2),
      realized_pct: +((realizedUsd / startingBalance) * 100).toFixed(3),
      wins, losses, trades_count: trades.length,
      trades: trades.map(t => ({
        instrument: t.instrument, side: t.side, size_pct: t.size_pct,
        entry: t.entry_price, close: t.close_price, pct: t.realized_pnl_pct,
        close_reason: t.close_reason, thesis: t.thesis,
      })),
      note: 'Write the brutally honest EOD recap per the system schema. Return ONLY the JSON.',
    });

    try {
      const res = await callClaude({
        model: CLAUDE_MODELS.sonnet,
        system: RECAP_SYSTEM,
        messages: [{ role: 'user', content: userMessage }],
        max_tokens: 600,
        temperature: 0.3,
      });
      const cleaned = parseTextContent(res).replace(/^\s*```(?:json)?\s*/, '').replace(/\s*```\s*$/, '').trim();
      recapPayload = JSON.parse(cleaned);
    } catch (e) {
      console.warn('[eod-close] recap failed:', e instanceof Error ? e.message : e);
    }
  }

  if (recapPayload) {
    await supabase.from('ct_daily_recaps').upsert({
      session_date: sessionDate,
      recap: recapPayload.recap,
      what_worked: recapPayload.what_worked,
      what_didnt: recapPayload.what_didnt,
      tomorrow_posture: recapPayload.tomorrow_posture,
      pnl_pct: +((realizedUsd / startingBalance) * 100).toFixed(3),
    }, { onConflict: 'session_date' });
    await supabase.from('ct_book').update({ daily_recap: recapPayload.recap }).eq('session_date', sessionDate);
  }

  // Post-mortem backfill: any trade that closed today without claude_notes
  // (e.g. eod_flat just now, or a book-manager close where the fire-and-forget
  // never landed) gets a post-mortem here. Sequential + small volume (one
  // trading day) so we just await each one. Haiku, ~$0.001 per trade.
  let postMortemsWritten = 0;
  const { data: missing } = await supabase
    .from('ct_trades')
    .select('id, instrument, side, entry_price, stop_price, target_price, thesis, close_price, close_reason, realized_pnl_pct, opened_at, closed_at, contract_type')
    .eq('session_date', sessionDate)
    .eq('status', 'closed')
    .is('claude_notes', null);

  for (const t of missing ?? []) {
    if (t.close_price == null) continue;
    const durationMin = t.opened_at && t.closed_at
      ? Math.max(0, Math.round((new Date(t.closed_at as string).getTime() - new Date(t.opened_at as string).getTime()) / 60_000))
      : null;
    try {
      const started = Date.now();
      const res = await callClaude({
        model: CLAUDE_MODELS.haiku,
        system: POST_MORTEM_SYSTEM,
        messages: [{ role: 'user', content: JSON.stringify({
          instrument: t.instrument,
          side: t.side,
          contract_type: t.contract_type ?? 'underlying',
          entry_price: t.entry_price,
          stop_price: t.stop_price,
          target_price: t.target_price,
          thesis: t.thesis,
          actual_exit_price: t.close_price,
          close_reason: t.close_reason,
          realized_pnl_pct: t.realized_pnl_pct,
          duration_minutes: durationMin,
          note: 'Write the 2-3 sentence post-mortem per the system prompt. Plain prose only.',
        }) }],
        max_tokens: 400,
        temperature: 0.3,
      });
      const text = parseTextContent(res).trim();
      if (!text) continue;
      await supabase.from('ct_trades').update({
        claude_notes: text,
        journal_updated_at: new Date().toISOString(),
      }).eq('id', t.id as string);
      logClaudeUsage(supabase, {
        source: 'trade-post-mortem',
        model: CLAUDE_MODELS.haiku,
        usage: res.usage,
        duration_ms: Date.now() - started,
        metadata: { trade_id: t.id, instrument: t.instrument, close_reason: t.close_reason, via: 'eod-backfill' },
      });
      postMortemsWritten++;
    } catch (e) {
      console.warn('[eod-close] post-mortem backfill failed for', t.id, e instanceof Error ? e.message : e);
    }
  }

  return new Response(JSON.stringify({
    ok: true,
    session_date: sessionDate,
    starting_balance: startingBalance,
    ending_balance: +endingBalance.toFixed(2),
    realized_usd: +realizedUsd.toFixed(2),
    realized_pct: +((realizedUsd / startingBalance) * 100).toFixed(3),
    trades_count: trades.length, wins, losses, goal_hit: goalHit,
    recap: recapPayload?.recap ?? null,
    post_mortems_written: postMortemsWritten,
  }), {
    status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
