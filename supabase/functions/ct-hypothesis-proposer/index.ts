/**
 * ct-hypothesis-proposer — propose up to N new hypotheses from recent tape.
 *
 * Runs weekdays at 11:00 UTC (07:00 ET, pre-bell). Process:
 *   1. Pull the last `hypothesis_proposer_lookback_hours` of ct_observations,
 *      ct_alerts, and ct_grades (especially yesterday's non-confirmed grades).
 *   2. Pull currently open hypotheses so Claude doesn't re-propose.
 *   3. Ask Claude Sonnet for up to `hypothesis_proposer_max_per_day` NEW
 *      hypotheses that don't duplicate existing ones.
 *   4. Insert each into ct_hypotheses (status='open', created_by='claude',
 *      confidence=0.50, elo=1500).
 *   5. Log a ct_hypothesis_events row (event_type='created') for each.
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
import { callClaude, CLAUDE_MODELS, parseTextContent, ClaudeError } from '../_shared/anthropic.ts';
import { getConfig } from '../_shared/configCache.ts';
import { buildClaudeContext, claudeSystemPromptPreamble } from '../_shared/claudeReadSurface.ts';

const VALID_HORIZONS = new Set(['session', 'week', 'month', 'open']);

interface Proposal {
  claim: string;
  because: string[];
  invalidate_if: string;
  horizon: string;
  tickers: string[];
}

const SYSTEM = `You are the Hypothesis Proposer for a single-trader co-pilot.

Your job: from the last ~36h of market observations, alerts, and graded
outcomes, propose NEW running hypotheses that are worth tracking for days
or weeks. Quality > quantity. It is completely acceptable — and often
correct — to propose ZERO.

Each proposal must have:
  - claim:         one assertive sentence about what's true right now
  - because:       3-5 short bullets citing the specific evidence from the input
  - invalidate_if: a CONCRETE trigger (price level, flow pattern, macro print)
                   that would clearly refute the claim
  - horizon:       one of session | week | month | open
  - tickers:       array of tickers the claim touches (use uppercase, [] if macro)

Rules:
  - Do NOT duplicate an existing open hypothesis. Treat two claims as duplicates
    if they're about the same tickers with the same direction over overlapping
    horizons, regardless of wording.
  - Prefer claims that YESTERDAY'S GRADES say Claude was wrong about or wobbly on —
    those are the gaps worth owning.
  - Avoid hedges ("might", "could") in the claim. Pick a side.
  - invalidate_if must be measurable — not "if the narrative changes."
  - If you have nothing strong, return { "proposals": [] }. That is a valid,
    preferred outcome.

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

  const userPayload = {
    max_new_hypotheses: maxPerDay,
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
    recent_tape: tape,
    blocked_from_reading: claudeCtx.blockedFromReading,
  };

  const systemPrompt = `${claudeSystemPromptPreamble(claudeCtx)}\n\n${SYSTEM}`;

  let proposals: Proposal[] = [];
  try {
    const res = await callClaude({
      model: CLAUDE_MODELS.sonnet,
      system: systemPrompt,
      messages: [{ role: 'user', content: JSON.stringify(userPayload) }],
      max_tokens: 2000,
      temperature: 0.4,
    });
    const raw = parseTextContent(res).trim();
    const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed = JSON.parse(stripped) as { proposals?: unknown };
    const candidates = Array.isArray(parsed.proposals) ? parsed.proposals : [];
    proposals = candidates.filter(validateProposal) as Proposal[];
    // Hard cap even if Claude over-delivers.
    if (proposals.length > maxPerDay) proposals = proposals.slice(0, maxPerDay);
  } catch (e) {
    const detail = e instanceof ClaudeError ? `Claude ${e.status}` : String(e);
    return new Response(JSON.stringify({ ok: false, error: `proposer llm: ${detail}` }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const inserted: Array<{ id: string; claim: string; horizon: string; tickers: string[] }> = [];
  for (const p of proposals) {
    const tickers = p.tickers.map((t) => t.toUpperCase().trim()).filter(Boolean);
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
      continue;
    }
    inserted.push({ id: data.id, claim: p.claim, horizon: p.horizon, tickers });
    await supabase.from('ct_hypothesis_events').insert({
      hypothesis_id: data.id,
      event_type: 'created',
      reason: `proposer: ${p.claim.slice(0, 200)}`,
      created_by: 'cron',
    });
  }

  const body = {
    ok: true,
    proposed: inserted.length,
    capped_at: maxPerDay,
    lookback_hours: lookbackHours,
    existing_open_count: claudeCtx.openHypotheses.length,
    tape_sample: {
      observations: tape.observations.length,
      alerts: tape.alerts.length,
      wobbly_grades: tape.wobbly_grades.length,
    },
    inserted,
    duration_ms: Date.now() - startedAt,
  };
  console.log('[ct-hypothesis-proposer]', JSON.stringify(body));
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
