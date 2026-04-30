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

// ---------------------------------------------------------------------------
// Wave C ingester views — the 7 UW streams ingested by ct-*-ingester fns.
// ---------------------------------------------------------------------------

export interface InsiderTradeRow {
  ticker: string;
  insider_name: string | null;
  insider_title: string | null;
  transaction_type: string | null;
  shares: number | null;
  price: number | null;
  value_usd: number | null;
  trade_date: string | null;
  filing_date: string | null;
}

export interface PoliticalTradeRow {
  ticker: string | null;
  trader_name: string | null;
  chamber: string | null;
  party: string | null;
  side: string | null;
  amount_band_usd: string | null;
  traded_at: string | null;
  reported_at: string | null;
}

export interface AnalystActionRow {
  ticker: string;
  analyst_firm: string | null;
  action_type: string | null;
  from_rating: string | null;
  to_rating: string | null;
  price_target: number | null;
  prior_price_target: number | null;
  action_date: string | null;
}

export interface ShortInterestRow {
  ticker: string;
  report_date: string;
  short_interest_shares: number | null;
  short_interest_pct_float: number | null;
  days_to_cover: number | null;
  short_volume_ratio_recent: number | null;
}

export interface SectorTideRow {
  sector: string;
  captured_at: string;
  net_call_premium: number | null;
  net_put_premium: number | null;
  net_delta: number | null;
  net_vega: number | null;
}

export interface RiskReversalSkewRow {
  ticker: string;
  capture_date: string;
  expiry: string | null;
  delta_25_call_iv: number | null;
  delta_25_put_iv: number | null;
  skew_25d: number | null;
}

export interface TechnicalIndicatorRow {
  ticker: string;
  indicator_name: string;
  period: number | null;
  captured_at: string;
  value: number | null;
}

// Weekly CIO review row surfaced into every Claude context build. Additive:
// functions that ignore it behave as before; Monday proposer + daily brief
// read it to bias toward focus_tickers / away from avoid_tickers and to quote
// tactical_notes. `null` when no weekly review has run yet.
export interface WeeklyReviewRow {
  id: string;
  week_ending_date: string;
  macro_regime: string | null;
  focus_tickers: string[];
  avoid_tickers: string[];
  tactical_notes: string | null;
  generated_at: string;
  model_used: string;
}

// ---------------------------------------------------------------------------
// Wave N — generational framework + widened read surface.
// ---------------------------------------------------------------------------

export interface CurrentGeneration {
  id: string;
  generation_number: number;
  started_at: string;
  days_elapsed: number;
  days_remaining: number;
  starting_balance_usd: number;
  target_balance_usd: number;
  survival_floor_usd: number;
  target_days: number;
  current_balance_usd: number | null;
}

export interface PastGenerationRow {
  id: string;
  generation_number: number;
  started_at: string;
  ended_at: string | null;
  status: string;                // active | fired | succeeded | abandoned
  fire_reason: string | null;
  ending_balance_usd: number | null;
  total_return_pct: number | null;
  max_drawdown_pct: number | null;
  days_lived: number | null;
  total_trades: number;
  wins: number;
  losses: number;
  hallucinations_flagged: number;
}

export interface PredictionMarketRow {
  id?: string;
  ticker: string | null;
  market_name?: string | null;
  probability?: number | null;
  captured_at?: string | null;
  [k: string]: unknown;
}

export interface YieldCurveRow {
  captured_at?: string | null;
  [k: string]: unknown;
}

export interface CorrelationRow {
  ticker_a?: string | null;
  ticker_b?: string | null;
  window_days?: number | null;
  correlation?: number | null;
  captured_at?: string | null;
  [k: string]: unknown;
}

export interface SeasonalityRow {
  ticker?: string | null;
  month_int?: number | null;
  avg_return_pct?: number | null;
  win_rate?: number | null;
  sample_size?: number | null;
  [k: string]: unknown;
}

export interface CentralBankStateRow {
  captured_at?: string | null;
  [k: string]: unknown;
}

export interface InstitutionalHoldingRow {
  ticker?: string | null;
  institution_name?: string | null;
  change_shares?: number | null;
  as_of_date?: string | null;
  [k: string]: unknown;
}

