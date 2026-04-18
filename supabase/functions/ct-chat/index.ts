/**
 * ct-chat — conversational interface for James to talk to Claude about
 * the tape. Called from the frontend ChatBox with user JWT auth.
 *
 * Input:
 *   { message: string, history: Array<{role: 'user'|'assistant', content: string}> }
 *
 * Pulls: latest heartbeat (condensed state), all theses, recent events
 * (last 10 obs/flags/alerts), and hands it all to Claude along with
 * chat history + new message.
 *
 * Output: { response: string, duration_ms: number }
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { extractUserId, isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { isKillSwitchActive } from '../_shared/killSwitch.ts';
import { callClaude, CLAUDE_MODELS, parseTextContent, ClaudeError } from '../_shared/anthropic.ts';
import { CT_CHAT_SYSTEM } from '../_shared/chatPromptV1.ts';
import { logMcpCalls } from '../_shared/mcpLog.ts';
import { logClaudeUsage } from '../_shared/claudeUsageLog.ts';
import { voyageEmbed } from '../_shared/ctEmbed.ts';
import { queryDcdBrain, shouldQueryDcdBrain, type CrossFacetHit } from '../_shared/crossFacetMemory.ts';
import { CT_PROMPT_VERSION } from '../_shared/systemPromptV1.ts';
import { writeTradeAudit, deriveMarketRegime, shapeMcpCalls } from '../_shared/tradeAudit.ts';
import { checkConcentration } from '../_shared/concentration.ts';
import { classifyThesis } from '../_shared/thesisClassifier.ts';
import { ctSlackPushDirect } from '../_shared/ctSlack.ts';
import { preTradeCheck, type Check } from '../_shared/preTradeGate.ts';
import { firePreTradeQuality } from '../_shared/tradeQuality.ts';

// ============================================================================
// /propose — Claude proposes 1-3 trade ideas given current state.
// Proposals are EPHEMERAL — James reviews, then /commits the ones he likes.
// Sonnet only (quality > cost; ~$0.02/call expected).
// ============================================================================

const PROPOSE_TRADE_SYSTEM = `You're proposing 1-3 trades James could take right now. These are
PROPOSALS not commits. He reviews and decides.

Each proposal MUST include:
  - instrument, side, size_pct (respecting concentration + ideal R)
  - entry, stop, target (levels, not percentages)
  - thesis (2-3 sentences, cite specific evidence)
  - evidence_axes (A-F array)
  - expected_move { low_pct, high_pct, confidence_pct, horizon_hrs }
  - conviction (1-5)
  - bias_check (which active biases could invalidate this, or "clear")
  - pre_trade_concerns (any warn-level gate issues)
  - commit_syntax (the exact /commit ... line James pastes to execute)

Rules:
  - Don't propose if concentration would breach.
  - Don't propose if kill switch active.
  - Don't propose anti-bias trades unless severity < 3.
  - If tape is quiet, return { proposals: [], skip_reason: "quiet tape, no edge" }.
  - Numbers-first, no cheerleading, acknowledge uncertainty.

Return ONLY a JSON object shaped:
{
  "proposals": [ { ...fields above... } ],
  "skip_reason": null | string
}
No prose outside the JSON. No code fence.`;

interface ProposalCard {
  instrument: string;
  side: 'long' | 'short';
  size_pct: number;
  entry: number | null;
  stop: number | null;
  target: number | null;
  thesis: string;
  evidence_axes: string[];
  expected_move: {
    low_pct: number | null;
    high_pct: number | null;
    confidence_pct: number | null;
    horizon_hrs: number | null;
  };
  conviction: number;
  bias_check: string;
  pre_trade_concerns: string[];
  commit_syntax: string;
  /** Populated server-side after preTradeCheck runs on the draft. */
  pre_trade_checks?: Check[];
}

/**
 * Build the /propose context block. Pulls current book, open positions,
 * concentration snapshot, recent high-attention events, active biases,
 * news sentiment, and combo verdicts. Everything is best-effort — a
 * missing table returns [] rather than failing the whole proposal.
 */
