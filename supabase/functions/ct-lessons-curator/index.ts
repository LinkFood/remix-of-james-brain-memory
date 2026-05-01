/**
 * ct-lessons-curator — weekly ADD/SUPERSEDE/SKIP lesson consolidation.
 *
 * Cron: Sundays at 23:00 UTC (after NY weekend wraps).
 * Reads the past week's observations + flags + grades + current active
 * lessons, asks Claude to curate. Writes new lessons to ct_lessons,
 * marks superseded lessons inactive, embeds each new lesson.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { callClaude, CLAUDE_MODELS, parseTextContent, ClaudeError } from '../_shared/anthropic.ts';
import { logClaudeUsage } from '../_shared/claudeUsageLog.ts';
import { LESSONS_CURATOR_SYSTEM } from '../_shared/ctPrompts.ts';
import { embedCtItem } from '../_shared/ctEmbed.ts';
import { CT_PROMPT_VERSION } from '../_shared/systemPromptV1.ts';
import { buildClaudeContext } from '../_shared/claudeReadSurface.ts';

// ---------------------------------------------------------------------------
// Brain integration (Phase 4 — synthesis layer migration).
// Audience: 'cotrader'. Organ subset (curator-focused):
//   - principles + biases + hypotheses (flat fields on ClaudeContext —
//     activePrinciples/activeBiases/openHypotheses; not yet helper-backed)
//   - event_recency (organ — last-72h material events)
// The orchestrator runs all 8 helpers; we only surface the curator-focused
// subset to the lessons prompt to keep token weight on what matters for
// ADD/SUPERSEDE/SKIP reasoning.
// ---------------------------------------------------------------------------
function pickEventRecencyOrgan(organs: Record<string, unknown>): unknown {
  const o = organs.event_recency;
  if (o && typeof o === 'object' && 'data' in (o as Record<string, unknown>)) {
    return (o as { data: unknown }).data;
  }
  return null;
}

function weekBounds(): { start: string; end: string } {
  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 7);
  return { start: start.toISOString(), end: end.toISOString() };
}

async function gatherWeekData(supabase: SupabaseClient, start: string, end: string) {
  const [obs, flags, grades, currentLessons] = await Promise.all([
    supabase.from('ct_observations').select('id, instruments, direction, up_case_odds, down_case_odds, glance, observation, created_at').gte('created_at', start).lte('created_at', end).order('created_at').limit(150),
    supabase.from('ct_flags').select('id, instruments, direction, conviction, horizon, up_case_odds, down_case_odds, glance, full_reasoning, grade_id, created_at').gte('created_at', start).lte('created_at', end).order('created_at').limit(100),
    supabase.from('ct_grades').select('subject_type, subject_id, instrument, claimed_direction, verdict, actual_return_pct, actual_direction, calibration_delta, graded_at').gte('graded_at', start).lte('graded_at', end).order('graded_at').limit(200),
    supabase.from('ct_lessons').select('id, lesson, instruments, created_at').eq('active', true).limit(100),
  ]);

  return {
    observations: obs.data ?? [],
    flags: flags.data ?? [],
    grades: grades.data ?? [],
    current_active_lessons: currentLessons.data ?? [],
  };
}

serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  const corsHeaders = getCorsHeaders(req);
  if (!isServiceRoleRequest(req)) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const startedAt = Date.now();

  try {
    const { data: users } = await supabase.from('profiles').select('id').limit(1);
    const userId = (users?.[0]?.id as string | undefined) ?? null;

    const { start, end } = weekBounds();
    const [data, brain] = await Promise.all([
      gatherWeekData(supabase, start, end),
      buildClaudeContext(supabase, {
        audience: 'cotrader',
        consumerName: 'ct-lessons-curator',
      }).catch((e) => {
        console.warn('[ct-lessons] brain build failed:', e instanceof Error ? e.message : String(e));
        return null;
      }),
    ]);

    const corpusThin = data.observations.length + data.flags.length < 5;
    if (corpusThin) {
      return new Response(JSON.stringify({
        success: true,
        skipped: true,
        reason: 'corpus too thin this week',
        counts: { observations: data.observations.length, flags: data.flags.length, grades: data.grades.length },
        duration_ms: Date.now() - startedAt,
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const brainContext = brain ? {
      session_date: brain.preamble.temporalAnchor,
      what_just_happened: brain.preamble.whatJustHappened,
      principles: brain.activePrinciples,
      biases: brain.activeBiases,
      open_hypotheses: brain.openHypotheses,
      event_recency: pickEventRecencyOrgan(brain.organs as Record<string, unknown>),
    } : null;

    const userMessage = JSON.stringify({
      window: { start, end },
      brain_context: brainContext,
      ...data,
    });

    let claudeText = '';
    const claudeCallStart = Date.now();
    try {
      const res = await callClaude({
        model: CLAUDE_MODELS.sonnet,
        system: LESSONS_CURATOR_SYSTEM,
        messages: [{ role: 'user', content: userMessage }],
        max_tokens: 4000,
        temperature: 0.2,
      });
      claudeText = parseTextContent(res);
      logClaudeUsage(supabase, {
        source: 'ct-lessons-curator',
        model: CLAUDE_MODELS.sonnet,
        usage: res.usage,
        duration_ms: Date.now() - claudeCallStart,
        metadata: { user_id: userId, window: { start, end } },
      });
    } catch (e) {
      console.error('[ct-lessons] Claude failed:', e instanceof ClaudeError ? e.message : e);
      return new Response(JSON.stringify({ error: 'Claude call failed' }), { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const cleaned = claudeText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    let parsed: { lessons?: Array<Record<string, unknown>>; summary?: string } | null = null;
    try { parsed = JSON.parse(cleaned); } catch {
      const m = cleaned.match(/\{[\s\S]*\}/);
      if (m) try { parsed = JSON.parse(m[0]); } catch { /* ignore */ }
    }
    if (!parsed) {
      return new Response(JSON.stringify({ error: 'lessons output unparsable', raw: cleaned.slice(0, 500) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const proposed = Array.isArray(parsed.lessons) ? parsed.lessons : [];
    let added = 0, superseded = 0, skipped = 0, failed = 0;

    for (const l of proposed.slice(0, 5)) {
      const action = String(l.action ?? '').toUpperCase();
      if (action === 'SKIP') { skipped++; continue; }
      if (action !== 'ADD' && action !== 'SUPERSEDE') { failed++; continue; }

      const lessonText = typeof l.lesson === 'string' ? l.lesson : '';
      if (!lessonText) { failed++; continue; }

      const instruments = Array.isArray(l.instruments) ? l.instruments : null;
      const sourceItems = Array.isArray(l.source_items) ? l.source_items : null;
      const supersedesId = typeof l.supersedes_lesson_id === 'string' ? l.supersedes_lesson_id : null;

      const { data: newLesson, error: insErr } = await supabase.from('ct_lessons').insert({
        user_id: userId,
        lesson: lessonText,
        source_items: sourceItems,
        instruments,
        curation_action: action,
        supersedes_lesson: action === 'SUPERSEDE' ? supersedesId : null,
        active: true,
        prompt_version: CT_PROMPT_VERSION,
      }).select('id').maybeSingle();

      if (insErr || !newLesson) { failed++; continue; }

      if (action === 'SUPERSEDE' && supersedesId) {
        await supabase.from('ct_lessons').update({ active: false }).eq('id', supersedesId);
        superseded++;
      } else {
        added++;
      }

      // Embed the new lesson
      await embedCtItem(supabase, {
        item_type: 'lesson',
        item_id: newLesson.id as string,
        text: `LESSON ${(instruments ?? ['ALL']).join(',')} | ${lessonText}`,
        metadata: {
          instrument: instruments?.[0] ?? null,
          instruments: instruments ?? null,
          created_at: new Date().toISOString(),
        },
      });
    }

    return new Response(JSON.stringify({
      success: true,
      added,
      superseded,
      skipped,
      failed,
      summary: parsed.summary ?? null,
      duration_ms: Date.now() - startedAt,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error) {
    console.error('[ct-lessons-curator] fatal:', error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'failed' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
