/**
 * ct-reflect-to-jac — One-way bridge from Co-Trader's decision journal into
 * JAC's reflection pipeline.
 *
 * Gap it closes: ct_claude_decisions and jac_reflections never meet. JAC's
 * weekly distill-principles reads jac_reflections only, so whatever Claude-
 * the-trader is learning stays silo'd in Co-Trader. This function promotes
 * the most interesting Co-Trader decisions from the last 24h into one
 * jac_reflections row per user (James).
 *
 * Isolation (Tenet 6): this is OUT-only. Co-Trader functions do NOT read
 * jac_reflections. The bridge writes to JAC so JAC's wisdom layer can see
 * what Claude-the-trader did; it does not feed JAC principles back to
 * Claude-the-trader. Claude only reads ct_principles.
 *
 * Schedule: daily 22:30 UTC — after EOD recap, before dream.
 * Auth: service role only.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { callClaude, CLAUDE_MODELS, parseTextContent } from '../_shared/anthropic.ts';
import { recordDecision } from '../_shared/decisionJournal.ts';

const HIGH_SIGNAL_DECISION_TYPES = [
  'fill_trade',
  'close_trade',
  'circuit_breaker_tripped',
  'hallucination_flagged',
  'brief_rebriefed',
];

interface DecisionRow {
  id: string;
  decision_type: string;
  model_tier: string;
  reasoning: string;
  outcome: string | null;
  alignment: string | null;
  claude_followed: string | null;
  hallucination_flag: boolean;
  hallucination_reason: string | null;
  created_at: string;
}

async function loadNotableDecisions(
  supabase: SupabaseClient,
  sinceIso: string,
): Promise<DecisionRow[]> {
  // Three independent filters OR'd together. PostgREST .or() with mixed
  // operators works inside a single argument string.
  //
  //   1) decision_type IN (high signal set)
  //   2) hallucination_flag = true
  //   3) alignment = 'conflict' AND claude_followed IS NOT NULL
  //
  // We dedupe by id after fetching each.
  const [byType, byHallu, byConflict] = await Promise.all([
    supabase
      .from('ct_claude_decisions')
      .select('id,decision_type,model_tier,reasoning,outcome,alignment,claude_followed,hallucination_flag,hallucination_reason,created_at')
      .gte('created_at', sinceIso)
      .in('decision_type', HIGH_SIGNAL_DECISION_TYPES)
      .order('created_at', { ascending: false })
      .limit(150),
    supabase
      .from('ct_claude_decisions')
      .select('id,decision_type,model_tier,reasoning,outcome,alignment,claude_followed,hallucination_flag,hallucination_reason,created_at')
      .gte('created_at', sinceIso)
      .eq('hallucination_flag', true)
      .order('created_at', { ascending: false })
      .limit(50),
    supabase
      .from('ct_claude_decisions')
      .select('id,decision_type,model_tier,reasoning,outcome,alignment,claude_followed,hallucination_flag,hallucination_reason,created_at')
      .gte('created_at', sinceIso)
      .eq('alignment', 'conflict')
      .not('claude_followed', 'is', null)
      .order('created_at', { ascending: false })
      .limit(50),
  ]);

  const seen = new Set<string>();
  const merged: DecisionRow[] = [];
  for (const bucket of [byType.data ?? [], byHallu.data ?? [], byConflict.data ?? []]) {
    for (const row of bucket) {
      const d = row as DecisionRow;
      if (!seen.has(d.id)) {
        seen.add(d.id);
        merged.push(d);
      }
    }
  }
  // Newest first, capped at 80 rows — keeps the Haiku payload bounded.
  merged.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return merged.slice(0, 80);
}

interface DecisionCounts {
  total: number;
  by_type: Record<string, number>;
  hallucinations: number;
  conflicts_followed_narrative: number;
  conflicts_followed_tape: number;
}

function summarizeDecisions(rows: DecisionRow[]): DecisionCounts {
  const byType: Record<string, number> = {};
  let hallucinations = 0;
  let conflictsFollowedNarrative = 0;
  let conflictsFollowedTape = 0;
  for (const r of rows) {
    byType[r.decision_type] = (byType[r.decision_type] ?? 0) + 1;
    if (r.hallucination_flag) hallucinations += 1;
    if (r.alignment === 'conflict') {
      if (r.claude_followed === 'narrative') conflictsFollowedNarrative += 1;
      else if (r.claude_followed === 'tape') conflictsFollowedTape += 1;
    }
  }
  return {
    total: rows.length,
    by_type: byType,
    hallucinations,
    conflicts_followed_narrative: conflictsFollowedNarrative,
    conflicts_followed_tape: conflictsFollowedTape,
  };
}

const SYSTEM = `You are JAC's reflection engine. You have just received a
24-hour snapshot of the Co-Trader agent's decision journal — fills, closes,
circuit breakers, hallucination catches, narrative-vs-tape conflicts.

Your job is ONE meta-reflection, 2-3 sentences, in JAC's voice, focused on
LEARNING — not scoreboard. Name the pattern, not the number. What did
Co-Trader's behavior reveal about its current decision-making? Where did
narrative lose to tape (or vice versa)? What class of mistake recurred?
Pattern over P&L. Cross-cutting insight over per-trade recap.

Write in first person, as JAC reflecting on a facet of itself.`;

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

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, serviceKey);
  const startedAt = Date.now();

  const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const decisions = await loadNotableDecisions(supabase, sinceIso);

  if (decisions.length === 0) {
    const body = {
      ok: true,
      reflected: 0,
      note: 'no notable Co-Trader decisions in the last 24h',
      duration_ms: Date.now() - startedAt,
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const counts = summarizeDecisions(decisions);

  // Compact payload for Haiku — reasoning is truncated to keep tokens sane.
  const compact = decisions.slice(0, 40).map((d) => ({
    type: d.decision_type,
    tier: d.model_tier,
    at: d.created_at,
    alignment: d.alignment,
    followed: d.claude_followed,
    hallu: d.hallucination_flag,
    reasoning: (d.reasoning ?? '').slice(0, 400),
    outcome: d.outcome,
  }));

  // Haiku synthesis — one call, produces the meta-reflection summary.
  let summary: string | null = null;
  let tokensIn = 0;
  let tokensOut = 0;
  try {
    const res = await callClaude({
      model: CLAUDE_MODELS.haiku,
      system: SYSTEM,
      messages: [
        {
          role: 'user',
          content: JSON.stringify({
            window_hours: 24,
            counts,
            decisions: compact,
          }),
        },
      ],
      max_tokens: 400,
      temperature: 0.4,
    });
    summary = parseTextContent(res);
    tokensIn = res.usage?.input_tokens ?? 0;
    tokensOut = res.usage?.output_tokens ?? 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[ct-reflect-to-jac] Haiku call failed: ${msg}`);
    return new Response(JSON.stringify({ ok: false, error: `haiku: ${msg}` }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (!summary || summary.trim().length === 0) {
    return new Response(JSON.stringify({ ok: false, error: 'empty summary from Haiku' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  const summaryText = summary.trim();

  // One reflection per JAC user (profiles.id). Single-user today, but stays
  // correct if JAC grows. jac_reflections requires user_id NOT NULL.
  const { data: users } = await supabase.from('profiles').select('id');
  if (!users || users.length === 0) {
    return new Response(JSON.stringify({ ok: false, error: 'no profiles found' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const sourceDecisionIds = decisions.map((d) => d.id);
  const reflectionIds: string[] = [];

  for (const u of users) {
    const userId = u.id as string;

    // Embed the meta-reflection via the shared pipeline.
    let embedding: number[] | null = null;
    try {
      const embRes = await fetch(`${supabaseUrl}/functions/v1/generate-embedding`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: `co_trader_reflection | trading | ${summaryText}`,
          input_type: 'document',
        }),
      });
      if (embRes.ok) {
        const embData = await embRes.json();
        embedding = embData.embedding ?? null;
      } else {
        console.warn(`[ct-reflect-to-jac] embedding failed: ${embRes.status}`);
      }
    } catch (e) {
      console.warn(`[ct-reflect-to-jac] embedding fetch threw: ${e instanceof Error ? e.message : String(e)}`);
    }

    const { data: inserted, error: insErr } = await supabase
      .from('jac_reflections')
      .insert({
        user_id: userId,
        task_id: null,
        task_type: 'co_trader_reflection',
        intent: 'trading',
        summary: summaryText,
        connections: sourceDecisionIds.length > 0 ? sourceDecisionIds : null,
        embedding: embedding ? JSON.stringify(embedding) : null,
      })
      .select('id')
      .single();

    if (insErr || !inserted) {
      console.warn(`[ct-reflect-to-jac] insert failed for user ${userId}: ${insErr?.message ?? 'no data'}`);
      continue;
    }
    reflectionIds.push(inserted.id as string);
  }

  // Audit trail in Co-Trader's own journal. decision_type='reflection' is an
  // allowed value in the ct_claude_decisions CHECK constraint.
  await recordDecision(supabase, {
    decision_type: 'reflection',
    model_tier: 'haiku',
    reasoning: `Co-Trader -> JAC bridge: promoted ${decisions.length} notable decisions from last 24h into ${reflectionIds.length} jac_reflections row(s). Summary: ${summaryText.slice(0, 500)}`,
    outcome: reflectionIds.length > 0 ? 'reflected' : 'no_users',
    context_snapshot: {
      source: 'ct-reflect-to-jac',
      window_hours: 24,
      source_decision_count: decisions.length,
      counts,
      jac_reflection_ids: reflectionIds,
      summary: summaryText,
    },
    tokens_in: tokensIn,
    tokens_out: tokensOut,
  });

  const body = {
    ok: true,
    reflected: reflectionIds.length,
    source_decisions: decisions.length,
    counts,
    summary: summaryText,
    jac_reflection_ids: reflectionIds,
    duration_ms: Date.now() - startedAt,
  };
  console.log('[ct-reflect-to-jac]', JSON.stringify(body));
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
