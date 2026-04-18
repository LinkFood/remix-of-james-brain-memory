/**
 * ct-midday-recap — midday tape + current lean card.
 *
 * Cron: weekdays at 16:30 UTC (12:30 ET) — halfway through the session.
 * Pulls today's corpus from market-open (13:30 UTC) through NOW and
 * feeds Claude Sonnet for a tight status card: tape so far, current
 * lean, whipsaws, book status, what we're watching into the close.
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { callClaude, CLAUDE_MODELS, parseTextContent, ClaudeError } from '../_shared/anthropic.ts';
import { logClaudeUsage } from '../_shared/claudeUsageLog.ts';
import { MIDDAY_RECAP_SYSTEM } from '../_shared/ctPrompts.ts';
import { embedCtItem } from '../_shared/ctEmbed.ts';
import { CT_PROMPT_VERSION } from '../_shared/systemPromptV1.ts';
import { ctSlackPush } from '../_shared/ctSlack.ts';
import { now as clockNow } from '../_shared/clock.ts';

function middayBounds(): { start: string; now: string; session_date: string } {
  // Session open: 13:30 UTC (9:30 ET). "So far" = open → now.
  const now = new Date();
  const start = new Date(now);
  start.setUTCHours(13, 30, 0, 0);
  // If we somehow fire before open, fall back to yesterday's open.
  if (now.getTime() < start.getTime()) {
    start.setUTCDate(start.getUTCDate() - 1);
  }
  return {
    start: start.toISOString(),
    now: now.toISOString(),
    session_date: start.toISOString().slice(0, 10),
  };
}

async function gatherMiddayData(supabase: SupabaseClient, start: string, end: string, sessionDate: string) {
  const [obs, flags, alerts, grades, trades, heartbeat] = await Promise.all([
    supabase.from('ct_observations')
      .select('id, instruments, direction, glance, created_at')
      .gte('created_at', start).lte('created_at', end)
      .order('created_at'),
    supabase.from('ct_flags')
      .select('id, instruments, direction, conviction, horizon, glance, created_at')
      .gte('created_at', start).lte('created_at', end)
      .order('created_at'),
    supabase.from('ct_alerts')
      .select('id, instruments, direction, conviction, alert_trigger, glance, created_at')
      .gte('created_at', start).lte('created_at', end)
      .order('created_at'),
    supabase.from('ct_grades')
      .select('subject_type, subject_id, instrument, claimed_direction, verdict, actual_return_pct, actual_direction, graded_at')
      .gte('graded_at', start).lte('graded_at', end)
      .order('graded_at'),
    supabase.from('ct_trades')
      .select('id, instrument, side, status, close_reason, realized_pnl_pct, session_date, created_at')
      .eq('session_date', sessionDate)
      .order('created_at'),
    supabase.from('ct_heartbeats')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(1),
  ]);

  return {
    observations: obs.data ?? [],
    flags: flags.data ?? [],
    alerts: alerts.data ?? [],
    grades: grades.data ?? [],
    trades: trades.data ?? [],
    heartbeat: heartbeat.data?.[0] ?? null,
  };
}

/**
 * Count direction flips across the flags+alerts stream in chronological order.
 * A "flip" = transitioning from one direction to a different non-null direction.
 */
function countDirectionFlips(
  flags: Array<{ direction: string | null; created_at: string }>,
  alerts: Array<{ direction: string | null; created_at: string }>,
): number {
  const merged = [...flags, ...alerts]
    .filter(r => r.direction)
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  let flips = 0;
  let last: string | null = null;
  for (const r of merged) {
    if (last && r.direction !== last) flips++;
    last = r.direction;
  }
  return flips;
}

serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  const corsHeaders = getCorsHeaders(req);
  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const startedAt = Date.now();

  try {
    const { data: users } = await supabase.from('profiles').select('id').limit(1);
    const userId = (users?.[0]?.id as string | undefined) ?? null;

    const { start, now: nowIso, session_date } = middayBounds();
    const clock = clockNow();
    const dayData = await gatherMiddayData(supabase, start, nowIso, session_date);

    const flipCount = countDirectionFlips(dayData.flags, dayData.alerts);
    const corpusEmpty =
      dayData.observations.length === 0 &&
      dayData.flags.length === 0 &&
      dayData.alerts.length === 0;

    const userMessage = JSON.stringify({
      session_date_utc: session_date,
      now_et: clock.datetime,
      window_start_utc: start,
      window_end_utc: nowIso,
      corpus_empty_so_far: corpusEmpty,
      direction_flip_count: flipCount,
      ...dayData,
    });

    let claudeText = '';
    const claudeCallStart = Date.now();
    try {
      const res = await callClaude({
        model: CLAUDE_MODELS.sonnet,
        system: MIDDAY_RECAP_SYSTEM,
        messages: [{ role: 'user', content: userMessage }],
        max_tokens: 2500,
        temperature: 0.3,
      });
      claudeText = parseTextContent(res);
      logClaudeUsage(supabase, {
        source: 'ct-midday-recap',
        model: CLAUDE_MODELS.sonnet,
        usage: res.usage,
        duration_ms: Date.now() - claudeCallStart,
        metadata: { user_id: userId, session_date },
      });
    } catch (e) {
      console.error('[ct-midday] Claude failed:', e instanceof ClaudeError ? e.message : e);
      return new Response(JSON.stringify({ error: 'Claude call failed' }), {
        status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const cleaned = claudeText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    let parsed: Record<string, unknown> | null = null;
    try { parsed = JSON.parse(cleaned); } catch {
      const m = cleaned.match(/\{[\s\S]*\}/);
      if (m) try { parsed = JSON.parse(m[0]); } catch { /* ignore */ }
    }
    if (!parsed) {
      return new Response(JSON.stringify({ error: 'Midday recap unparsable', raw: cleaned.slice(0, 500) }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const summary = String(parsed.summary ?? '(empty)');
    const lean = String(parsed.lean ?? '');
    const whipsaws = String(parsed.whipsaws ?? '');
    const bookStatus = String(parsed.book_status ?? '');
    const watchingIntoClose = String(parsed.watching_into_close ?? '');
    const glanceRaw = parsed.glance;
    const glance: string[] = Array.isArray(glanceRaw)
      ? glanceRaw.map(g => String(g)).filter(Boolean).slice(0, 4)
      : [summary.slice(0, 200), lean.slice(0, 200)].filter(Boolean);

    const { data: report, error: reportErr } = await supabase.from('ct_reports').insert({
      user_id: userId,
      report_type: 'midday',
      period_start: start,
      period_end: nowIso,
      summary,
      decomposition: {
        lean,
        whipsaws,
        book_status: bookStatus,
        watching_into_close: watchingIntoClose,
        direction_flip_count: flipCount,
      },
      rabbit_hole: '',
      scorecard: null,
      self_assessment: '',
      prompt_version: CT_PROMPT_VERSION,
    }).select('id').maybeSingle();

    if (reportErr || !report) {
      return new Response(JSON.stringify({ error: 'midday report insert failed', detail: reportErr?.message }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    await embedCtItem(supabase, {
      item_type: 'report',
      item_id: report.id as string,
      text: `MIDDAY ${session_date} | ${summary} | lean: ${lean} | whipsaws: ${whipsaws} | watching: ${watchingIntoClose}`,
      metadata: {
        report_type: 'midday',
        period_start: start,
        period_end: nowIso,
        session_date,
        direction_flip_count: flipCount,
        created_at: new Date().toISOString(),
      },
    });

    if (userId) {
      await ctSlackPush(supabase, userId, {
        state: 'RECAP',
        instruments: ['MIDDAY'],
        glance: glance.length ? glance.map(g => g.slice(0, 400)) : [summary.slice(0, 400)],
      });
    }

    return new Response(JSON.stringify({
      success: true,
      report_id: report.id,
      corpus_empty_so_far: corpusEmpty,
      direction_flip_count: flipCount,
      counts: {
        observations: dayData.observations.length,
        flags: dayData.flags.length,
        alerts: dayData.alerts.length,
        grades: dayData.grades.length,
        trades: dayData.trades.length,
      },
      duration_ms: Date.now() - startedAt,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error) {
    console.error('[ct-midday-recap] fatal:', error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'failed' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
