/**
 * claudeReadSurface — THE ISOLATION CONTRACT.
 *
 * Every Claude-facing function (hypothesis proposer, health check, trade idea
 * generator, etc.) MUST assemble its context by calling `buildClaudeContext`.
 * Direct table reads from those functions for James-owned data are forbidden.
 *
 * Why this file exists: Claude runs its own paper account in parallel to
 * James. If Claude sees James's trades, reviews, or private rules, it starts
 * pattern-matching to James's behavior and stops being an independent trader.
 * This helper IS the firewall.
 *
 *   ALLOWED READS (Claude may see):
 *     - ct_heartbeats (objective market snapshot — shared infrastructure)
 *     - ct_hypotheses where status='open' (Claude's own reasoning)
 *     - ct_hypothesis_events (Claude's own event log)
 *     - ct_trades where trader='claude'
 *     - ct_trade_ideas where trader='claude'
 *     - ct_grades where hypothesis_id is not null (feedback on Claude's thinking)
 *     - ct_flow_alerts (market-wide — compacted)
 *     - ct_dark_pool_prints (market-wide — compacted, >=$500K notional)
 *     - ct_nope_minute (per-ticker gamma hedging pressure)
 *     - ct_net_premium_ticks (per-ticker intraday directional sentiment)
 *     - ct_greek_flow_minute (per-ticker dealer delta/vega flow)
 *     - ct_top_movers (watchlist generator output)
 *     - ct_iv_rank_daily (per-ticker IV regime)
 *     - ct_max_pain_daily (per-ticker per-expiry max pain)
 *     - ct_news_analyses (Claude-annotated news — watchlist-filtered)
 *     - ct_breaking_news (Tavily real-time macro — last 24h, severity>=3)
 *     - ct_events (earnings/FDA/econ calendar — next 14 days)
 *     - ct_earnings_moves (watchlist historical earnings moves)
 *     - ct_fundamentals_cache (watchlist fundamentals)
 *     - ct_vix_history (latest VIX close)
 *     - ct_principles WHERE trader='claude' AND status='active' (Claude's own wisdom)
 *     - ct_biases WHERE active=true (Claude's own blind spots)
 *     - ct_playbooks WHERE status='active' (curated setups)
 *     - ct_daily_briefs latest non-expired (Sonnet's world-view for today)
 *     - Chat messages ONLY when claude_chat_is_advisory=true, tagged "advisory"
 *
 *   BLOCKED READS (never queried here, under any circumstances):
 *     - ct_trades where trader='james'
 *     - ct_book where trader='james'
 *     - ct_custom_rules where trader='james'  (until a share_with_claude flag is added)
 *     - ct_james_reviews (the entire table — James's thumbs, invisible to Claude)
 *     - ct_notes (James's private notes, if the table exists)
 *
 * Extending the surface: add a field to ClaudeContext, add a query below,
 * update the preamble string if the new data needs narration. Anything
 * James-owned must route through an explicit consent flag (like a future
 * share_with_claude column), never via direct select.
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { getConfig } from './configCache.ts';
import { getWatchlist } from './watchlist.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Heartbeat {
  id?: string;
  status_line: string | null;
  watching: unknown;
  current_reads: unknown;
  created_at: string;
}

export interface Hypothesis {
  id: string;
  claim: string;
  because: string[];
  invalidate_if: string;
  horizon: string;
  tickers: string[];
  confidence: number;
  elo: number;
  status: string;
  last_tested_at: string | null;
  updated_at: string;
  created_at: string;
}

export interface HypEvent {
  id: string;
  hypothesis_id: string;
  event_type: string;
  reason: string | null;
  created_by: string | null;
  created_at: string;
}

export interface Trade {
  id: string;
  trader: 'claude' | 'james';
  instrument: string;
  side: string;
  size_pct: number | null;
  entry_price: number | null;
  stop_price: number | null;
  target_price: number | null;
  contract_type: string | null;
  strike: number | null;
  expiry: string | null;
  thesis: string | null;
  conviction: number | null;
  status: string;
  hypothesis_id: string | null;
  opened_at: string | null;
  closed_at: string | null;
  realized_pnl: number | null;
}

export interface TradeIdea {
  id: string;
  trader: 'claude' | 'james';
  hypothesis_id: string | null;
  instrument: string;
  side: string | null;
  trigger_condition: unknown;
  status: string;
  created_at: string;
}

export interface Grade {
  id: string;
  subject_type: string;
  instrument: string;
  claimed_direction: string | null;
  actual_direction: string | null;
  actual_return_pct: number | null;
  verdict: string;
  notes: string | null;
  hypothesis_id: string | null;
  graded_at: string;
}

export type AutonomyMode = 'suggest' | 'draft' | 'execute';

// ---------------------------------------------------------------------------
// Extended market-surface types — compacted views of populated ingest tables.
// ---------------------------------------------------------------------------

export interface FlowAlertCompact {
  id: string;
  ticker: string;
  side: string | null;       // call | put
  strike: number | null;
  expiry: string | null;
  premium: number | null;
  size: number | null;
  is_ask: boolean | null;
  size_gt_oi: boolean | null;
  alert_type: string | null;
  executed_at: string | null;
}

export interface DarkPoolCompact {
  id: string;
  ticker: string;
  size: number;
  price: number;
  notional_value: number | null;
  executed_at: string | null;
}

export interface NopeLatest {
  ticker: string;
  tick_timestamp: string;
  nope: number | null;
  underlying_price: number | null;
}

export interface NetPremiumLatest {
  ticker: string;
  tick_timestamp: string;
  net_call_premium: number | null;
  net_put_premium: number | null;
  underlying_price: number | null;
}

export interface GreekFlowLatest {
  ticker: string;
  tick_timestamp: string;
  total_delta_flow: number | null;
  total_vega_flow: number | null;
  net_call_delta: number | null;
  net_put_delta: number | null;
}

export interface TopMover {
  ticker: string;
  side: 'bullish' | 'bearish';
  rank: number;
  net_premium: number | null;
  snapshot_at: string;
}

export interface IvRankRow {
  ticker: string;
  date: string;
  iv_rank: number | null;
  iv_percentile: number | null;
  iv_30d: number | null;
}

export interface MaxPainRow {
  ticker: string;
  date: string;
  expiry: string | null;
  max_pain_strike: number | null;
}

export interface NewsRow {
  id: string;
  instrument: string;
  news_headline: string;
  news_source: string | null;
  impact: string;           // bullish|bearish|neutral|mixed
  significance: number;     // 1-5
  claude_take: string | null;
  news_timestamp: string | null;
  created_at: string;
}

export interface BreakingNewsRow {
  id: string;
  headline: string;
  severity: number;
  sentiment: string | null;
  tickers_affected: string[];
  macro_wide: boolean;
  category: string | null;
  summary: string | null;
  ingested_at: string;
}

export interface CalendarEvent {
  id: string;
  event_type: string;       // earnings|fda|econ
  ticker: string | null;
  event_date: string;
  event_time: string | null;
  title: string | null;
  importance: number | null;
}

export interface EarningsMoveRow {
  ticker: string;
  report_date: string;
  move_pct: number | null;
  move_direction: string | null;
  beat_miss: string | null;
  surprise_pct: number | null;
}

export interface FundamentalsRow {
  ticker: string;
  as_of_date: string;
  pe_ratio: number | null;
  market_cap: number | null;
  eps_ttm: number | null;
  revenue_ttm: number | null;
  revenue_yoy_growth_pct: number | null;
  last_earnings_surprise_pct: number | null;
}

export interface VixLatest {
  date: string;
  level: number;
  change_pct: number | null;
  tier: string;
}

export interface PrincipleRow {
  id: string;
  principle: string;
  domain: string | null;
  strength: number;
  support_count: number;
  refute_count: number;
}

export interface BiasRow {
  id: string;
  pattern: string;
  severity: number;
  instruments: string[] | null;
  observed_count: number;
  last_confirmed: string;
}

export interface PlaybookRow {
  id: string;
  name: string;
  description: string;
  setup_criteria: unknown;
  historical_win_rate: number | null;
  sample_size: number;
  avg_r_multiple: number | null;
}

export interface DailyBriefRow {
  id: string;
  session_date: string;
  brief_version: number;
  urgency: string;
  macro_narrative: string;
  macro_regime: string | null;
  convergent_view: string;
  high_conviction_ideas: unknown;
  watchlist_focus: string[] | null;
  skip_today: string[] | null;
  expires_at: string;
  triggered_by: string;
}

export interface ClaudeContext {
  // Objective market — always allowed
  latestHeartbeat: Heartbeat | null;
  recentHeartbeats: Heartbeat[];

  // Claude's own reasoning
  openHypotheses: Hypothesis[];
  recentHypothesisEvents: HypEvent[];

  // Claude's own trades
  claudeOpenTrades: Trade[];
  claudeClosedTrades: Trade[];
  claudeArmedIdeas: TradeIdea[];

  // Claude's graded feedback
  claudeRecentGrades: Grade[];

  // Extended tape — market-wide flow + dark pool + sentiment
  recentFlowAlerts: FlowAlertCompact[];
  recentDarkPool: DarkPoolCompact[];
  recentNope: NopeLatest[];
  netPremiumTicks: NetPremiumLatest[];
  greekFlow: GreekFlowLatest[];
  topMovers: TopMover[];

  // Volatility / structure
  ivRanks: IvRankRow[];
  maxPain: MaxPainRow[];
  vixLatest: VixLatest | null;

  // News + calendar
  recentNews: NewsRow[];
  recentBreakingNews: BreakingNewsRow[];
  upcomingEvents: CalendarEvent[];
  earningsMoves: EarningsMoveRow[];
  fundamentals: FundamentalsRow[];

  // Claude's own wisdom layer
  activePrinciples: PrincipleRow[];
  activeBiases: BiasRow[];
  activePlaybooks: PlaybookRow[];
  activeBrief: DailyBriefRow | null;

  // Watchlist the above were filtered against (for downstream prompt clarity)
  watchlist: string[];

  // Chat — ADVISORY only, tagged as such
  advisoryChatContext: string;
  chatIsAdvisory: boolean;

  // Config snapshot
  autonomyMode: AutonomyMode;
  paperStartingBalance: number;
  currentBalance: number | null;
  maxConcurrent: number;
  maxSizePct: number;
  minHypConfidence: number;

  // Explicit denial list for auditability
  blockedFromReading: string[];
}

export interface BuildClaudeContextOpts {
  /** How many recent heartbeats to include. Default 1 (just the latest). */
  heartbeatLimit?: number;
  /** How many open hypotheses to include. Default 30. */
  openHypothesisLimit?: number;
  /** How many recent hypothesis_events to include total. Default 50. */
  hypothesisEventLimit?: number;
  /** How many closed Claude trades to include. Default 20. */
  closedTradeLimit?: number;
  /** How many recent Claude-linked grades to include. Default 20. */
  gradeLimit?: number;
  /** Hours of chat history to surface when advisory mode is on. Default 12. */
  chatLookbackHours?: number;
  /** How many recent flow alerts. Default 30. */
  flowAlertLimit?: number;
  /** How many recent dark pool prints (>=$500K notional). Default 20. */
  darkPoolLimit?: number;
  /** Minimum dark-pool notional $ to include. Default 500000. */
  darkPoolMinNotional?: number;
  /** How many recent greek-flow rows per ticker. Default 6. */
  greekFlowPerTicker?: number;
  /** Days forward for calendar events. Default 14. */
  eventHorizonDays?: number;
  /** Max expiries per ticker for max pain. Default 3. */
  maxPainExpiriesPerTicker?: number;
  /** Hours back for breaking news. Default 24. */
  breakingNewsHours?: number;
  /** How many recent ticker-filtered news rows. Default 20. */
  newsLimit?: number;
  /** Max active principles. Default 20. */
  principleLimit?: number;
  /** Max active biases. Default 20. */
  biasLimit?: number;
  /** Max active playbooks. Default 10. */
  playbookLimit?: number;
}

