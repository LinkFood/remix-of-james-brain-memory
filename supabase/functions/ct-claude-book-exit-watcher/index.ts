/**
 * ct-claude-book-exit-watcher — closes Claude's open paper trades when they
 * hit stop, target, or horizon expiry. Grades each closed trade against its
 * originating hypothesis so the existing grade-insert trigger updates Elo.
 *
 * Flow (every heartbeat RTH):
 *   1. SELECT ct_trades WHERE trader='claude' AND status='open'.
 *   2. For each, pull current spot (heartbeat → gex_timeseries fallback).
 *   3. Close on:
 *        - long + spot <= stop_price  → 'stopped_out'
 *        - long + spot >= target_price → 'target_hit'
 *        - short + spot >= stop_price → 'stopped_out'
 *        - short + spot <= target_price → 'target_hit'
 *        - intraday + past 4pm ET today → 'session_close'
 *        - session + past 4pm ET of opened_at session → 'session_close'
 *   4. Compute realized_pnl_pct and realized_pnl_usd, update ct_trades.
 *   5. Insert ct_grades row with subject_type='trade' + hypothesis_id so the
 *      AFTER INSERT trigger fires update_hypothesis_confidence.
 *   6. Update ct_book (Claude, today): wins/losses/realized_pnl/ending_balance.
 *
 * Auth: service role only. Called by pg_cron every 2 min during RTH.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';

interface OpenTrade {
  id: string;
  session_date: string;
  instrument: string;
  side: 'long' | 'short';
  size_pct: number;
  size_usd: number;
  entry_price: number;
  stop_price: number | null;
  target_price: number | null;
  thesis: string;
  horizon: string | null;
  opened_at: string | null;
  hypothesis_id: string | null;
  trade_idea_id: string | null;
}

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

/**
 * True if we are currently past 4pm ET (20:00 UTC standard / 21:00 during DST)
 * on the session date given. Uses a simple America/New_York hour check.
 */
function pastSessionClose(sessionDate: string): boolean {
  const nowNy = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const [y, m, d] = sessionDate.split('-').map((x) => parseInt(x, 10));
  // Build the close moment: the session date at 16:00 ET of that date.
  const todayNy = `${nowNy.getFullYear()}-${String(nowNy.getMonth() + 1).padStart(2, '0')}-${String(nowNy.getDate()).padStart(2, '0')}`;
  const sessionYmd = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  if (todayNy > sessionYmd) return true;
  if (todayNy < sessionYmd) return false;
  // Same calendar day: check hour.
  return nowNy.getHours() >= 16;
}

