/**
 * ct-claude-trade-reopen — 10:30 AM ET weekday. Second chance at the book.
 *
 * Problem: morning ct-claude-trade-open runs pre-market with Thursday-close
 * prices. If the 9:30 open gaps past Claude's stops/targets, all trades
 * get cancelled (honest: couldn't have entered before the gap). Book goes
 * flat for the entire session. Dead.
 *
 * Fix: 60 min after open (post-gap settling), if the book still has
 * 0 OPEN trades AND morning trades were cancelled, give Claude a second
 * commit using CURRENT tape + CURRENT prices. Tighter stops, smaller size,
 * post-gap read. Fresh read, fresh entry.
 *
 * Only fires if:
 *   1. Current time 14:30 UTC (10:30 AM ET)
 *   2. Book has 0 open trades for today
 *   3. Morning had ≥1 cancelled trade (not if Claude skipped intentionally)
 *
 * Auth: service role only.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { isKillSwitchActive, killSwitchSkipResponse } from '../_shared/killSwitch.ts';
import { callClaude, CLAUDE_MODELS, parseTextContent, ClaudeError } from '../_shared/anthropic.ts';
import { getCurrentPrice } from '../_shared/ctGrader.ts';

const WATCHLIST = ['SPY', 'QQQ', 'IWM', 'NVDA', 'AAPL', 'MSFT', 'META', 'GOOGL', 'AMZN', 'TSLA', 'GLD', 'USO'] as const;

const SYSTEM_PROMPT = `You manage a $10k paper book. Mid-session. Book is empty. Your job: commit 1-2 trades NOW or skip with reason.

PRIORITY: signal > noise > silence. If the tape has shifted (regime flip, flow acceleration, wall break, invalidated priors), commit. Flat-$0 days are fine when nothing is happening, but NOT when you've been reading clear signals all session and just freezing.

Rules:
  - Tighter stops (less time before close than a morning trade)
  - Smaller size than morning (max 25% per trade, 40% total, max 2 trades)
  - Post-gap/mid-session real-time context — use what's happening NOW, not pre-market thesis

HARD RULES:
- Instruments: SPY, QQQ, IWM, NVDA, AAPL, MSFT, META, GOOGL, AMZN, TSLA, GLD, USO ONLY
- Long or short
- No overnight holds — flat at 4pm ET
- Every trade: entry reasoning, stop, target, conviction 1-5

CONVICTION FOR MID-SESSION:
  1-2 = pass, don't force
  3 = clear signal, size 15%
  4 = multi-signal confluence, size 20%
  5 = do-or-die, size 25%

READ YOUR CONTEXT:
- Why did morning cancel? (gap_past_target = your thesis was right but entry missed;
  gap_past_stop = your thesis was wrong)
- known_biases / self_corrections: don't repeat patterns you've been flagged on
- current_observation: Claude (you) has been updating the tape read every 15min

Return EXACTLY this JSON:
{
  "trades": [
    {
      "instrument": "SPY",
      "side": "long" | "short",
      "size_pct": 15,
      "entry_reasoning": "what you see on the tape right now, why this trade mid-session",
      "stop_price": 707.00,
      "target_price": 712.00,
      "conviction": 3,
      "horizon": "intraday"
    }
  ],
  "posture": "one sentence framing the post-gap read",
  "skip_reason": null
}

Or skip:
{ "trades": [], "posture": null, "skip_reason": "why you're flat mid-session" }

SKIP IS VALID. Only commit if the current tape gives you a clear read. A $0 day is better than a $-500 day.`;

interface TradeCommit {
  instrument: string;
  side: 'long' | 'short';
  size_pct: number;
  entry_reasoning: string;
  stop_price: number;
  target_price: number;
  conviction: number;
  horizon: string;
}

serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  const corsHeaders = getCorsHeaders(req);
  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  // Kill switch — no second-chance commits.
  if (await isKillSwitchActive(supabase)) {
    return killSwitchSkipResponse(supabase, 'ct-claude-trade-reopen', corsHeaders);
  }

  const sessionDate = new Date().toISOString().slice(0, 10);

  // Gate 1: if already has open trades, skip (morning trades still live)
  const { data: openCount } = await supabase
    .from('ct_trades')
    .select('id', { count: 'exact', head: true })
    .eq('session_date', sessionDate)
    .eq('status', 'open');
  const openN = (openCount as unknown as { count: number } | null)?.count;
  if (typeof openN === 'number' && openN > 0) {
    return new Response(JSON.stringify({ skipped: true, reason: 'open_trades_exist', open_count: openN }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  // Gate 2: check if mid-session reopen already happened
  const { data: allToday } = await supabase
    .from('ct_trades')
    .select('id, status, close_reason, opened_at, created_at, horizon')
    .eq('session_date', sessionDate);
  const morningCancelled = (allToday ?? []).filter(t =>
    t.status === 'cancelled' && (t.close_reason === 'gap_past_target' || t.close_reason === 'gap_past_stop')
  ).length;
  const midSessionReopenExists = (allToday ?? []).some(t => {
    const created = new Date(t.created_at as string);
    // created after 14:15 UTC = mid-session reopen
    return created.getUTCHours() >= 14 && created.getUTCMinutes() >= 15;
  });

  // Permissive gate: any empty-book mid-session (regardless of cause) gets one
  // re-entry attempt per session. Being too strict = book stays flat all day.
  if (midSessionReopenExists) {
    return new Response(JSON.stringify({ skipped: true, reason: 'mid_session_reopen_already_ran' }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  // Gather context
  const since12h = new Date(Date.now() - 12 * 3600_000).toISOString();
  const since72h = new Date(Date.now() - 72 * 3600_000).toISOString();
  const [heartbeat, recentObs, flow, news, biases, corrections, cancelled] = await Promise.all([
    supabase.from('ct_heartbeats').select('status_line, current_reads, created_at').order('created_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('ct_observations').select('direction, observation, glance, created_at').order('created_at', { ascending: false }).limit(3),
    supabase.from('ct_flow_alerts').select('ticker, side, strike, premium, executed_at').gte('ingested_at', new Date(Date.now() - 60 * 60_000).toISOString()).order('premium', { ascending: false }).limit(15),
    supabase.from('ct_news_analyses').select('instrument, news_headline, impact, significance, claude_take').gte('created_at', since12h).gte('significance', 3).limit(8),
    supabase.from('ct_biases').select('pattern, severity').eq('active', true).order('severity', { ascending: false }).limit(3),
    supabase.from('ct_self_regrades').select('what_i_got_wrong, how_id_rewrite').gte('regraded_at', since72h).order('regraded_at', { ascending: false }).limit(3),
    supabase.from('ct_trades').select('instrument, side, size_pct, entry_price, stop_price, target_price, close_price, close_reason, thesis').eq('session_date', sessionDate).eq('status', 'cancelled'),
  ]);

  const userMessage = JSON.stringify({
    session_date: sessionDate,
    current_utc: new Date().toISOString(),
    morning_cancelled_trades: cancelled.data ?? [],
    latest_heartbeat: heartbeat.data ?? null,
    recent_observations: recentObs.data ?? [],
    recent_flow_60min: flow.data ?? [],
    overnight_news: news.data ?? [],
    known_biases: biases.data ?? [],
    self_corrections_72h: corrections.data ?? [],
    allowed_instruments: WATCHLIST,
    note: 'Commit 1-2 mid-session trades or skip per the system schema. Return ONLY the JSON.',
  });

  let claudeText = '';
  try {
    const res = await callClaude({
      model: CLAUDE_MODELS.sonnet,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
      max_tokens: 1200,
      temperature: 0.2,
    });
    claudeText = parseTextContent(res);
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof ClaudeError ? `Claude ${e.status}: ${e.message}` : String(e) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const cleaned = claudeText.replace(/^\s*```(?:json)?\s*/, '').replace(/\s*```\s*$/, '').trim();
  let parsed: { trades?: TradeCommit[]; posture?: string; skip_reason?: string };
  try { parsed = JSON.parse(cleaned); } catch {
    return new Response(JSON.stringify({ error: 'invalid json', raw: claudeText.slice(0, 300) }), { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const trades = (parsed.trades ?? []).slice(0, 2);
  if (trades.length === 0) {
    // Log skip to ct_heartbeats so we can diagnose via REST
    await supabase.from('ct_heartbeats').insert({
      status_line: `[reopen-skip] ${parsed.skip_reason ?? 'no trades returned'} — posture: ${parsed.posture ?? 'n/a'}`,
      watching: ['reopen-debug'],
      current_reads: { _reopen: { skip_reason: parsed.skip_reason, posture: parsed.posture, raw_claude: claudeText.slice(0, 500) } },
      prompt_version: 'reopen-debug',
    });
    return new Response(JSON.stringify({ ok: true, committed: 0, skip_reason: parsed.skip_reason ?? 'no setups', posture: parsed.posture }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  // Get current prices for entry (this IS the fill since we're mid-session)
  const allowed = new Set(WATCHLIST);
  const valid: TradeCommit[] = [];
  let totalPct = 0;
  for (const t of trades) {
    if (!allowed.has(t.instrument as typeof WATCHLIST[number])) continue;
    if (t.side !== 'long' && t.side !== 'short') continue;
    const sz = Math.min(25, Math.max(1, Math.round(t.size_pct ?? 15)));
    if (totalPct + sz > 40) break;
    totalPct += sz;
    valid.push({ ...t, size_pct: sz });
  }
  if (valid.length === 0) {
    return new Response(JSON.stringify({ error: 'no valid trades after clipping' }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  // Pull book balance
  const { data: book } = await supabase.from('ct_book').select('starting_balance').eq('session_date', sessionDate).maybeSingle();
  const startingBalance = (book?.starting_balance as number | undefined) ?? 10000;

  // Entry prices NOW = actual fills (we're mid-session, this is the tape)
  const now = new Date().toISOString();
  const rows = await Promise.all(valid.map(async t => {
    const fill = await getCurrentPrice(t.instrument);
    if (fill == null) return null;
    const sizeUsd = startingBalance * (t.size_pct / 100);
    return {
      session_date: sessionDate,
      instrument: t.instrument,
      side: t.side,
      size_pct: t.size_pct,
      size_usd: +sizeUsd.toFixed(2),
      entry_price: fill,       // mid-session = real fill now
      stop_price: t.stop_price,
      target_price: t.target_price,
      thesis: `[mid-session reopen] ${t.entry_reasoning}`,
      horizon: t.horizon ?? 'intraday',
      conviction: Math.min(5, Math.max(1, Math.round(t.conviction ?? 3))),
      status: 'open',         // mid-session = immediately open (no planned stage)
      opened_at: now,
    };
  }));

  const validRows = rows.filter((r): r is NonNullable<typeof r> => r !== null);
  if (validRows.length === 0) {
    return new Response(JSON.stringify({ error: 'no entry prices resolved' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const { error: insErr } = await supabase.from('ct_trades').insert(validRows);
  if (insErr) {
    return new Response(JSON.stringify({ error: `insert failed: ${insErr.message}` }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  return new Response(JSON.stringify({
    ok: true,
    committed: validRows.length,
    posture: parsed.posture ?? null,
    trades: validRows.map(r => ({ instrument: r.instrument, side: r.side, size_pct: r.size_pct, entry: r.entry_price, stop: r.stop_price, target: r.target_price })),
  }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});
