/**
 * ct-claude-trade-open — 9:26 ET weekday. Claude commits 1-3 paper trades
 * for the session. This is the book version of the pre-bell gauntlet:
 * not "predict direction," but "put size on it with a stop + target."
 *
 * Reads overnight context + biases + self-corrections + current GEX.
 * Writes to ct_trades with status='planned'. First book-manager tick
 * flips them to 'open' at the 9:30 fill price.
 *
 * Rules enforced here (not just in prompt):
 *  - Max 3 concurrent trades
 *  - Max 40% of book per trade
 *  - Total exposure cap 100% of book (sum of size_pct)
 *  - Underlying only (no options v1)
 *  - No overnight holds (EOD closer handles the flat)
 *
 * Auth: service role only.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { callClaude, CLAUDE_MODELS, parseTextContent, ClaudeError } from '../_shared/anthropic.ts';
import { getCurrentPrice } from '../_shared/ctGrader.ts';
import { classifyThesis } from '../_shared/thesisClassifier.ts';
import { CT_PROMPT_VERSION } from '../_shared/systemPromptV1.ts';
import { writeTradeAudit, deriveMarketRegime } from '../_shared/tradeAudit.ts';

const WATCHLIST = ['SPY', 'QQQ', 'IWM', 'NVDA', 'AAPL', 'MSFT', 'META', 'GOOGL', 'AMZN', 'TSLA', 'GLD', 'USO'] as const;

const SYSTEM_PROMPT = `You manage a $10k paper trading book. 9:26 AM ET. Market opens in 4 minutes.

Your job: commit 1-3 trades for today. Long or short — doesn't matter. Make money. Daily goal: positive P&L. Stretch: +0.5% ($50).

HARD RULES (enforced after your output — violations get clipped):
- Instruments: SPY, QQQ, IWM, NVDA, AAPL, MSFT, META, GOOGL, AMZN, TSLA, GLD, USO ONLY
- Side: long or short
- Max 3 trades total
- Max 40% of book per trade (size_pct 1-40)
- Total size_pct across all trades ≤ 100 (no leverage)
- No overnight holds — everything flat at 4pm ET
- Every trade MUST have: entry reasoning, stop price, target price, conviction 1-5

CONVICTION RUBRIC:
  1 = tossup, size 10-15%
  2 = lean, size 15-25%
  3 = thesis + 1 signal, size 20-30%
  4 = thesis + 2 signals, size 25-35%
  5 = multi-signal, high confidence, size 30-40%. USE SPARINGLY.

READ YOUR OWN HISTORY FIRST:
- known_biases: identity-level patterns. If current setup matches a bias, demote conviction or skip.
- self_corrections_72h: recent mistakes. Don't repeat them.
- recent_grades: your track record. Over-sized losses mean you were wrong about conviction before — account for it.

Return EXACTLY this JSON:
{
  "trades": [
    {
      "instrument": "SPY",
      "side": "long" | "short",
      "size_pct": 15,
      "entry_reasoning": "what you see on the tape that makes this trade",
      "stop_price": 695.00,
      "target_price": 708.00,
      "conviction": 3,
      "horizon": "intraday",
      "bias_check": "brief note on whether any known_bias applies, or 'clear'"
    }
  ],
  "posture": "one sentence framing the day (e.g. 'bear-biased into open, looking to scale if QQQ breaks 640')",
  "skip_reason": null
}

If the tape gives you nothing — no clear setup, violates biases, corpus thin — return:
{ "trades": [], "posture": null, "skip_reason": "why you're flat today" }

SKIP > FORCE. Flat is a position. But if you skip 5 days in a row you're not trying.`;

interface TradeCommit {
  instrument: string;
  side: 'long' | 'short';
  size_pct: number;
  entry_reasoning: string;
  stop_price: number;
  target_price: number;
  conviction: number;
  horizon: string;
  bias_check?: string;
}

serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
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

  const sessionDate = new Date().toISOString().slice(0, 10);

  // Idempotent — bail if already opened today
  const { data: existing } = await supabase
    .from('ct_trades')
    .select('id')
    .eq('session_date', sessionDate)
    .limit(1);
  if (existing && existing.length > 0) {
    return new Response(JSON.stringify({ skipped: true, reason: 'already_opened_today' }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Ensure today's book row. Rolls yesterday's ending balance forward.
  const { data: todayBook } = await supabase
    .from('ct_book')
    .select('id, starting_balance')
    .eq('session_date', sessionDate)
    .maybeSingle();

  let startingBalance = todayBook?.starting_balance as number | undefined;
  if (!todayBook) {
    const { data: priorBook } = await supabase
      .from('ct_book')
      .select('ending_balance, high_water_mark')
      .lt('session_date', sessionDate)
      .order('session_date', { ascending: false })
      .limit(1)
      .maybeSingle();
    startingBalance = (priorBook?.ending_balance as number | undefined) ?? 10000;
    const hwm = Math.max((priorBook?.high_water_mark as number | undefined) ?? 10000, startingBalance);
    await supabase.from('ct_book').insert({
      session_date: sessionDate,
      starting_balance: startingBalance,
      high_water_mark: hwm,
    });
  }

  // Gather context
  const since12h = new Date(Date.now() - 12 * 3600_000).toISOString();
  const since72h = new Date(Date.now() - 72 * 3600_000).toISOString();
  const [news, flow, heartbeat, biases, corrections, recentGrades, priorRecap, allActiveBiases] = await Promise.all([
    supabase.from('ct_news_analyses').select('instrument, news_headline, impact, significance, claude_take, created_at').gte('created_at', since12h).gte('significance', 3).order('significance', { ascending: false }).limit(10),
    supabase.from('ct_flow_alerts').select('ticker, side, strike, expiry, is_otm, size, premium, executed_at').gte('ingested_at', since12h).order('premium', { ascending: false }).limit(15),
    supabase.from('ct_heartbeats').select('id, status_line, current_reads, created_at').order('created_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('ct_biases').select('pattern, instruments, severity').eq('active', true).order('severity', { ascending: false }).limit(3),
    supabase.from('ct_self_regrades').select('what_i_got_wrong, how_id_rewrite, regraded_at').gte('regraded_at', since72h).order('regraded_at', { ascending: false }).limit(3),
    supabase.from('ct_grades').select('instrument, claimed_direction, verdict, actual_return_pct, graded_at').gte('graded_at', since72h).order('graded_at', { ascending: false }).limit(10),
    supabase.from('ct_daily_recaps').select('session_date, recap, what_worked, what_didnt, tomorrow_posture, pnl_pct').order('session_date', { ascending: false }).limit(1).maybeSingle(),
    // Full active bias snapshot for the audit trail — the prompt-facing `biases`
    // is truncated to top 3; the audit row keeps the whole list so post-mortem
    // questions like "was there a severity-2 bias Claude ignored?" are answerable.
    supabase.from('ct_biases').select('id, pattern, instruments, severity').eq('active', true),
  ]);

  const userMessage = JSON.stringify({
    session_date: sessionDate,
    book_starting_balance: startingBalance,
    overnight_news: news.data ?? [],
    recent_flow: flow.data ?? [],
    latest_market_state: heartbeat.data ?? null,
    known_biases: biases.data ?? [],
    self_corrections_72h: corrections.data ?? [],
    recent_grades_72h: recentGrades.data ?? [],
    yesterday_recap: priorRecap.data ?? null,
    allowed_instruments: WATCHLIST,
    note: 'Commit 1-3 trades per the system schema, OR skip with reason. Return ONLY the JSON.',
  });

  let claudeText = '';
  try {
    const res = await callClaude({
      model: CLAUDE_MODELS.sonnet,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
      max_tokens: 1500,
      temperature: 0.2,
    });
    claudeText = parseTextContent(res);
  } catch (e) {
    const msg = e instanceof ClaudeError ? `Claude ${e.status}: ${e.message}` : String(e);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const cleaned = claudeText.replace(/^\s*```(?:json)?\s*/, '').replace(/\s*```\s*$/, '').trim();
  let parsed: { trades?: TradeCommit[]; posture?: string; skip_reason?: string };
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return new Response(JSON.stringify({ error: 'invalid json', raw: claudeText.slice(0, 500) }), {
      status: 502,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const trades = (parsed.trades ?? []).slice(0, 3);

  // Skip path
  if (trades.length === 0) {
    return new Response(JSON.stringify({
      ok: true, committed: 0, skip_reason: parsed.skip_reason ?? 'no setups', posture: parsed.posture ?? null,
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Sanity-clip + totals check
  const allowed = new Set(WATCHLIST);
  let totalPct = 0;
  const valid: TradeCommit[] = [];
  for (const t of trades) {
    if (!allowed.has(t.instrument as typeof WATCHLIST[number])) continue;
    if (t.side !== 'long' && t.side !== 'short') continue;
    const sz = Math.min(40, Math.max(1, Math.round(t.size_pct ?? 15)));
    if (totalPct + sz > 100) break;
    totalPct += sz;
    valid.push({ ...t, size_pct: sz });
  }
  if (valid.length === 0) {
    return new Response(JSON.stringify({ error: 'no valid trades after clipping', raw: parsed }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Fetch entry prices NOW (pre-market; these become planned entries until 9:30 fill)
  const entryPrices: Record<string, number | null> = {};
  await Promise.all(valid.map(async t => {
    entryPrices[t.instrument] = await getCurrentPrice(t.instrument);
  }));

  const rows = valid
    .filter(t => entryPrices[t.instrument] != null)
    .map(t => {
      const entry = entryPrices[t.instrument]!;
      const sizeUsd = startingBalance! * (t.size_pct / 100);
      const thesisText = t.entry_reasoning ?? '';
      return {
        session_date: sessionDate,
        instrument: t.instrument,
        side: t.side,
        size_pct: t.size_pct,
        size_usd: +sizeUsd.toFixed(2),
        entry_price: entry,
        stop_price: t.stop_price ?? null,
        target_price: t.target_price ?? null,
        thesis: thesisText,
        thesis_theme: classifyThesis(thesisText),
        horizon: t.horizon ?? 'intraday',
        conviction: Math.min(5, Math.max(1, Math.round(t.conviction ?? 3))),
        status: 'planned',
      };
    });

  if (rows.length === 0) {
    return new Response(JSON.stringify({ error: 'no entry prices resolved', attempted: valid.map(v => v.instrument) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const { data: insertedRows, error: insErr } = await supabase
    .from('ct_trades')
    .insert(rows)
    .select('id, instrument, side, size_pct, size_usd, entry_price, stop_price, target_price, thesis, conviction');
  if (insErr) {
    return new Response(JSON.stringify({ error: `insert failed: ${insErr.message}` }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  const inserted = (insertedRows ?? []) as Array<{ id: string; instrument: string; side: string; size_pct: number; size_usd: number; entry_price: number | null; stop_price: number | null; target_price: number | null; thesis: string; conviction: number }>;

  // Audit trail — fire-and-forget, one row per trade inserted. Captures the
  // exact state Claude saw, the full active bias list, and the raw response
  // JSON. Never blocks the commit response.
  const hbRow = heartbeat.data as { id?: string; current_reads?: Record<string, unknown> } | null;
  const snapshot = hbRow?.current_reads?._snapshot ?? null;
  const marketRegime = deriveMarketRegime(snapshot);
  const activeBiasesSnapshot = (allActiveBiases?.data ?? []) as unknown;

  for (const row of inserted) {
    writeTradeAudit(supabase, {
      trade_id: row.id,
      source: 'claude-trade-open',
      uw_state_snapshot: snapshot,
      mcp_calls: [], // ct-claude-trade-open doesn't call MCP in this version
      active_biases: activeBiasesSnapshot,
      sizing_computed: {
        book_equity:  startingBalance,
        size_pct:     row.size_pct,
        size_usd:     row.size_usd,
        entry_price:  row.entry_price,
        stop_price:   row.stop_price,
        target_price: row.target_price,
        conviction:   row.conviction,
      },
      market_regime: marketRegime,
      heartbeat_id: hbRow?.id ?? null,
      triggering_alert_id: null,
      triggering_flag_id: null,
      prompt_version: CT_PROMPT_VERSION,
      raw_claude_response: claudeText,
    });
  }

  return new Response(JSON.stringify({
    ok: true,
    session_date: sessionDate,
    book_starting: startingBalance,
    committed: inserted.length,
    total_exposure_pct: inserted.reduce((a, r) => a + (r.size_pct ?? 0), 0),
    posture: parsed.posture ?? null,
    trades: inserted.map(r => ({ instrument: r.instrument, side: r.side, size_pct: r.size_pct, entry: r.entry_price, stop: r.stop_price, target: r.target_price })),
  }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