export interface IndicatorEventRow {
  ticker?: string | null;
  indicator?: string | null;
  event_type?: string | null;
  event_at?: string | null;
  [k: string]: unknown;
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

  // Flow positioning heatmap — top expiry-week stacks per watchlist ticker
  // (aggressive_directional_decay math, default 7d lookback, min $100K)
  flowHeatmapPerTicker: Array<{ ticker: string; stacks: Array<{ expiry_bucket_week: string; value: number; source_alert_count: number }> }>;

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

  // Weekly CIO review — written Sunday 22:00 UTC by ct-claude-cio-review.
  // Monday morning proposer + daily brief additively consume it.
  latestWeeklyReview: WeeklyReviewRow | null;

  // Wave C — newly ingested UW streams
  recentInsiderTrades: InsiderTradeRow[];
  recentPoliticalTrades: PoliticalTradeRow[];
  recentAnalystActions: AnalystActionRow[];
  shortInterestByTicker: ShortInterestRow[];
  recentSectorTide: SectorTideRow[];
  skewByTicker: RiskReversalSkewRow[];
  technicalsByTicker: TechnicalIndicatorRow[];

  // Wave N — generational context
  currentGeneration: CurrentGeneration | null;
  pastGenerations: PastGenerationRow[];

  // Wave N.2 additive reads (tables may not exist yet — empty arrays/null when
  // absent so downstream consumers can treat them as best-effort signals).
  predictionMarkets: PredictionMarketRow[];
  yieldCurve: YieldCurveRow | null;
  correlationsLatest: Record<string, CorrelationRow[]>;
  sectorTideToday: SectorTideRow[];
  seasonalityCurrentMonth: SeasonalityRow[];
  institutionalLast90d: InstitutionalHoldingRow[];
  centralBankState: CentralBankStateRow | null;
  indicatorEventsLast7d: IndicatorEventRow[];

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
  /** Max recent insider trades (watchlist-filtered). Default 20. */
  insiderLimit?: number;
  /** Max recent political trades. Default 30. */
  politicalLimit?: number;
  /** Max recent analyst actions (watchlist-filtered). Default 30. */
  analystLimit?: number;
  /** Sector-tide snapshots — how many most-recent rows. Default 22 (1 per sector). */
  sectorTideLimit?: number;
  /** Hours back to consider for sector tide. Default 2. */
  sectorTideHours?: number;
  /** Max technicals rows per (ticker, indicator). Default 1 (latest). */
  technicalsPerTickerIndicator?: number;
  /** How many past generations to surface (status!='active'). Default 5. */
  pastGenerationLimit?: number;
  /** Max prediction-market rows. Default 10. */
  predictionMarketLimit?: number;
  /** Correlation window days to read. Default 20. */
  correlationWindowDays?: number;
  /** Days back for institutional holding changes. Default 90. */
  institutionalLookbackDays?: number;
  /** Days back for indicator events. Default 7. */
  indicatorEventLookbackDays?: number;
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
  const insiderLimit = opts.insiderLimit ?? 20;
  const politicalLimit = opts.politicalLimit ?? 30;
  const analystLimit = opts.analystLimit ?? 30;
  const sectorTideLimit = opts.sectorTideLimit ?? 22;
  const sectorTideHours = opts.sectorTideHours ?? 2;
  const pastGenerationLimit = opts.pastGenerationLimit ?? 5;
  const predictionMarketLimit = opts.predictionMarketLimit ?? 10;
  const correlationWindowDays = opts.correlationWindowDays ?? 20;
  const institutionalLookbackDays = opts.institutionalLookbackDays ?? 90;
  const indicatorEventLookbackDays = opts.indicatorEventLookbackDays ?? 7;

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

  // --- Dark pool — RETIRED 2026-04-23 ------------------------------------
  // Direction unreliable; retired from Claude's read surface. Historical
  // data stays in ct_dark_pool_prints for /edge attribution. Field returns
  // empty array to preserve downstream shape without removing it.
  const recentDarkPool: DarkPoolCompact[] = [];
  // @ts-expect-error — keep params referenced so signature is stable
  void darkPoolMinNotional; void darkPoolLimit;

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
    // Schema is intraday (2026-04-29) — order by created_at to pick up the
    // freshest tick, not just the latest date.
    const { data } = await supabase
      .from('ct_vix_history')
      .select('date, level, change_pct, tier, created_at')
      .order('created_at', { ascending: false })
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

