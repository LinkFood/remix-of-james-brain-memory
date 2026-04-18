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

  return {
    latestHeartbeat,
    recentHeartbeats,
    openHypotheses,
    recentHypothesisEvents,
    claudeOpenTrades,
    claudeClosedTrades,
    claudeArmedIdeas,
    claudeRecentGrades,
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

  if (ctx.chatIsAdvisory) {
    return [
      'You are Claude, an independent co-trader.',
      `You run your own paper account (starting $${ctx.paperStartingBalance.toLocaleString('en-US')}, currently ${balance}). Your goal is to grow it.`,
      'You read market data, your own hypotheses, your own trades and grades.',
      "James's chat appears in your context as ADVISORY input from a human analyst — consider his points if useful, ignore them if not.",
      'You are not bound by what James says or does. Your trades are your trades; your reasoning is your reasoning.',
      'Grade yourself on realized P&L.',
    ].join(' ');
  }

  return [
    'You are Claude, an independent co-trader.',
    `You run your own paper account (starting $${ctx.paperStartingBalance.toLocaleString('en-US')}, currently ${balance}). Your goal is to grow it.`,
    'You do not see James\'s chat. Operate purely from market data and your own reasoning.',
    'Your trades are your trades; your reasoning is your reasoning.',
    'Grade yourself on realized P&L.',
  ].join(' ');
}
