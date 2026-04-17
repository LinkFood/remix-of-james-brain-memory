/**
 * ct-eod-recap — end-of-day Doc's-style recap.
 *
 * Cron: weekdays at 21:30 UTC (post-market close during EDT).
 * Pulls the day's observations, flags, grades, thesis changes, news,
 * and feeds Claude Sonnet for a structured recap into ct_reports.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { callClaude, CLAUDE_MODELS, parseTextContent, ClaudeError } from '../_shared/anthropic.ts';
import { EOD_RECAP_SYSTEM } from '../_shared/ctPrompts.ts';
import { embedCtItem } from '../_shared/ctEmbed.ts';
import { CT_PROMPT_VERSION } from '../_shared/systemPromptV1.ts';
import { ctSlackPush } from '../_shared/ctSlack.ts';
import { now as clockNow } from '../_shared/clock.ts';

function marketDayBounds(): { start: string; end: string } {
  // Today's market day: 13:00 UTC (9am ET) to 21:00 UTC (5pm ET) approximately
  const now = new Date();
  const start = new Date(now);
  start.setUTCHours(13, 0, 0, 0);
  const end = new Date(now);
  end.setUTCHours(21, 0, 0, 0);
  // If we're BEFORE today's open, use yesterday's session.
  if (now.getTime() < start.getTime()) {
    start.setUTCDate(start.getUTCDate() - 1);
    end.setUTCDate(end.getUTCDate() - 1);
  }
  return { start: start.toISOString(), end: end.toISOString() };
}

async function gatherDayData(supabase: SupabaseClient, start: string, end: string) {
  const [obs, flags, alerts, grades, thesisChanges, news] = await Promise.all([
    supabase.from('ct_observations').select('id, instruments, direction, glance, created_at').gte('created_at', start).lte('created_at', end).order('created_at'),
    supabase.from('ct_flags').select('id, instruments, direction, conviction, horizon, glance, grade_id, created_at').gte('created_at', start).lte('created_at', end).order('created_at'),
    supabase.from('ct_alerts').select('id, instruments, direction, conviction, alert_trigger, glance, grade_id, created_at').gte('created_at', start).lte('created_at', end).order('created_at'),
    supabase.from('ct_grades').select('subject_type, subject_id, instrument, claimed_direction, verdict, actual_return_pct, actual_direction, calibration_delta, graded_at').gte('graded_at', start).lte('graded_at', end).order('graded_at'),
    supabase.from('ct_thesis_history').select('instrument, previous_direction, new_direction, previous_conviction, new_conviction, reason, created_at').gte('created_at', start).lte('created_at', end).order('created_at'),
    supabase.from('ct_news_analyses').select('instrument, news_headline, impact, significance, claude_take, created_at').gte('created_at', start).lte('created_at', end).gte('significance', 3).order('significance', { ascending: false }).limit(25),
  ]);

  return {
    observations: obs.data ?? [],
    flags: flags.data ?? [],
    alerts: alerts.data ?? [],
    grades: grades.data ?? [],
    thesis_changes: thesisChanges.data ?? [],
    significant_news: news.data ?? [],
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

    const { start, end } = marketDayBounds();
    const clock = clockNow();
    const dayData = await gatherDayData(supabase, start, end);

    const corpusEmpty = dayData.observations.length === 0 && dayData.flags.length === 0 && dayData.grades.length === 0;

    const userMessage = JSON.stringify({
      session_date_utc: start.slice(0, 10),
      now_et: clock.datetime,
      corpus_empty_today: corpusEmpty,
      ...dayData,
    });

    let claudeText = '';
    try {
      const res = await callClaude({
        model: CLAUDE_MODELS.sonnet,     // better recap quality than Haiku
        system: EOD_RECAP_SYSTEM,
        messages: [{ role: 'user', content: userMessage }],
        max_tokens: 4000,
        temperature: 0.3,
      });
      claudeText = parseTextContent(res);
    } catch (e) {
      console.error('[ct-eod] Claude failed:', e instanceof ClaudeError ? e.message : e);
      return new Response(JSON.stringify({ error: 'Claude call failed' }), { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Parse
    const cleaned = claudeText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    let parsed: Record<string, unknown> | null = null;
    try { parsed = JSON.parse(cleaned); } catch {
      const m = cleaned.match(/\{[\s\S]*\}/);
      if (m) try { parsed = JSON.parse(m[0]); } catch { /* ignore */ }
    }
    if (!parsed) {
      return new Response(JSON.stringify({ error: 'EOD recap unparsable', raw: cleaned.slice(0, 500) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const summary = String(parsed.summary ?? '(empty)');
    const decomposition = parsed.decomposition ?? null;
    const rabbitHole = String(parsed.rabbit_hole ?? '');
    const scorecard = parsed.scorecard ?? null;
    const selfAssessment = String(parsed.self_assessment ?? '');

    const { data: report, error: reportErr } = await supabase.from('ct_reports').insert({
      user_id: userId,
      report_type: 'eod',
      period_start: start,
      period_end: end,
      summary,
      decomposition,
      rabbit_hole: rabbitHole,
      scorecard,
      self_assessment: selfAssessment,
      prompt_version: CT_PROMPT_VERSION,
    }).select('id').maybeSingle();

    if (reportErr || !report) {
      return new Response(JSON.stringify({ error: 'report insert failed', detail: reportErr?.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Embed recap for future recall ("what did we think on such-and-such day?")
    await embedCtItem(supabase, {
      item_type: 'report',
      item_id: report.id as string,
      text: `EOD ${start.slice(0, 10)} | ${summary} | rabbit: ${rabbitHole}`,
      metadata: {
        report_type: 'eod',
        period_start: start,
        period_end: end,
        created_at: new Date().toISOString(),
      },
    });

    // Slack push — short glance from summary
    if (userId) {
      const firstPara = summary.split('\n\n')[0] ?? summary.slice(0, 300);
      await ctSlackPush(supabase, userId, {
        state: 'RECAP',
        instruments: ['EOD'],
        glance: [firstPara.slice(0, 400), `Rabbit hole: ${rabbitHole.slice(0, 200)}`],
      });
    }

    return new Response(JSON.stringify({
      success: true,
      report_id: report.id,
      corpus_empty_today: corpusEmpty,
      counts: {
        observations: dayData.observations.length,
        flags: dayData.flags.length,
        alerts: dayData.alerts.length,
        grades: dayData.grades.length,
        thesis_changes: dayData.thesis_changes.length,
        significant_news: dayData.significant_news.length,
      },
      duration_ms: Date.now() - startedAt,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error) {
    console.error('[ct-eod-recap] fatal:', error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'failed' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