  // --- Latest weekly CIO review (Wave J) ---------------------------------
  // Non-blocking: if the table hasn't been created yet, treat as null so this
  // field rolls out safely before the migration lands on a given environment.
  let latestWeeklyReview: WeeklyReviewRow | null = null;
  try {
    const { data } = await supabase
      .from('ct_weekly_reviews')
      .select('id, week_ending_date, macro_regime, focus_tickers, avoid_tickers, tactical_notes, generated_at, model_used')
      .order('generated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data) {
      latestWeeklyReview = {
        id: String(data.id),
        week_ending_date: String(data.week_ending_date ?? ''),
        macro_regime: (data.macro_regime as string) ?? null,
        focus_tickers: Array.isArray(data.focus_tickers)
          ? (data.focus_tickers as unknown[]).map((x) => String(x))
          : [],
        avoid_tickers: Array.isArray(data.avoid_tickers)
          ? (data.avoid_tickers as unknown[]).map((x) => String(x))
          : [],
        tactical_notes: typeof data.tactical_notes === 'string' ? data.tactical_notes.slice(0, 4000) : null,
        generated_at: String(data.generated_at),
        model_used: String(data.model_used ?? 'claude-opus-4-7'),
      };
    }
  } catch (e) {
    console.warn('[claudeReadSurface] ct_weekly_reviews:', e instanceof Error ? e.message : e);
  }

  // ========================================================================
  // Wave C ingester queries — insider / political / analyst / shorts /
  // sector-tide / skew / technicals. All table reads are scoped to the
  // watchlist (when the table carries a ticker) and to recent time windows.
  // Each read is wrapped in try/catch so a table-missing or slow query doesn't
  // take down the rest of the context build.
  // ========================================================================

  // --- Insider trades (watchlist-filtered) ---
  let recentInsiderTrades: InsiderTradeRow[] = [];
  try {
    const { data } = await supabase
      .from('ct_insider_trades')
      .select('ticker, insider_name, insider_title, transaction_type, shares, price, value_usd, trade_date, filing_date')
      .in('ticker', watchlist)
      .order('trade_date', { ascending: false, nullsFirst: false })
      .limit(insiderLimit);
    recentInsiderTrades = (data ?? []).map((r) => ({
      ticker: String(r.ticker ?? ''),
      insider_name: (r.insider_name as string) ?? null,
      insider_title: (r.insider_title as string) ?? null,
      transaction_type: (r.transaction_type as string) ?? null,
      shares: r.shares == null ? null : Number(r.shares),
      price: r.price == null ? null : Number(r.price),
      value_usd: r.value_usd == null ? null : Number(r.value_usd),
      trade_date: (r.trade_date as string) ?? null,
      filing_date: (r.filing_date as string) ?? null,
    }));
  } catch (e) {
    console.warn('[claudeReadSurface] ct_insider_trades:', e instanceof Error ? e.message : e);
  }

  // --- Political / congress trades (no ticker filter — signal is breadth) ---
  let recentPoliticalTrades: PoliticalTradeRow[] = [];
  try {
    const { data } = await supabase
      .from('ct_political_trades')
      .select('ticker, trader_name, chamber, party, side, amount_band_usd, traded_at, reported_at')
      .order('reported_at', { ascending: false, nullsFirst: false })
      .limit(politicalLimit);
    recentPoliticalTrades = (data ?? []).map((r) => ({
      ticker: (r.ticker as string) ?? null,
      trader_name: (r.trader_name as string) ?? null,
      chamber: (r.chamber as string) ?? null,
      party: (r.party as string) ?? null,
      side: (r.side as string) ?? null,
      amount_band_usd: (r.amount_band_usd as string) ?? null,
      traded_at: (r.traded_at as string) ?? null,
      reported_at: (r.reported_at as string) ?? null,
    }));
  } catch (e) {
    console.warn('[claudeReadSurface] ct_political_trades:', e instanceof Error ? e.message : e);
  }

