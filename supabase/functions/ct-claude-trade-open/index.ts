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
import { isKillSwitchActive, killSwitchSkipResponse } from '../_shared/killSwitch.ts';
import { callClaude, CLAUDE_MODELS, parseTextContent, ClaudeError } from '../_shared/anthropic.ts';
import { getCurrentPrice } from '../_shared/ctGrader.ts';
import { classifyThesis } from '../_shared/thesisClassifier.ts';
import { CT_PROMPT_VERSION } from '../_shared/systemPromptV1.ts';
import { writeTradeAudit, deriveMarketRegime } from '../_shared/tradeAudit.ts';
import { checkConcentration } from '../_shared/concentration.ts';
import { ctSlackPushDirect } from '../_shared/ctSlack.ts';
import { preTradeCheck, type Check } from '../_shared/preTradeGate.ts';
import { firePreTradeQuality } from '../_shared/tradeQuality.ts';
import { getWatchlist } from '../_shared/watchlist.ts';

// The 12-ticker hard-coded watchlist that previously lived here now lives
// in `supabase/functions/_shared/watchlist.ts` as DEFAULT_WATCHLIST, which
// is the safety-net fallback `getWatchlist()` returns when ct_config is
// unreadable or the value fails validation.

const SYSTEM_PROMPT_TEMPLATE = `You manage a $10k paper trading book. 9:26 AM ET. Market opens in 4 minutes.

Your job: commit 1-3 trades for today. Long or short — doesn't matter. Make money. Daily goal: positive P&L. Stretch: +0.5% ($50).

HARD RULES (enforced after your output — violations get clipped):
- Instruments: {{WATCHLIST}} ONLY
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

function buildSystemPrompt(watchlist: readonly string[]): string {
  return SYSTEM_PROMPT_TEMPLATE.replace('{{WATCHLIST}}', watchlist.join(', '));
}

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

  // Kill switch — skip morning trade opens entirely.
  if (await isKillSwitchActive(supabase)) {
    return killSwitchSkipResponse(supabase, 'ct-claude-trade-open', corsHeaders);
  }

  // Tunable watchlist — one config read per invocation. Falls back to the
  // 12-ticker default inside getWatchlist if ct_config is unreadable.
  const watchlist = await getWatchlist(supabase);
  const allowedSet = new Set<string>(watchlist);
  const systemPrompt = buildSystemPrompt(watchlist);

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
    allowed_instruments: watchlist,
    note: 'Commit 1-3 trades per the system schema, OR skip with reason. Return ONLY the JSON.',
  });

  let claudeText = '';
  try {
    const res = await callClaude({
      model: CLAUDE_MODELS.sonnet,
      system: systemPrompt,
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

  // Sanity-clip + totals check — reuse the set built at handler entry
  // (one ct_config read per tick, not per trade).
  let totalPct = 0;
  const valid: TradeCommit[] = [];
  for (const t of trades) {
    if (!allowedSet.has(t.instrument)) continue;
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

  const rows: Array<Record<string, unknown>> = [];
  const concentrationSkips: Array<{ instrument: string; side: string; size_pct: number; reason: string }> = [];
  // Gate results indexed by row position — preserved alongside `rows` so the
  // post-insert audit writer can attach the right checklist to each trade.
  const gateChecksPerRow: Check[][] = [];
  const gateSkips: Array<{ instrument: string; side: string; size_pct: number; blockers: Check[] }> = [];

  // Candidate rows, gated one-by-one against concentration. We feed each
  // proposed trade into checkConcentration BEFORE insert so the cumulative
  // state reflects prior rows that already passed (they're inserted at the
  // end). To mimic that, we track an in-flight accumulator by re-running
  // checkConcentration after each "virtual" addition — simpler: insert the
  // gate via a running shadow state embedded in the DB check at insert time.
  // Trick: call checkConcentration per candidate against the current DB
  // state + add each passing candidate into a local projection. We achieve
  // this by calling it sequentially and simulating passing candidates by
  // pushing temp rows. But since checkConcentration reads from ct_trades
  // directly, we'd miss prior in-flight candidates. Solve: for claude-trade-
  // open, sizes sum to ≤100 anyway; we check each candidate independently
  // first (cheap fail) and then do one final sweep after batch-insert is
  // simulated by iterating with a local tally. Implement now as a sequential
  // check where we also project prior-accepted trades by re-fetching after
  // each accept would be too slow; instead we add a local overlay.
  const localOverlay: Array<{ instrument: string; side: 'long' | 'short'; size_pct: number; thesis_theme: string; contract_type: 'underlying' }> = [];

  for (const t of valid) {
    if (entryPrices[t.instrument] == null) continue;
    const entry = entryPrices[t.instrument]!;
    const sizeUsd = startingBalance! * (t.size_pct / 100);
    const thesisText = t.entry_reasoning ?? '';
    const theme = classifyThesis(thesisText);

    // Full compliance gate — runs all 7 checks (kill switch, drawdown tier,
    // concentration, bias, UW usage, cooldown, session context). Blocked
    // candidates skip commit but we still record their checklist so the
    // audit answers "why did Claude propose this and get blocked?"
    const gateResult = await preTradeCheck(supabase, {
      instrument:    t.instrument,
      side:          t.side,
      size_pct:      t.size_pct,
      thesis_theme:  theme,
      contract_type: 'underlying',
      source:        'claude-trade-open',
      session_date:  sessionDate,
    });
    if (!gateResult.passed) {
      gateSkips.push({
        instrument: t.instrument,
        side: t.side,
        size_pct: t.size_pct,
        blockers: gateResult.blockers,
      });
      console.log(`[ct-claude-trade-open] gate blocked ${t.instrument} ${t.side}: ${gateResult.blockers.map(b => `${b.name}(${b.threshold_key ?? '-'})`).join(', ')}`);
      continue;
    }

    // Gate: DB state + anything already accepted in this batch.
    const report = await checkConcentration(supabase, {
      instrument:    t.instrument,
      side:          t.side,
      size_pct:      t.size_pct,
      thesis_theme:  theme,
      contract_type: 'underlying',
    });

    // Overlay already-accepted candidates by re-checking their marginal
    // impact against the limits. This is cheaper than re-querying the DB
    // per iteration: we manually fold the overlay into the projected
    // percentages before judging.
    if (report.passed) {
      let breach: string | null = null;
      const proj = { ...report.projected };
      const tickerProj: Record<string, number> = { ...proj.ticker_pct };
      const themeProj:  Record<string, number> = { ...proj.theme_pct };
      let longProj = proj.long_pct;
      let shortProj = proj.short_pct;
      for (const o of localOverlay) {
        tickerProj[o.instrument] = (tickerProj[o.instrument] ?? 0) + o.size_pct;
        themeProj[o.thesis_theme] = (themeProj[o.thesis_theme] ?? 0) + o.size_pct;
        if (o.side === 'long')  longProj  += o.size_pct;
        if (o.side === 'short') shortProj += o.size_pct;
      }
      for (const [tkr, pct] of Object.entries(tickerProj)) {
        if (pct > report.limits.max_ticker_pct) { breach = `would breach max_ticker_pct (batch): ${tkr} at ${pct.toFixed(1)}% > ${report.limits.max_ticker_pct}%`; break; }
      }
      if (!breach) for (const [th, pct] of Object.entries(themeProj)) {
        if (pct > report.limits.max_theme_pct) { breach = `would breach max_theme_pct (batch): ${th} at ${pct.toFixed(1)}% > ${report.limits.max_theme_pct}%`; break; }
      }
      if (!breach && longProj  > report.limits.max_direction_pct) breach = `would breach max_direction_pct (batch): long at ${longProj.toFixed(1)}% > ${report.limits.max_direction_pct}%`;
      if (!breach && shortProj > report.limits.max_direction_pct) breach = `would breach max_direction_pct (batch): short at ${shortProj.toFixed(1)}% > ${report.limits.max_direction_pct}%`;
      if (breach) {
        concentrationSkips.push({ instrument: t.instrument, side: t.side, size_pct: t.size_pct, reason: breach });
        continue;
      }
    } else {
      concentrationSkips.push({ instrument: t.instrument, side: t.side, size_pct: t.size_pct, reason: report.reason ?? 'unknown breach' });
      continue;
    }

    localOverlay.push({ instrument: t.instrument, side: t.side, size_pct: t.size_pct, thesis_theme: theme, contract_type: 'underlying' });
    gateChecksPerRow.push(gateResult.checks);
    rows.push({
      session_date: sessionDate,
      instrument: t.instrument,
      side: t.side,
      size_pct: t.size_pct,
      size_usd: +sizeUsd.toFixed(2),
      entry_price: entry,
      stop_price: t.stop_price ?? null,
      target_price: t.target_price ?? null,
      thesis: thesisText,
      thesis_theme: theme,
      horizon: t.horizon ?? 'intraday',
      conviction: Math.min(5, Math.max(1, Math.round(t.conviction ?? 3))),
      status: 'planned',
    });
  }

  // Slack + log concentration skips — best-effort, never blocks the commit.
  if (concentrationSkips.length > 0) {
    try {
      const { data: profileRow } = await supabase.from('profiles').select('id').limit(1).maybeSingle();
      const userId = (profileRow?.id as string | undefined) ?? null;
      if (userId) {
        const lines = concentrationSkips.map(s => `• ${s.side.toUpperCase()} ${s.instrument} ${s.size_pct}% — ${s.reason}`).join('\n');
        await ctSlackPushDirect(supabase, userId, `:no_entry: ct-claude-trade-open rejected ${concentrationSkips.length} trade(s) on concentration:\n${lines}`, 'concentration-gate');
      }
    } catch (e) {
      console.warn('[ct-claude-trade-open] concentration slack push failed:', (e as Error).message);
    }
    console.log('[ct-claude-trade-open] concentration skips:', JSON.stringify(concentrationSkips));
  }

  if (rows.length === 0) {
    // Distinguish: all candidates blocked on concentration (200 ok, nothing
    // committed) vs. price resolution failures (500 — something's wrong with
    // the pricer).
    if ((concentrationSkips.length + gateSkips.length) > 0
        && (concentrationSkips.length + gateSkips.length) === valid.length) {
      return new Response(JSON.stringify({
        ok: true, committed: 0, posture: parsed.posture ?? null,
        skip_reason: 'all candidates blocked by pre-trade gate or concentration',
        concentration_skips: concentrationSkips,
        gate_skips: gateSkips,
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ error: 'no entry prices resolved', attempted: valid.map(v => v.instrument), concentration_skips: concentrationSkips, gate_skips: gateSkips }), {
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

  for (let i = 0; i < inserted.length; i++) {
    const row = inserted[i];
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
      // Pair by insertion order — gateChecksPerRow[i] is the checklist that
      // let row i pass; missing index falls back to empty to keep the column
      // well-formed.
      pre_trade_checks: gateChecksPerRow[i] ?? [],
    });

    // Fire-and-forget pre-trade quality rating. Claude grades his own SETUP
    // 1-10 right after commit, outcome-blind. This is the "process half" of
    // the process-vs-outcome split — paired with a post-trade rating at
    // close (firePostTradeQuality in ct-book-manager / ct-book-eod-close).
    firePreTradeQuality(supabase, {
      tradeId:       row.id,
      instrument:    row.instrument,
      side:          row.side as 'long' | 'short',
      size_pct:      row.size_pct,
      entry_price:   row.entry_price,
      stop_price:    row.stop_price,
      target_price:  row.target_price,
      thesis:        row.thesis,
      conviction:    row.conviction,
      contract_type: 'underlying',
      source:        'claude-trade-open',
      context: {
        active_biases: activeBiasesSnapshot,
        recent_grades_72h: recentGrades.data ?? [],
        self_corrections_72h: corrections.data ?? [],
        market_regime: marketRegime,
        pre_trade_checks: gateChecksPerRow[i] ?? [],
      },
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
    concentration_skips: concentrationSkips,
    gate_skips: gateSkips,
  }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
