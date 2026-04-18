/**
 * ct-bias-booth — weekly meta-analysis extracts structural biases.
 *
 * Cron: Sundays 22:00 UTC. Reads last 30d of ct_grades + ct_self_regrades
 * + existing active biases → Claude Sonnet synthesizes up to 5 structural
 * patterns ("I overweight X in Y regime"). Returns ADD / SUPERSEDE /
 * CONFIRM / SKIP actions per proposed bias. Writes to ct_biases.
 *
 * Biases differ from lessons: lessons are tactical ("watch wall breaks
 * on NOPE flip"); biases are identity-level ("you're too eager to call
 * imminent when wall proximity < 0.5%"). Both feed the watcher.
 *
 * Auth: service role only.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { callClaude, CLAUDE_MODELS, parseTextContent, ClaudeError } from '../_shared/anthropic.ts';
import { logClaudeUsage } from '../_shared/claudeUsageLog.ts';

const SYSTEM_PROMPT = `You are the bias booth. Your job: extract 3-5 STRUCTURAL patterns where Claude (you, last week) was systematically wrong. Not tactical rules — identity-level blindspots.

Input you'll receive:
- 30d of ct_grades (verdict + return vs claimed)
- 30d of ct_self_regrades (your own hindsight — "what I got wrong")
- Current active ct_biases (to SUPERSEDE or CONFIRM)

Return EXACTLY this JSON:
{
  "actions": [
    {
      "type": "add" | "confirm" | "supersede" | "retire",
      "supersede_id": "uuid-or-null",  // required if type=supersede or retire
      "bias": {
        "pattern": "one-sentence identity-level statement (e.g. 'I overweight put flow in low-VIX tape')",
        "evidence": "specific citation: grade IDs, regrade quotes, or quick stats (e.g. '4 of 6 wrong-bearish calls when VIX<14, see regrade xyz789')",
        "instruments": ["SPY", "QQQ"] or null,
        "severity": 1-5
      }
    }
  ],
  "reasoning": "brief meta-take on what this week revealed"
}

Severity rubric: 1 = minor tendency. 3 = shows up weekly, costs calibration. 5 = repeating pattern eating real returns.

If the corpus is thin (<10 grades), emit at most 1-2 low-severity biases and mark them provisional in the evidence field. Don't invent biases.`;

interface BiasAction {
  type: 'add' | 'confirm' | 'supersede' | 'retire';
  supersede_id: string | null;
  bias: {
    pattern: string;
    evidence: string;
    instruments: string[] | null;
    severity: number;
  };
}

async function gatherData(supabase: SupabaseClient) {
  const since30d = new Date(Date.now() - 30 * 86400_000).toISOString();
  const [grades, regrades, active] = await Promise.all([
    supabase.from('ct_grades').select('subject_type, subject_id, instrument, claimed_direction, verdict, actual_return_pct, actual_direction, calibration_delta, graded_at').gte('graded_at', since30d).order('graded_at', { ascending: false }).limit(200),
    supabase.from('ct_self_regrades').select('subject_type, subject_id, original_confidence, retrospective_confidence, what_i_got_wrong, how_id_rewrite, grader_verdict, regraded_at').gte('regraded_at', since30d).order('regraded_at', { ascending: false }).limit(100),
    supabase.from('ct_biases').select('id, pattern, evidence, instruments, severity, observed_count, last_confirmed').eq('active', true).order('severity', { ascending: false }).limit(20),
  ]);
  return {
    grades_30d: grades.data ?? [],
    self_regrades_30d: regrades.data ?? [],
    active_biases: active.data ?? [],
  };
}

serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  const corsHeaders = getCorsHeaders(req);

  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const data = await gatherData(supabase);
  if (data.grades_30d.length < 3 && data.self_regrades_30d.length < 3) {
    return new Response(JSON.stringify({ ok: true, skipped: true, reason: 'corpus too thin', grades: data.grades_30d.length, regrades: data.self_regrades_30d.length }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const userMessage = JSON.stringify({ ...data, note: 'Extract 3-5 structural biases per the system schema. Return ONLY the JSON.' });

  let claudeText = '';
  const claudeCallStart = Date.now();
  try {
    const res = await callClaude({
      model: CLAUDE_MODELS.sonnet,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
      max_tokens: 2000,
      temperature: 0.3,
    });
    claudeText = parseTextContent(res);
    logClaudeUsage(supabase, {
      source: 'ct-bias-booth',
      model: CLAUDE_MODELS.sonnet,
      usage: res.usage,
      duration_ms: Date.now() - claudeCallStart,
      metadata: {
        grades_30d_count: data.grades_30d.length,
        self_regrades_30d_count: data.self_regrades_30d.length,
        active_biases_count: data.active_biases.length,
      },
    });
  } catch (e) {
    const msg = e instanceof ClaudeError ? `Claude ${e.status}: ${e.message}` : String(e);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const cleaned = claudeText.replace(/^\s*```(?:json)?\s*/, '').replace(/\s*```\s*$/, '').trim();
  let parsed: { actions?: BiasAction[]; reasoning?: string };
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return new Response(JSON.stringify({ error: 'invalid json', raw: claudeText.slice(0, 500) }), {
      status: 502,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const now = new Date().toISOString();
  let added = 0, confirmed = 0, superseded = 0, retired = 0;

  for (const action of parsed.actions ?? []) {
    try {
      if (action.type === 'add') {
        const { error } = await supabase.from('ct_biases').insert({
          pattern: action.bias.pattern,
          evidence: action.bias.evidence,
          instruments: action.bias.instruments,
          severity: Math.min(5, Math.max(1, Math.round(action.bias.severity ?? 3))),
          active: true,
          first_seen_at: now,
          last_confirmed: now,
          observed_count: 1,
        });
        if (!error) added++;
      } else if (action.type === 'confirm' && action.supersede_id) {
        await supabase
          .from('ct_biases')
          .update({ last_confirmed: now, observed_count: undefined })
          .eq('id', action.supersede_id);
        // Increment observed_count via RPC or re-read+write
        const { data: row } = await supabase.from('ct_biases').select('observed_count').eq('id', action.supersede_id).maybeSingle();
        const current = (row?.observed_count as number | undefined) ?? 0;
        await supabase.from('ct_biases').update({ observed_count: current + 1, last_confirmed: now }).eq('id', action.supersede_id);
        confirmed++;
      } else if (action.type === 'supersede' && action.supersede_id) {
        const { data: newRow, error: insErr } = await supabase
          .from('ct_biases')
          .insert({
            pattern: action.bias.pattern,
            evidence: action.bias.evidence,
            instruments: action.bias.instruments,
            severity: Math.min(5, Math.max(1, Math.round(action.bias.severity ?? 3))),
            active: true,
            first_seen_at: now,
            last_confirmed: now,
            observed_count: 1,
          })
          .select('id')
          .single();
        if (!insErr && newRow) {
          await supabase.from('ct_biases').update({ active: false, superseded_by: newRow.id }).eq('id', action.supersede_id);
          superseded++;
        }
      } else if (action.type === 'retire' && action.supersede_id) {
        await supabase.from('ct_biases').update({ active: false }).eq('id', action.supersede_id);
        retired++;
      }
    } catch (e) {
      console.warn('[ct-bias-booth] action failed:', e instanceof Error ? e.message : e);
    }
  }

  return new Response(JSON.stringify({
    ok: true, added, confirmed, superseded, retired,
    reasoning: parsed.reasoning ?? null,
  }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