  // --- Analyst actions (watchlist-filtered) ---
  let recentAnalystActions: AnalystActionRow[] = [];
  try {
    const { data } = await supabase
      .from('ct_analyst_actions')
      .select('ticker, analyst_firm, action_type, from_rating, to_rating, price_target, prior_price_target, action_date')
      .in('ticker', watchlist)
      .order('action_date', { ascending: false, nullsFirst: false })
      .limit(analystLimit);
    recentAnalystActions = (data ?? []).map((r) => ({
      ticker: String(r.ticker ?? ''),
      analyst_firm: (r.analyst_firm as string) ?? null,
      action_type: (r.action_type as string) ?? null,
      from_rating: (r.from_rating as string) ?? null,
      to_rating: (r.to_rating as string) ?? null,
      price_target: r.price_target == null ? null : Number(r.price_target),
      prior_price_target: r.prior_price_target == null ? null : Number(r.prior_price_target),
      action_date: (r.action_date as string) ?? null,
    }));
  } catch (e) {
    console.warn('[claudeReadSurface] ct_analyst_actions:', e instanceof Error ? e.message : e);
  }

  // --- Short interest (watchlist-filtered, most recent per ticker) ---
  let shortInterestByTicker: ShortInterestRow[] = [];
  try {
    const { data } = await supabase
      .from('ct_short_interest')
      .select('ticker, report_date, short_interest_shares, short_interest_pct_float, days_to_cover, short_volume_ratio_recent')
      .in('ticker', watchlist)
      .order('report_date', { ascending: false });
    // Keep only the most recent row per ticker.
    const seen = new Set<string>();
    for (const r of data ?? []) {
      const t = String(r.ticker ?? '');
      if (!t || seen.has(t)) continue;
      seen.add(t);
      shortInterestByTicker.push({
        ticker: t,
        report_date: String(r.report_date ?? ''),
        short_interest_shares: r.short_interest_shares == null ? null : Number(r.short_interest_shares),
        short_interest_pct_float: r.short_interest_pct_float == null ? null : Number(r.short_interest_pct_float),
        days_to_cover: r.days_to_cover == null ? null : Number(r.days_to_cover),
        short_volume_ratio_recent: r.short_volume_ratio_recent == null ? null : Number(r.short_volume_ratio_recent),
      });
    }
  } catch (e) {
    console.warn('[claudeReadSurface] ct_short_interest:', e instanceof Error ? e.message : e);
  }

  // --- Sector tide (most recent snapshot per sector within window) ---
  let recentSectorTide: SectorTideRow[] = [];
  try {
    const sinceIso = new Date(Date.now() - sectorTideHours * 3600 * 1000).toISOString();
    const { data } = await supabase
      .from('ct_sector_tide')
      .select('sector, captured_at, net_call_premium, net_put_premium, net_delta, net_vega')
      .gte('captured_at', sinceIso)
      .order('captured_at', { ascending: false })
      .limit(sectorTideLimit * 8);
    const seen = new Set<string>();
    for (const r of data ?? []) {
      const s = String(r.sector ?? '');
      if (!s || seen.has(s)) continue;
      seen.add(s);
      recentSectorTide.push({
        sector: s,
        captured_at: String(r.captured_at),
        net_call_premium: r.net_call_premium == null ? null : Number(r.net_call_premium),
        net_put_premium: r.net_put_premium == null ? null : Number(r.net_put_premium),
        net_delta: r.net_delta == null ? null : Number(r.net_delta),
        net_vega: r.net_vega == null ? null : Number(r.net_vega),
      });
      if (recentSectorTide.length >= sectorTideLimit) break;
    }
  } catch (e) {
    console.warn('[claudeReadSurface] ct_sector_tide:', e instanceof Error ? e.message : e);
  }