async function buildProposeContext(
  supabase: ReturnType<typeof createClient>,
  instrumentFilter: string | null,
) {
  const attentionCutoff = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
  const sessionDate = new Date().toISOString().slice(0, 10);

  const [
    heartbeat,
    theses,
    openTrades,
    book,
    biases,
    flags,
    alerts,
    news,
    drawdown,
  ] = await Promise.all([
    supabase.from('ct_heartbeats').select('status_line, current_reads, watching, created_at').order('created_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('ct_theses').select('instrument, direction, conviction, up_case, down_case, watching, rationale, updated_at'),
    supabase.from('ct_trades').select('id, instrument, side, size_pct, entry_price, stop_price, target_price, contract_type, strike, expiry, thesis, conviction, status, opened_at').eq('status', 'open'),
    supabase.from('ct_book').select('session_date, realized_pnl, unrealized_pnl, ending_balance, max_drawdown_pct, starting_balance').eq('session_date', sessionDate).maybeSingle(),
    supabase.from('ct_biases').select('id, pattern, instruments, severity, notes, created_at').eq('active', true),
    supabase.from('ct_flags').select('id, instruments, direction, conviction, horizon, glance, created_at').gte('created_at', attentionCutoff).order('created_at', { ascending: false }).limit(8),
    supabase.from('ct_alerts').select('id, instruments, direction, conviction, horizon, alert_trigger, glance, created_at').gte('created_at', attentionCutoff).order('created_at', { ascending: false }).limit(5),
    supabase.from('ct_news_analyses').select('instrument, news_headline, impact, significance, claude_take, created_at').gte('significance', 3).order('created_at', { ascending: false }).limit(8),
    supabase.from('ct_drawdown_alerts').select('tier, intraday_pnl_pct, drawdown_from_hwm_pct').eq('session_date', sessionDate).order('created_at', { ascending: false }).limit(1).maybeSingle(),
  ]);

  const hb = heartbeat.data as { status_line?: string; current_reads?: Record<string, unknown>; created_at?: string } | null;
  const snapshot = hb?.current_reads?._snapshot ?? null;
  const comboVerdicts = (hb?.current_reads as Record<string, unknown> | null)?.combo_verdicts
    ?? (hb?.current_reads as Record<string, unknown> | null)?._combo_verdicts
    ?? null;

  // Filter by instrument if requested.
  const filter = instrumentFilter?.toUpperCase() ?? null;
  const filterArr = <T extends { instrument?: string | null; instruments?: string[] | null; ticker?: string | null }>(rows: T[] | null | undefined): T[] => {
    if (!filter || !rows) return rows ?? [];
    return rows.filter((r) => {
      if (r.instrument && String(r.instrument).toUpperCase() === filter) return true;
      if (r.ticker && String(r.ticker).toUpperCase() === filter) return true;
      if (Array.isArray(r.instruments) && r.instruments.map((x) => String(x).toUpperCase()).includes(filter)) return true;
      return false;
    });
  };

  return {
    instrument_filter: filter,
    latest_status: hb?.status_line ?? null,
    latest_pulse_at: hb?.created_at ?? null,
    market_state: snapshot,
    combo_verdicts: comboVerdicts,
    book_today: book.data ?? null,
    drawdown_today: drawdown.data ?? null,
    open_positions: filterArr(openTrades.data as Array<Record<string, unknown>> | null ?? []),
    theses: filterArr(theses.data as Array<Record<string, unknown>> | null ?? []),
    active_biases: biases.data ?? [],
    recent_high_attention_flags: filterArr(flags.data as Array<Record<string, unknown>> | null ?? []).slice(0, 5),
    recent_alerts: filterArr(alerts.data as Array<Record<string, unknown>> | null ?? []),
    recent_significant_news: filterArr(news.data as Array<Record<string, unknown>> | null ?? []),
  };
}

/**
 * Handle /propose — short-circuit guards before calling Claude, then assemble
 * context, call Sonnet, parse proposals, run preTradeCheck on each, drop
 * blocked proposals, surface warns as pre_trade_concerns.
 */
async function handleProposeCommand(
  supabase: ReturnType<typeof createClient>,
  instrumentFilter: string | null,
): Promise<{
  response: string;
  proposal_cards: ProposalCard[];
  skip_reason: string | null;
  model: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
}> {
  // Short-circuit 1: kill switch
  if (await isKillSwitchActive(supabase)) {
    return {
      response: 'Kill switch engaged — no proposals. Disarm via TopNav or /disarm to resume.',
      proposal_cards: [],
      skip_reason: 'kill_switch_active',
      model: 'sonnet',
      tokens_in: 0,
      tokens_out: 0,
      cost_usd: 0,
    };
  }

  // Short-circuit 2: urgent drawdown today
  const sessionDate = new Date().toISOString().slice(0, 10);
  const { data: urgent } = await supabase
    .from('ct_drawdown_alerts')
    .select('tier, intraday_pnl_pct, drawdown_from_hwm_pct')
    .eq('session_date', sessionDate)
    .eq('tier', 'urgent')
    .limit(1)
    .maybeSingle();
  if (urgent) {
    const u = urgent as { intraday_pnl_pct?: number; drawdown_from_hwm_pct?: number };
    return {
      response: `Urgent drawdown tier today (intraday ${u.intraday_pnl_pct}%, HWM ${u.drawdown_from_hwm_pct}%) — no proposals.`,
      proposal_cards: [],
      skip_reason: 'drawdown_urgent',
      model: 'sonnet',
      tokens_in: 0,
      tokens_out: 0,
      cost_usd: 0,
    };
  }

  // Short-circuit 3: any open positions already at concentration max for filter?
  // (Leave to preTradeCheck per-proposal — don't pre-block all proposals here.)

  // Build context and call Sonnet
  const context = await buildProposeContext(supabase, instrumentFilter);
  const userMsg = `[LIVE STATE]\n${JSON.stringify(context, null, 2)}\n\n${
    instrumentFilter
      ? `Propose 1-3 trades focused on ${instrumentFilter} given this state.`
      : 'Propose 1-3 trades given this state. Return { proposals: [], skip_reason } if tape is quiet.'
  }`;

  let raw = '';
  let tokensIn = 0;
  let tokensOut = 0;
  let costUsd = 0;
  try {
    const res = await callClaude({
      model: CLAUDE_MODELS.sonnet,
      system: PROPOSE_TRADE_SYSTEM,
      messages: [{ role: 'user', content: userMsg }],
      max_tokens: 2500,
      temperature: 0.3,
    });
    raw = parseTextContent(res).trim();
    const usage = (res as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
    tokensIn = usage?.input_tokens ?? 0;
    tokensOut = usage?.output_tokens ?? 0;
    costUsd = Number(((tokensIn / 1_000_000) * 3 + (tokensOut / 1_000_000) * 15).toFixed(6));
  } catch (e) {
    const detail = e instanceof ClaudeError ? `Claude ${e.status}` : String(e);
    return {
      response: `Propose failed — Claude error: ${detail}`,
      proposal_cards: [],
      skip_reason: 'claude_error',
      model: 'sonnet',
      tokens_in: 0,
      tokens_out: 0,
      cost_usd: 0,
    };
  }

  // Fallback-safe JSON parse. Strip code fences if Sonnet ignored the rule.
  let parsed: { proposals?: unknown; skip_reason?: unknown } | null = null;
  try {
    const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    parsed = JSON.parse(stripped);
  } catch (e) {
    return {
      response: `Propose returned malformed JSON — can't render cards. Raw head: ${raw.slice(0, 200)}`,
      proposal_cards: [],
      skip_reason: 'malformed_response',
      model: 'sonnet',
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      cost_usd: costUsd,
    };
  }

  const skipReason = typeof parsed?.skip_reason === 'string' ? parsed.skip_reason : null;
  const rawProposals = Array.isArray(parsed?.proposals) ? parsed!.proposals as Array<Record<string, unknown>> : [];

  if (rawProposals.length === 0) {
    return {
      response: skipReason ? `No proposals — ${skipReason}` : 'No proposals.',
      proposal_cards: [],
      skip_reason: skipReason,
      model: 'sonnet',
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      cost_usd: costUsd,
    };
  }

  // Run preTradeCheck on each proposal. Drop blocked. Merge warn details into
  // pre_trade_concerns so James sees them on the card.
  const kept: ProposalCard[] = [];
  for (const p of rawProposals) {
    const instrument = String(p.instrument ?? '').toUpperCase();
    const side = (p.side === 'short' ? 'short' : 'long') as 'long' | 'short';
    const sizePct = Number(p.size_pct ?? 0);
    if (!instrument || !sizePct) continue;

    const draft = {
      instrument,
      side,
      size_pct: sizePct,
      thesis_theme: null,
      contract_type: 'underlying' as const,
      size_usd: null,
      source: 'chat' as const,
    };
    const gate = await preTradeCheck(supabase, draft, { force: false });

    const warnDetails = gate.checks
      .filter((c) => c.status === 'warn')
      .map((c) => `${c.name}: ${c.detail}`);

    if (!gate.passed) {
      // Block-level failure → drop the proposal entirely.
      console.log(`[ct-chat propose] dropped ${instrument} ${side} ${sizePct}% — blockers:`, gate.blockers.map((b) => b.name).join(','));
      continue;
    }

    const card: ProposalCard = {
      instrument,
      side,
      size_pct: sizePct,
      entry: typeof p.entry === 'number' ? p.entry : null,
      stop: typeof p.stop === 'number' ? p.stop : null,
      target: typeof p.target === 'number' ? p.target : null,
      thesis: String(p.thesis ?? ''),
      evidence_axes: Array.isArray(p.evidence_axes) ? (p.evidence_axes as unknown[]).map(String) : [],
      expected_move: {
        low_pct: typeof (p.expected_move as Record<string, unknown> | undefined)?.low_pct === 'number' ? (p.expected_move as Record<string, number>).low_pct : null,
        high_pct: typeof (p.expected_move as Record<string, unknown> | undefined)?.high_pct === 'number' ? (p.expected_move as Record<string, number>).high_pct : null,
        confidence_pct: typeof (p.expected_move as Record<string, unknown> | undefined)?.confidence_pct === 'number' ? (p.expected_move as Record<string, number>).confidence_pct : null,
        horizon_hrs: typeof (p.expected_move as Record<string, unknown> | undefined)?.horizon_hrs === 'number' ? (p.expected_move as Record<string, number>).horizon_hrs : null,
      },
      conviction: Number(p.conviction ?? 3),
      bias_check: String(p.bias_check ?? 'clear'),
      pre_trade_concerns: [
        ...(Array.isArray(p.pre_trade_concerns) ? (p.pre_trade_concerns as unknown[]).map(String) : []),
        ...warnDetails,
      ],
      commit_syntax: String(p.commit_syntax ?? `/commit ${instrument} ${side} ${sizePct}%`),
      pre_trade_checks: gate.checks,
    };
    kept.push(card);
  }

  const header = kept.length === 0
    ? `Claude returned ${rawProposals.length} proposal(s) but all were blocked by the pre-trade gate.`
    : `${kept.length} proposal${kept.length === 1 ? '' : 's'} — review each and paste the commit line to execute.`;

  return {
    response: header,
    proposal_cards: kept,
    skip_reason: kept.length === 0 ? 'all_blocked' : skipReason,
    model: 'sonnet',
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    cost_usd: costUsd,
  };
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

// ============================================================================
// /debate — Claude argues BOTH sides of a question with equal rigor.
// Confirmation-bias antidote. Claude does NOT pick a winner — James decides.
// Sonnet only (quality-critical; ~$0.02-0.03/debate expected).
//
// v2: debates are PERSISTED to ct_debates (wave 27). Topic is embedded once
// via Voyage for semantic search on /debates. user_pick stays null until James
// clicks a Pick button in ChatPanel — we NEVER auto-pick. The returned
// debate_id lets the client PATCH user_pick later.
// ============================================================================

const DEBATE_SYSTEM = `You must now present BOTH SIDES of the user's question with equal
rigor. This is structured adversarial analysis — not a balanced
"here are all sides" fluff piece.

Output structure (JSON):
  topic: restate the question
  bull_case: {
    headline: 1 sentence,
    evidence: string[] (5-8 specific datapoints / conditions),
    best_trade: "what you'd do if this side wins",
    probability_estimate: 0-100,
  }
  bear_case: symmetric
  your_prior_lean: "bullish" | "bearish" | "neutral" | "no prior",
  recent_grade_on_this: if you've called this topic before, cite the grade (or null),
  your_bias_risk: what's your confirmation-bias risk here?
  synthesis: final 2-3 sentences — what weight to give each side. NOT a conclusion. NOT a recommendation. Just "given both cases, the edge is conditional on X."

Rules:
  - Each case MUST cite at least 3 specific datapoints from the payload (not general market wisdom).
  - If one side is genuinely thin, SAY SO — don't fabricate evidence to balance.
  - your_bias_risk MUST reference a specific logged bias if applicable.
  - Numbers-first, no cheerleading.
  - probability_estimate on each side is INDEPENDENT — they do NOT need to sum to 100.
    If both cases are weak, BOTH estimates should be low (e.g. bull 30, bear 25 → "neither
    case is strong"). If both are strong, both can be high. Never force balance.
  - Do NOT pick a winner in the synthesis. James decides. Your job is to frame the trade-off,
    not resolve it.

Return ONLY a JSON object. No prose outside the JSON. No code fence.`;

interface DebateSide {
  headline: string;
  evidence: string[];
  best_trade: string;
  probability_estimate: number | null;
}

interface DebateCard {
  topic: string;
  bull_case: DebateSide;
  bear_case: DebateSide;
  your_prior_lean: 'bullish' | 'bearish' | 'neutral' | 'no prior' | string;
  recent_grade_on_this: string | null;
  your_bias_risk: string;
  synthesis: string;
  /** Optional — the instrument parsed from the topic (if any). Powers "Propose from X side" pre-fill. */
  instrument: string | null;
}

/**
 * Build /debate context. Same base as /chat plus topic-specific focus:
 *   - If an instrument was extracted, pull recent theses + ct_flags + ct_alerts
 *     with Claude's latest direction on it (so "your_prior_lean" is grounded).
 *   - Pull recent ct_grades on the instrument (so "recent_grade_on_this" can cite
 *     a specific verdict rather than hand-wave).
 *   - Pull active ct_biases so "your_bias_risk" is anchored to real logged biases.
 */
async function buildDebateContext(
  supabase: ReturnType<typeof createClient>,
  topic: string,
  instrumentFilter: string | null,
) {
  const attentionCutoff = new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString();
  const filter = instrumentFilter?.toUpperCase() ?? null;

  const [
    heartbeat,
    theses,
    openTrades,
    biases,
    recentFlags,
    recentAlerts,
    recentGrades,
    news,
  ] = await Promise.all([
    supabase.from('ct_heartbeats').select('status_line, current_reads, watching, created_at').order('created_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('ct_theses').select('instrument, direction, conviction, up_case, down_case, watching, rationale, updated_at'),
    supabase.from('ct_trades').select('id, instrument, side, size_pct, entry_price, stop_price, target_price, thesis, conviction, status, opened_at').eq('status', 'open'),
    supabase.from('ct_biases').select('id, pattern, instruments, severity, notes, created_at').eq('active', true),
    supabase.from('ct_flags').select('id, instruments, direction, conviction, horizon, glance, created_at').gte('created_at', attentionCutoff).order('created_at', { ascending: false }).limit(10),
    supabase.from('ct_alerts').select('id, instruments, direction, conviction, horizon, alert_trigger, glance, created_at').gte('created_at', attentionCutoff).order('created_at', { ascending: false }).limit(10),
    // Recent grades: if filtered by instrument, show Claude's track record on it.
    // Otherwise skip (a general debate doesn't need every grade in the book).
    filter
      ? supabase.from('ct_grades').select('subject_type, instrument, claimed_direction, actual_direction, verdict, actual_return_pct, calibration_delta, graded_at').eq('instrument', filter).order('graded_at', { ascending: false }).limit(10)
      : Promise.resolve({ data: [] }),
    supabase.from('ct_news_analyses').select('instrument, news_headline, impact, significance, claude_take, created_at').gte('significance', 3).order('created_at', { ascending: false }).limit(8),
  ]);

  const hb = heartbeat.data as { status_line?: string; current_reads?: Record<string, unknown>; created_at?: string } | null;
  const snapshot = hb?.current_reads?._snapshot ?? null;

  const filterArr = <T extends { instrument?: string | null; instruments?: string[] | null }>(rows: T[] | null | undefined): T[] => {
    if (!filter || !rows) return rows ?? [];
    return rows.filter((r) => {
      if (r.instrument && String(r.instrument).toUpperCase() === filter) return true;
      if (Array.isArray(r.instruments) && r.instruments.map((x) => String(x).toUpperCase()).includes(filter)) return true;
      return false;
    });
  };

  // Claude's "most recent direction on the topic" — strongest signal when
  // filtered by instrument. Pick the most recent thesis + most recent flag/alert.
  const filteredTheses = filterArr(theses.data as Array<Record<string, unknown>> | null ?? []);
  const filteredFlags = filterArr(recentFlags.data as Array<Record<string, unknown>> | null ?? []);
  const filteredAlerts = filterArr(recentAlerts.data as Array<Record<string, unknown>> | null ?? []);
  const mostRecentDirection = (() => {
    const latestFlag = filteredFlags[0] as Record<string, unknown> | undefined;
    const latestAlert = filteredAlerts[0] as Record<string, unknown> | undefined;
    const pick = latestAlert?.created_at && latestFlag?.created_at
      ? (String(latestAlert.created_at) > String(latestFlag.created_at) ? latestAlert : latestFlag)
      : (latestAlert ?? latestFlag ?? null);
    return pick
      ? {
          source: pick === latestAlert ? 'alert' : 'flag',
          direction: pick.direction ?? null,
          conviction: pick.conviction ?? null,
          horizon: pick.horizon ?? null,
          glance: pick.glance ?? null,
          at: pick.created_at ?? null,
        }
      : null;
  })();

  return {
    topic,
    instrument_filter: filter,
    latest_status: hb?.status_line ?? null,
    latest_pulse_at: hb?.created_at ?? null,
    market_state: snapshot,
    // Claude's prior direction on THIS topic — grounds `your_prior_lean`.
    claudes_latest_direction_on_topic: mostRecentDirection,
    relevant_theses: filteredTheses,
    open_positions_on_topic: filterArr(openTrades.data as Array<Record<string, unknown>> | null ?? []),
    active_biases: biases.data ?? [],
    recent_flags_on_topic: filteredFlags.slice(0, 5),
    recent_alerts_on_topic: filteredAlerts.slice(0, 5),
    // Claude's track record on this instrument (for `recent_grade_on_this`).
    recent_grades_on_topic: recentGrades.data ?? [],
    recent_significant_news: filterArr(news.data as Array<Record<string, unknown>> | null ?? []),
  };
}

/**
 * Persist a DebateCard to ct_debates and embed the topic (Voyage 512-dim).
 * One row per debate; embedding is one-shot on save, never re-embedded.
 *
 * Best-effort: if the insert or embed fails we log and return null — the
 * chat response still flies back (James sees the card), we just can't
 * track outcomes. That's acceptable degradation; a retry scaffold would
 * add more failure surface than the cost it averts.
 */
async function persistDebate(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  card: DebateCard,
): Promise<string | null> {
  // Rich text for embedding: topic is the load-bearing signal; tail with
  // instrument + synthesis so semantically-similar framings ("should I hold
  // SPY" vs "SPY at these levels") retrieve each other.
  const embedInput = [
    card.topic,
    card.instrument ? `instrument:${card.instrument}` : '',
    card.synthesis,
  ].filter(Boolean).join(' | ');

  let embedding: number[] | null = null;
  try {
    embedding = await voyageEmbed(embedInput, 'document');
  } catch (e) {
    console.warn(`[ct-chat/persistDebate] embed failed: ${e instanceof Error ? e.message : e}`);
    // Continue — we still persist the row, just without an embedding.
  }

  const { data, error } = await supabase
    .from('ct_debates')
    .insert({
      user_id: userId,
      topic: card.topic,
      bull_case: card.bull_case,
      bear_case: card.bear_case,
      your_prior_lean: card.your_prior_lean,
      recent_grade_on_this: card.recent_grade_on_this
        ? { note: card.recent_grade_on_this }
        : null,
      your_bias_risk: card.your_bias_risk,
      synthesis: card.synthesis,
      instrument: card.instrument,
      embedding: embedding as unknown as string | null,
    })
    .select('id')
    .maybeSingle();

  if (error) {
    console.warn(`[ct-chat/persistDebate] insert failed: ${error.message}`);
    return null;
  }
  return (data?.id as string | undefined) ?? null;
}

/**
 * Handle /debate — build topic context, call Sonnet with DEBATE_SYSTEM,
 * parse structured JSON, persist to ct_debates, return a DebateCard + its id.
 */
async function handleDebateCommand(
  supabase: ReturnType<typeof createClient>,
  topic: string,
  instrumentFilter: string | null,
  userId: string | null,
): Promise<{
  response: string;
  debate_card: DebateCard | null;
  debate_id: string | null;
  model: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
}> {
  if (!topic) {
    return {
      response: `/debate needs a topic. Try "/debate should I hold SPY" or "/debate long NVDA vs short NVDA here".`,
      debate_card: null,
      debate_id: null,
      model: 'sonnet',
      tokens_in: 0,
      tokens_out: 0,
      cost_usd: 0,
    };
  }

  const context = await buildDebateContext(supabase, topic, instrumentFilter);
  const userMsg = `[LIVE STATE + TOPIC CONTEXT]\n${JSON.stringify(context, null, 2)}\n\nDebate this topic with equal rigor on both sides: "${topic}"`;

  let raw = '';
  let tokensIn = 0;
  let tokensOut = 0;
  let costUsd = 0;
  try {
    const res = await callClaude({
      model: CLAUDE_MODELS.sonnet,
      system: DEBATE_SYSTEM,
      messages: [{ role: 'user', content: userMsg }],
      max_tokens: 2500,
      temperature: 0.4,
    });
    raw = parseTextContent(res).trim();
    const usage = (res as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
    tokensIn = usage?.input_tokens ?? 0;
    tokensOut = usage?.output_tokens ?? 0;
    costUsd = Number(((tokensIn / 1_000_000) * 3 + (tokensOut / 1_000_000) * 15).toFixed(6));
  } catch (e) {
    const detail = e instanceof ClaudeError ? `Claude ${e.status}` : String(e);
    return {
      response: `Debate failed — Claude error: ${detail}`,
      debate_card: null,
      debate_id: null,
      model: 'sonnet',
      tokens_in: 0,
      tokens_out: 0,
      cost_usd: 0,
    };
  }

  let parsed: Record<string, unknown> | null = null;
  try {
    const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    parsed = JSON.parse(stripped);
  } catch (_e) {
    return {
      response: `Debate returned malformed JSON — can't render card. Raw head: ${raw.slice(0, 200)}`,
      debate_card: null,
      debate_id: null,
      model: 'sonnet',
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      cost_usd: costUsd,
    };
  }

  const sideShape = (side: unknown): DebateSide => {
    const s = (side ?? {}) as Record<string, unknown>;
    const prob = typeof s.probability_estimate === 'number'
      ? Math.max(0, Math.min(100, s.probability_estimate))
      : null;
    return {
      headline: typeof s.headline === 'string' ? s.headline : '',
      evidence: Array.isArray(s.evidence) ? (s.evidence as unknown[]).map(String) : [],
      best_trade: typeof s.best_trade === 'string' ? s.best_trade : '',
      probability_estimate: prob,
    };
  };

  const card: DebateCard = {
    topic: typeof parsed?.topic === 'string' ? parsed.topic : topic,
    bull_case: sideShape(parsed?.bull_case),
    bear_case: sideShape(parsed?.bear_case),
    your_prior_lean: typeof parsed?.your_prior_lean === 'string' ? parsed.your_prior_lean : 'no prior',
    recent_grade_on_this: typeof parsed?.recent_grade_on_this === 'string' ? parsed.recent_grade_on_this : null,
    your_bias_risk: typeof parsed?.your_bias_risk === 'string' ? parsed.your_bias_risk : '',
    synthesis: typeof parsed?.synthesis === 'string' ? parsed.synthesis : '',
    instrument: instrumentFilter ?? null,
  };

  // Persist + embed (once, on save). debate_id is returned to the client so
  // the Pick buttons can PATCH user_pick later. Service-role calls without a
  // userId (rare — testing path) skip persistence.
  let debateId: string | null = null;
  if (userId) {
    debateId = await persistDebate(supabase, userId, card);
  }

  return {
    response: `Debate on "${card.topic}" — both sides below. Your call.`,
    debate_card: card,
    debate_id: debateId,
    model: 'sonnet',
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    cost_usd: costUsd,
  };
}

/**
 * Parse and execute a commit-trade command from chat.
 * Grammars accepted:
 *   commit SPY long 15% stop 708 target 712 [thesis: "..."]
 *   commit SPY 710C 4/18 long 5 @1.25 [stop 0.8 target 2.5] [thesis: "..."]
 */
async function handleCommitCommand(
  supabase: ReturnType<typeof createClient>,
  args: string,
): Promise<{ response: string; trade_id: string | null; pre_trade_checks?: Check[]; force?: boolean }> {
  // --force strips from args BEFORE grammar parsing so it never confuses the
  // tokenizer. Force bypasses WARN-level checks only. Block-level checks
  // (kill switch, drawdown urgent, concentration, high-sev bias, cooldown)
  // are ALWAYS hard — --force cannot override them.
  const force = /(^|\s)--force(\s|$)/.test(args);
  args = args.replace(/(^|\s)--force(\s|$)/g, ' ').trim();

  const thesisMatch = args.match(/thesis[:\s]+"([^"]+)"|thesis[:\s]+(.+)$/i);
  const thesis = thesisMatch ? (thesisMatch[1] ?? thesisMatch[2] ?? '').trim() : '';
  const bare = thesisMatch ? args.replace(thesisMatch[0], '').trim() : args.trim();

  const tokens = bare.split(/\s+/);
  if (tokens.length < 3) {
    return { response: `commit parse error — usage: "commit SPY long 15% stop 708 target 712 thesis: '...'" or "commit SPY 710C 4/18 long 5 @1.25 thesis: '...'"`, trade_id: null };
  }

  const instrument = tokens[0].toUpperCase();
  // Detect option: token like 710C or 710P or 710c 4/18
  const optMatch = tokens[1].match(/^(\d+(?:\.\d+)?)([CPcp])$/);
  let rpcArgs: Record<string, unknown>;

  if (optMatch) {
    // Option trade: commit SPY 710C 4/18 long 5 @1.25
    const strike = parseFloat(optMatch[1]);
    const contractType = optMatch[2].toLowerCase() === 'c' ? 'call' : 'put';
    const exp = tokens[2]; // 4/18 or 2026-04-18
    const year = new Date().getUTCFullYear();
    let expiry: string;
    if (exp.includes('-')) expiry = exp;
    else if (exp.includes('/')) {
      const [m, d] = exp.split('/');
      expiry = `${year}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    } else {
      return { response: 'option expiry must be M/D or YYYY-MM-DD', trade_id: null };
    }
    const side = tokens[3]?.toLowerCase() === 'long' || tokens[3]?.toLowerCase() === 'short' ? tokens[3].toLowerCase() : 'long';
    const contracts = parseInt(tokens[4] ?? '1', 10);
    const premMatch = args.match(/@\s*(\d+(?:\.\d+)?)/);
    const entryPremium = premMatch ? parseFloat(premMatch[1]) : null;
    if (!entryPremium) return { response: 'option trade needs entry premium: @1.25', trade_id: null };
    const stopMatch = args.match(/stop\s+(\d+(?:\.\d+)?)/i);
    const targetMatch = args.match(/target\s+(\d+(?:\.\d+)?)/i);
    rpcArgs = {
      p_instrument: instrument,
      p_side: side,
      p_size_pct: 0,
      p_contract_type: contractType,
      p_strike: strike,
      p_expiry: expiry,
      p_contracts: contracts,
      p_entry_premium: entryPremium,
      p_entry_price: null,
      p_stop_price: stopMatch ? parseFloat(stopMatch[1]) : null,
      p_target_price: targetMatch ? parseFloat(targetMatch[1]) : null,
      p_thesis: thesis || `manual commit: ${instrument} ${strike}${optMatch[2].toUpperCase()} ${expiry}`,
      p_horizon: 'intraday',
      p_conviction: 3,
    };
  } else {
    // Underlying trade: commit SPY long 15% stop 708 target 712
    const side = tokens[1]?.toLowerCase();
    if (side !== 'long' && side !== 'short') {
      return { response: `second token must be 'long' or 'short'`, trade_id: null };
    }
    const sizeMatch = args.match(/(\d+(?:\.\d+)?)\s*%/);
    const sizePct = sizeMatch ? parseFloat(sizeMatch[1]) : 10;
    const stopMatch = args.match(/stop\s+(\d+(?:\.\d+)?)/i);
    const targetMatch = args.match(/target\s+(\d+(?:\.\d+)?)/i);
    rpcArgs = {
      p_instrument: instrument,
      p_side: side,
      p_size_pct: sizePct,
      p_contract_type: 'underlying',
      p_strike: null,
      p_expiry: null,
      p_contracts: null,
      p_entry_premium: null,
      p_entry_price: null, // book-manager will fill at current price on next tick
      p_stop_price: stopMatch ? parseFloat(stopMatch[1]) : null,
      p_target_price: targetMatch ? parseFloat(targetMatch[1]) : null,
      p_thesis: thesis || `manual ${side} ${instrument} ${sizePct}%`,
      p_horizon: 'intraday',
      p_conviction: 3,
    };
  }

  // Concentration gate — reject if the requested trade would breach any
  // portfolio concentration cap. For options, we size on premium: size_usd
  // is contracts * entry_premium * 100 (shares/contract).
  const proposedContractType = (rpcArgs.p_contract_type as string) ?? 'underlying';
  const proposedSizeUsd = proposedContractType === 'underlying'
    ? null
    : Number(rpcArgs.p_contracts ?? 0) * Number(rpcArgs.p_entry_premium ?? 0) * 100;
  const concReport = await checkConcentration(supabase, {
    instrument:    (rpcArgs.p_instrument as string) ?? instrument,
    side:          (rpcArgs.p_side as 'long' | 'short'),
    size_pct:      Number(rpcArgs.p_size_pct ?? 0),
    thesis_theme:  classifyThesis(rpcArgs.p_thesis as string | null),
    contract_type: proposedContractType as 'underlying' | 'call' | 'put',
    size_usd:      proposedSizeUsd,
  });
  if (!concReport.passed) {
    // Best-effort Slack notify — James can still manually re-issue the
    // command to override (though nothing about the response hides the
    // rejection, and CtSettings is the right place to tune the cap).
    try {
      const { data: profileRow } = await supabase.from('profiles').select('id').limit(1).maybeSingle();
      const userId = (profileRow?.id as string | undefined) ?? null;
      if (userId) {
        await ctSlackPushDirect(
          supabase, userId,
          `:no_entry: ct-chat rejected manual commit on concentration — ${concReport.reason ?? 'breach'}`,
          'concentration-gate',
        );
      }
    } catch (_) { /* swallow — Slack is best-effort */ }
    return {
      response: `✗ commit rejected on concentration: ${concReport.reason ?? 'breach'}\nTune limits in /ct-settings under "concentration" if you want to override.`,
      trade_id: null,
    };
  }

  // Full pre-trade compliance gate — 7 checks. Manual chat commits route
  // 'chat' as the trade source; cooldown's alert-only rule returns pass.
  // Blockers are always hard. Warns are bypassed iff --force was passed.
  const gateResult = await preTradeCheck(supabase, {
    instrument:    (rpcArgs.p_instrument as string) ?? instrument,
    side:          (rpcArgs.p_side as 'long' | 'short'),
    size_pct:      Number(rpcArgs.p_size_pct ?? 0),
    thesis_theme:  classifyThesis(rpcArgs.p_thesis as string | null),
    contract_type: proposedContractType as 'underlying' | 'call' | 'put',
    size_usd:      proposedSizeUsd,
    source:        'chat',
  }, { force });

  if (!gateResult.passed) {
    const lines = gateResult.blockers.map(b => `• ${b.name} [${b.threshold_key ?? 'no-threshold'}]: ${b.detail}`).join('\n');
    return {
      response: `✗ commit blocked by pre-trade gate (${gateResult.blockers.length} blocker${gateResult.blockers.length === 1 ? '' : 's'}):\n${lines}\n\nBlock-level checks cannot be bypassed with --force. Tune thresholds in /ct-settings.`,
      trade_id: null,
      pre_trade_checks: gateResult.checks,
      force,
    };
  }

  // Warn-level rejection: if any check is a warn AND --force was NOT passed,
  // we advise the user but do NOT block. This mirrors the UI's Override
  // behavior: warns are visible friction, not a wall.
  const warns = gateResult.checks.filter(c => c.status === 'warn');
  if (warns.length > 0 && !force) {
    const warnLines = warns.map(w => `• ${w.name}: ${w.detail}`).join('\n');
    return {
      response: `⚠ pre-trade gate raised ${warns.length} warn${warns.length === 1 ? '' : 's'} (not blocking):\n${warnLines}\n\nRe-issue with --force to commit through these warnings.`,
      trade_id: null,
      pre_trade_checks: gateResult.checks,
      force,
    };
  }

  const { data, error } = await supabase.rpc('commit_manual_trade', rpcArgs);
  if (error) {
    return { response: `commit failed: ${error.message}`, trade_id: null };
  }
  const tradeId = (data as unknown) as string;
  const summary = optMatch
    ? `✓ committed ${instrument} ${rpcArgs.p_strike}${(rpcArgs.p_contract_type as string).toUpperCase()} ${rpcArgs.p_expiry} ${rpcArgs.p_side} ${rpcArgs.p_contracts} @${rpcArgs.p_entry_premium}`
    : `✓ committed ${instrument} ${rpcArgs.p_side} ${rpcArgs.p_size_pct}% stop=${rpcArgs.p_stop_price ?? '—'} target=${rpcArgs.p_target_price ?? '—'}`;
  const forceTag = force ? ' (--force: warns bypassed)' : '';
  return {
    response: `${summary}${forceTag}\ntrade_id: ${tradeId}\nbook-manager will manage on next :15 tick`,
    trade_id: tradeId,
    pre_trade_checks: gateResult.checks,
    force,
  };
}

/**
 * Detect whether the user's query is asking about very recent events.
 * Keyword heuristic — keeps things fast and cheap (no extra LLM call).
 */
const RECENT_QUERY_PATTERNS = [
  /\brecent(?:ly)?\b/i,
  /\bjust now\b/i,
  /\bjust happened\b/i,
  /\bright now\b/i,
  /\b\d+\s*min(?:ute)?s?\s+ago\b/i,
  /\bin the last\s+(?:hour|\d+\s*min(?:ute)?s?)\b/i,
  /\bpast\s+(?:hour|\d+\s*min(?:ute)?s?)\b/i,
  /\blast few (?:min(?:ute)?s|minutes)\b/i,
  /\bthis hour\b/i,
];

function isRecentQuery(message: string): boolean {
  return RECENT_QUERY_PATTERNS.some((rx) => rx.test(message));
}

/**
 * Extract likely instrument tickers from the user's message (uppercase 1–5 char
 * tokens). Used to scope the ct_similar_items RPC, which requires p_instrument.
 * Falls back to a small default set so general queries still recall.
 */
const DEFAULT_RECALL_INSTRUMENTS = ['SPY', 'QQQ'] as const;
const TICKER_STOPWORDS = new Set([
  'I', 'A', 'AM', 'PM', 'ET', 'UTC', 'OK', 'NO', 'YES', 'THE', 'AND', 'OR',
  'IF', 'IS', 'IT', 'TO', 'OF', 'ON', 'IN', 'AT', 'BY', 'DO', 'GO', 'MY',
  'ALL', 'ANY', 'SO', 'US', 'WE', 'UP', 'OUT', 'ARE', 'WAS', 'BE', 'ASK',
  'NOW', 'GET', 'SEE', 'HAS', 'HAD', 'CAN', 'WHY', 'HOW', 'WHO', 'BUT',
  'ITM', 'OTM', 'ATM', 'IV', 'OI', 'UW', 'AI', 'ML', 'ETF', 'PR', 'LLM',
]);

function extractInstruments(message: string): string[] {
  const matches = message.match(/\b[A-Z]{1,5}\b/g) ?? [];
  const out: string[] = [];
  for (const m of matches) {
    if (TICKER_STOPWORDS.has(m)) continue;
    if (!out.includes(m)) out.push(m);
    if (out.length >= 4) break;
  }
  return out;
}

/**
 * Semantic recall over ct_embeddings via the ct_similar_items RPC.
 * Matches the call style in _shared/memoryRecall.ts#getSimilarPastSetups.
 * Best-effort — returns [] on any failure (never throws).
 *
 * Time-floor heuristic:
 *   - If message reads like "recently / just now / 10 min ago / in the last hour"
 *     → include rows from the last 60 min only.
 *   - Otherwise no time floor (so "what happened 10 min ago?" can actually recall
 *     fresh rows), with result count capped to avoid context bloat.
 */
async function recentSemanticHits(
  supabase: ReturnType<typeof createClient>,
  message: string,
): Promise<{ hits: Array<Record<string, unknown>>; timeFloorApplied: 'none' | '60min' }> {
  try {
    const queryEmb = await voyageEmbed(message, 'query');
    const instruments = extractInstruments(message);
    const targets = instruments.length > 0 ? instruments : [...DEFAULT_RECALL_INSTRUMENTS];

    const recent = isRecentQuery(message);
    const timeFloorApplied: 'none' | '60min' = recent ? '60min' : 'none';
    const cutoffIso = recent ? new Date(Date.now() - 60 * 60 * 1000).toISOString() : null;

    // Per-instrument RPC calls run in parallel. Shape matches
    // getSimilarPastSetups in _shared/memoryRecall.ts.
    const perInstrumentLimit = 6;
    const rpcResults = await Promise.all(targets.map(async (instrument) => {
      const { data, error } = await supabase.rpc('ct_similar_items', {
        p_instrument: instrument,
        p_query_embedding: queryEmb as unknown as string,
        p_limit: perInstrumentLimit,
      });
      if (error) {
        console.warn(`[ct-chat] ct_similar_items RPC failed for ${instrument}:`, error.message);
        return [] as Array<Record<string, unknown>>;
      }
      return (data ?? []) as Array<Record<string, unknown>>;
    }));

    // Merge, dedupe by (type:id), apply recent-window floor if heuristic fired,
    // sort by distance, cap at 7 so context doesn't bloat.
    const merged = new Map<string, Record<string, unknown>>();
    for (const rows of rpcResults) {
      for (const row of rows) {
        if (cutoffIso && typeof row.created_at === 'string' && row.created_at < cutoffIso) continue;
        const key = `${row.type}:${row.id}`;
        const prev = merged.get(key);
        if (!prev || (row.distance as number) < (prev.distance as number)) {
          merged.set(key, row);
        }
      }
    }

    const hits = [...merged.values()]
      .sort((a, b) => (a.distance as number) - (b.distance as number))
      .slice(0, 7)
      .map((r) => ({
        type: r.type,
        id: r.id,
        distance: typeof r.distance === 'number' ? Number((r.distance as number).toFixed(4)) : r.distance,
        timestamp: r.created_at,
        instrument: r.instrument ?? null,
        direction: r.claimed_direction ?? null,
        conviction: r.conviction ?? null,
        grade: r.verdict
          ? { verdict: r.verdict, actual_return_pct: r.actual_return_pct ?? null }
          : null,
      }));

    return { hits, timeFloorApplied };
  } catch (e) {
    console.warn('[ct-chat] recentSemanticHits failed:', e instanceof Error ? e.message : e);
    return { hits: [], timeFloorApplied: 'none' };
  }
}

async function buildContext(supabase: ReturnType<typeof createClient>) {
  const flowCutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();

  const [heartbeat, theses, obs, flags, alerts, flow, dp, news] = await Promise.all([
    supabase.from('ct_heartbeats').select('status_line, current_reads, watching, created_at').order('created_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('ct_theses').select('instrument, direction, conviction, up_case, down_case, watching, rationale, updated_at'),
    supabase.from('ct_observations').select('id, instruments, direction, glance, created_at').order('created_at', { ascending: false }).limit(6),
    supabase.from('ct_flags').select('id, instruments, direction, conviction, horizon, glance, created_at').order('created_at', { ascending: false }).limit(6),
    supabase.from('ct_alerts').select('id, instruments, direction, conviction, horizon, alert_trigger, glance, created_at').order('created_at', { ascending: false }).limit(3),
    supabase.from('ct_flow_alerts').select('ticker, side, strike, expiry, is_otm, is_ask, size, premium, size_gt_oi, executed_at').gte('ingested_at', flowCutoff).order('premium', { ascending: false }).limit(25),
    supabase.from('ct_dark_pool_prints').select('ticker, size, price, notional_value, executed_at').gte('ingested_at', flowCutoff).order('notional_value', { ascending: false }).limit(25),
    supabase.from('ct_news_analyses').select('instrument, news_headline, impact, significance, claude_take, created_at').gte('significance', 3).order('created_at', { ascending: false }).limit(10),
  ]);

  // Condense heartbeat current_reads — only send the _snapshot (condensed state),
  // not the _macro blob with raw per-strike Greek vectors.
  const hb = heartbeat.data as { status_line?: string; current_reads?: Record<string, unknown>; created_at?: string } | null;
  const snapshot = hb?.current_reads?._snapshot ?? null;

  return {
    latest_status: hb?.status_line ?? null,
    latest_pulse_at: hb?.created_at ?? null,
    market_state: snapshot,
    theses: theses.data ?? [],
    recent_observations: obs.data ?? [],
    recent_flags: flags.data ?? [],
    recent_alerts: alerts.data ?? [],
    recent_flow_alerts_30min: flow.data ?? [],
    recent_dark_pool_prints_30min: dp.data ?? [],
    recent_significant_news: news.data ?? [],
  };
}

serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  const corsHeaders = getCorsHeaders(req);

  // Accept either authenticated user JWT or service role (for testing).
  let authorized = false;
  let userId: string | null = null;
  if (isServiceRoleRequest(req)) {
    authorized = true;
  } else {
    const extracted = await extractUserId(req);
    if (extracted.userId) {
      authorized = true;
      userId = extracted.userId;
    }
  }
  if (!authorized) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  const startedAt = Date.now();

  try {
    const body = await req.json().catch(() => ({}));
    const message = typeof body?.message === 'string' ? body.message.trim() : '';
    const history = Array.isArray(body?.history) ? (body.history as ChatMessage[]).slice(-10) : [];

    if (!message) {
      return new Response(JSON.stringify({ error: 'message required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Commit-trade slash command. Two grammars:
    //   commit SPY long 15% stop 708 target 712 [thesis: text]
    //   commit SPY 710C 4/18 long 5 @1.25 [stop 0.8 target 2.5] [thesis: text]
    const commitMatch = message.match(/^\s*\/?commit\s+(.*)$/i);
    if (commitMatch) {
      // Kill switch — chat READS pass through but COMMITS are gated.
      // Chat is James's main talk-to-Claude channel; we deliberately keep it
      // available while killed so he can still ask questions, just not bind
      // the book.
      if (await isKillSwitchActive(supabase)) {
        return new Response(
          JSON.stringify({
            response: 'Kill switch is engaged — commit blocked. Disarm via TopNav, Slack `/disarm`, or the UI button to resume writes.',
            skipped: true,
            reason: 'kill_switch_active',
            duration_ms: Date.now() - startedAt,
          }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }
      const args = commitMatch[1];
      const out = await handleCommitCommand(supabase, args);

      // Audit trail — fire-and-forget. Manual chat commits are the highest-
      // trust path (James himself) but also the one that bypasses Claude's
      // usual reasoning loop. The audit row captures:
      //   - the chat message that issued the commit (raw_claude_response field
      //     reused as "raw input text" — there's no Claude JSON here),
      //   - the last ~10 message chat history (as context),
      //   - active biases + latest heartbeat snapshot + market regime,
      //   - MCP calls from this chat session in the preceding 15 min.
      if (out.trade_id) {
        // Fire-and-forget pre-trade quality rating. Claude grades his own
        // commit SETUP 1-10, outcome-blind. Chat commits are interesting
        // because James is the author, not Claude — but Claude should still
        // grade the setup the same way (sizing, R:R, thesis). Pairs with a
        // post-rating fired by ct-book-manager at close. Wrapped in its own
        // IIFE so the fetch that resolves trade fields never blocks the
        // HTTP response.
        const capturedTradeId = out.trade_id;
        (async () => {
          const { data: tr } = await supabase
            .from('ct_trades')
            .select('id, instrument, side, size_pct, entry_price, stop_price, target_price, thesis, conviction, contract_type')
            .eq('id', capturedTradeId)
            .maybeSingle();
          if (!tr) return;
          const row = tr as {
            id: string;
            instrument: string;
            side: 'long' | 'short';
            size_pct: number;
            entry_price: number | null;
            stop_price: number | null;
            target_price: number | null;
            thesis: string | null;
            conviction: number | null;
            contract_type: string | null;
          };
          firePreTradeQuality(supabase, {
            tradeId:       row.id,
            instrument:    row.instrument,
            side:          row.side,
            size_pct:      row.size_pct,
            entry_price:   row.entry_price,
            stop_price:    row.stop_price,
            target_price:  row.target_price,
            thesis:        row.thesis,
            conviction:    row.conviction,
            contract_type: row.contract_type,
            source:        'chat',
            context: {
              chat_message: message,
              pre_trade_checks: out.pre_trade_checks ?? [],
              force: out.force ?? false,
            },
          });
        })();

        (async () => {
          try {
            const [hbRes, biasRes, mcpRes] = await Promise.all([
              supabase.from('ct_heartbeats')
                .select('id, current_reads, created_at')
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle(),
              supabase.from('ct_biases')
                .select('id, pattern, instruments, severity')
                .eq('active', true),
              supabase.from('ct_mcp_calls')
                .select('tool_name, input, result, is_error, created_at')
                .eq('source', 'chat')
                .gte('created_at', new Date(Date.now() - 15 * 60_000).toISOString())
                .order('created_at', { ascending: false })
                .limit(20),
            ]);
            const hb = hbRes.data as { id?: string; current_reads?: Record<string, unknown> } | null;
            const snapshot = hb?.current_reads?._snapshot ?? null;

            writeTradeAudit(supabase, {
              trade_id: out.trade_id,
              source: 'chat',
              uw_state_snapshot: snapshot,
              mcp_calls: shapeMcpCalls(mcpRes.data as Array<Record<string, unknown>> | null),
              active_biases: biasRes.data ?? [],
              // Chat commits don't compute size_pct via a sizer — the numbers
              // are parsed straight from the slash-command args. Record them
              // as-entered for the audit trail.
              sizing_computed: {
                source: 'chat-slash-command',
                raw_args: args,
                trade_id: out.trade_id,
              },
              market_regime: deriveMarketRegime(snapshot),
              heartbeat_id: hb?.id ?? null,
              triggering_alert_id: null,
              triggering_flag_id: null,
              prompt_version: CT_PROMPT_VERSION,
              // For chat commits there's no Claude JSON; preserve the full
              // user message + tail of chat history as the "input" that
              // produced the trade. Capped at 20KB by writeTradeAudit.
              raw_claude_response: JSON.stringify({
                message,
                tail_history: history.slice(-5),
              }),
              pre_trade_checks: out.pre_trade_checks ?? [],
            });
          } catch (e) {
            console.warn('[ct-chat] audit write failed:', e instanceof Error ? e.message : e);
          }
        })();
      }

      // Return the full checklist so the UI can render the PreTradeChecklist
      // card inline. Blocked/warned paths (trade_id=null) still surface the
      // checks — the UI uses them to decide whether to show the Override
      // button.
      return new Response(JSON.stringify({
        response: out.response,
        trade_id: out.trade_id,
        commit: true,
        pre_trade_checks: out.pre_trade_checks ?? [],
        force: out.force ?? false,
        duration_ms: 0,
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // /propose — Claude proposes 1-3 trades given current state.
    // Guardrails (kill switch, drawdown urgent) short-circuit BEFORE calling
    // Claude. Proposals are ephemeral; James pastes the commit_syntax to
    // execute. Optional instrument filter: "/propose NVDA" → NVDA only.
    // Match:  "/propose", "/propose NVDA", "propose" (exact), "Propose a trade"
    // The chip-suggested "Propose a trade" is treated as a bare /propose with
    // no filter (we intentionally ignore the trailing natural-language bits
    // when there's no leading slash). With a leading slash, the next token is
    // the instrument filter: "/propose NVDA" → NVDA only.
    const slashProposeMatch = message.match(/^\s*\/propose(?:\s+(\S+))?(?:\s.*)?$/i);
    const bareProposeMatch = !slashProposeMatch && /^\s*propose(\s+a\s+trade)?\s*\.?\s*$/i.test(message);
    const isProposeCmd = Boolean(slashProposeMatch) || bareProposeMatch;
    if (isProposeCmd) {
      const filterRaw = (slashProposeMatch?.[1] ?? '').trim();
      const filter = filterRaw && /^[A-Za-z]{1,5}$/.test(filterRaw) ? filterRaw.toUpperCase() : null;
      const proposed = await handleProposeCommand(supabase, filter);
      return new Response(JSON.stringify({
        response: proposed.response,
        proposal_cards: proposed.proposal_cards,
        skip_reason: proposed.skip_reason,
        propose: true,
        model: proposed.model,
        tokens_in: proposed.tokens_in,
        tokens_out: proposed.tokens_out,
        cost_usd: proposed.cost_usd,
        mcp_calls: 0,
        duration_ms: Date.now() - startedAt,
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // /debate — force Claude to steel-man BOTH sides. Confirmation-bias
    // antidote. Sonnet required for quality (~$0.02-0.03). Ephemeral; see the
    // persistence hook comment in handleDebateCommand. Claude is explicitly
    // instructed NOT to pick a winner — James decides.
    // Match: "/debate <anything>" OR bare "debate <topic>" (no chip fallback
    // since chips pre-fill the slash form).
    const slashDebateMatch = message.match(/^\s*\/debate\s+(.+)$/i);
    const bareDebateMatch = !slashDebateMatch && message.match(/^\s*debate\s+(.+)$/i);
    const debateMatch = slashDebateMatch ?? bareDebateMatch;
    if (debateMatch) {
      const topic = debateMatch[1].trim();
      // Extract first clean ticker from the topic (reuse chat's extractor so
      // stopword handling stays consistent). If the topic is "should I hold
      // my current position", there's no instrument → null, and the debate
      // will use general context.
      const tickers = extractInstruments(topic);
      const instrumentFilter = tickers.length > 0 ? tickers[0] : null;
      const debated = await handleDebateCommand(supabase, topic, instrumentFilter, userId);
      return new Response(JSON.stringify({
        response: debated.response,
        debate_card: debated.debate_card,
        debate_id: debated.debate_id,
        debate: true,
        model: debated.model,
        tokens_in: debated.tokens_in,
        tokens_out: debated.tokens_out,
        cost_usd: debated.cost_usd,
        mcp_calls: 0,
        duration_ms: Date.now() - startedAt,
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Cross-facet gate: only pay for the DCD brain query when the question
    // reads like it's asking for historical depth outside Co-Trader's own
    // corpus ("precedent", "years ago", "regime analogs"...). Heuristic
    // keyword match, no extra LLM call.
    const crossFacetTriggered = shouldQueryDcdBrain(message);

    const [context, recall, crossFacet] = await Promise.all([
      buildContext(supabase),
      recentSemanticHits(supabase, message),
      crossFacetTriggered
        ? queryDcdBrain(supabase, message, { limit: 5 })
        : Promise.resolve({ hits: [] as CrossFacetHit[], reachable: true, reason: 'not_triggered' as string | null, duration_ms: 0 }),
    ]);
    (context as Record<string, unknown>).recent_semantic_hits = recall.hits;
    // Only attach cross_facet_hits to the context when we actually have
    // something — empty arrays invite Claude to comment on their emptiness.
    if (crossFacet.hits.length > 0) {
      (context as Record<string, unknown>).cross_facet_hits = crossFacet.hits;
    }
    const recallDebug = {
      query: message.slice(0, 200),
      semantic_hit_count: recall.hits.length,
      time_floor_applied: recall.timeFloorApplied,
      cross_facet_triggered: crossFacetTriggered,
      cross_facet_reachable: crossFacet.reachable,
      cross_facet_hit_count: crossFacet.hits.length,
      cross_facet_reason: crossFacet.reason,
      cross_facet_ms: crossFacet.duration_ms,
    };

    // Prepend a context block as the first user turn so Claude sees live state
    // before any conversation history. Then real conversation, then new message.
    const contextBlock = `[LIVE STATE — injected by system, not a user message]\n${JSON.stringify(context, null, 2)}\n\n[END LIVE STATE]`;

    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
      { role: 'user', content: contextBlock },
      { role: 'assistant', content: 'Got it. I have the current state loaded. What do you want to talk about?' },
      ...history,
      { role: 'user', content: message },
    ];

    let responseText = '';
    // Surfaced on the response payload so the chat UI can render per-message metadata
    // (model · tokens · cost · mcp calls). Populated after the Claude call returns.
    let tokensIn = 0;
    let tokensOut = 0;
    let costUsd = 0;
    let mcpCalls = 0;
    try {
      const uwKey = Deno.env.get('UW_API_KEY');
      const res = await callClaude({
        model: CLAUDE_MODELS.sonnet,   // better conversational reasoning than Haiku
        system: CT_CHAT_SYSTEM,
        messages,
        max_tokens: 1500,
        temperature: 0.4,
        // Live UW MCP — Claude can query any of UW's endpoints on demand during
        // the turn. Pairs our cached state with full-surface UW access.
        mcp_servers: uwKey ? [{
          type: 'url',
          url: 'https://api.unusualwhales.com/api/mcp',
          name: 'unusual-whales',
          authorization_token: uwKey,
        }] : undefined,
        beta: uwKey ? ['mcp-client-2025-04-04'] : undefined,
      });
      responseText = parseTextContent(res).trim();
      // Log every MCP call Claude made during this turn — user can audit.
      logMcpCalls(supabase, 'chat', res as unknown as { content?: unknown }, { user_id: null }).catch(() => { /* non-blocking */ });

      // Record cost + usage. Chat doesn't use agent_tasks, so write direct
      // to ct_chat_tokens. Fire-and-forget — never blocks the response.
      try {
        const usage = (res as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
        const content = (res as { content?: unknown[] }).content ?? [];
        const mcpCount = Array.isArray(content)
          ? content.filter((b) => (b as { type?: string }).type === 'mcp_tool_use').length
          : 0;
        const inTok = usage?.input_tokens ?? 0;
        const outTok = usage?.output_tokens ?? 0;
        // Sonnet 4: $3/M in, $15/M out.
        const cost = (inTok / 1_000_000) * 3 + (outTok / 1_000_000) * 15;
        // Hoist for the response payload.
        tokensIn = inTok;
        tokensOut = outTok;
        costUsd = Number(cost.toFixed(6));
        mcpCalls = mcpCount;
        supabase.from('ct_chat_tokens').insert({
          user_id: userId,
          model: 'sonnet',
          tokens_in: inTok,
          tokens_out: outTok,
          cost_usd: Number(cost.toFixed(6)),
          duration_ms: Date.now() - startedAt,
          mcp_calls: mcpCount,
          user_message: message.slice(0, 500),
          response_chars: responseText.length,
          cross_facet_hits: crossFacet.hits.length,
        }).then(() => { /* fire-and-forget */ });
        // Dual-write to unified ct_claude_usage so /health shows ct-chat
        // alongside every other ct-* Claude caller. ct_chat_tokens stays as
        // a chat-specific table (has user_message + response_chars); this
        // is the cross-function cost view.
        logClaudeUsage(supabase, {
          source: 'ct-chat',
          model: CLAUDE_MODELS.sonnet,
          usage: usage ?? null,
          duration_ms: Date.now() - startedAt,
          mcp_calls: mcpCount,
          metadata: {
            user_id: userId,
            response_chars: responseText.length,
            // Cross-facet usage so /health and cost audits can see when
            // Co-Trader reached into DCD's brain. Only set when triggered.
            cross_facet: crossFacetTriggered ? {
              reachable: crossFacet.reachable,
              hits: crossFacet.hits.length,
              reason: crossFacet.reason,
              ms: crossFacet.duration_ms,
            } : null,
          },
        });
      } catch (_e) { /* ignore token logging errors */ }
    } catch (e) {
      const detail = e instanceof ClaudeError ? `Claude ${e.status}` : String(e);
      console.error('[ct-chat] Claude failed:', detail);
      return new Response(JSON.stringify({ error: 'Claude call failed', detail }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Cross-facet chip signal: surface a "drew from DCD brain (N)" chip only
    // when (a) we actually injected hits, AND (b) Claude's response shows
    // evidence it used them. Cheap regex — the prompt explicitly coaches
    // "DCD brain" as the cite phrase, so the signal is clean.
    const crossFacetUsed = crossFacet.hits.length > 0 &&
      /\bDCD\s+brain\b|\bDuck\s+Countdown\b|\bcross[-\s]?facet\b|\bhistorical\s+brain\b/i.test(responseText);

    return new Response(JSON.stringify({
      response: responseText || '(empty response)',
      duration_ms: Date.now() - startedAt,
      recall_debug: recallDebug,
      // Chat UI renders these under each assistant bubble.
      model: 'sonnet',
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      cost_usd: costUsd,
      mcp_calls: mcpCalls,
      // Cross-facet: number of DCD hits injected, and whether the response
      // actually used them. The UI only shows the chip when used === true.
      cross_facet_hits: crossFacet.hits.length,
      cross_facet_used: crossFacetUsed,
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[ct-chat] fatal:', error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'chat failed' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
