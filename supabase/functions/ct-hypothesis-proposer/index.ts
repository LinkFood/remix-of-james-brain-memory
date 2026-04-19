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
import { callClaude, CLAUDE_MODELS, parseTextContent, ClaudeError, calculateCost } from '../_shared/anthropic.ts';
import { getConfig } from '../_shared/configCache.ts';
import { buildClaudeContext, claudeSystemPromptPreamble } from '../_shared/claudeReadSurface.ts';
import { recordDecision } from '../_shared/decisionJournal.ts';
import { validateHypothesisClaims } from '../_shared/hallucinationGuard.ts';
import { getTickerQuantCard, TickerQuantCard } from '../_shared/tickerQuantCard.ts';

const VALID_HORIZONS = new Set(['session', 'week', 'month', 'open']);

interface Proposal {
  claim: string;
  because: string[];
  invalidate_if: string;
  horizon: string;
  tickers: string[];
}

const SYSTEM = `You are Claude, the co-trader. You run your own paper account. Your hypotheses
are not commentary — they are the REASONING LAYER that drives trades. Every
hypothesis you propose should translate, given the right market state, into a
concrete trade idea with an entry trigger, stop, target, and size.

PRIMARY DATA SOURCE: The user payload carries \`quant_cards\` — one per watchlist
ticker. Each card contains precise numbers: structure (spot, gamma_flip,
call_wall, put_wall, max_pain, iv_rank, iv_percentile, net_gamma, regime),
flow_last_hour (total_premium, net_call_prem, net_put_prem, whale_count,
sweep_count), dark_pool_last_hour (print_count, total_notional, largest_single,
accumulation_score), greek_flow_last_hour (net_delta_flow, net_vega_flow), and
sentiment (nope_latest, put_call_ratio). These are the ONLY numbers you may
cite in your because-bullets. Narrative context (observations, alerts,
wobbly_grades) is supplementary — it gives you ideas; the quant cards give you
the numbers to back them.

THE CITATION RULE — NON-NEGOTIABLE:
Every "because" bullet that references a specific numeric value MUST cite
where that value came from, using the format:
  "<claim fragment with number> (<TICKER>.<card_path>)"

GOOD examples:
  ✓ "SPY iv_rank=19 (SPY.structure.iv_rank), call_wall=710 within 0.3% of
     spot=710.42 (SPY.structure.spot)"
  ✓ "IWM gamma_flip at 217.50 (IWM.structure.gamma_flip), regime=positive_gamma
     (IWM.structure.regime) — pinning pressure dominant"
  ✓ "NVDA flow last hour net_call_prem=$12.4M (NVDA.flow_last_hour.net_call_prem)
     with 3 whales (NVDA.flow_last_hour.whale_count)"

BAD examples (THESE ARE RULE VIOLATIONS):
  ✗ "dark pool accumulated $1.72B in last 10min" — no card path; number is
     synthesized
  ✗ "IWM gamma flip at 14" — card says 217.50; this is a hallucination
  ✗ "Per UW: SPY sweeps elevated" — no card path; vague

If the cards don't contain data to support a bullet, DO NOT WRITE THAT BULLET.
Pick a different angle that the cards DO support. Better to propose fewer
hypotheses than to fabricate numbers.

Each proposal must have:
  - claim:         one assertive, TRADEABLE sentence — what's true right now AND
                   what trade setup it implies. Bad: "0DTE pins dominate in the
                   final hour." Good: "SPY pins to max-pain 710 (SPY.structure
                   .max_pain) into 3:55 PM when call_wall 710 (SPY.structure
                   .call_wall) aligns — short into close, stop 0.2% above,
                   target max-pain."
  - because:       3-5 bullets, EACH citing a specific value from quant_cards
                   using the format above. Narrative references (active_brief,
                   active_principles, active_biases, recent observations) are
                   allowed but they don't substitute for quant-card citations.
  - invalidate_if: a CONCRETE trigger (price level, flow pattern, macro print)
                   that would clearly refute the claim and kill any live trade.
                   Cite card paths where relevant (e.g., "if SPY breaks
                   put_wall=705 (SPY.structure.put_wall)").
  - horizon:       one of session | week | month | open
  - tickers:       array of tickers the claim touches (uppercase, [] if macro)

Rules:
  - Prefer hypotheses that translate to specific trigger conditions
    (price cross, time gate, flow threshold, regime flip). Avoid pure-
    observational claims ("X dominates Y") that don't imply a trade.
  - Do NOT duplicate an existing open hypothesis. Two claims are duplicates if
    they're about the same tickers with the same direction over overlapping
    horizons, regardless of wording.
  - Prefer claims that YESTERDAY'S GRADES say Claude was wrong or wobbly on —
    those are the gaps worth owning.
  - No hedges ("might", "could") in the claim. Pick a side.
  - invalidate_if must be measurable — not "if the narrative changes."
  - If you have nothing tradeable, return { "proposals": [] }. Better to pass
    than to force a weak hypothesis that generates weak trades.
  - Zero numeric citations across all bullets = weak proposal. Hallucinated
    numbers (values the cards don't support) = auto-rejected downstream.

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

  const maxPerDay = Number(await getConfig<number>('hypothesis_proposer_max_per_day', 3));
  const lookbackHours = Number(await getConfig<number>('hypothesis_proposer_lookback_hours', 36));

  // ISOLATION: Claude read surface (open hyps, own trades/grades, config).
  // Observations/alerts/wobbly-grades still come from the tape puller below —
  // those are Claude-authored watcher output, not James-owned data.
  const claudeCtx = await buildClaudeContext(supabase, {
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

  const userPayload = {
    max_new_hypotheses: maxPerDay,
    quant_cards: quantCards,
    active_brief: claudeCtx.activeBrief,
    active_principles: claudeCtx.activePrinciples,
    active_biases: claudeCtx.activeBiases,
    wobbly_grades: tape.wobbly_grades,
    existing_open_hypotheses: claudeCtx.openHypotheses.map((h) => ({
      id: h.id,
      claim: h.claim,
      tickers: h.tickers,
      horizon: h.horizon,
      created_at: h.created_at,
    })),
    claude_own_open_trades: claudeCtx.claudeOpenTrades.map((t) => ({
      id: t.id,
      instrument: t.instrument,
      side: t.side,
      hypothesis_id: t.hypothesis_id,
      thesis: t.thesis,
    })),
    // Supplementary narrative context — gives Claude ideas, doesn't supply
    // numbers. Per SYSTEM rules: any numeric citation must be from quant_cards.
    supplementary_narrative: {
      observations: tape.observations,
      alerts: tape.alerts,
    },
    blocked_from_reading: claudeCtx.blockedFromReading,
  };

  const systemPrompt = `${claudeSystemPromptPreamble(claudeCtx)}\n\n${SYSTEM}`;

  let proposals: Proposal[] = [];
  let tokensIn = 0;
  let tokensOut = 0;
  let costUsd = 0;
  try {
    const res = await callClaude({
      model: CLAUDE_MODELS.sonnet_46,
      system: systemPrompt,
      messages: [{ role: 'user', content: JSON.stringify(userPayload) }],
      max_tokens: 2000,
      temperature: 0.4,
    });
    tokensIn = res.usage?.input_tokens ?? 0;
    tokensOut = res.usage?.output_tokens ?? 0;
    costUsd = calculateCost(CLAUDE_MODELS.sonnet_46, res.usage ?? { input_tokens: 0, output_tokens: 0 });
    const raw = parseTextContent(res).trim();
    const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed = JSON.parse(stripped) as { proposals?: unknown };
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