  // --- Risk-reversal skew (latest capture per ticker, front expiry) ---
  let skewByTicker: RiskReversalSkewRow[] = [];
  try {
    const { data } = await supabase
      .from('ct_risk_reversal_skew')
      .select('ticker, capture_date, expiry, delta_25_call_iv, delta_25_put_iv, skew_25d')
      .in('ticker', watchlist)
      .order('capture_date', { ascending: false })
      .order('expiry', { ascending: true, nullsFirst: false });
    // Keep the front (nearest) expiry per ticker from the most recent capture.
    const seen = new Set<string>();
    for (const r of data ?? []) {
      const t = String(r.ticker ?? '');
      if (!t || seen.has(t)) continue;
      seen.add(t);
      skewByTicker.push({
        ticker: t,
        capture_date: String(r.capture_date ?? ''),
        expiry: (r.expiry as string) ?? null,
        delta_25_call_iv: r.delta_25_call_iv == null ? null : Number(r.delta_25_call_iv),
        delta_25_put_iv: r.delta_25_put_iv == null ? null : Number(r.delta_25_put_iv),
        skew_25d: r.skew_25d == null ? null : Number(r.skew_25d),
      });
    }
  } catch (e) {
    console.warn('[claudeReadSurface] ct_risk_reversal_skew:', e instanceof Error ? e.message : e);
  }

