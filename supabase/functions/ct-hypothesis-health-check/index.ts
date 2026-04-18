/**
 * ct-hypothesis-health-check — does the current tape invalidate any open hypothesis?
 *
 * Runs every 15 min during RTH (13-20 UTC, Mon-Fri). For each `status='open'`
 * hypothesis, we:
 *   1. Pull the latest ct_heartbeats.current_reads snapshot (market state).
 *   2. Ask Claude Haiku whether the hypothesis's invalidate_if trigger has
 *      fired given that market state. Return: intact | invalidated | ambiguous.
 *   3. On `invalidated` -> call retire_hypothesis(id, 'refuted', reason).
 *   4. On `ambiguous` -> log a ct_hypothesis_events row (event_type='edited')
 *      so James can review on the UI.
 *   5. `intact` is a no-op (no write, no event — keeps the audit log clean).
 *
 * Budget cap: MAX_PER_RUN=20. Sorted by last_tested_at NULLS FIRST so the
 * oldest-checked hypotheses get re-read first.
 *
 * Auth: service role only. Called by pg_cron.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { callClaude, CLAUDE_MODELS, parseTextContent, ClaudeError } from '../_shared/anthropic.ts';
import { buildClaudeContext, claudeSystemPromptPreamble, type ClaudeContext } from '../_shared/claudeReadSurface.ts';

const MAX_PER_RUN = 20;

interface HypothesisRow {
  id: string;
  claim: string;
  because: string[];
  invalidate_if: string;
  horizon: string;
  tickers: string[];
  confidence: number;
  elo: number;
  last_tested_at: string | null;
}

interface HaikuVerdict {
  verdict: 'intact' | 'invalidated' | 'ambiguous';
  reasoning: string;
}

const HAIKU_SYSTEM = `You're reviewing ONE running trading hypothesis against the live tape.

Given:
  - claim: what Claude thinks is true
  - because: the supporting reasoning
  - invalidate_if: the concrete trigger that would refute the claim
  - current_market_state: the latest per-instrument reads

Your ONLY job is to judge whether invalidate_if has fired RIGHT NOW.

Return strictly JSON:
  { "verdict": "intact" | "invalidated" | "ambiguous", "reasoning": "one sentence citing specific evidence" }

Rules:
  - "intact"      = the trigger has clearly NOT fired
  - "invalidated" = the trigger has clearly fired — the claim is dead
  - "ambiguous"   = you genuinely cannot tell from the snapshot (use sparingly)
  - Grade against the literal trigger, not vibes. If invalidate_if says
    "SPY breaks 550" and SPY is 552, the answer is intact — not "close call."
  - Single sentence reasoning. Cite the specific read.`;

async function judgeHypothesis(
  h: HypothesisRow,
  marketState: Record<string, unknown> | null,
  systemPrompt: string,
): Promise<HaikuVerdict | null> {
  try {
    const payload = {
      claim: h.claim,
      because: h.because,
      invalidate_if: h.invalidate_if,
      horizon: h.horizon,
      tickers: h.tickers,
      current_market_state: marketState ?? { note: 'no recent heartbeat snapshot' },
    };
    const res = await callClaude({
      model: CLAUDE_MODELS.haiku,
      system: systemPrompt,
      messages: [{ role: 'user', content: JSON.stringify(payload) }],
      max_tokens: 250,
      temperature: 0.1,
    });
    const raw = parseTextContent(res).trim();
    const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed = JSON.parse(stripped) as Record<string, unknown>;
    const verdict = parsed.verdict;
    if (verdict !== 'intact' && verdict !== 'invalidated' && verdict !== 'ambiguous') return null;
    return {
      verdict,
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
    };
  } catch (e) {
    const detail = e instanceof ClaudeError ? `Claude ${e.status}` : String(e);
    console.warn(`[ct-hypothesis-health-check] haiku failed for hyp=${h.id}: ${detail}`);
    return null;
  }
}

function marketStateFromContext(ctx: ClaudeContext): Record<string, unknown> | null {
  const hb = ctx.latestHeartbeat;
  if (!hb) return null;
  return {
    status_line: hb.status_line,
    watching: hb.watching,
    current_reads: hb.current_reads,
    snapshot_at: hb.created_at,
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

  // ISOLATION: all context (heartbeat, config, preamble) via Claude read surface.
  // The stale-first ordering below is a separate query against the same
  // Claude-own ct_hypotheses table — still inside the contract.
  const claudeCtx = await buildClaudeContext(supabase, { heartbeatLimit: 1 });
  const marketState = marketStateFromContext(claudeCtx);
  const systemPrompt = `${claudeSystemPromptPreamble(claudeCtx)}\n\n${HAIKU_SYSTEM}`;

  const { data: open, error } = await supabase
    .from('ct_hypotheses')
    .select('id, claim, because, invalidate_if, horizon, tickers, confidence, elo, last_tested_at')
    .eq('status', 'open')
    .order('last_tested_at', { ascending: true, nullsFirst: true })
    .limit(MAX_PER_RUN);

  if (error) {
    return new Response(JSON.stringify({ ok: false, error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const rows = (open ?? []) as HypothesisRow[];
  let intact = 0, invalidated = 0, ambiguous = 0, failed = 0;

  for (const h of rows) {
    const v = await judgeHypothesis(h, marketState, systemPrompt);
    if (!v) { failed++; continue; }

    if (v.verdict === 'invalidated') {
      invalidated++;
      const { error: retireErr } = await supabase.rpc('retire_hypothesis', {
        p_hypothesis_id: h.id,
        p_status: 'refuted',
        p_reason: `health-check: ${v.reasoning}`.slice(0, 500),
      });
      if (retireErr) {
        console.warn(`[ct-hypothesis-health-check] retire failed hyp=${h.id}: ${retireErr.message}`);
      }
    } else if (v.verdict === 'ambiguous') {
      ambiguous++;
      const { error: evErr } = await supabase
        .from('ct_hypothesis_events')
        .insert({
          hypothesis_id: h.id,
          event_type: 'edited',
          reason: `health-check ambiguous: ${v.reasoning}`.slice(0, 500),
          created_by: 'cron',
        });
      if (evErr) {
        console.warn(`[ct-hypothesis-health-check] event insert failed hyp=${h.id}: ${evErr.message}`);
      }
      // Touch last_tested_at so we don't re-grade ambiguous every 15 min.
      await supabase
        .from('ct_hypotheses')
        .update({ last_tested_at: new Date().toISOString() })
        .eq('id', h.id);
    } else {
      intact++;
      await supabase
        .from('ct_hypotheses')
        .update({ last_tested_at: new Date().toISOString() })
        .eq('id', h.id);
    }
  }

  const body = {
    ok: true,
    processed: rows.length,
    intact,
    invalidated,
    ambiguous,
    failed,
    had_market_state: marketState !== null,
    duration_ms: Date.now() - startedAt,
  };
  console.log('[ct-hypothesis-health-check]', JSON.stringify(body));
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
