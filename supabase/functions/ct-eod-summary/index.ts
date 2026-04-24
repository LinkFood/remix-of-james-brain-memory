/**
 * ct-eod-summary — Daily 4:30pm ET narrative + grades for Co-Trader.
 *
 * Cron: 30 20 * * 1-5 (20:30 UTC weekdays). Aggregates the day's
 *   - flags + grades (per-specialist breakdown)
 *   - specialist reads (direction lean + conviction)
 *   - top scored flow events (top 5 by premium)
 *   - top contract stacks (top 3 per ticker via ct_contract_stacking RPC)
 *   - FlowPulse open vs close (first vs last tick)
 *   - tape-reader first vs last commentary
 *   - watchlist underlying day moves (open vs close from ct_price_bars)
 *
 * Sends the structured JSON to Sonnet 4.6 for a 400-500 word narrative.
 * UPSERTs into ct_eod_summaries (UNIQUE on session_date — re-running the
 * day overwrites). Pushes Block Kit summary to Slack via ctSlackPushDirect.
 *
 * Slack is best-effort — never throws. Missing data sources gracefully
 * degrade to "[no data yet]" tokens in the prompt.
 *
 * Tenets: meta-layer eats its own outputs (17), real-time contextual
 * awareness (10), every number tunable (7).
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { callClaude, CLAUDE_MODELS, CLAUDE_RATES, ClaudeError } from '../_shared/anthropic.ts';
import { ctSlackPushDirect } from '../_shared/ctSlack.ts';

const WATCHLIST = ['SPY', 'QQQ', 'IWM', 'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'TSLA'];

interface FlagRow {
  id: string;
  specialist_ticker: string;
  direction: string;
  score: number | null;
  status: string;
  thesis: string | null;
  created_at: string;
}

interface GradeRow {
  flag_id: string;
  specialist_ticker: string;
  outcome: string;
  alpha_pct: number | null;
}

interface ReadRow {
  ticker: string;
  direction_lean: string | null;
  conviction: number | null;
  flagged: boolean;
  updated_at: string;
}

interface ScoredFlowRow {
  id: number;
  ticker: string;
  option_symbol: string | null;
  classification: string | null;
  direction: string | null;
  premium: number | null;
  score: number | null;
  strike: number | null;
  expiry: string | null;
}

interface StackRow {
  option_symbol: string;
  ticker: string;
  strike: number | null;
  expiry: string | null;
  side: string;
  prints_count: number;
  premium_total: number;
  ask_dominant_pct: number | null;
  opening_buy_count: number;
  opening_sell_count: number;
}

interface FlowPulseTickRow {
  tick_time: string;
  ticker: string;
  premium_net: number | string;
  call_put_ratio: number | string | null;
  is_unusual: boolean;
}

interface PriceBarRow {
  ticker: string;
  ts: string;
  open: number | string;
  close: number | string;
}

interface TapeCommentaryRow {
  created_at: string;
  commentary: string;
}

function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  const sign = v >= 0 ? '+' : '-';
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

function fmtPremium(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(Number(n))) return '?';
  const v = Math.abs(Number(n));
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(2)}%`;
}

function interpretStackLabel(r: StackRow): string {
  const side = (r.side || '').toUpperCase().startsWith('C') ? 'C' : 'P';
  const total = Math.max(1, (r.opening_buy_count ?? 0) + (r.opening_sell_count ?? 0));
  const buyShare = (r.opening_buy_count ?? 0) / total;
  const sellShare = (r.opening_sell_count ?? 0) / total;
  const askLow = r.ask_dominant_pct != null && Number(r.ask_dominant_pct) < 30;
  if (buyShare >= 0.8) return side === 'C' ? 'call accumulation (bullish)' : 'put accumulation (bearish)';
  if (sellShare >= 0.8 && askLow) return side === 'P' ? 'put writing (bullish)' : 'call writing (bearish)';
  if (sellShare >= 0.8) return side === 'C' ? 'call distribution' : 'put distribution';
  return '2-sided mixed';
}

serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  const corsHeaders = getCorsHeaders(req);

  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // ----- Date bounds in NY tz -------------------------------------------------
  const now = new Date();
  // session_date — NY-tz date (matches ct_tape_commentary, ct_specialist_reads convention)
  const nyParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const yyyy = nyParts.find(p => p.type === 'year')?.value ?? '1970';
  const mm = nyParts.find(p => p.type === 'month')?.value ?? '01';
  const dd = nyParts.find(p => p.type === 'day')?.value ?? '01';
  const sessionDate = `${yyyy}-${mm}-${dd}`;

  // NY-tz midnight as UTC for filtering created_at columns
  // 04:00 UTC ≈ 00:00 EDT, 05:00 UTC ≈ 00:00 EST. ET 4pm = 20:00 UTC EST or 20:00 EDT.
  // For day boundary use a generous window: previous day 04:00 UTC up through call time.
  const dayStartIso = `${sessionDate}T04:00:00Z`; // catches all of NY business day
  const dayEndIso = now.toISOString();

  // Underlying spot moves — pull last 2 days of daily bars and compute today's % move
  const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60_000);

  // ----- Pull data in parallel -----------------------------------------------
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb: any = supabase;

  const [
    flagsRes,
    gradesRes,
    readsRes,
    scoredFlowRes,
    stackingRes,
    flowPulseSeriesRes,
    tapeRes,
    barsRes,
  ] = await Promise.all([
    sb.from('ct_flags')
      .select('id, specialist_ticker, direction, score, status, thesis, created_at')
      .gte('created_at', dayStartIso)
      .lte('created_at', dayEndIso)
      .order('created_at', { ascending: true }),
    sb.from('ct_flag_grades')
      .select('flag_id, specialist_ticker, outcome, alpha_pct, graded_at')
      .gte('graded_at', dayStartIso)
      .lte('graded_at', dayEndIso),
    sb.from('ct_specialist_reads')
      .select('ticker, direction_lean, conviction, flagged, updated_at')
      .gte('updated_at', dayStartIso)
      .lte('updated_at', dayEndIso),
    sb.from('ct_scored_flow')
      .select('id, ticker, option_symbol, classification, direction, premium, score, strike, expiry, event_ts')
      .gte('event_ts', dayStartIso)
      .lte('event_ts', dayEndIso)
      .in('ticker', WATCHLIST)
      .order('premium', { ascending: false })
      .limit(50),
    sb.rpc('ct_contract_stacking', {
      p_window_min: 480, // ~8h covers full RTH
      p_min_prints: 3,
      p_min_premium: 100_000,
      p_ticker: null,
      p_limit: 30,
    }),
    sb.rpc('ct_flow_pulse_series', { p_since: dayStartIso }),
    sb.from('ct_tape_commentary')
      .select('created_at, commentary')
      .eq('session_date', sessionDate)
      .order('created_at', { ascending: true }),
    sb.from('ct_price_bars')
      .select('ticker, ts, open, close')
      .in('ticker', WATCHLIST)
      .eq('timeframe', '1d')
      .gte('ts', twoDaysAgo.toISOString())
      .order('ts', { ascending: false })
      .limit(40),
  ]);

  const flags = (flagsRes.data ?? []) as FlagRow[];
  const grades = (gradesRes.data ?? []) as GradeRow[];
  const reads = (readsRes.data ?? []) as ReadRow[];
  const scoredFlow = (scoredFlowRes.data ?? []) as ScoredFlowRow[];
  const stacks = (stackingRes.data ?? []) as StackRow[];
  const pulseSeries = (flowPulseSeriesRes.data ?? []) as FlowPulseTickRow[];
  const tape = (tapeRes.data ?? []) as TapeCommentaryRow[];
  const bars = (barsRes.data ?? []) as PriceBarRow[];

  // ----- Aggregate: gradesByFlagId -------------------------------------------
  const gradeByFlag = new Map<string, GradeRow>();
  for (const g of grades) gradeByFlag.set(g.flag_id, g);

  // ----- specialist_stats per ticker -----------------------------------------
  const specialistStats: Record<string, {
    flags_count: number;
    bull_count: number;
    bear_count: number;
    mixed_count: number; // neutral
    avg_conviction: number | null;
    reads_count: number;
    grade_breakdown: { win: number; loss: number; partial: number; invalidated_early: number; ungraded: number };
  }> = {};

  for (const t of WATCHLIST) {
    specialistStats[t] = {
      flags_count: 0,
      bull_count: 0,
      bear_count: 0,
      mixed_count: 0,
      avg_conviction: null,
      reads_count: 0,
      grade_breakdown: { win: 0, loss: 0, partial: 0, invalidated_early: 0, ungraded: 0 },
    };
  }

  for (const f of flags) {
    const t = f.specialist_ticker;
    if (!specialistStats[t]) continue; // only watchlist
    specialistStats[t].flags_count++;
    if (f.direction === 'bullish') specialistStats[t].bull_count++;
    else if (f.direction === 'bearish') specialistStats[t].bear_count++;
    else specialistStats[t].mixed_count++;
    const g = gradeByFlag.get(f.id);
    const gb = specialistStats[t].grade_breakdown;
    if (!g) gb.ungraded++;
    else if (g.outcome === 'win') gb.win++;
    else if (g.outcome === 'loss') gb.loss++;
    else if (g.outcome === 'partial') gb.partial++;
    else if (g.outcome === 'invalidated_early') gb.invalidated_early++;
    else gb.ungraded++;
  }

  // Reads: per-ticker count + avg conviction
  const convAcc: Record<string, { sum: number; n: number }> = {};
  for (const t of WATCHLIST) convAcc[t] = { sum: 0, n: 0 };
  for (const r of reads) {
    if (!specialistStats[r.ticker]) continue;
    specialistStats[r.ticker].reads_count++;
    if (r.conviction != null && Number.isFinite(Number(r.conviction))) {
      convAcc[r.ticker].sum += Number(r.conviction);
      convAcc[r.ticker].n++;
    }
  }
  for (const t of WATCHLIST) {
    if (convAcc[t].n > 0) {
      specialistStats[t].avg_conviction = Math.round(convAcc[t].sum / convAcc[t].n * 10) / 10;
    }
  }

  // ----- ticker_stats per ticker ---------------------------------------------
  // Spot moves from daily bars
  const todaySpotByTicker = new Map<string, { open: number; close: number; ts: string }>();
  // bars sorted DESC by ts; first hit per ticker = latest day
  for (const b of bars) {
    if (!todaySpotByTicker.has(b.ticker)) {
      const o = Number(b.open);
      const c = Number(b.close);
      if (Number.isFinite(o) && Number.isFinite(c)) {
        todaySpotByTicker.set(b.ticker, { open: o, close: c, ts: b.ts });
      }
    }
  }

  // Top scored flow per ticker
  const topFlowByTicker = new Map<string, ScoredFlowRow>();
  for (const r of scoredFlow) {
    if (!topFlowByTicker.has(r.ticker)) topFlowByTicker.set(r.ticker, r);
  }

  // Top stack per ticker
  const topStackByTicker = new Map<string, StackRow>();
  for (const s of stacks) {
    if (!topStackByTicker.has(s.ticker)) topStackByTicker.set(s.ticker, s);
  }

  // FlowPulse: first/last tick per ticker
  const pulseFirstByTicker = new Map<string, FlowPulseTickRow>();
  const pulseLastByTicker = new Map<string, FlowPulseTickRow>();
  // pulseSeries comes ordered by ticker, tick_time ASC from the RPC
  for (const tick of pulseSeries) {
    if (!pulseFirstByTicker.has(tick.ticker)) pulseFirstByTicker.set(tick.ticker, tick);
    pulseLastByTicker.set(tick.ticker, tick); // last write wins
  }

  const tickerStats: Record<string, {
    open_spot: number | null;
    close_spot: number | null;
    day_pct_change: number | null;
    top_flow: { symbol: string; premium: number; score: number | null } | null;
    top_stack: { symbol: string; prints: number; signal_label: string; premium: number } | null;
    flow_pulse_open: { premium_net: number; cp_ratio: number | null } | null;
    flow_pulse_close: { premium_net: number; cp_ratio: number | null } | null;
    regime_shift: string | null;
  }> = {};

  for (const t of WATCHLIST) {
    const spot = todaySpotByTicker.get(t);
    const open = spot?.open ?? null;
    const close = spot?.close ?? null;
    const pct = (open != null && close != null && open !== 0)
      ? ((close - open) / open) * 100
      : null;

    const tf = topFlowByTicker.get(t);
    const ts = topStackByTicker.get(t);
    const pulseFirst = pulseFirstByTicker.get(t);
    const pulseLast = pulseLastByTicker.get(t);

    const firstNet = pulseFirst ? Number(pulseFirst.premium_net) : null;
    const lastNet = pulseLast ? Number(pulseLast.premium_net) : null;
    let regimeShift: string | null = null;
    if (firstNet != null && lastNet != null) {
      if (firstNet < 0 && lastNet > 0) regimeShift = 'bearish→bullish';
      else if (firstNet > 0 && lastNet < 0) regimeShift = 'bullish→bearish';
      else if (Math.abs(lastNet - firstNet) > 1_000_000) {
        regimeShift = lastNet > firstNet ? 'bullish acceleration' : 'bearish acceleration';
      }
    }

    tickerStats[t] = {
      open_spot: open,
      close_spot: close,
      day_pct_change: pct != null ? Math.round(pct * 100) / 100 : null,
      top_flow: tf ? {
        symbol: tf.option_symbol ?? `${tf.ticker} ${tf.strike ?? '?'}${tf.expiry ?? ''}`,
        premium: Number(tf.premium ?? 0),
        score: tf.score,
      } : null,
      top_stack: ts ? {
        symbol: ts.option_symbol,
        prints: ts.prints_count,
        signal_label: interpretStackLabel(ts),
        premium: Number(ts.premium_total ?? 0),
      } : null,
      flow_pulse_open: pulseFirst ? {
        premium_net: firstNet ?? 0,
        cp_ratio: pulseFirst.call_put_ratio != null ? Number(pulseFirst.call_put_ratio) : null,
      } : null,
      flow_pulse_close: pulseLast ? {
        premium_net: lastNet ?? 0,
        cp_ratio: pulseLast.call_put_ratio != null ? Number(pulseLast.call_put_ratio) : null,
      } : null,
      regime_shift: regimeShift,
    };
  }

  // ----- market_stats ---------------------------------------------------------
  const marketFirst = pulseFirstByTicker.get('MARKET') ?? null;
  const marketLast = pulseLastByTicker.get('MARKET') ?? null;
  const mktPremOpen = marketFirst ? Number(marketFirst.premium_net) : null;
  const mktPremClose = marketLast ? Number(marketLast.premium_net) : null;
  const mktPremDelta = (mktPremOpen != null && mktPremClose != null)
    ? mktPremClose - mktPremOpen : null;

  const tapeFirst = tape[0]?.commentary ?? null;
  const tapeLast = tape.length > 0 ? tape[tape.length - 1].commentary : null;

  let unusualPulseCount = 0;
  for (const tick of pulseSeries) {
    if (tick.ticker !== 'MARKET' && tick.is_unusual) unusualPulseCount++;
  }

  const marketStats = {
    tape_first: tapeFirst,
    tape_last: tapeLast,
    market_premium_open: mktPremOpen,
    market_premium_close: mktPremClose,
    market_premium_delta: mktPremDelta,
    total_flags: flags.length,
    total_reads: reads.length,
    total_stacks: stacks.length,
    unusual_pulse_count: unusualPulseCount,
    total_grades: grades.length,
    grade_breakdown: {
      win: grades.filter(g => g.outcome === 'win').length,
      loss: grades.filter(g => g.outcome === 'loss').length,
      partial: grades.filter(g => g.outcome === 'partial').length,
      invalidated_early: grades.filter(g => g.outcome === 'invalidated_early').length,
    },
  };

  // ----- Build Sonnet prompt --------------------------------------------------
  const promptLines: string[] = [];
  promptLines.push(`Session date: ${sessionDate}`);
  promptLines.push('');
  promptLines.push('=== MARKET-WIDE ===');
  promptLines.push(`Total flags written today: ${flags.length} (${marketStats.grade_breakdown.win} win, ${marketStats.grade_breakdown.loss} loss, ${marketStats.grade_breakdown.partial} partial, ${marketStats.grade_breakdown.invalidated_early} invalidated_early, ${flags.length - grades.length} ungraded so far)`);
  promptLines.push(`Total specialist reads (every wakeup): ${reads.length}`);
  promptLines.push(`Total stacking patterns surfaced: ${stacks.length}`);
  promptLines.push(`Unusual FlowPulse ticks today: ${unusualPulseCount}`);
  if (mktPremOpen != null && mktPremClose != null) {
    promptLines.push(`Market net premium open→close: ${fmtUsd(mktPremOpen)} → ${fmtUsd(mktPremClose)} (Δ ${fmtUsd(mktPremDelta)})`);
  } else {
    promptLines.push('Market net premium: [no data yet]');
  }
  if (tapeFirst) promptLines.push(`First tape read of day: "${tapeFirst.replace(/\s+/g, ' ').slice(0, 240)}"`);
  else promptLines.push('First tape read: [no data yet]');
  if (tapeLast && tapeLast !== tapeFirst) promptLines.push(`Last tape read of day:  "${tapeLast.replace(/\s+/g, ' ').slice(0, 240)}"`);
  promptLines.push('');

  promptLines.push('=== PER TICKER ===');
  for (const t of WATCHLIST) {
    const ts = tickerStats[t];
    const ss = specialistStats[t];
    const moveStr = ts.day_pct_change != null
      ? `${fmtPct(ts.day_pct_change)} (${ts.open_spot?.toFixed(2)} → ${ts.close_spot?.toFixed(2)})`
      : '[no spot data]';
    const flagSummary = ss.flags_count > 0
      ? `${ss.flags_count} flags (${ss.bull_count}bull/${ss.bear_count}bear/${ss.mixed_count}neutral)`
      : 'no flags';
    const gb = ss.grade_breakdown;
    const gradeStr = ss.flags_count > 0
      ? ` | grades: ${gb.win}W/${gb.loss}L/${gb.partial}P/${gb.invalidated_early}IE/${gb.ungraded}ung`
      : '';
    const readStr = ss.reads_count > 0
      ? ` | ${ss.reads_count} reads, avg conv ${ss.avg_conviction ?? '—'}`
      : ' | 0 reads';
    promptLines.push(`${t}: ${moveStr} | ${flagSummary}${gradeStr}${readStr}`);

    if (ts.top_flow) {
      promptLines.push(`  Top flow: ${ts.top_flow.symbol} | premium ${fmtPremium(ts.top_flow.premium)} | score ${ts.top_flow.score ?? '—'}`);
    }
    if (ts.top_stack) {
      promptLines.push(`  Top stack: ${ts.top_stack.symbol} | ${ts.top_stack.prints} prints | ${fmtPremium(ts.top_stack.premium)} | ${ts.top_stack.signal_label}`);
    }
    if (ts.regime_shift) {
      promptLines.push(`  Regime shift: ${ts.regime_shift} (open net ${fmtUsd(ts.flow_pulse_open?.premium_net ?? null)} → close ${fmtUsd(ts.flow_pulse_close?.premium_net ?? null)})`);
    }
  }
  promptLines.push('');

  // Top market-wide flow events (top 5)
  promptLines.push('=== TOP 5 SCORED FLOW EVENTS (by premium) ===');
  if (scoredFlow.length === 0) promptLines.push('[no data yet]');
  else {
    for (const r of scoredFlow.slice(0, 5)) {
      const cls = r.classification ? ` ${r.classification}` : '';
      const dir = r.direction ? ` ${r.direction}` : '';
      promptLines.push(`  ${r.ticker} ${r.option_symbol ?? '?'} | ${fmtPremium(r.premium)} | score ${r.score ?? '—'}${dir}${cls}`);
    }
  }
  promptLines.push('');

  // Top stacks
  promptLines.push('=== TOP 5 CONTRACT STACKS ===');
  if (stacks.length === 0) promptLines.push('[no data yet]');
  else {
    for (const s of stacks.slice(0, 5)) {
      promptLines.push(`  ${s.ticker} ${s.option_symbol} | ${s.prints_count} prints | ${fmtPremium(Number(s.premium_total))} | ${interpretStackLabel(s)}`);
    }
  }
  promptLines.push('');

  // Data quality flags
  const dataQualityNotes: string[] = [];
  if (reads.length < 30) dataQualityNotes.push(`Only ${reads.length} specialist reads — system is brand-new (specialist_reads launched 2026-04-24).`);
  if (flags.length < 10) dataQualityNotes.push(`Only ${flags.length} flags written — sample is small.`);
  if (grades.length === 0 && flags.length > 0) dataQualityNotes.push('No grades landed yet — Tier 2 grader just shipped today, most flags still in active/horizon window.');
  if (pulseSeries.length === 0) dataQualityNotes.push('FlowPulse series is empty — Phase 1 capture cron may not have populated today.');
  if (dataQualityNotes.length > 0) {
    promptLines.push('=== DATA QUALITY FLAGS ===');
    for (const note of dataQualityNotes) promptLines.push(`  - ${note}`);
    promptLines.push('');
  }

  const userMsg = promptLines.join('\n');

  const system = `You are the Co-Trader EOD analyst. Write a 400-500 word narrative covering today's session for a day trader who runs an autonomous options-flow system. Cover, in order:

1. **The day's market arc** — open vs close net premium, regime shifts, where the tape was sitting first vs last commentary. Concrete numbers.
2. **Where specialists landed** — per-ticker direction split and grades where data exists. Call out specialists with sharp accuracy AND specialists where direction skewed all one way (bias check).
3. **Standout flow events** — top 1-2 by premium with what makes them notable (score, direction, ticker context).
4. **Notable stacking patterns** — top 1-2 stacks today and the directional read (call writing / put accumulation / etc.). Reference the labels — they're already interpreted.
5. **Data-quality realism** — when sample is tiny, say so explicitly. The system is days old; don't over-claim. If specialist_reads is brand new today, lead with that.

Style: terse, factual, no hedging language ("seems", "appears"). Reference numbers. Reference tickers by symbol. No disclaimers, no "this is not financial advice." If the data is sparse, name what's missing rather than padding the narrative. End with one sentence on what tomorrow's open looks like to set up given today's read.`;

  // ----- Call Sonnet ----------------------------------------------------------
  let summaryText = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let modelUsed: string = CLAUDE_MODELS.sonnet_46;
  let apiError: string | null = null;

  try {
    const resp = await callClaude({
      model: CLAUDE_MODELS.sonnet_46,
      system,
      messages: [{ role: 'user', content: userMsg }],
      max_tokens: 1400,
      temperature: 0.4,
    });
    const textBlock = resp.content.find(b => b.type === 'text' && b.text);
    summaryText = (textBlock?.text ?? '').trim();
    inputTokens = resp.usage?.input_tokens ?? 0;
    outputTokens = resp.usage?.output_tokens ?? 0;
    modelUsed = resp.model ?? modelUsed;
  } catch (e) {
    apiError = e instanceof ClaudeError ? `${e.status}: ${e.message}` : (e instanceof Error ? e.message : String(e));
    summaryText = `[EOD generation offline] ${apiError.slice(0, 200)}\n\nMarket stats: ${flags.length} flags, ${reads.length} reads, ${stacks.length} stacks. Net premium open→close: ${fmtUsd(mktPremOpen)} → ${fmtUsd(mktPremClose)}.`;
  }

  const rates = CLAUDE_RATES[modelUsed as keyof typeof CLAUDE_RATES] ?? CLAUDE_RATES[CLAUDE_MODELS.sonnet_46];
  const costUsd = (inputTokens * rates.input + outputTokens * rates.output) / 1_000_000;

  // ----- Upsert into ct_eod_summaries ----------------------------------------
  const upsertRow = {
    session_date: sessionDate,
    summary_text: summaryText,
    specialist_stats: specialistStats,
    ticker_stats: tickerStats,
    market_stats: marketStats,
    generated_at: new Date().toISOString(),
    model: modelUsed,
    cost_usd: Math.round(costUsd * 1_000_000) / 1_000_000,
  };

  const { data: upserted, error: upsertErr } = await sb
    .from('ct_eod_summaries')
    .upsert(upsertRow, { onConflict: 'session_date' })
    .select('id, session_date, generated_at')
    .single();

  // ----- Slack push (best-effort) --------------------------------------------
  let slackOutcome: 'sent' | 'skipped_no_user' | 'error' | 'skipped_api_error' = 'skipped_no_user';
  let slackError: string | null = null;

  if (!apiError) {
    try {
      // Single-user pattern matches ct-slack-digest
      const { data: users } = await sb.from('profiles').select('id').limit(1);
      const userId = users?.[0]?.id as string | undefined;

      if (userId) {
        const preview = summaryText.slice(0, 200) + (summaryText.length > 200 ? '…' : '');
        const winLossLine = grades.length > 0
          ? `${marketStats.grade_breakdown.win}W / ${marketStats.grade_breakdown.loss}L / ${marketStats.grade_breakdown.partial}P / ${marketStats.grade_breakdown.invalidated_early}IE`
          : 'no grades landed yet';
        const headerText = `Co-Trader EOD · ${sessionDate}`;

        const blocks: Array<Record<string, unknown>> = [
          { type: 'header', text: { type: 'plain_text', text: headerText, emoji: true } },
          { type: 'divider' },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Today's totals*\n${flags.length} flags · ${reads.length} reads · ${stacks.length} stacks · ${unusualPulseCount} unusual pulse ticks\n*Grades:* ${winLossLine}\n*Market net premium:* ${fmtUsd(mktPremOpen)} → ${fmtUsd(mktPremClose)} (Δ ${fmtUsd(mktPremDelta)})`,
            },
          },
          { type: 'divider' },
          {
            type: 'section',
            text: { type: 'mrkdwn', text: `:bar_chart: *Summary*\n${preview}` },
          },
          {
            type: 'context',
            elements: [
              { type: 'mrkdwn', text: `Read full report: <https://www.linkjac.cloud/eod|/eod> · model: ${modelUsed} · $${upsertRow.cost_usd.toFixed(4)}` },
            ],
          },
        ];

        const fallbackText = `Co-Trader EOD ${sessionDate}: ${flags.length} flags · ${winLossLine} · net ${fmtUsd(mktPremDelta)} delta`;
        await ctSlackPushDirect(supabase, userId, fallbackText, 'eod', blocks);
        slackOutcome = 'sent';
      }
    } catch (e) {
      slackOutcome = 'error';
      slackError = e instanceof Error ? e.message : String(e);
      console.warn('[ct-eod-summary] slack push failed (non-blocking):', slackError);
    }
  } else {
    slackOutcome = 'skipped_api_error';
  }

  return new Response(JSON.stringify({
    ok: !apiError && !upsertErr,
    session_date: sessionDate,
    id: upserted?.id ?? null,
    generated_at: upserted?.generated_at ?? null,
    model: modelUsed,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost_usd: upsertRow.cost_usd,
    summary_preview: summaryText.slice(0, 280),
    counts: {
      flags: flags.length,
      grades: grades.length,
      reads: reads.length,
      scored_flow: scoredFlow.length,
      stacks: stacks.length,
      pulse_ticks: pulseSeries.length,
      tape_rows: tape.length,
      bars: bars.length,
    },
    slack: { outcome: slackOutcome, error: slackError },
    api_error: apiError,
    upsert_error: upsertErr?.message ?? null,
  }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});
