/**
 * ct-tape-reader — Claude's running read of the tape.
 *
 * Scheduled every 10 minutes during RTH, plus event-driven interrupts when
 * specialists fire high-conviction (score >= 80) flags. Reads the last 10
 * minutes of scored flow + VIX + market tide + active flags, asks Claude
 * Haiku for a 2-3 sentence tape read, writes to ct_tape_commentary.
 *
 * The /tape banner shows the latest row; /tape-reader shows the day timeline.
 * Intentional design for self-improvement: commentary stores flow_ids +
 * flag_ids referenced + window bounds so we can later ask "what did the
 * reader say at 10:30 and what actually happened by 11:30?".
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { callClaude, CLAUDE_MODELS, CLAUDE_RATES, ClaudeError } from '../_shared/anthropic.ts';
import { getTemporalContext, tagIsoTimestamp } from '../_shared/temporalContext.ts';
import { validateTemporalCoherence } from '../_shared/temporalValidator.ts';
import { buildClaudeContext } from '../_shared/claudeReadSurface.ts';
import type {
  DetectorContextResult,
  DetectorFlag,
} from '../_shared/detectorContext.ts';
import type {
  NewsCausalityResult,
  NewsItem,
} from '../_shared/newsCausalityContext.ts';
import type { TapeContextResult } from '../_shared/tapeContext.ts';
import type { HelperResult } from '../_shared/contextHelper.ts';

const WATCHLIST = ['SPY','QQQ','IWM','AAPL','MSFT','GOOGL','AMZN','META','NVDA','TSLA'];
const DEFAULT_WINDOW_MIN = 10;

interface ScoredFlowRow {
  id: number;
  ticker: string;
  option_symbol: string | null;
  event_ts: string;
  classification: string | null;
  direction: string | null;
  score: number | null;
  strike: number | null;
  expiry: string | null;
  dte: number | null;
  premium: number | null;
  volume: number | null;
  open_interest: number | null;
  ask_side_perc: number | null;
}

interface PriceBarRow {
  ticker: string;
  close: number | null;
  ts: string;
}

interface FlowPulseRow {
  ticker: string;
  calls_count: number;
  puts_count: number;
  calls_premium: number;
  puts_premium: number;
  call_put_ratio: number;
  premium_net: number;
  cp_ratio_baseline_30d: number | null;
  cp_ratio_deviation: number | null;
  is_unusual: boolean;
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

interface RegimeSpotRow {
  ticker: string;
  spot_pct_from_prev_close: number | null;
}

interface PriorCommentaryRow {
  created_at: string;
  commentary: string;
}

/**
 * interpretStack — parity with src/hooks/useContractStacking.ts::interpretStack.
 * Not shared across edge/frontend boundary — kept in lockstep manually. Returns
 * a short directional label so the tape-reader prompt shows "call writing
 * (bearish)" instead of raw buy/sell/ask numbers it would otherwise re-derive.
 */
function interpretStack(r: {
  side: string;
  opening_buy_count: number;
  opening_sell_count: number;
  ask_dominant_pct: number | null;
  prints_count: number;
}): { label: string; color: 'bullish' | 'bearish' | 'mixed' } {
  const side = (r.side || '').toUpperCase().startsWith('C') ? 'C' : 'P';
  const total = Math.max(1, (r.opening_buy_count ?? 0) + (r.opening_sell_count ?? 0));
  const buyShare = (r.opening_buy_count ?? 0) / total;
  const sellShare = (r.opening_sell_count ?? 0) / total;
  const ask = r.ask_dominant_pct;
  const buyDominant = buyShare >= 0.8;
  const sellDominant = sellShare >= 0.8;

  if (buyDominant) {
    return side === 'C'
      ? { label: 'call accumulation (bullish)', color: 'bullish' }
      : { label: 'put accumulation (bearish)', color: 'bearish' };
  }
  if (sellDominant) {
    const askLow = ask != null && ask < 30;
    if (askLow) {
      return side === 'P'
        ? { label: 'put writing (bullish)', color: 'bullish' }
        : { label: 'call writing (bearish)', color: 'bearish' };
    }
    return { label: side === 'C' ? 'call distribution (mixed)' : 'put distribution (mixed)', color: 'mixed' };
  }
  return { label: '2-sided mixed', color: 'mixed' };
}

function fmtSignedPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return 'n/a';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

function parseOccSide(sym: string | null | undefined): string {
  if (!sym || sym.length < 9) return '';
  const ch = sym.charAt(sym.length - 9);
  if (ch === 'C' || ch === 'c') return 'C';
  if (ch === 'P' || ch === 'p') return 'P';
  return '';
}

function fmtContract(r: { ticker: string; option_symbol: string | null; strike: number | null; expiry: string | null }): string {
  const side = parseOccSide(r.option_symbol);
  const k = r.strike != null ? `$${r.strike}` : '?';
  const e = r.expiry ? r.expiry.slice(5).replace('-', '/') : '?';
  return `${r.ticker} ${k}${side} ${e}`;
}

function fmtPremium(n: number | null): string {
  if (n == null) return '?';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n}`;
}

serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  const corsHeaders = getCorsHeaders(req);
  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }),
      { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const body = await req.json().catch(() => ({})) as {
    trigger_kind?: 'scheduled' | 'flag_interrupt' | 'manual';
    window_minutes?: number;
    flag_id?: string;
  };
  const trigger_kind = body.trigger_kind ?? 'scheduled';
  const windowMin = Math.min(Math.max(body.window_minutes ?? DEFAULT_WINDOW_MIN, 1), 60);

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  // Temporal anchor — prevents Claude from carrying yesterday's news / day-name
  // framing into today's commentary. Pre-tag every timestamp shown to the
  // model with a relative-day tag (**TODAY HH:MM ET**, etc.) and prepend
  // `temporalAnchorPreamble` to the system prompt below. See
  // _shared/temporalContext.ts.
  const tctx = getTemporalContext();

  const now = new Date();
  const windowStart = new Date(now.getTime() - windowMin * 60_000);

  // --- Brain (synthesis layer Phase 4) -----------------------------------
  // One read for the whole brain — replaces the inline ct_flags / ct_breaking_news
  // queries below. Organs we consume: detector (active flags), news_causality
  // (recent watchlist + macro headlines), tape (prior commentary), pulse +
  // james_flags + specialist + flow_heatmap + event_recency surfaced through
  // ctx.preamble.whatJustHappened. UW MCP is write-path only (D4).
  const ctx = await buildClaudeContext(supabase, {
    audience: 'cotrader',
    consumerName: 'ct-tape-reader',
  });
  const detectorOrgan = ctx.organs.detector as
    | HelperResult<DetectorContextResult>
    | undefined;
  const newsOrgan = ctx.organs.news_causality as
    | HelperResult<NewsCausalityResult>
    | undefined;
  const tapeOrgan = ctx.organs.tape as
    | HelperResult<TapeContextResult>
    | undefined;

  // Active / conviction flags from the detector organ, last 30 min, watchlist-scoped.
  const flagsWindowMs = now.getTime() - 30 * 60_000;
  const flags: DetectorFlag[] = (detectorOrgan?.data.flags ?? [])
    .filter((f) => {
      const ts = Date.parse(f.created_at);
      if (!Number.isFinite(ts) || ts < flagsWindowMs) return false;
      if (!WATCHLIST.includes(f.ticker)) return false;
      // Mirror the prior status filter (active | conviction). The detector
      // helper currently includes all sources; we only narrate fresh, live ones.
      // (Helper does not expose status; rely on freshness window as proxy
      // since stale flags age out of the 24h lookback regardless.)
      return true;
    })
    .slice(0, 10);

  // Watchlist-relevant + macro-wide news, last 30 min, severity >= 2.
  const newsWindowMs = now.getTime() - 30 * 60_000;
  const newsAll: NewsItem[] = newsOrgan?.data.items ?? [];
  const news: NewsItem[] = newsAll
    .filter((n) => {
      const ts = Date.parse(n.ingested_at ?? n.event_at ?? '');
      if (!Number.isFinite(ts) || ts < newsWindowMs) return false;
      if (n.severity != null && n.severity < 2) return false;
      const tickers = n.tickers_affected ?? [];
      const macroWide = n.source_table === 'ct_breaking_news' && tickers.length === 0;
      return macroWide || tickers.some((t) => WATCHLIST.includes(t));
    })
    .slice(0, 8);

  // Scored flow in window — top 15 by score DESC, then premium DESC.
  // ct_scored_flow is not yet a brain organ; tape-reader is a primary consumer.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: scoredRaw } = await (supabase.from('ct_scored_flow' as never) as any)
    .select('id,ticker,option_symbol,event_ts,classification,direction,score,strike,expiry,dte,premium,volume,open_interest,ask_side_perc')
    .gte('event_ts', windowStart.toISOString())
    .in('ticker', WATCHLIST)
    .order('score', { ascending: false })
    .order('premium', { ascending: false })
    .limit(15);
  const scored = (scoredRaw ?? []) as ScoredFlowRow[];

  // Latest spot price per watchlist ticker — ct_price_bars (no brain organ yet).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: barsRaw } = await (supabase.from('ct_price_bars' as never) as any)
    .select('ticker,close,ts')
    .in('ticker', WATCHLIST)
    .order('ts', { ascending: false })
    .limit(80);
  const bars = (barsRaw ?? []) as PriceBarRow[];
  const spotMap = new Map<string, number>();
  for (const b of bars) {
    if (b.close != null && !spotMap.has(b.ticker)) spotMap.set(b.ticker, b.close);
  }

  // VIX lives in its own table (ct_vix_history) — 3x/day capture. Not yet
  // a brain organ; ct_vix_history → vixContext is on the Phase 3 backlog.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: vixRaw } = await (supabase.from('ct_vix_history' as never) as any)
    .select('level,change_pct,created_at')
    .order('created_at', { ascending: false })
    .limit(1);
  const vixRow = ((vixRaw ?? [])[0] ?? null) as { level: number | null; change_pct: number | null } | null;
  const vixLevel = vixRow?.level ?? null;
  const vixChange = vixRow?.change_pct ?? null;

  // Market tide — derived from the brain's pulse organ (latest ct_flow_pulse_ticks
  // row per ticker via _shared/pulseContext). Replaces the prior direct
  // ct_net_premium_ticks read (D4 — read/write separation). Sums latest-snapshot
  // premium_net across watchlist; semantics shift from "cumulative day" to
  // "latest tick" but the bullish/bearish/flat threshold stays at $5M.
  const pulseOrgan = ctx.organs.pulse as
    | HelperResult<{ per_ticker: Record<string, { netPremium: number | null }> }>
    | undefined;
  let netPrem = 0;
  if (pulseOrgan) {
    for (const t of WATCHLIST) {
      const v = pulseOrgan.data.per_ticker?.[t]?.netPremium;
      if (typeof v === 'number' && Number.isFinite(v)) netPrem += v;
    }
  }
  const marketTide = netPrem > 5_000_000 ? 'bullish' : netPrem < -5_000_000 ? 'bearish' : 'flat';

  // --- Pre-computed aggregates (parallel) -------------------------------
  // FlowPulse (6h directional imbalance + per-ticker baseline dev) and
  // contract stacking (repeat-hit contracts with buy/sell/ask breakdown) come
  // from RPCs not yet wrapped as brain organs. Regime tide (spot_pct_from_prev_close
  // avg over last 60 min) reads ct_scored_flow which is also organ-less today.
  // Prior commentary moved to the brain's tape organ above.
  const regimeWindow = new Date(now.getTime() - 60 * 60_000);
  // session_date in ct_tape_commentary is NY-tz date; filter today's prior runs
  const nyToday = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const sessionDate = `${nyToday.getFullYear()}-${String(nyToday.getMonth() + 1).padStart(2, '0')}-${String(nyToday.getDate()).padStart(2, '0')}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb: any = supabase;
  const [flowPulseRes, stackingRes, regimeRes] = await Promise.all([
    sb.rpc('ct_flow_pulse', { p_window_min: 360, p_ticker: null }),
    sb.rpc('ct_contract_stacking', {
      p_window_min: 360,
      p_min_prints: 3,
      p_min_premium: 100_000,
      p_ticker: null,
      p_limit: 10,
    }),
    sb.from('ct_scored_flow')
      .select('ticker, spot_pct_from_prev_close')
      .gte('event_ts', regimeWindow.toISOString())
      .in('ticker', WATCHLIST)
      .not('spot_pct_from_prev_close', 'is', null)
      .limit(2000),
  ]);

  const pulseRows = (flowPulseRes?.error ? [] : (flowPulseRes?.data ?? [])) as FlowPulseRow[];
  const stackRows = (stackingRes?.error ? [] : (stackingRes?.data ?? [])) as StackRow[];
  const regimeRows = (regimeRes?.error ? [] : (regimeRes?.data ?? [])) as RegimeSpotRow[];

  // Prior commentary today via the brain's tape organ (ct_tape_commentary helper).
  // Helper returns latest + prior newest-first; tape-reader narrates oldest-first
  // so "your prior observations today" reads chronologically.
  const priorEntries = tapeOrgan
    ? [
        ...(tapeOrgan.data.latest ? [tapeOrgan.data.latest] : []),
        ...tapeOrgan.data.prior,
      ]
        .filter((e) => e.session_date === sessionDate)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, 3)
    : [];
  const priorRows: PriorCommentaryRow[] = priorEntries.map((e) => ({
    created_at: e.created_at,
    commentary: e.commentary,
  }));

  // Market-wide aggregate from flow pulse rows
  let mktCalls = 0, mktPuts = 0, mktCallsPrem = 0, mktPutsPrem = 0, mktNetPrem = 0;
  for (const r of pulseRows) {
    mktCalls += r.calls_count ?? 0;
    mktPuts += r.puts_count ?? 0;
    mktCallsPrem += Number(r.calls_premium ?? 0);
    mktPutsPrem += Number(r.puts_premium ?? 0);
    mktNetPrem += Number(r.premium_net ?? 0);
  }
  const mktCpRatio = mktPutsPrem > 0
    ? mktCallsPrem / mktPutsPrem
    : (mktCalls / Math.max(mktPuts, 1));

  // Regime tide — avg spot_pct_from_prev_close across watchlist + per-ticker
  const regimeByTicker = new Map<string, { sum: number; n: number }>();
  let regimeSum = 0;
  let regimeN = 0;
  for (const r of regimeRows) {
    const v = r.spot_pct_from_prev_close;
    if (v == null || !Number.isFinite(Number(v))) continue;
    const pct = Number(v);
    regimeSum += pct;
    regimeN += 1;
    const cur = regimeByTicker.get(r.ticker) ?? { sum: 0, n: 0 };
    cur.sum += pct;
    cur.n += 1;
    regimeByTicker.set(r.ticker, cur);
  }
  const regimeAvg = regimeN > 0 ? regimeSum / regimeN : null;

  // --- Build prompt ------------------------------------------------------

  const lines: string[] = [];
  lines.push(`Session: ${tctx.session_date} (${tctx.session_day_name}) — now ${tctx.now_et}`);
  lines.push(`Window: ${windowMin} min ending ${tagIsoTimestamp(now.toISOString(), tctx.session_date)}`);
  lines.push(`VIX: ${vixLevel != null ? vixLevel.toFixed(2) : 'n/a'}${vixChange != null ? ` (${vixChange >= 0 ? '+' : ''}${vixChange.toFixed(2)}%)` : ''} | Tide: ${marketTide} (net ${fmtPremium(netPrem)})`);
  lines.push('');
  lines.push(`SPOT (latest close): ${WATCHLIST.map((t) => `${t} ${spotMap.get(t)?.toFixed(2) ?? '?'}`).join('  ')}`);
  lines.push('');

  // --- Block 1: Flow Pulse (6h macro aggregate) ---
  if (pulseRows.length > 0) {
    lines.push('[MARKET FLOW PULSE — 6h aggregate across watchlist]');
    const netLabel = mktNetPrem > 0 ? 'bullish' : mktNetPrem < 0 ? 'bearish' : 'flat';
    const netSign = mktNetPrem >= 0 ? '+' : '-';
    lines.push(
      `  Market-wide: ${mktCalls}C (${fmtPremium(mktCallsPrem)}) vs ${mktPuts}P (${fmtPremium(mktPutsPrem)}) · ${mktCpRatio.toFixed(2)}x call:put · net ${netSign}${fmtPremium(Math.abs(mktNetPrem))} ${netLabel}`,
    );
    lines.push('  Per-ticker:');
    // Sort by abs deviation so unusual tickers surface first; fall back to net premium
    const sorted = [...pulseRows].sort((a, b) => {
      const da = a.cp_ratio_deviation == null ? 0 : Math.abs(Number(a.cp_ratio_deviation) - 1);
      const db = b.cp_ratio_deviation == null ? 0 : Math.abs(Number(b.cp_ratio_deviation) - 1);
      if (db !== da) return db - da;
      return Math.abs(Number(b.premium_net ?? 0)) - Math.abs(Number(a.premium_net ?? 0));
    });
    for (const r of sorted) {
      const flag = r.is_unusual ? ' ⚠ unusual' : '';
      const baseline = r.cp_ratio_baseline_30d != null
        ? ` (baseline ${Number(r.cp_ratio_baseline_30d).toFixed(2)}x${r.cp_ratio_deviation != null ? `, ${Number(r.cp_ratio_deviation).toFixed(2)}x today` : ''})`
        : '';
      const net = Number(r.premium_net ?? 0);
      const netSignR = net >= 0 ? '+' : '-';
      const netLabelR = net > 0 ? 'bullish' : net < 0 ? 'bearish' : 'flat';
      lines.push(
        `    ${r.is_unusual ? '⚠ ' : ''}${r.ticker}: ${r.calls_count}C/${r.puts_count}P · ${Number(r.call_put_ratio ?? 0).toFixed(2)}x${baseline} · net ${netSignR}${fmtPremium(Math.abs(net))} ${netLabelR}${flag}`,
      );
    }
    lines.push('');
  }

  // --- Block 2: Stacking patterns (contracts hit repeatedly) ---
  if (stackRows.length > 0) {
    lines.push('[STACKING PATTERNS — contracts repeatedly hit today (6h)]');
    const top = stackRows.slice(0, 5);
    for (const s of top) {
      const signal = interpretStack({
        side: s.side,
        opening_buy_count: s.opening_buy_count ?? 0,
        opening_sell_count: s.opening_sell_count ?? 0,
        ask_dominant_pct: s.ask_dominant_pct,
        prints_count: s.prints_count ?? 0,
      });
      const marker = signal.color === 'bullish' ? '🟢' : signal.color === 'bearish' ? '🔴' : '🟡';
      const expiry = s.expiry ? s.expiry.slice(5).replace('-', '/') : '?';
      const strikeSide = `${s.strike != null ? `$${s.strike}` : '?'}${s.side}`;
      lines.push(
        `  ${marker} ${s.ticker} ${strikeSide} ${expiry} · ${s.prints_count} prints · ${fmtPremium(Number(s.premium_total ?? 0))} cum · ${signal.label}`,
      );
    }
    lines.push('');
  }

  // --- Block 3: Market regime (where the tape is sitting) ---
  if (regimeN > 0 || vixLevel != null) {
    lines.push('[MARKET REGIME — where the tape is sitting]');
    if (regimeAvg != null) {
      const tilt = regimeAvg > 0.3 ? 'bullish tilt' : regimeAvg < -0.3 ? 'bearish tilt' : 'flat';
      lines.push(`  Watchlist avg: ${fmtSignedPct(regimeAvg)} from prev close (${tilt})`);
    }
    if (vixLevel != null) {
      lines.push(`  VIX: ${vixLevel.toFixed(2)}${vixChange != null ? ` (${vixChange >= 0 ? '+' : ''}${vixChange.toFixed(2)}%)` : ''}`);
    }
    if (regimeByTicker.size > 0) {
      const perTicker = WATCHLIST
        .map((t) => {
          const agg = regimeByTicker.get(t);
          if (!agg || agg.n === 0) return null;
          return `${t} ${fmtSignedPct(agg.sum / agg.n)}`;
        })
        .filter((x): x is string => x !== null);
      if (perTicker.length > 0) lines.push(`  Per-ticker: ${perTicker.join(', ')}`);
    }
    lines.push('');
  }

  if (scored.length > 0) {
    lines.push('TOP SCORED FLOW (score desc):');
    for (const r of scored) {
      const cls = r.classification ? ` ${r.classification}` : '';
      const dir = r.direction ? ` ${r.direction}` : '';
      const ask = r.ask_side_perc != null ? ` ask${Math.round(r.ask_side_perc)}%` : '';
      const vOi = (r.volume && r.open_interest) ? ` V/OI ${(r.volume / r.open_interest).toFixed(1)}x` : '';
      const when = tagIsoTimestamp(r.event_ts, tctx.session_date);
      lines.push(`  ${when} ${fmtContract(r)} | score ${r.score ?? '?'}${dir}${cls} | ${fmtPremium(r.premium)}${vOi}${ask}`);
    }
  } else {
    lines.push('TOP SCORED FLOW: (nothing in window)');
  }

  if (flags.length > 0) {
    lines.push('');
    lines.push('ACTIVE SPECIALIST FLAGS (last 30 min):');
    for (const f of flags) {
      const when = tagIsoTimestamp(f.created_at, tctx.session_date);
      const thesis = (f.thesis ?? '').slice(0, 160);
      const detector = f.detector_name ? ` <${f.detector_name}>` : '';
      lines.push(`  ${when} ${f.ticker} ${f.direction} score ${Math.round(f.score)}${detector}: ${thesis}`);
    }
  }

  if (news.length > 0) {
    lines.push('');
    lines.push('BREAKING NEWS (last 30min, severity >=2):');
    for (const n of news) {
      const tickers = (n.tickers_affected ?? []).join(',');
      const ingestedTag = n.ingested_at
        ? tagIsoTimestamp(n.ingested_at, tctx.session_date)
        : '**UNKNOWN_TIME**';
      const publishedTag = n.event_at && n.event_at !== n.ingested_at
        ? tagIsoTimestamp(n.event_at, tctx.session_date)
        : null;
      const whenStr = publishedTag ? `${ingestedTag} (published ${publishedTag})` : ingestedTag;
      const sentiment = n.sentiment ?? '—';
      const headline = (n.headline ?? '').slice(0, 140);
      lines.push(`  ${whenStr} [sev ${n.severity} ${sentiment}] ${tickers ? `(${tickers}) ` : ''}${headline}`);
      if (n.summary) lines.push(`    ${n.summary.slice(0, 200)}`);
    }
  }

  // What just happened — preamble from event_recency organ. Bullet list of
  // last-72h material events with outcomes (FOMC, earnings, macro prints) so
  // the reader doesn't pattern-complete on yesterday's news as today's setup.
  if (ctx.preamble.whatJustHappened && ctx.preamble.whatJustHappened.trim()) {
    lines.push('');
    lines.push('[WHAT JUST HAPPENED — last 72h material events with outcomes]');
    lines.push(ctx.preamble.whatJustHappened);
  }

  if (priorRows.length > 0) {
    lines.push('');
    lines.push('[YOUR PRIOR OBSERVATIONS TODAY — chronological, oldest first]');
    const chronological = [...priorRows].reverse();
    for (const p of chronological) {
      const when = tagIsoTimestamp(p.created_at, tctx.session_date);
      const oneLine = (p.commentary || '').replace(/\s+/g, ' ').trim();
      lines.push(`  ${when}: "${oneLine}"`);
    }
    lines.push('(When your current read builds on, confirms, or contradicts these, reference them explicitly.)');
  }

  const systemBody = `You are a senior options flow reader looking over a day trader's shoulder. You read the tape for the Mag-7 + major indexes. Write 2-3 sentences describing what's happening right now. No hedging, no disclaimers, no "this is not financial advice." If the tape is quiet, say "Quiet tape." and note what would change that. If something is unusual, name it specifically — ticker, contract, pattern. Every sentence must say something.

You now receive pre-computed aggregates — [MARKET FLOW PULSE], [STACKING PATTERNS], and [MARKET REGIME] — at the top of each prompt. These are the macro anchor: use them directly, don't re-derive them from the candidate rows below. Reference them explicitly ("flow pulse shows NVDA 6.75x unusual, matches what I'm seeing on the tape..."). The stacking labels (call accumulation / put writing / distribution) are already interpreted — read them as directional signal, not raw buy/sell counts. The regime line tells you where the tape is sitting before you read individual prints.`;

  const system = tctx.temporalAnchorPreamble + '\n\n' + systemBody;

  const userMsg = lines.join('\n');

  // --- Call Claude -------------------------------------------------------

  let commentary = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let modelUsed = CLAUDE_MODELS.haiku;
  let apiError: string | null = null;

  try {
    const resp = await callClaude({
      model: CLAUDE_MODELS.haiku,
      system,
      messages: [{ role: 'user', content: userMsg }],
      max_tokens: 600,
      temperature: 0.3,
    });
    const textBlock = resp.content.find((b) => b.type === 'text' && b.text);
    commentary = (textBlock?.text ?? '').trim();
    inputTokens = resp.usage?.input_tokens ?? 0;
    outputTokens = resp.usage?.output_tokens ?? 0;
    modelUsed = resp.model ?? modelUsed;
  } catch (e) {
    apiError = e instanceof ClaudeError ? `${e.status}: ${e.message}` : (e instanceof Error ? e.message : String(e));
    commentary = `[reader offline] ${apiError.slice(0, 200)}`;
  }

  // Cost
  const rate = CLAUDE_RATES[modelUsed as keyof typeof CLAUDE_RATES] ?? CLAUDE_RATES[CLAUDE_MODELS.haiku];
  const costUsd = (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000;

  // Temporal-coherence validator (best-effort). Catches commentary that
  // pattern-completed on yesterday's news as today's framing. Critical
  // contradictions log to console; ct_tape_commentary has no
  // validator_warnings column today (Saturday work — see spec).
  let validatorOk = true;
  let validatorContradictions: Array<{ quote: string; issue: string; severity: 'critical' | 'warning' }> = [];
  if (commentary && !apiError) {
    try {
      const validation = await validateTemporalCoherence(commentary, tctx.session_date);
      validatorOk = validation.ok;
      validatorContradictions = validation.contradictions;
      const critical = validation.contradictions.filter(c => c.severity === 'critical');
      if (critical.length > 0) {
        console.warn(
          `[ct-tape-reader] temporal validator flagged ${critical.length} CRITICAL contradiction(s) for session ${tctx.session_date}:`,
          JSON.stringify(critical),
        );
      } else if (!validation.ok && validation.contradictions.length > 0) {
        console.warn(
          `[ct-tape-reader] temporal validator flagged ${validation.contradictions.length} warning(s) for session ${tctx.session_date}:`,
          JSON.stringify(validation.contradictions),
        );
      }
    } catch (e) {
      // Best-effort — never block the run.
      console.warn('[ct-tape-reader] temporal validator threw (non-blocking):', String(e));
    }
  }

  // --- Persist -----------------------------------------------------------

  const row = {
    trigger_kind,
    commentary,
    flow_ids: scored.map((r) => r.id),
    flag_ids: flags.map((f) => f.flag_id),
    vix_level: vixLevel,
    market_tide: marketTide,
    window_start: windowStart.toISOString(),
    window_end: now.toISOString(),
    model: modelUsed,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost_usd: Math.round(costUsd * 1_000_000) / 1_000_000,
  };

  const { data: inserted, error: insertErr } = await supabase
    .from('ct_tape_commentary')
    .insert(row)
    .select('id,created_at')
    .single();

  return new Response(JSON.stringify({
    ok: !apiError,
    trigger_kind,
    id: inserted?.id,
    created_at: inserted?.created_at,
    commentary,
    flow_count: scored.length,
    flag_count: flags.length,
    vix_level: vixLevel,
    market_tide: marketTide,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost_usd: row.cost_usd,
    model: modelUsed,
    api_error: apiError,
    insert_error: insertErr?.message ?? null,
    session_date: tctx.session_date,
    temporal_validator: {
      ok: validatorOk,
      contradiction_count: validatorContradictions.length,
      critical_count: validatorContradictions.filter(c => c.severity === 'critical').length,
    },
  }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});