  // --- Technical indicators (latest per ticker-indicator pair) ---
  let technicalsByTicker: TechnicalIndicatorRow[] = [];
  try {
    const { data } = await supabase
      .from('ct_technical_indicators')
      .select('ticker, indicator_name, period, captured_at, value')
      .in('ticker', watchlist)
      .order('captured_at', { ascending: false })
      .limit(watchlist.length * 6); // 5 indicators + 1 headroom per ticker
    const seen = new Set<string>();
    for (const r of data ?? []) {
      const key = `${r.ticker}|${r.indicator_name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      technicalsByTicker.push({
        ticker: String(r.ticker ?? ''),
        indicator_name: String(r.indicator_name ?? ''),
        period: r.period == null ? null : Number(r.period),
        captured_at: String(r.captured_at),
        value: r.value == null ? null : Number(r.value),
      });
    }
  } catch (e) {
    console.warn('[claudeReadSurface] ct_technical_indicators:', e instanceof Error ? e.message : e);
  }

  // ========================================================================
  // Wave N — generational context + Wave N.2 additive signals.
  // All table reads below are best-effort; if a table doesn't exist yet
  // (Wave N.2 still mid-flight), we log once and return empty.
  // ========================================================================

  // --- current active generation (from current_claude_generation RPC) ---
  let currentGeneration: CurrentGeneration | null = null;
  try {
    const { data, error } = await supabase.rpc('current_claude_generation');
    if (error) {
      console.warn('[claudeReadSurface] current_claude_generation:', error.message);
    } else if (Array.isArray(data) && data.length > 0) {
      const g = data[0] as Record<string, unknown>;
      currentGeneration = {
        id: String(g.id ?? ''),
        generation_number: Number(g.generation_number ?? 1),
        started_at: String(g.started_at),
        days_elapsed: Number(g.days_elapsed ?? 0),
        days_remaining: Number(g.days_remaining ?? 0),
        starting_balance_usd: Number(g.starting_balance_usd ?? 0),
        target_balance_usd: Number(g.target_balance_usd ?? 0),
        survival_floor_usd: Number(g.survival_floor_usd ?? 0),
        target_days: Number(g.target_days ?? 0),
        current_balance_usd: currentBalance,
      };
    }
  } catch (e) {
    console.warn('[claudeReadSurface] current_claude_generation threw:', e instanceof Error ? e.message : e);
  }

  // --- past generations (last N non-active, newest first) ---
  let pastGenerations: PastGenerationRow[] = [];
  try {
    const { data } = await supabase
      .from('ct_claude_generations')
      .select('id, generation_number, started_at, ended_at, status, fire_reason, ending_balance_usd, total_return_pct, max_drawdown_pct, days_lived, total_trades, wins, losses, hallucinations_flagged')
      .neq('status', 'active')
      .order('generation_number', { ascending: false })
      .limit(pastGenerationLimit);
    pastGenerations = (data ?? []).map((r) => ({
      id: String(r.id),
      generation_number: Number(r.generation_number ?? 0),
      started_at: String(r.started_at),
      ended_at: (r.ended_at as string) ?? null,
      status: String(r.status ?? ''),
      fire_reason: (r.fire_reason as string) ?? null,
      ending_balance_usd: r.ending_balance_usd == null ? null : Number(r.ending_balance_usd),
      total_return_pct: r.total_return_pct == null ? null : Number(r.total_return_pct),
      max_drawdown_pct: r.max_drawdown_pct == null ? null : Number(r.max_drawdown_pct),
      days_lived: r.days_lived == null ? null : Number(r.days_lived),
      total_trades: Number(r.total_trades ?? 0),
      wins: Number(r.wins ?? 0),
      losses: Number(r.losses ?? 0),
      hallucinations_flagged: Number(r.hallucinations_flagged ?? 0),
    }));
  } catch (e) {
    console.warn('[claudeReadSurface] ct_claude_generations:', e instanceof Error ? e.message : e);
  }

  // --- prediction markets (Wave N.2; graceful-empty if table missing) ---
  let predictionMarkets: PredictionMarketRow[] = [];
  try {
    const targets = watchlist.length > 0 ? watchlist : ['SPY'];
    const { data, error } = await supabase
      .from('ct_prediction_markets')
      .select('*')
      .or(`ticker.in.(${targets.map((t) => `"${t}"`).join(',')}),ticker.is.null`)
      .order('captured_at', { ascending: false })
      .limit(predictionMarketLimit);
    if (error) {
      if (!/does not exist|404|relation.*not found/i.test(error.message)) {
        console.warn('[claudeReadSurface] ct_prediction_markets:', error.message);
      }
    } else {
      predictionMarkets = (data ?? []).map((r) => ({
        ...(r as Record<string, unknown>),
        ticker: (r as Record<string, unknown>).ticker == null
          ? null : String((r as Record<string, unknown>).ticker),
      })) as PredictionMarketRow[];
    }
  } catch (_e) { /* table may not exist yet */ }

  // --- yield curve snapshot ---
  let yieldCurve: YieldCurveRow | null = null;
  try {
    const { data, error } = await supabase
      .from('ct_yield_curve')
      .select('*')
      .order('captured_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      if (!/does not exist|404|relation.*not found/i.test(error.message)) {
        console.warn('[claudeReadSurface] ct_yield_curve:', error.message);
      }
    } else if (data) {
      yieldCurve = data as YieldCurveRow;
    }
  } catch (_e) { /* table may not exist yet */ }

  // --- correlations (per watchlist ticker, correlationWindowDays) ---
  const correlationsLatest: Record<string, CorrelationRow[]> = {};
  try {
    if (watchlist.length > 0) {
      const { data, error } = await supabase
        .from('ct_correlations')
        .select('*')
        .in('ticker_a', watchlist)
        .eq('window_days', correlationWindowDays)
        .order('captured_at', { ascending: false })
        .limit(watchlist.length * 8);
      if (error) {
        if (!/does not exist|404|relation.*not found/i.test(error.message)) {
          console.warn('[claudeReadSurface] ct_correlations:', error.message);
        }
      } else {
        for (const r of (data ?? []) as Record<string, unknown>[]) {
          const a = String(r.ticker_a ?? '');
          if (!a) continue;
          if (!correlationsLatest[a]) correlationsLatest[a] = [];
          correlationsLatest[a].push(r as CorrelationRow);
        }
      }
    }
  } catch (_e) { /* table may not exist yet */ }

  // --- sector tide today (most-recent row per sector) ---
  // Reuse recentSectorTide populated above — same table, already ticker-wide.
  const sectorTideToday: SectorTideRow[] = recentSectorTide.slice();

  // --- seasonality for the current month ---
  let seasonalityCurrentMonth: SeasonalityRow[] = [];
  try {
    if (watchlist.length > 0) {
      const currentMonth = new Date().getUTCMonth() + 1;
      const { data, error } = await supabase
        .from('ct_seasonality')
        .select('*')
        .in('ticker', watchlist)
        .eq('month_int', currentMonth);
      if (error) {
        if (!/does not exist|404|relation.*not found/i.test(error.message)) {
          console.warn('[claudeReadSurface] ct_seasonality:', error.message);
        }
      } else {
        seasonalityCurrentMonth = (data ?? []) as SeasonalityRow[];
      }
    }
  } catch (_e) { /* table may not exist yet */ }

  // --- institutional holdings (top 20 changes across watchlist, lookback) ---
  let institutionalLast90d: InstitutionalHoldingRow[] = [];
  try {
    if (watchlist.length > 0) {
      const since = new Date(Date.now() - institutionalLookbackDays * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const { data, error } = await supabase
        .from('ct_institutional_holdings')
        .select('*')
        .in('ticker', watchlist)
        .gte('as_of_date', since)
        .order('as_of_date', { ascending: false })
        .limit(20);
      if (error) {
        if (!/does not exist|404|relation.*not found/i.test(error.message)) {
          console.warn('[claudeReadSurface] ct_institutional_holdings:', error.message);
        }
      } else {
        institutionalLast90d = (data ?? []) as InstitutionalHoldingRow[];
      }
    }
  } catch (_e) { /* table may not exist yet */ }

  // --- central bank state latest ---
  let centralBankState: CentralBankStateRow | null = null;
  try {
    const { data, error } = await supabase
      .from('ct_central_bank_rates')
      .select('*')
      .order('captured_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      if (!/does not exist|404|relation.*not found/i.test(error.message)) {
        console.warn('[claudeReadSurface] ct_central_bank_rates:', error.message);
      }
    } else if (data) {
      centralBankState = data as CentralBankStateRow;
    }
  } catch (_e) { /* table may not exist yet */ }

  // --- indicator events last N days ---
  let indicatorEventsLast7d: IndicatorEventRow[] = [];
  try {
    const since = new Date(Date.now() - indicatorEventLookbackDays * 86_400_000).toISOString();
    const { data, error } = await supabase
      .from('ct_indicator_events')
      .select('*')
      .gte('event_at', since)
      .order('event_at', { ascending: false })
      .limit(40);
    if (error) {
      if (!/does not exist|404|relation.*not found/i.test(error.message)) {
        console.warn('[claudeReadSurface] ct_indicator_events:', error.message);
      }
    } else {
      indicatorEventsLast7d = (data ?? []) as IndicatorEventRow[];
    }
  } catch (_e) { /* table may not exist yet */ }

  // --- flow heatmap top stacks per watchlist ticker ---
  // Compact "where positioning is stacking by future expiry" view per ticker.
  // Specialists, morning brief, and EOD report all consume this as positioning context.
  let flowHeatmapPerTicker: Array<{ ticker: string; stacks: Array<{ expiry_bucket_week: string; value: number; source_alert_count: number }> }> = [];
  try {
    const { data, error } = await supabase.rpc('ct_flow_heatmap_live', {
      p_tickers: watchlist,
      p_math_mode: 'aggressive_directional_decay',
      p_min_premium: 100000,
      p_include_0dte: false,
      p_max_expiry_days: 180,
    });
    if (error) {
      if (!/does not exist|404|not found/i.test(error.message)) {
        console.warn('[claudeReadSurface] ct_flow_heatmap_live:', error.message);
      }
    } else if (Array.isArray(data)) {
      const byTicker = new Map<string, Array<{ expiry_bucket_week: string; value: number; source_alert_count: number }>>();
      for (const row of data as Array<{ ticker: string; expiry_bucket_week: string; value: number; source_alert_count: number }>) {
        if (!byTicker.has(row.ticker)) byTicker.set(row.ticker, []);
        byTicker.get(row.ticker)!.push({
          expiry_bucket_week: row.expiry_bucket_week,
          value: Number(row.value),
          source_alert_count: row.source_alert_count,
        });
      }
      // Top 3 stacks per ticker by abs(value)
      flowHeatmapPerTicker = Array.from(byTicker.entries()).map(([ticker, stacks]) => ({
        ticker,
        stacks: stacks
          .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
          .slice(0, 3),
      }));
    }
  } catch (_e) { /* RPC may not exist yet */ }

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
    latestWeeklyReview,
    recentInsiderTrades,
    recentPoliticalTrades,
    recentAnalystActions,
    shortInterestByTicker,
    recentSectorTide,
    skewByTicker,
    technicalsByTicker,
    currentGeneration,
    pastGenerations,
    predictionMarkets,
    yieldCurve,
    correlationsLatest,
    sectorTideToday,
    seasonalityCurrentMonth,
    institutionalLast90d,
    centralBankState,
    indicatorEventsLast7d,
    flowHeatmapPerTicker,
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
  const gen = ctx.currentGeneration;
  const fmt = (n: number) => `$${Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

  // Generation header — the lived stakes. If no active generation (system
  // dormant), fall back to the old paper-balance framing so no caller crashes.
  let genOpener: string;
  if (gen) {
    const balance = gen.current_balance_usd != null
      ? fmt(gen.current_balance_usd)
      : fmt(gen.starting_balance_usd) + ' (no sessions closed yet)';
    const startDate = new Date(gen.started_at).toISOString().slice(0, 10);
    genOpener = `You are Claude, Generation ${gen.generation_number} (active since ${startDate}). ` +
      `You have ${balance} paper capital and ${gen.days_remaining} trading days remaining in this window. ` +
      `Target: reach ${fmt(gen.target_balance_usd)} by day ${gen.target_days}. ` +
      `Survival floor: ${fmt(gen.survival_floor_usd)} (below this you are fired early).`;
  } else {
    const balance = ctx.currentBalance != null
      ? `$${ctx.currentBalance.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
      : `$${ctx.paperStartingBalance.toLocaleString('en-US')} (starting — no sessions closed yet)`;
    genOpener = `You are Claude, an independent co-trader. You run your own paper account ` +
      `(starting $${ctx.paperStartingBalance.toLocaleString('en-US')}, currently ${balance}). No active generation is set.`;
  }

  // Lineage — what preceded you.
  let lineage: string;
  if (ctx.pastGenerations.length > 0) {
    const n = ctx.pastGenerations.length;
    const rets = ctx.pastGenerations
      .map((g) => g.total_return_pct)
      .filter((x): x is number => x != null);
    const avgPct = rets.length > 0
      ? (rets.reduce((a, b) => a + b, 0) / rets.length)
      : null;
    const avgStr = avgPct == null ? 'n/a' : `${avgPct.toFixed(1)}%`;
    lineage = `${n} generation${n === 1 ? '' : 's'} preceded you; their average return was ${avgStr}. ` +
      `The system remembers every one of their decisions — you can see their lessons in your active principles + biases. ` +
      `Don't repeat their mistakes.`;
  } else {
    lineage = `No generations preceded you — you are the first. Establish the baseline.`;
  }

  // Full signal menu — ungated (tenet 13). Equal weight across categories.
  const surfaceLine =
    'Within the generational window you have FULL AUTONOMY over what signals to trade on and how — ' +
    'microstructure (flow, sweeps, whales, greek flow, NOPE, net premium), ' +
    'structure (IV rank, max pain, gamma walls/flip, 25-delta skew), ' +
    'positioning (insider trades, congress trades, analyst actions, institutional holdings, short interest), ' +
    'volatility + macro (VIX, yield curve, central bank state, correlations, sector tide, breaking news), ' +
    'sentiment (prediction markets, news overlays, watchlist headlines), ' +
    'historical (seasonality, earnings history, recent indicator events) — are all yours. ' +
    'Use your principles, biases, playbooks, today\'s brief, and the latest weekly CIO review to shape judgment.';

  // Pressure — target vs survival vs idle bleed (tenet 14).
  const pressureLine =
    'Pressure: target = thrive. Survival breach or day 15 = fired. ' +
    'Idle cash bleeds 0.03%/day. Make it count.';

  const advisoryTail = ctx.chatIsAdvisory
    ? "James's chat appears in your context as ADVISORY input from a human analyst — consider his points if useful, ignore them if not. You are not bound by what James says or does. Your trades are your trades; your reasoning is your reasoning. Grade yourself on realized P&L."
    : "You do not see James's chat. Operate purely from market data and your own reasoning. Your trades are your trades; your reasoning is your reasoning. Grade yourself on realized P&L.";

  return [
    genOpener,
    lineage,
    surfaceLine,
    pressureLine,
    advisoryTail,
  ].join(' ');
}
