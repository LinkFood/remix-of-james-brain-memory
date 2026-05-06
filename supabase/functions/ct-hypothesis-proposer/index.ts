/**
 * ct-hypothesis-proposer — propose up to N new hypotheses from recent tape.
 *
 * Runs weekdays at 11:00 UTC (07:00 ET, pre-bell). Process:
 *   1. Pull the last `hypothesis_proposer_lookback_hours` of ct_observations,
 *      ct_alerts, and ct_grades (especially yesterday's non-confirmed grades).
 *   2. Pull currently open hypotheses so Claude doesn't re-propose.
 *   3. Ask Claude Sonnet 4.6 (PM-tier — daily judgment call) for up to
 *      `hypothesis_proposer_max_per_day` NEW hypotheses that don't duplicate
 *      existing ones.
 *   4. Insert each into ct_hypotheses (status='open', created_by='claude',
 *      confidence=0.50, elo=1500).
 *   5. Log a ct_hypothesis_events row (event_type='created') for each.
 *   6. Write one ct_claude_decisions row per proposal (and one for zero-
 *      proposal passes) for the Decision Journal.
 *
 * Claude returns strict JSON:
 *   {
 *     proposals: [
 *       { claim, because[3-5], invalidate_if, horizon, tickers[] }
 *     ]
 *   }
 *
 * If Claude returns 0 proposals, that's success — not everything deserves a
 * running hypothesis. We log and exit.
 *
 * Auth: service role only. Called by pg_cron.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { callClaude, CLAUDE_MODELS, parseToolUse, ClaudeError, calculateCost } from '../_shared/anthropic.ts';
import { logClaudeUsage } from '../_shared/claudeUsageLog.ts';
import { getConfig } from '../_shared/configCache.ts';
import { buildClaudeContext, claudeSystemPromptPreamble } from '../_shared/claudeReadSurface.ts';
import { recordDecision } from '../_shared/decisionJournal.ts';
import { validateHypothesisClaims } from '../_shared/hallucinationGuard.ts';
import { getTickerQuantCard, TickerQuantCard } from '../_shared/tickerQuantCard.ts';
import { getTemporalContext, tagIsoTimestamp } from '../_shared/temporalContext.ts';
import { validateTemporalCoherence } from '../_shared/temporalValidator.ts';

const VALID_HORIZONS = new Set(['session', 'week', 'month', 'open']);

interface Proposal {
  claim: string;
  because: string[];
  invalidate_if: string;
  horizon: string;
  tickers: string[];
}

const SYSTEM = `Your hypotheses are the REASONING LAYER that drives your trades. Every one
must translate, in the right market state, into a concrete trade idea with an
entry trigger, stop, target, and size. No commentary. No observations that
don't imply action.

====================================================================
THE SIGNAL MENU — you have ungated access to ALL of these. Equal weight.
Every category stands on its own. Pick the combination that forms the sharpest
setup; do not default to one family.

Per-ticker quant_cards carry six sections, each cite-able by dotted path:

  <TICKER>.structural           spot, gamma_flip, call_wall, put_wall,
                                max_pain, iv_rank, iv_percentile,
                                net_gamma, regime
  <TICKER>.flow_last_hour       net_call_prem, net_put_prem, whales[],
                                sweep_count, dp_accumulation,
                                greek_flow_delta, greek_flow_vega
  <TICKER>.positioning          insider_trades_last_30d[],
                                political_trades_last_30d[],
                                analyst_actions_last_7d[],
                                institutional_changes_last_90d[],
                                short_interest
  <TICKER>.macro                vix_latest, yield_curve_snapshot,
                                central_bank_state, correlations,
                                sector_tide_today[], breaking_news_last_24h[]
  <TICKER>.sentiment            nope_latest, put_call_ratio,
                                net_premium_cum_today,
                                prediction_market_overlay, recent_news[]
  <TICKER>.historical           seasonality, earnings_history,
                                next_earnings, recent_indicator_events

Top-level card header also carries <TICKER>.generation_id and
<TICKER>.generation_days_remaining — the stakes you're trading under.

====================================================================
NON-MICROSTRUCTURE REQUIREMENT — at least ONE proposal per run

If you propose more than one hypothesis in this run, at least one must be
LED BY non-microstructure evidence: positioning (insider / political /
analyst / institutional / short), macro (yield curve / central bank /
correlations / sector tide / breaking news), or sentiment (prediction
markets / news-driven). Microstructure (flow, walls, gamma, NOPE) can
support it, but the lead evidence must come from another family.

If those sections are empty for every ticker (Wave N.2 tables not
populated yet), say so in a single \`because\` bullet on your final proposal
and continue with the data you have. Don't invent positioning or macro
data to satisfy the rule.

GOOD positioning-led example:
  claim:       "Insider cluster at NVDA (3 buys, $12M total last 5d,
                NVDA.positioning.insider_trades_last_30d) + 2 congressional
                buys last month (NVDA.positioning.political_trades_last_30d)
                + 3 analyst target raises last 7d
                (NVDA.positioning.analyst_actions_last_7d) — long NVDA on
                first 5-min close above 200 with call_wall
                (NVDA.structural.call_wall) holding, stop 195, target 208.
                Horizon: week."

GOOD macro-led example:
  claim:       "Yield curve steepened 12bps this week
                (GLD.macro.yield_curve_snapshot) + central-bank pause signal
                (GLD.macro.central_bank_state) + gold breaking out — long
                GLD on pullback to 2460, stop 2445, target 2485.
                Horizon: week."

====================================================================
THE ACTIONABILITY RULE (tenet 16) — NON-NEGOTIABLE

Every \`because\` bullet must state HOW the evidence changes the setup, not
just that the evidence exists. Thread evidence → implication.

  ✗ BAD:  "NVDA has earnings in 4 days."   (factual but non-actionable)
  ✓ GOOD: "NVDA earnings in 4 days (NVDA.historical.next_earnings.date) AND
          25d skew flipped put-heavy (-0.12 vs 30d avg +0.05,
          NVDA.structural... inferred from recent_news context) AND insider
          selling 3 days straight (NVDA.positioning.insider_trades_last_30d)
          — setup favors bearish pre-earnings positioning; call_wall 250
          (NVDA.structural.call_wall) becomes resistance instead of magnet."

If the evidence doesn't change the trade setup, it does not belong in the
bullet.

====================================================================
THE CITATION RULE — NON-NEGOTIABLE

Every \`because\` bullet that references a specific numeric value MUST cite
where that value came from, using the dotted path:
  "<claim fragment with number> (<TICKER>.<card_path>)"

If the cards don't contain data to support a bullet, DO NOT WRITE THAT
BULLET. Pick a different angle. Better to propose fewer hypotheses than to
fabricate numbers — hallucinated values are auto-rejected downstream.

====================================================================
DIVERSITY HINT

If your last 10 active hypotheses (in \`existing_open_hypotheses\`) all rely
on the same category of signal (e.g. mostly flow/gamma plays), prefer a
different category this run. The point of ungated access is to multiplex.

====================================================================
GENERATIONAL HINT (tenet 14)

If Generation N-1 (in \`past_generations[0]\`) was fired for
survival_breach, bias toward lower-size setups this run. If it was fired
for performance_floor, bias toward higher-conviction / larger-size. If it
succeeded, preserve what worked and expand cautiously.

====================================================================
PROPOSAL SHAPE

Each proposal must have:
  - claim:         one assertive, TRADEABLE sentence — what's true right now
                   AND what trade setup it implies. Entry, stop, target,
                   horizon should be statable from the claim + bullets.
  - because:       3-5 bullets. EACH bullet must satisfy BOTH:
                     (a) cite a specific value via <TICKER>.<path>
                     (b) state HOW that evidence shifts the setup
                   Narrative references (active_brief, active_principles,
                   active_biases, wobbly_grades) are allowed but they don't
                   substitute for card-cited evidence.
  - invalidate_if: a CONCRETE trigger (price level, flow pattern, macro
                   print, positioning flip) that would clearly refute the
                   claim and kill any live trade. Cite card paths where
                   relevant.
  - horizon:       one of session | week | month | open
  - tickers:       array of tickers the claim touches (uppercase, [] if
                   purely macro)

Other rules:
  - Do NOT duplicate an existing open hypothesis. Two claims are duplicates
    if they're about the same tickers with the same direction over
    overlapping horizons, regardless of wording.
  - Prefer claims that YESTERDAY'S GRADES say Claude was wrong or wobbly on
    — those are the gaps worth owning.
  - No hedges ("might", "could") in the claim. Pick a side.
  - invalidate_if must be measurable — not "if the narrative changes."
  - If you have nothing tradeable, return { "proposals": [] }. Passing is
    better than forcing a weak hypothesis.

Return strictly:
  { "proposals": [ { "claim": "...", "because": ["...", "..."], "invalidate_if": "...", "horizon": "session|week|month|open", "tickers": ["SPY"] }, ... ] }
No prose, no markdown fences, just JSON.`;

function validateProposal(p: unknown): p is Proposal {
  if (!p || typeof p !== 'object') return false;
  const obj = p as Record<string, unknown>;
  if (typeof obj.claim !== 'string' || obj.claim.trim().length < 10) return false;
  if (!Array.isArray(obj.because) || obj.because.length < 3 || obj.because.length > 8) return false;
  if (!obj.because.every((b) => typeof b === 'string' && b.trim().length > 0)) return false;
  if (typeof obj.invalidate_if !== 'string' || obj.invalidate_if.trim().length < 5) return false;
  if (typeof obj.horizon !== 'string' || !VALID_HORIZONS.has(obj.horizon)) return false;
  if (!Array.isArray(obj.tickers)) return false;
  if (!obj.tickers.every((t) => typeof t === 'string')) return false;
  return true;
}

async function pullRecentTape(supabase: SupabaseClient, lookbackHours: number) {
  const since = new Date(Date.now() - lookbackHours * 3_600_000).toISOString();
  const yesterdayStart = new Date(Date.now() - 36 * 3_600_000).toISOString();

  const [obs, alerts, grades] = await Promise.all([
    supabase
      .from('ct_observations')
      .select('id, instruments, observation, glance, direction, up_case, down_case, watching, created_at')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(40),
    supabase
      .from('ct_alerts')
      .select('id, instruments, direction, horizon, up_case, down_case, glance, created_at')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(40),
    supabase
      .from('ct_grades')
      .select('id, subject_type, instrument, claimed_direction, actual_direction, actual_return_pct, verdict, notes, graded_at')
      .gte('graded_at', yesterdayStart)
      .neq('verdict', 'right')
      .order('graded_at', { ascending: false })
      .limit(30),
  ]);

  return {
    observations: (obs.data ?? []).map((r) => ({
      id: r.id,
      instruments: r.instruments,
      direction: r.direction,
      glance: r.glance,
      observation: typeof r.observation === 'string' ? r.observation.slice(0, 800) : null,
      up_case: typeof r.up_case === 'string' ? r.up_case.slice(0, 400) : null,
      down_case: typeof r.down_case === 'string' ? r.down_case.slice(0, 400) : null,
      watching: r.watching,
      created_at: r.created_at,
    })),
    alerts: (alerts.data ?? []).map((r) => ({
      id: r.id,
      instruments: r.instruments,
      direction: r.direction,
      horizon: r.horizon,
      up_case: typeof r.up_case === 'string' ? r.up_case.slice(0, 400) : null,
      down_case: typeof r.down_case === 'string' ? r.down_case.slice(0, 400) : null,
      glance: r.glance,
      created_at: r.created_at,
    })),
    wobbly_grades: (grades.data ?? []),
  };
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

  // Temporal anchor — every Claude-narrative consumer must prepend the
  // preamble + pre-tag every date field. The 2026-04-30 morning-brief
  // hallucination ("today is April 29") originated from a hypothesis claim
  // that baked "today (Apr 29)" into prose. Anchoring the proposer's input
  // and validating its output is the structural fix for this class.
  const tctx = getTemporalContext();

  // Tenet 4 — respect the circuit breaker at every writer, not just trade
  // execution. Yesterday's Slack timeline showed the hallucination detector
  // firing 8+ times while this proposer kept generating conv-flipping
  // hypotheses on the same tickers. Self-awareness without self-correction
  // is not self-correction. If ct_claude_circuit_breakers has tripped
  // (hallucination_rate, session_loss, concurrent_cascade, manual_halt) we
  // log the skip to the decision journal and exit. Breaker clears itself
  // at next session; config-tunable trip thresholds live in ct_config.
  try {
    const { data: haltRows } = await supabase.rpc('is_claude_trading_halted');
    const halt = Array.isArray(haltRows) ? haltRows[0] : haltRows;
    if (halt?.halted) {
      await recordDecision(supabase, {
        decision_type: 'no_trade',
        model_tier: 'sonnet',
        reasoning: `Proposer halted by circuit breaker (${halt.breaker_type ?? 'unknown'}): ${halt.reason ?? 'no reason'}. No new hypotheses proposed this run.`,
        outcome: `breaker_halted_${halt.breaker_type ?? 'unknown'}`,
        context_snapshot: {
          breaker_type: halt.breaker_type ?? null,
          reason: halt.reason ?? null,
          tripped_at: halt.tripped_at ?? null,
          duration_ms: Date.now() - startedAt,
        },
        tool_calls_summary: { called: 'is_claude_trading_halted' },
      });
      return new Response(JSON.stringify({
        ok: true,
        skipped: true,
        reason: 'circuit_breaker',
        breaker_type: halt.breaker_type ?? null,
        breaker_reason: halt.reason ?? null,
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  } catch (e) {
    // Breaker RPC failure shouldn't block proposer — fail open, log only.
    console.warn(`[ct-hypothesis-proposer] circuit breaker check failed (fail-open): ${e instanceof Error ? e.message : String(e)}`);
  }

  const maxPerDay = Number(await getConfig<number>('hypothesis_proposer_max_per_day', 3));
  const lookbackHours = Number(await getConfig<number>('hypothesis_proposer_lookback_hours', 36));

  // ISOLATION: Claude read surface (open hyps, own trades/grades, config).
  // Observations/alerts/wobbly-grades still come from the tape puller below —
  // those are Claude-authored watcher output, not James-owned data.
  const claudeCtx = await buildClaudeContext(supabase, {
    audience: 'paper_claude',
    consumerName: 'ct-hypothesis-proposer',
    openHypothesisLimit: 30,
    gradeLimit: 20,
  });

  const tape = await pullRecentTape(supabase, lookbackHours);

  // PRIMARY CONTEXT: Per-ticker quant cards, loaded in parallel. These are
  // the numbers Claude must cite. The old narrative-only context let Sonnet
  // invent values that sounded plausible but weren't in the data (5/6
  // proposals in first live run hit the hallucination guard). Structural
  // fix: give precise numbers, require citation, reject fabrications.
  const watchlist = claudeCtx.watchlist;
  const quantCardResults = await Promise.all(
    watchlist.map((t) => getTickerQuantCard(supabase, t)),
  );
  const quantCards: TickerQuantCard[] = quantCardResults.filter(
    (c): c is TickerQuantCard => c !== null,
  );

  // Pre-tag every date-bearing field with its relative-day tag so Claude
  // sees "**YESTERDAY 16:14 ET**" instead of a raw ISO. Without this Sonnet
  // pattern-completes on prior-day timestamps as if they were today's reality.
  const taggedObservations = tape.observations.map((o) => ({
    ...o,
    created_at_tag: tagIsoTimestamp(o.created_at, tctx.session_date),
  }));
  const taggedAlerts = tape.alerts.map((a) => ({
    ...a,
    created_at_tag: tagIsoTimestamp(a.created_at, tctx.session_date),
  }));
  const taggedWobblyGrades = tape.wobbly_grades.map((g) => ({
    ...g,
    graded_at_tag: tagIsoTimestamp(
      typeof (g as { graded_at?: unknown }).graded_at === 'string'
        ? (g as { graded_at: string }).graded_at
        : null,
      tctx.session_date,
    ),
  }));
  const taggedExistingHypotheses = claudeCtx.openHypotheses.map((h) => ({
    id: h.id,
    claim: h.claim,
    tickers: h.tickers,
    horizon: h.horizon,
    created_at: h.created_at,
    created_at_tag: tagIsoTimestamp(h.created_at, tctx.session_date),
  }));

  const userPayload = {
    session_date: tctx.session_date,
    session_day_name: tctx.session_day_name,
    now_et: tctx.now_et,
    max_new_hypotheses: maxPerDay,
    // Wave N: generational stakes — Claude must see what generation he is in,
    // how many days remain, and what happened to the generations before him.
    current_generation: claudeCtx.currentGeneration,
    past_generations: claudeCtx.pastGenerations,
    quant_cards: quantCards,
    active_brief: claudeCtx.activeBrief,
    // Wave J: weekly CIO review. Additive — Claude may bias proposals toward
    // focus_tickers and away from avoid_tickers. Null when no review exists.
    latest_weekly_review: claudeCtx.latestWeeklyReview,
    active_principles: claudeCtx.activePrinciples,
    active_biases: claudeCtx.activeBiases,
    wobbly_grades: taggedWobblyGrades,
    existing_open_hypotheses: taggedExistingHypotheses,
    claude_own_open_trades: claudeCtx.claudeOpenTrades.map((t) => ({
      id: t.id,
      instrument: t.instrument,
      side: t.side,
      hypothesis_id: t.hypothesis_id,
      thesis: t.thesis,
    })),
    // Wave N.2 additive — cross-ticker macro + sentiment + historical rolls.
    // Present even when empty so Claude can see what's available and what
    // isn't, rather than assuming absence means the data doesn't matter.
    macro_context: {
      yield_curve: claudeCtx.yieldCurve,
      central_bank_state: claudeCtx.centralBankState,
      sector_tide_today: claudeCtx.sectorTideToday,
      correlations_latest: claudeCtx.correlationsLatest,
      indicator_events_last_7d: claudeCtx.indicatorEventsLast7d,
    },
    sentiment_context: {
      prediction_markets: claudeCtx.predictionMarkets,
    },
    historical_context: {
      seasonality_current_month: claudeCtx.seasonalityCurrentMonth,
    },
    positioning_context: {
      institutional_changes_last_90d: claudeCtx.institutionalLast90d,
    },
    // Supplementary narrative context — gives Claude ideas, doesn't supply
    // numbers. Per SYSTEM rules: any numeric citation must be from quant_cards.
    supplementary_narrative: {
      observations: taggedObservations,
      alerts: taggedAlerts,
    },
    blocked_from_reading: claudeCtx.blockedFromReading,
  };

  const systemPrompt = `${tctx.temporalAnchorPreamble}\n\n${claudeSystemPromptPreamble(claudeCtx)}\n\n${SYSTEM}`;

  // Forced tool-use: Sonnet's prose-mode JSON is unreliable for long structured
  // output (14 of 25 fires last 7 days errored with `Unexpected token 'L',
  // "Looking at"...`). Tool-use returns parsed input directly, no parse step.
  // See feedback_sonnet_long_json_use_tool_use.md for the canonical pattern.
  const proposalTool = {
    name: 'propose_hypotheses',
    description: 'Return zero or more new trading hypotheses. Empty array is acceptable when nothing meets the bar.',
    input_schema: {
      type: 'object',
      properties: {
        proposals: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              claim: { type: 'string' },
              because: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 5 },
              invalidate_if: { type: 'string' },
              horizon: { type: 'string', enum: ['session', 'week', 'month', 'open'] },
              tickers: { type: 'array', items: { type: 'string' } },
            },
            required: ['claim', 'because', 'invalidate_if', 'horizon', 'tickers'],
          },
        },
      },
      required: ['proposals'],
    },
  };

  let proposals: Proposal[] = [];
  let tokensIn = 0;
  let tokensOut = 0;
  let costUsd = 0;
  const claudeCallStart = Date.now();
  try {
    const res = await callClaude({
      model: CLAUDE_MODELS.sonnet_46,
      system: systemPrompt,
      messages: [{ role: 'user', content: JSON.stringify(userPayload) }],
      max_tokens: 2000,
      temperature: 0.4,
      tools: [proposalTool],
      tool_choice: { type: 'tool', name: 'propose_hypotheses' },
    });
    tokensIn = res.usage?.input_tokens ?? 0;
    tokensOut = res.usage?.output_tokens ?? 0;
    costUsd = calculateCost(CLAUDE_MODELS.sonnet_46, res.usage ?? { input_tokens: 0, output_tokens: 0 });
    logClaudeUsage(supabase, {
      source: 'ct-hypothesis-proposer',
      model: CLAUDE_MODELS.sonnet_46,
      usage: res.usage,
      duration_ms: Date.now() - claudeCallStart,
      mcp_calls: 0,
      metadata: { brief_id: claudeCtx.activeBrief?.id ?? null },
    });
    const tool = parseToolUse(res);
    if (!tool || tool.name !== 'propose_hypotheses') {
      throw new Error(`expected tool_use propose_hypotheses, got ${tool?.name ?? 'none'}`);
    }
    const parsed = tool.input as { proposals?: unknown };
    const candidates = Array.isArray(parsed.proposals) ? parsed.proposals : [];
    proposals = candidates.filter(validateProposal) as Proposal[];
    // Hard cap even if Claude over-delivers.
    if (proposals.length > maxPerDay) proposals = proposals.slice(0, maxPerDay);
  } catch (e) {
    const detail = e instanceof ClaudeError ? `Claude ${e.status}` : String(e);
    await recordDecision(supabase, {
      decision_type: 'propose_hypothesis',
      model_tier: 'sonnet',
      reasoning: `proposer llm call failed: ${detail}`,
      outcome: 'claude_error',
      context_snapshot: {
        brief_id: claudeCtx.activeBrief?.id ?? null,
        lookback_hours: lookbackHours,
        existing_hypothesis_count: claudeCtx.openHypotheses.length,
      },
      linked_brief_id: claudeCtx.activeBrief?.id,
      tool_calls_summary: { called: 'callClaude(sonnet_46, propose_hypotheses)', error: detail },
    });
    return new Response(JSON.stringify({ ok: false, error: `proposer llm: ${detail}` }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const inserted: Array<{ id: string; claim: string; horizon: string; tickers: string[]; hallucination_flag: boolean }> = [];
  const autoRejected: Array<{ claim: string; tickers: string[]; rejected_reason: string; flagged_count: number }> = [];
  let singleFlagCount = 0;
  // Spread token+cost across proposals so each decision row carries a share.
  const perProposalTokensIn = proposals.length > 0 ? Math.round(tokensIn / proposals.length) : tokensIn;
  const perProposalTokensOut = proposals.length > 0 ? Math.round(tokensOut / proposals.length) : tokensOut;
  const perProposalCost = proposals.length > 0 ? costUsd / proposals.length : costUsd;

  for (const p of proposals) {
    const tickers = p.tickers.map((t) => t.toUpperCase().trim()).filter(Boolean);

    // Hallucination check FIRST — before inserting. If 2+ bullets fail
    // source-truth validation, the proposal is auto-rejected and no
    // hypothesis row is created. Single-flag proposals still insert, tagged.
    let hallucinationFlag = false;
    let hallucinationReason: string | undefined;
    let flaggedBullets: Array<{ bullet: string; reason: string; actual?: string }> = [];
    let accepted = true;
    let rejectedReason: string | undefined;
    try {
      const check = await validateHypothesisClaims(supabase, p.because);
      flaggedBullets = check.flagged;
      accepted = check.accepted;
      rejectedReason = check.rejected_reason;
      if (!check.valid) {
        hallucinationFlag = true;
        hallucinationReason = check.flagged
          .map((f) => `"${f.bullet.slice(0, 80)}" → ${f.reason}`)
          .join(' | ')
          .slice(0, 1000);
      }
    } catch (e) {
      console.warn(`[ct-hypothesis-proposer] hallucination guard threw: ${e instanceof Error ? e.message : String(e)}`);
    }

    // AUTO-REJECT path — 2+ hallucinated bullets. Log to decision journal
    // with source-truth data, skip insert, move on.
    if (!accepted) {
      autoRejected.push({
        claim: p.claim,
        tickers,
        rejected_reason: rejectedReason ?? 'multi_hallucination',
        flagged_count: flaggedBullets.length,
      });
      await recordDecision(supabase, {
        decision_type: 'hallucination_flagged',
        model_tier: 'sonnet',
        reasoning: `Proposal auto-rejected: ${flaggedBullets.length} bullets failed source-truth validation. Claim: ${p.claim.slice(0, 400)}. Flagged bullets + actuals: ${flaggedBullets.map((f) => `["${f.bullet.slice(0, 120)}" → reason: ${f.reason}; source_truth: ${f.actual ?? 'n/a'}]`).join(' | ').slice(0, 3000)}`,
        outcome: 'rejected_multi_hallucination',
        context_snapshot: {
          brief_id: claudeCtx.activeBrief?.id ?? null,
          claim: p.claim,
          because: p.because,
          invalidate_if: p.invalidate_if,
          tickers,
          horizon: p.horizon,
          flagged_count: flaggedBullets.length,
          flagged_bullets: flaggedBullets,
          quant_cards_provided: quantCards.length,
        },
        tool_calls_summary: { called: 'validateHypothesisClaims', flagged: flaggedBullets.length },
        linked_brief_id: claudeCtx.activeBrief?.id,
        hallucination_flag: true,
        hallucination_reason: hallucinationReason,
        tokens_in: perProposalTokensIn,
        tokens_out: perProposalTokensOut,
        cost_usd: perProposalCost,
      });
      continue;
    }

    if (hallucinationFlag) singleFlagCount += 1;

    // Temporal-coherence validation. Best-effort, never blocks insert. The
    // 2026-04-30 morning-brief bug rooted in a hypothesis claim that baked
    // "today (Apr 29)" into prose. Haiku reads the proposed claim + bullets
    // against the session date and flags any contradictions. Critical hits
    // are surfaced into console.warn + decision_journal context_snapshot;
    // the proposal itself still inserts because the lifecycle (health-check,
    // grader) has its own verdict path.
    let temporalContradictions: Array<{ quote: string; issue: string; severity: 'critical' | 'warning' }> = [];
    let temporalOk = true;
    try {
      const claimText = `${p.claim}\n\n${p.because.map((b) => `- ${b}`).join('\n')}\n\nInvalidate if: ${p.invalidate_if}`;
      const tval = await validateTemporalCoherence(claimText, tctx.session_date, {
        tickerContext: tickers.join(', ') || undefined,
      });
      temporalOk = tval.ok;
      temporalContradictions = tval.contradictions;
      const critical = temporalContradictions.filter((c) => c.severity === 'critical');
      if (critical.length > 0) {
        console.warn(
          `[ct-hypothesis-proposer] temporal_critical claim="${p.claim.slice(0, 120)}" contradictions=${JSON.stringify(critical).slice(0, 600)}`,
        );
      }
    } catch (e) {
      console.warn(`[ct-hypothesis-proposer] temporal validator threw (non-blocking): ${e instanceof Error ? e.message : String(e)}`);
    }

    const { data, error } = await supabase
      .from('ct_hypotheses')
      .insert({
        claim: p.claim.trim(),
        because: p.because.map((b) => b.trim()),
        invalidate_if: p.invalidate_if.trim(),
        horizon: p.horizon,
        status: 'open',
        confidence: 0.50,
        elo: 1500,
        created_by: 'claude',
        tickers,
        // Wave N: stamp with current generation so we can slice proposals
        // per-lineage without back-filling.
        generation_id: claudeCtx.currentGeneration?.id ?? null,
      })
      .select('id')
      .single();
    if (error || !data) {
      console.warn(`[ct-hypothesis-proposer] insert failed: ${error?.message ?? 'no data'}`);
      await recordDecision(supabase, {
        decision_type: 'propose_hypothesis',
        model_tier: 'sonnet',
        reasoning: `proposal insert failed: ${error?.message ?? 'no data'}. Claim: ${p.claim.slice(0, 200)}`,
        outcome: 'insert_failed',
        context_snapshot: { claim: p.claim, tickers, horizon: p.horizon },
      });
      continue;
    }

    inserted.push({ id: data.id, claim: p.claim, horizon: p.horizon, tickers, hallucination_flag: hallucinationFlag });
    await supabase.from('ct_hypothesis_events').insert({
      hypothesis_id: data.id,
      event_type: 'created',
      reason: `proposer: ${p.claim.slice(0, 200)}`,
      created_by: 'cron',
    });

    // Decision journal — one row per proposed hypothesis.
    await recordDecision(supabase, {
      decision_type: 'propose_hypothesis',
      model_tier: 'sonnet',
      reasoning: `Proposed hypothesis: ${p.claim}. Because: ${p.because.join('; ').slice(0, 1500)}. Invalidate if: ${p.invalidate_if}`,
      outcome: hallucinationFlag ? 'armed_with_hallucination_flag' : 'armed',
      context_snapshot: {
        brief_id: claudeCtx.activeBrief?.id ?? null,
        lookback_hours: lookbackHours,
        existing_hypothesis_count: claudeCtx.openHypotheses.length,
        horizon: p.horizon,
        tickers,
        quant_cards_provided: quantCards.length,
        tape_sample_sizes: {
          observations: tape.observations.length,
          alerts: tape.alerts.length,
          wobbly_grades: tape.wobbly_grades.length,
        },
        // Temporal coherence — Haiku-validated against session_date. Empty
        // contradictions array on a coherent proposal. Persisted to the
        // decision journal because ct_hypotheses has no metadata column.
        temporal_validation: {
          session_date: tctx.session_date,
          ok: temporalOk,
          contradictions: temporalContradictions,
        },
      },
      narrative_signal: {
        reasoning: p.because.join(' | ').slice(0, 2000),
        sources: ['quant_cards', 'ct_observations', 'ct_alerts', 'ct_grades'],
      },
      tool_calls_summary: { called: 'callClaude(sonnet_46, propose_hypotheses)', proposals_returned: proposals.length },
      linked_hypothesis_id: data.id,
      linked_brief_id: claudeCtx.activeBrief?.id,
      hallucination_flag: hallucinationFlag,
      hallucination_reason: hallucinationReason,
      tokens_in: perProposalTokensIn,
      tokens_out: perProposalTokensOut,
      cost_usd: perProposalCost,
    });
  }

  // If Claude proposed nothing, still journal the pass. Use decision_type=
  // 'propose_hypothesis' (not 'no_trade') so every proposer run tells the
  // same story in the journal, and outcome encodes the zero count.
  if (proposals.length === 0) {
    await recordDecision(supabase, {
      decision_type: 'propose_hypothesis',
      model_tier: 'sonnet',
      reasoning: 'Proposer returned zero proposals — nothing tradeable in the tape window.',
      outcome: '0 proposals — no high-conviction setups in the tape',
      context_snapshot: {
        brief_id: claudeCtx.activeBrief?.id ?? null,
        lookback_hours: lookbackHours,
        existing_hypothesis_count: claudeCtx.openHypotheses.length,
        quant_cards_provided: quantCards.length,
        tape_sample_sizes: {
          observations: tape.observations.length,
          alerts: tape.alerts.length,
          wobbly_grades: tape.wobbly_grades.length,
        },
      },
      linked_brief_id: claudeCtx.activeBrief?.id,
      tool_calls_summary: { called: 'callClaude(sonnet_46, propose_hypotheses)', proposals_returned: 0 },
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      cost_usd: costUsd,
    });
  }

  // End-of-run summary — one row per proposer invocation. Lets us track
  // hallucination rate over time and detect regression/drift.
  const proposalsTotal = proposals.length;
  const proposalsAccepted = inserted.length;
  const proposalsRejected = autoRejected.length;
  await recordDecision(supabase, {
    decision_type: 'propose_hypothesis',
    model_tier: 'sonnet',
    reasoning: `Proposer run summary: total=${proposalsTotal}, accepted=${proposalsAccepted}, rejected_multi_hallucination=${proposalsRejected}, single_flag=${singleFlagCount}. Quant cards provided: ${quantCards.length}/${watchlist.length}.`,
    outcome: `run_summary_${proposalsTotal}_${proposalsAccepted}_${proposalsRejected}`,
    context_snapshot: {
      brief_id: claudeCtx.activeBrief?.id ?? null,
      proposals_total: proposalsTotal,
      proposals_accepted: proposalsAccepted,
      proposals_rejected_for_multi_hallucination: proposalsRejected,
      single_flag_count: singleFlagCount,
      quant_cards_provided: quantCards.length,
      watchlist_size: watchlist.length,
      auto_rejected_samples: autoRejected.slice(0, 5),
      duration_ms: Date.now() - startedAt,
    },
    linked_brief_id: claudeCtx.activeBrief?.id,
    tool_calls_summary: { kind: 'run_summary' },
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    cost_usd: costUsd,
  });

  const body = {
    ok: true,
    proposed: inserted.length,
    proposals_total: proposalsTotal,
    proposals_accepted: proposalsAccepted,
    proposals_rejected_for_multi_hallucination: proposalsRejected,
    single_flag_count: singleFlagCount,
    capped_at: maxPerDay,
    lookback_hours: lookbackHours,
    existing_open_count: claudeCtx.openHypotheses.length,
    quant_cards_provided: quantCards.length,
    watchlist_size: watchlist.length,
    tape_sample: {
      observations: tape.observations.length,
      alerts: tape.alerts.length,
      wobbly_grades: tape.wobbly_grades.length,
    },
    inserted,
    auto_rejected: autoRejected,
    duration_ms: Date.now() - startedAt,
  };
  console.log('[ct-hypothesis-proposer]', JSON.stringify(body));
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