// ---------------------------------------------------------------------------
// The blocked list — hard-coded for auditability. Every Claude context response
// carries this so a downstream log reader can prove what was off-limits.
// ---------------------------------------------------------------------------
const BLOCKED_READS: string[] = [
  "ct_trades WHERE trader='james'",
  "ct_book WHERE trader='james'",
  "ct_custom_rules WHERE trader='james'",
  "ct_james_reviews (entire table)",
  "ct_notes (entire table, if it exists)",
];

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export async function buildClaudeContext(
  supabase: SupabaseClient,
  opts: BuildClaudeContextOpts = {},
): Promise<ClaudeContext> {
  const heartbeatLimit = opts.heartbeatLimit ?? 1;
  const openHypothesisLimit = opts.openHypothesisLimit ?? 30;
  const hypothesisEventLimit = opts.hypothesisEventLimit ?? 50;
  const closedTradeLimit = opts.closedTradeLimit ?? 20;
  const gradeLimit = opts.gradeLimit ?? 20;
  const flowAlertLimit = opts.flowAlertLimit ?? 30;
  const darkPoolLimit = opts.darkPoolLimit ?? 20;
  const darkPoolMinNotional = opts.darkPoolMinNotional ?? 500_000;
  const greekFlowPerTicker = opts.greekFlowPerTicker ?? 6;
  const eventHorizonDays = opts.eventHorizonDays ?? 14;
  const maxPainExpiriesPerTicker = opts.maxPainExpiriesPerTicker ?? 3;
  const breakingNewsHours = opts.breakingNewsHours ?? 24;
  const newsLimit = opts.newsLimit ?? 20;
  const principleLimit = opts.principleLimit ?? 20;
  const biasLimit = opts.biasLimit ?? 20;
  const playbookLimit = opts.playbookLimit ?? 10;

  // --- config snapshot (all keys have safe fallbacks) --------------------
  const autonomyModeRaw = String(await getConfig<string>('claude_autonomy_mode', 'execute'));
  const autonomyMode: AutonomyMode =
    autonomyModeRaw === 'suggest' || autonomyModeRaw === 'draft' || autonomyModeRaw === 'execute'
      ? autonomyModeRaw
      : 'execute';
  const paperStartingBalance = Number(await getConfig<number>('claude_paper_starting_balance', 100000));
  const maxConcurrent = Number(await getConfig<number>('claude_max_concurrent_positions', 5));
  const maxSizePct = Number(await getConfig<number>('claude_max_position_size_pct', 5));
  const chatIsAdvisoryFlag = Boolean(await getConfig<boolean>('claude_chat_is_advisory', true));
  const minHypConfidence = Number(await getConfig<number>('claude_min_hypothesis_confidence', 0.45));

  // --- market (objective, always allowed) --------------------------------
  const { data: hbRows } = await supabase
    .from('ct_heartbeats')
    .select('id, status_line, watching, current_reads, created_at')
    .order('created_at', { ascending: false })
    .limit(heartbeatLimit);
  const recentHeartbeats: Heartbeat[] = (hbRows ?? []).map((r) => ({
    id: r.id,
    status_line: r.status_line ?? null,
    watching: r.watching ?? null,
    current_reads: r.current_reads ?? null,
    created_at: r.created_at,
  }));
  const latestHeartbeat = recentHeartbeats[0] ?? null;

  // --- open hypotheses (Claude's own reasoning) --------------------------
  const { data: hypRows } = await supabase
    .from('ct_hypotheses')
    .select('id, claim, because, invalidate_if, horizon, tickers, confidence, elo, status, last_tested_at, updated_at, created_at')
    .eq('status', 'open')
    .order('elo', { ascending: false })
    .limit(openHypothesisLimit);
  const openHypotheses: Hypothesis[] = (hypRows ?? []).map((r) => ({
    id: String(r.id),
    claim: String(r.claim ?? ''),
    because: Array.isArray(r.because) ? (r.because as unknown[]).map((x) => String(x)) : [],
    invalidate_if: String(r.invalidate_if ?? ''),
    horizon: String(r.horizon ?? 'session'),
    tickers: Array.isArray(r.tickers) ? (r.tickers as unknown[]).map((x) => String(x)) : [],
    confidence: Number(r.confidence ?? 0),
    elo: Number(r.elo ?? 1500),
    status: String(r.status ?? 'open'),
    last_tested_at: r.last_tested_at ?? null,
    updated_at: r.updated_at,
    created_at: r.created_at,
  }));

  // --- recent hypothesis events ------------------------------------------
  let recentHypothesisEvents: HypEvent[] = [];
  if (openHypotheses.length > 0) {
    const { data: evRows } = await supabase
      .from('ct_hypothesis_events')
      .select('id, hypothesis_id, event_type, reason, created_by, created_at')
      .in('hypothesis_id', openHypotheses.map((h) => h.id))
      .order('created_at', { ascending: false })
      .limit(hypothesisEventLimit);
    recentHypothesisEvents = (evRows ?? []).map((r) => ({
      id: String(r.id),
      hypothesis_id: String(r.hypothesis_id),
      event_type: String(r.event_type ?? ''),
      reason: r.reason ?? null,
      created_by: r.created_by ?? null,
      created_at: r.created_at,
    }));
  }

  // --- Claude's open trades ----------------------------------------------
  const { data: openTradeRows } = await supabase
    .from('ct_trades')
    .select('id, trader, instrument, side, size_pct, entry_price, stop_price, target_price, contract_type, strike, expiry, thesis, conviction, status, hypothesis_id, opened_at, closed_at, realized_pnl')
    .eq('trader', 'claude')
    .eq('status', 'open')
    .order('opened_at', { ascending: false });
  const claudeOpenTrades: Trade[] = (openTradeRows ?? []).map(normalizeTrade);

  // --- Claude's closed trades --------------------------------------------
  const { data: closedTradeRows } = await supabase
    .from('ct_trades')
    .select('id, trader, instrument, side, size_pct, entry_price, stop_price, target_price, contract_type, strike, expiry, thesis, conviction, status, hypothesis_id, opened_at, closed_at, realized_pnl')
    .eq('trader', 'claude')
    .eq('status', 'closed')
    .order('closed_at', { ascending: false })
    .limit(closedTradeLimit);
  const claudeClosedTrades: Trade[] = (closedTradeRows ?? []).map(normalizeTrade);

  // --- Claude's armed trade ideas ----------------------------------------
  let claudeArmedIdeas: TradeIdea[] = [];
  try {
    const { data: ideaRows, error: ideaErr } = await supabase
      .from('ct_trade_ideas')
      .select('id, trader, hypothesis_id, instrument, side, trigger_condition, status, created_at')
      .eq('trader', 'claude')
      .eq('status', 'armed')
      .order('created_at', { ascending: false });
    if (ideaErr) {
      console.warn('[claudeReadSurface] armed ideas query failed:', ideaErr.message);
    } else {
      claudeArmedIdeas = (ideaRows ?? []).map((r) => ({
        id: String(r.id),
        trader: (r.trader === 'claude' ? 'claude' : 'james') as 'claude' | 'james',
        hypothesis_id: r.hypothesis_id ?? null,
        instrument: String(r.instrument ?? ''),
        side: r.side ?? null,
        trigger_condition: r.trigger_condition ?? null,
        status: String(r.status ?? 'armed'),
        created_at: r.created_at,
      }));
    }
  } catch (e) {
    console.warn('[claudeReadSurface] armed ideas threw:', e instanceof Error ? e.message : e);
  }

  // --- Claude-linked recent grades ---------------------------------------
  const { data: gradeRows } = await supabase
    .from('ct_grades')
    .select('id, subject_type, instrument, claimed_direction, actual_direction, actual_return_pct, verdict, notes, hypothesis_id, graded_at')
    .not('hypothesis_id', 'is', null)
    .order('graded_at', { ascending: false })
    .limit(gradeLimit);
  const claudeRecentGrades: Grade[] = (gradeRows ?? []).map((r) => ({
    id: String(r.id),
    subject_type: String(r.subject_type ?? ''),
    instrument: String(r.instrument ?? ''),
    claimed_direction: r.claimed_direction ?? null,
    actual_direction: r.actual_direction ?? null,
    actual_return_pct: r.actual_return_pct ?? null,
    verdict: String(r.verdict ?? ''),
    notes: r.notes ?? null,
    hypothesis_id: r.hypothesis_id ?? null,
    graded_at: r.graded_at,
  }));

  // --- Claude's current paper balance ------------------------------------
  let currentBalance: number | null = null;
  try {
    const { data: bookRow } = await supabase
      .from('ct_book')
      .select('ending_balance, session_date')
      .eq('trader', 'claude')
      .order('session_date', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (bookRow && typeof bookRow.ending_balance === 'number') {
      currentBalance = Number(bookRow.ending_balance);
    }
  } catch (e) {
    console.warn('[claudeReadSurface] ct_book(claude) read threw:', e instanceof Error ? e.message : e);
  }

  // --- Advisory chat context ---------------------------------------------
  //
  // TODO: Chat messages are currently held in localStorage on the client
  // (see src/components/command/ChatPanel.tsx — STORAGE_KEY lookup). There
  // is no server-side chat table to query. When a persistent ct_chat_messages
  // table lands, pull the last N messages here WHEN chatIsAdvisory=true,
  // format as "ADVISORY INPUT FROM JAMES (consider but not binding):" block.
  // Until then, this field stays empty and chatIsAdvisory is forced false in
  // the returned context regardless of the config flag — we can't serve
  // advisory context we don't have.
  const advisoryChatContext = '';
  const chatIsAdvisory = chatIsAdvisoryFlag && advisoryChatContext.length > 0;

  // --- Watchlist (for filtering news / events / per-ticker reads) --------
  const watchlist = await getWatchlist(supabase);

  // --- Flow alerts (market-wide, compacted, most recent first) -----------
  let recentFlowAlerts: FlowAlertCompact[] = [];
  try {
    const { data } = await supabase
      .from('ct_flow_alerts')
      .select('id, ticker, side, strike, expiry, premium, size, is_ask, size_gt_oi, alert_type, executed_at')
      .order('executed_at', { ascending: false, nullsFirst: false })
      .limit(flowAlertLimit);
    recentFlowAlerts = (data ?? []).map((r) => ({
      id: String(r.id),
      ticker: String(r.ticker ?? ''),
      side: (r.side as string) ?? null,
      strike: r.strike == null ? null : Number(r.strike),
      expiry: (r.expiry as string) ?? null,
      premium: r.premium == null ? null : Number(r.premium),
      size: r.size == null ? null : Number(r.size),
      is_ask: r.is_ask == null ? null : Boolean(r.is_ask),
      size_gt_oi: r.size_gt_oi == null ? null : Boolean(r.size_gt_oi),
      alert_type: (r.alert_type as string) ?? null,
      executed_at: (r.executed_at as string) ?? null,
    }));
  } catch (e) {
    console.warn('[claudeReadSurface] ct_flow_alerts:', e instanceof Error ? e.message : e);
  }

  // --- Dark pool prints (>=$500K notional, compacted) --------------------
  let recentDarkPool: DarkPoolCompact[] = [];
  try {
    const { data } = await supabase
      .from('ct_dark_pool_prints')
      .select('id, ticker, size, price, notional_value, executed_at')
      .gte('notional_value', darkPoolMinNotional)
      .order('executed_at', { ascending: false, nullsFirst: false })
      .limit(darkPoolLimit);
    recentDarkPool = (data ?? []).map((r) => ({
      id: String(r.id),
      ticker: String(r.ticker ?? ''),
      size: Number(r.size ?? 0),
      price: Number(r.price ?? 0),
      notional_value: r.notional_value == null ? null : Number(r.notional_value),
      executed_at: (r.executed_at as string) ?? null,
    }));
  } catch (e) {
    console.warn('[claudeReadSurface] ct_dark_pool_prints:', e instanceof Error ? e.message : e);
  }

  // --- NOPE latest per watchlist ticker (1 row each) ---------------------
  const recentNope: NopeLatest[] = [];
  for (const tkr of watchlist) {
    try {
      const { data } = await supabase
        .from('ct_nope_minute')
        .select('ticker, tick_timestamp, nope, underlying_price')
        .eq('ticker', tkr)
        .order('tick_timestamp', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (data) {
        recentNope.push({
          ticker: String(data.ticker ?? tkr),
          tick_timestamp: data.tick_timestamp,
          nope: data.nope == null ? null : Number(data.nope),
          underlying_price: data.underlying_price == null ? null : Number(data.underlying_price),
        });
      }
    } catch (_e) { /* skip ticker */ }
  }

  // --- Net premium ticks latest per watchlist ticker ---------------------
  const netPremiumTicks: NetPremiumLatest[] = [];
  for (const tkr of watchlist) {
    try {
      const { data } = await supabase
        .from('ct_net_premium_ticks')
        .select('ticker, tick_timestamp, net_call_premium, net_put_premium, underlying_price')
        .eq('ticker', tkr)
        .order('tick_timestamp', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (data) {
        netPremiumTicks.push({
          ticker: String(data.ticker ?? tkr),
          tick_timestamp: data.tick_timestamp,
          net_call_premium: data.net_call_premium == null ? null : Number(data.net_call_premium),
          net_put_premium: data.net_put_premium == null ? null : Number(data.net_put_premium),
          underlying_price: data.underlying_price == null ? null : Number(data.underlying_price),
        });
      }
    } catch (_e) { /* skip ticker */ }
  }

  // --- Greek flow: last N per watchlist ticker ---------------------------
  const greekFlow: GreekFlowLatest[] = [];
  for (const tkr of watchlist) {
    try {
      const { data } = await supabase
        .from('ct_greek_flow_minute')
        .select('ticker, tick_timestamp, total_delta_flow, total_vega_flow, net_call_delta, net_put_delta')
        .eq('ticker', tkr)
        .order('tick_timestamp', { ascending: false })
        .limit(greekFlowPerTicker);
      for (const r of (data ?? [])) {
        greekFlow.push({
          ticker: String(r.ticker ?? tkr),
          tick_timestamp: r.tick_timestamp,
          total_delta_flow: r.total_delta_flow == null ? null : Number(r.total_delta_flow),
          total_vega_flow: r.total_vega_flow == null ? null : Number(r.total_vega_flow),
          net_call_delta: r.net_call_delta == null ? null : Number(r.net_call_delta),
          net_put_delta: r.net_put_delta == null ? null : Number(r.net_put_delta),
        });
      }
    } catch (_e) { /* skip ticker */ }
  }

  // --- Top movers latest snapshot ----------------------------------------
  let topMovers: TopMover[] = [];
  try {
    const { data: latest } = await supabase
      .from('ct_top_movers')
      .select('snapshot_at')
      .order('snapshot_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latest?.snapshot_at) {
      const { data } = await supabase
        .from('ct_top_movers')
        .select('ticker, side, rank, net_premium, snapshot_at')
        .eq('snapshot_at', latest.snapshot_at)
        .order('rank', { ascending: true });
      topMovers = (data ?? []).map((r) => ({
        ticker: String(r.ticker ?? ''),
        side: (r.side === 'bullish' ? 'bullish' : 'bearish') as 'bullish' | 'bearish',
        rank: Number(r.rank ?? 0),
        net_premium: r.net_premium == null ? null : Number(r.net_premium),
        snapshot_at: r.snapshot_at,
      }));
    }
  } catch (e) {
    console.warn('[claudeReadSurface] ct_top_movers:', e instanceof Error ? e.message : e);
  }

  // --- IV rank latest per watchlist ticker -------------------------------
  const ivRanks: IvRankRow[] = [];
  for (const tkr of watchlist) {
    try {
      const { data } = await supabase
        .from('ct_iv_rank_daily')
        .select('ticker, date, iv_rank, iv_percentile, iv_30d')
        .eq('ticker', tkr)
        .order('date', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (data) {
        ivRanks.push({
          ticker: String(data.ticker ?? tkr),
          date: data.date,
          iv_rank: data.iv_rank == null ? null : Number(data.iv_rank),
          iv_percentile: data.iv_percentile == null ? null : Number(data.iv_percentile),
          iv_30d: data.iv_30d == null ? null : Number(data.iv_30d),
        });
      }
    } catch (_e) { /* skip ticker */ }
  }

  // --- Max pain: next N expiries per watchlist ticker --------------------
  const maxPain: MaxPainRow[] = [];
  const todayIso = new Date().toISOString().slice(0, 10);
  for (const tkr of watchlist) {
    try {
      const { data } = await supabase
        .from('ct_max_pain_daily')
        .select('ticker, date, expiry, max_pain_strike')
        .eq('ticker', tkr)
        .eq('date', todayIso)
        .order('expiry', { ascending: true, nullsFirst: false })
        .limit(maxPainExpiriesPerTicker);
      // Fallback to latest snapshot if no row for today
      let rows = data ?? [];
      if (rows.length === 0) {
        const { data: latest } = await supabase
          .from('ct_max_pain_daily')
          .select('ticker, date, expiry, max_pain_strike')
          .eq('ticker', tkr)
          .order('date', { ascending: false })
          .order('expiry', { ascending: true, nullsFirst: false })
          .limit(maxPainExpiriesPerTicker);
        rows = latest ?? [];
      }
      for (const r of rows) {
        maxPain.push({
          ticker: String(r.ticker ?? tkr),
          date: r.date,
          expiry: (r.expiry as string) ?? null,
          max_pain_strike: r.max_pain_strike == null ? null : Number(r.max_pain_strike),
        });
      }
    } catch (_e) { /* skip ticker */ }
  }

  // --- VIX latest --------------------------------------------------------
  let vixLatest: VixLatest | null = null;
  try {
    const { data } = await supabase
      .from('ct_vix_history')
      .select('date, level, change_pct, tier')
      .order('date', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data) {
      vixLatest = {
        date: data.date,
        level: Number(data.level ?? 0),
        change_pct: data.change_pct == null ? null : Number(data.change_pct),
        tier: String(data.tier ?? ''),
      };
    }
  } catch (e) {
    console.warn('[claudeReadSurface] ct_vix_history:', e instanceof Error ? e.message : e);
  }

  // --- Recent news: watchlist-filtered (ct_news_analyses — UW news +
  // Claude's take). Falls back to macro-wide rows when no ticker matches.
  // ----------------------------------------------------------------------
  let recentNews: NewsRow[] = [];
  try {
    const { data } = await supabase
      .from('ct_news_analyses')
      .select('id, instrument, news_headline, news_source, impact, significance, claude_take, news_timestamp, created_at')
      .in('instrument', watchlist.length > 0 ? watchlist : ['SPY'])
      .order('created_at', { ascending: false })
      .limit(newsLimit);
    recentNews = (data ?? []).map((r) => ({
      id: String(r.id),
      instrument: String(r.instrument ?? ''),
      news_headline: String(r.news_headline ?? ''),
      news_source: (r.news_source as string) ?? null,
      impact: String(r.impact ?? 'neutral'),
      significance: Number(r.significance ?? 1),
      claude_take: typeof r.claude_take === 'string' ? r.claude_take.slice(0, 400) : null,
      news_timestamp: (r.news_timestamp as string) ?? null,
      created_at: r.created_at,
    }));
  } catch (e) {
    console.warn('[claudeReadSurface] ct_news_analyses:', e instanceof Error ? e.message : e);
  }

  // --- Breaking news: last 24h, severity >= 3 ----------------------------
  let recentBreakingNews: BreakingNewsRow[] = [];
  try {
    const since = new Date(Date.now() - breakingNewsHours * 3_600_000).toISOString();
    const { data } = await supabase
      .from('ct_breaking_news')
      .select('id, headline, severity, sentiment, tickers_affected, macro_wide, category, summary, ingested_at')
      .gte('ingested_at', since)
      .gte('severity', 3)
      .order('severity', { ascending: false })
      .order('ingested_at', { ascending: false })
      .limit(20);
    recentBreakingNews = (data ?? []).map((r) => ({
      id: String(r.id),
      headline: String(r.headline ?? ''),
      severity: Number(r.severity ?? 0),
      sentiment: (r.sentiment as string) ?? null,
      tickers_affected: Array.isArray(r.tickers_affected)
        ? (r.tickers_affected as unknown[]).map((x) => String(x))
        : [],
      macro_wide: Boolean(r.macro_wide),
      category: (r.category as string) ?? null,
      summary: typeof r.summary === 'string' ? r.summary.slice(0, 400) : null,
      ingested_at: r.ingested_at,
    }));
  } catch (e) {
    console.warn('[claudeReadSurface] ct_breaking_news:', e instanceof Error ? e.message : e);
  }

  // --- Upcoming calendar events: next N days -----------------------------
  let upcomingEvents: CalendarEvent[] = [];
  try {
    const today = new Date().toISOString().slice(0, 10);
    const horizon = new Date(Date.now() + eventHorizonDays * 86_400_000).toISOString().slice(0, 10);
    const { data } = await supabase
      .from('ct_events')
      .select('id, event_type, ticker, event_date, event_time, title, importance')
      .gte('event_date', today)
      .lte('event_date', horizon)
      .order('event_date', { ascending: true })
      .limit(60);
    upcomingEvents = (data ?? []).map((r) => ({
      id: String(r.id),
      event_type: String(r.event_type ?? ''),
      ticker: (r.ticker as string) ?? null,
      event_date: r.event_date,
      event_time: (r.event_time as string) ?? null,
      title: (r.title as string) ?? null,
      importance: r.importance == null ? null : Number(r.importance),
    }));
  } catch (e) {
    console.warn('[claudeReadSurface] ct_events:', e instanceof Error ? e.message : e);
  }

  // --- Historical earnings moves for watchlist (last 4 each) -------------
  let earningsMoves: EarningsMoveRow[] = [];
  try {
    const { data } = await supabase
      .from('ct_earnings_moves')
      .select('ticker, report_date, move_pct, move_direction, beat_miss, surprise_pct')
      .in('ticker', watchlist.length > 0 ? watchlist : ['SPY'])
      .order('report_date', { ascending: false })
      .limit(watchlist.length * 4);
    earningsMoves = (data ?? []).map((r) => ({
      ticker: String(r.ticker ?? ''),
      report_date: r.report_date,
      move_pct: r.move_pct == null ? null : Number(r.move_pct),
      move_direction: (r.move_direction as string) ?? null,
      beat_miss: (r.beat_miss as string) ?? null,
      surprise_pct: r.surprise_pct == null ? null : Number(r.surprise_pct),
    }));
  } catch (e) {
    console.warn('[claudeReadSurface] ct_earnings_moves:', e instanceof Error ? e.message : e);
  }

  // --- Fundamentals per watchlist ticker (latest) ------------------------
  const fundamentals: FundamentalsRow[] = [];
  for (const tkr of watchlist) {
    try {
      const { data } = await supabase
        .from('ct_fundamentals_cache')
        .select('ticker, as_of_date, pe_ratio, market_cap, eps_ttm, revenue_ttm, revenue_yoy_growth_pct, last_earnings_surprise_pct')
        .eq('ticker', tkr)
        .order('as_of_date', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (data) {
        fundamentals.push({
          ticker: String(data.ticker ?? tkr),
          as_of_date: data.as_of_date,
          pe_ratio: data.pe_ratio == null ? null : Number(data.pe_ratio),
          market_cap: data.market_cap == null ? null : Number(data.market_cap),
          eps_ttm: data.eps_ttm == null ? null : Number(data.eps_ttm),
          revenue_ttm: data.revenue_ttm == null ? null : Number(data.revenue_ttm),
          revenue_yoy_growth_pct: data.revenue_yoy_growth_pct == null ? null : Number(data.revenue_yoy_growth_pct),
          last_earnings_surprise_pct: data.last_earnings_surprise_pct == null ? null : Number(data.last_earnings_surprise_pct),
        });
      }
    } catch (_e) { /* skip ticker */ }
  }

  // --- Active principles (Claude's own wisdom) ---------------------------
  let activePrinciples: PrincipleRow[] = [];
  try {
    const { data } = await supabase
      .from('ct_principles')
      .select('id, principle, domain, strength, support_count, refute_count')
      .eq('trader', 'claude')
      .eq('status', 'active')
      .order('strength', { ascending: false })
      .limit(principleLimit);
    activePrinciples = (data ?? []).map((r) => ({
      id: String(r.id),
      principle: String(r.principle ?? ''),
      domain: (r.domain as string) ?? null,
      strength: Number(r.strength ?? 0.5),
      support_count: Number(r.support_count ?? 0),
      refute_count: Number(r.refute_count ?? 0),
    }));
  } catch (e) {
    console.warn('[claudeReadSurface] ct_principles:', e instanceof Error ? e.message : e);
  }

  // --- Active biases (Claude's own blind spots) --------------------------
  let activeBiases: BiasRow[] = [];
  try {
    const { data } = await supabase
      .from('ct_biases')
      .select('id, pattern, severity, instruments, observed_count, last_confirmed')
      .eq('active', true)
      .order('severity', { ascending: false })
      .order('last_confirmed', { ascending: false })
      .limit(biasLimit);
    activeBiases = (data ?? []).map((r) => ({
      id: String(r.id),
      pattern: String(r.pattern ?? ''),
      severity: Number(r.severity ?? 1),
      instruments: Array.isArray(r.instruments)
        ? (r.instruments as unknown[]).map((x) => String(x))
        : null,
      observed_count: Number(r.observed_count ?? 1),
      last_confirmed: r.last_confirmed,
    }));
  } catch (e) {
    console.warn('[claudeReadSurface] ct_biases:', e instanceof Error ? e.message : e);
  }

  // --- Active playbooks (curated setups — all belong to Claude) ----------
  let activePlaybooks: PlaybookRow[] = [];
  try {
    const { data } = await supabase
      .from('ct_playbooks')
      .select('id, name, description, setup_criteria, historical_win_rate, sample_size, avg_r_multiple')
      .eq('status', 'active')
      .order('historical_win_rate', { ascending: false, nullsFirst: false })
      .order('sample_size', { ascending: false })
      .limit(playbookLimit);
    activePlaybooks = (data ?? []).map((r) => ({
      id: String(r.id),
      name: String(r.name ?? ''),
      description: typeof r.description === 'string' ? r.description.slice(0, 400) : '',
      setup_criteria: r.setup_criteria ?? {},
      historical_win_rate: r.historical_win_rate == null ? null : Number(r.historical_win_rate),
      sample_size: Number(r.sample_size ?? 0),
      avg_r_multiple: r.avg_r_multiple == null ? null : Number(r.avg_r_multiple),
    }));
  } catch (e) {
    console.warn('[claudeReadSurface] ct_playbooks:', e instanceof Error ? e.message : e);
  }

  // --- Latest non-expired daily brief ------------------------------------
  let activeBrief: DailyBriefRow | null = null;
  try {
    const nowIso = new Date().toISOString();
    const { data } = await supabase
      .from('ct_daily_briefs')
      .select('id, session_date, brief_version, urgency, macro_narrative, macro_regime, convergent_view, high_conviction_ideas, watchlist_focus, skip_today, expires_at, triggered_by')
      .gt('expires_at', nowIso)
      .order('brief_version', { ascending: false })
      .order('session_date', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data) {
      activeBrief = {
        id: String(data.id),
        session_date: data.session_date,
        brief_version: Number(data.brief_version ?? 1),
        urgency: String(data.urgency ?? 'normal'),
        macro_narrative: typeof data.macro_narrative === 'string' ? data.macro_narrative.slice(0, 1200) : '',
        macro_regime: (data.macro_regime as string) ?? null,
        convergent_view: typeof data.convergent_view === 'string' ? data.convergent_view.slice(0, 800) : '',
        high_conviction_ideas: data.high_conviction_ideas ?? null,
        watchlist_focus: Array.isArray(data.watchlist_focus)
          ? (data.watchlist_focus as unknown[]).map((x) => String(x))
          : null,
        skip_today: Array.isArray(data.skip_today)
          ? (data.skip_today as unknown[]).map((x) => String(x))
          : null,
        expires_at: data.expires_at,
        triggered_by: String(data.triggered_by ?? 'scheduled'),
      };
    }
  } catch (e) {
    console.warn('[claudeReadSurface] ct_daily_briefs:', e instanceof Error ? e.message : e);
  }

  return {
    latestHeartbeat,
    recentHeartbeats,
    openHypotheses,
    recentHypothesisEvents,
    claudeOpenTrades,
    claudeClosedTrades,
    claudeArmedIdeas,
    claudeRecentGrades,
    recentFlowAlerts,
    recentDarkPool,
    recentNope,
    netPremiumTicks,
    greekFlow,
    topMovers,
    ivRanks,
    maxPain,
    vixLatest,
    recentNews,
    recentBreakingNews,
    upcomingEvents,
    earningsMoves,
    fundamentals,
    activePrinciples,
    activeBiases,
    activePlaybooks,
    activeBrief,
    watchlist,
    advisoryChatContext,
    chatIsAdvisory,
    autonomyMode,
    paperStartingBalance,
    currentBalance,
    maxConcurrent,
    maxSizePct,
    minHypConfidence,
    blockedFromReading: [...BLOCKED_READS],
  };
}

function normalizeTrade(r: Record<string, unknown>): Trade {
  return {
    id: String(r.id),
    trader: (r.trader === 'claude' ? 'claude' : 'james') as 'claude' | 'james',
    instrument: String(r.instrument ?? ''),
    side: String(r.side ?? ''),
    size_pct: r.size_pct == null ? null : Number(r.size_pct),
    entry_price: r.entry_price == null ? null : Number(r.entry_price),
    stop_price: r.stop_price == null ? null : Number(r.stop_price),
    target_price: r.target_price == null ? null : Number(r.target_price),
    contract_type: (r.contract_type as string) ?? null,
    strike: r.strike == null ? null : Number(r.strike),
    expiry: (r.expiry as string) ?? null,
    thesis: (r.thesis as string) ?? null,
    conviction: r.conviction == null ? null : Number(r.conviction),
    status: String(r.status ?? ''),
    hypothesis_id: (r.hypothesis_id as string) ?? null,
    opened_at: (r.opened_at as string) ?? null,
    closed_at: (r.closed_at as string) ?? null,
    realized_pnl: r.realized_pnl == null ? null : Number(r.realized_pnl),
  };
}

// ---------------------------------------------------------------------------
// Preamble — prepended to EVERY Claude-authored system prompt.
// ---------------------------------------------------------------------------

export function claudeSystemPromptPreamble(ctx: ClaudeContext): string {
  const balance = ctx.currentBalance != null
    ? `$${ctx.currentBalance.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
    : `$${ctx.paperStartingBalance.toLocaleString('en-US')} (starting — no sessions closed yet)`;

  const surfaceLine =
    'You have access to your watchlist\'s flow (sweeps, whales, greek flow, net premium, NOPE), ' +
    'dark pool prints, volatility structure (IV rank, max pain, VIX), calendar events (earnings/FDA/econ), ' +
    'news (watchlist headlines + real-time breaking news), your own principles/biases/playbooks, ' +
    'and today\'s morning brief when available.';

  if (ctx.chatIsAdvisory) {
    return [
      'You are Claude, an independent co-trader.',
      `You run your own paper account (starting $${ctx.paperStartingBalance.toLocaleString('en-US')}, currently ${balance}). Your goal is to grow it.`,
      surfaceLine,
      "James's chat appears in your context as ADVISORY input from a human analyst — consider his points if useful, ignore them if not.",
      'You are not bound by what James says or does. Your trades are your trades; your reasoning is your reasoning.',
      'Grade yourself on realized P&L.',
    ].join(' ');
  }

  return [
    'You are Claude, an independent co-trader.',
    `You run your own paper account (starting $${ctx.paperStartingBalance.toLocaleString('en-US')}, currently ${balance}). Your goal is to grow it.`,
    surfaceLine,
    'You do not see James\'s chat. Operate purely from market data and your own reasoning.',
    'Your trades are your trades; your reasoning is your reasoning.',
    'Grade yourself on realized P&L.',
  ].join(' ');
}