function classifyVerdict(pnlPct: number): 'right' | 'wrong' | 'ambiguous' {
  if (pnlPct > 0.05) return 'right';
  if (pnlPct < -0.05) return 'wrong';
  return 'ambiguous';
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

  const { data: trades, error: tradesErr } = await supabase
    .from('ct_trades')
    .select('id, session_date, instrument, side, size_pct, size_usd, entry_price, stop_price, target_price, thesis, horizon, opened_at, hypothesis_id, trade_idea_id')
    .eq('trader', 'claude')
    .eq('status', 'open');
  if (tradesErr) {
    return new Response(JSON.stringify({ ok: false, error: `trades load: ${tradesErr.message}` }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (!trades || trades.length === 0) {
    return new Response(JSON.stringify({
      ok: true, evaluated: 0, closed: 0, duration_ms: Date.now() - startedAt,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const sessionDateToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());

  const results: Array<{ trade_id: string; outcome: string; close_reason?: string; pnl_pct?: number }> = [];
  const closedTodayByBook: Record<string, { wins: number; losses: number; realized_usd: number }> = {};

  for (const raw of trades as OpenTrade[]) {
    const trade = raw;
    const spot = await resolveSpot(supabase, trade.instrument);
    if (spot == null) {
      results.push({ trade_id: trade.id, outcome: 'no_spot' });
      continue;
    }

    const isLong = trade.side === 'long';
    let closeReason: string | null = null;
    let closePrice: number = spot;

    // Stop + target evaluation.
    if (trade.stop_price != null) {
      if (isLong && spot <= trade.stop_price) {
        closeReason = 'stopped_out';
        closePrice = trade.stop_price;
      } else if (!isLong && spot >= trade.stop_price) {
        closeReason = 'stopped_out';
        closePrice = trade.stop_price;
      }
    }
    if (!closeReason && trade.target_price != null) {
      if (isLong && spot >= trade.target_price) {
        closeReason = 'target_hit';
        closePrice = trade.target_price;
      } else if (!isLong && spot <= trade.target_price) {
        closeReason = 'target_hit';
        closePrice = trade.target_price;
      }
    }

    // Horizon expiry. intraday → must close today by 4pm ET. session → 4pm ET
    // of opened_at's session (= session_date field).
    if (!closeReason) {
      const horizon = (trade.horizon ?? 'intraday').toLowerCase();
      if (horizon === 'intraday' || horizon === 'session') {
        const refSession = trade.session_date ?? sessionDateToday;
        if (pastSessionClose(refSession)) {
          closeReason = 'session_close';
          closePrice = spot;
        }
      }
    }

    if (!closeReason) {
      results.push({ trade_id: trade.id, outcome: 'hold' });
      continue;
    }

    const entry = trade.entry_price;
    const pnlPct = isLong
      ? ((closePrice / entry) - 1) * 100
      : ((entry / closePrice) - 1) * 100;
    const pnlUsd = +(trade.size_usd * pnlPct / 100).toFixed(2);
    const pnlPctRounded = +pnlPct.toFixed(4);

    const { error: updErr } = await supabase
      .from('ct_trades')
      .update({
        status:            'closed',
        close_price:       closePrice,
        closed_at:         new Date().toISOString(),
        close_reason:      closeReason,
        realized_pnl_pct:  pnlPctRounded,
        realized_pnl_usd:  pnlUsd,
      })
      .eq('id', trade.id);
    if (updErr) {
      results.push({ trade_id: trade.id, outcome: 'update_failed', close_reason: updErr.message });
      continue;
    }

    // Insert grade — the ct_grades AFTER INSERT trigger fires
    // ct-hypothesis-confidence-update automatically when hypothesis_id is set.
    const verdict = classifyVerdict(pnlPctRounded);
    const actualDirection = pnlPctRounded > 0.05 ? 'bullish' : pnlPctRounded < -0.05 ? 'bearish' : 'flat';
    const { error: gradeErr } = await supabase.from('ct_grades').insert({
      hypothesis_id:     trade.hypothesis_id,
      subject_type:      'trade',
      subject_id:        trade.id,
      instrument:        trade.instrument,
      claimed_direction: trade.side === 'long' ? 'bullish' : 'bearish',
      entry_price:       entry,
      exit_price:        closePrice,
      actual_return_pct: pnlPctRounded,
      actual_direction:  actualDirection,
      verdict,
      notes:             `close:${closeReason} size:${trade.size_usd} pnl_usd:${pnlUsd}`,
    });
    if (gradeErr) {
      console.warn(`[ct-claude-book-exit-watcher] grade insert failed for ${trade.id}:`, gradeErr.message);
    }

    // Accumulate per-session-date book deltas.
    const key = trade.session_date ?? sessionDateToday;
    const agg = closedTodayByBook[key] ?? { wins: 0, losses: 0, realized_usd: 0 };
    if (pnlUsd > 0) agg.wins += 1;
    else if (pnlUsd < 0) agg.losses += 1;
    agg.realized_usd += pnlUsd;
    closedTodayByBook[key] = agg;

    results.push({ trade_id: trade.id, outcome: 'closed', close_reason: closeReason, pnl_pct: pnlPctRounded });
  }

  // Apply book deltas per session.
  for (const [sessionDate, agg] of Object.entries(closedTodayByBook)) {
    const { data: bookRow } = await supabase
      .from('ct_book')
      .select('id, starting_balance, ending_balance, realized_pnl, wins, losses, high_water_mark')
      .eq('trader', 'claude')
      .eq('session_date', sessionDate)
      .maybeSingle();
    if (!bookRow) {
      console.warn(`[ct-claude-book-exit-watcher] no book row for claude ${sessionDate}`);
      continue;
    }
    const starting = (bookRow.starting_balance as number) ?? 100000;
    const prevRealized = (bookRow.realized_pnl as number | null) ?? 0;
    const newRealized = +(prevRealized + agg.realized_usd).toFixed(2);
    const newEnding = +(starting + newRealized).toFixed(2);
    const prevHwm = (bookRow.high_water_mark as number | null) ?? starting;
    const newHwm = Math.max(prevHwm, newEnding);

    await supabase.from('ct_book').update({
      realized_pnl:   newRealized,
      ending_balance: newEnding,
      wins:           ((bookRow.wins as number | null) ?? 0) + agg.wins,
      losses:         ((bookRow.losses as number | null) ?? 0) + agg.losses,
      high_water_mark: newHwm,
    }).eq('id', bookRow.id);
  }

  const body = {
    ok: true,
    evaluated: trades.length,
    closed: results.filter((r) => r.outcome === 'closed').length,
    book_updates: closedTodayByBook,
    results,
    duration_ms: Date.now() - startedAt,
  };
  console.log('[ct-claude-book-exit-watcher]', JSON.stringify(body));
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
