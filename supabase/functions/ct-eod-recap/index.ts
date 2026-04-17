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
  const sessionDate = start.slice(0, 10);
  const [obs, flags, alerts, grades, thesisChanges, news, trades, tradeActions, biases] = await Promise.all([
    supabase.from('ct_observations').select('id, instruments, direction, glance, created_at').gte('created_at', start).lte('created_at', end).order('created_at'),
    supabase.from('ct_flags').select('id, instruments, direction, conviction, horizon, glance, grade_id, created_at').gte('created_at', start).lte('created_at', end).order('created_at'),
    supabase.from('ct_alerts').select('id, instruments, direction, conviction, alert_trigger, glance, grade_id, created_at').gte('created_at', start).lte('created_at', end).order('created_at'),
    supabase.from('ct_grades').select('subject_type, subject_id, instrument, claimed_direction, verdict, actual_return_pct, actual_direction, calibration_delta, graded_at').gte('graded_at', start).lte('graded_at', end).order('graded_at'),
    supabase.from('ct_thesis_history').select('instrument, previous_direction, new_direction, previous_conviction, new_conviction, reason, created_at').gte('created_at', start).lte('created_at', end).order('created_at'),
    supabase.from('ct_news_analyses').select('instrument, news_headline, impact, significance, claude_take, created_at').gte('created_at', start).lte('created_at', end).gte('significance', 3).order('significance', { ascending: false }).limit(25),
    supabase.from('ct_trades').select('id, instrument, side, size_pct, status, opened_at, closed_at, close_reason, realized_pnl_pct, thesis, conviction').eq('session_date', sessionDate).order('created_at'),
    supabase.from('ct_trade_actions').select('trade_id, action, rationale, price, created_at').gte('created_at', start).lte('created_at', end).order('created_at'),
    supabase.from('ct_biases').select('id, pattern, severity, instruments').eq('active', true).order('severity', { ascending: false }),
  ]);

  return {
    observations: obs.data ?? [],
    flags: flags.data ?? [],
    alerts: alerts.data ?? [],
    grades: grades.data ?? [],
    thesis_changes: thesisChanges.data ?? [],
    significant_news: news.data ?? [],
    trades: trades.data ?? [],
    trade_actions: tradeActions.data ?? [],
    active_biases: biases.data ?? [],
  };
}

type AlertRow = { instruments?: string[] | null; direction?: string | null; created_at?: string | null };

/**
 * Cheap whiplash heuristic: for each instrument, count direction transitions
 * (bullish<->bearish, ignoring neutral as bridge). Whiplash = 3+ transitions
 * inside any 2-hour window on the same instrument.
 */
function detectWhiplash(alerts: AlertRow[]): boolean {
  const byInstrument = new Map<string, { t: number; d: string }[]>();
  for (const a of alerts) {
    const dir = (a.direction ?? '').toLowerCase();
    if (dir !== 'bullish' && dir !== 'bearish') continue;
    const t = a.created_at ? new Date(a.created_at).getTime() : NaN;
    if (!Number.isFinite(t)) continue;
    const instruments = Array.isArray(a.instruments) ? a.instruments : [];
    for (const inst of instruments) {
      if (!byInstrument.has(inst)) byInstrument.set(inst, []);
      byInstrument.get(inst)!.push({ t, d: dir });
    }
  }
  for (const [, series] of byInstrument) {
    series.sort((x, y) => x.t - y.t);
    // sliding window of 2h; count transitions where adjacent directions differ
    for (let i = 0; i < series.length; i++) {
      let transitions = 0;
      for (let j = i + 1; j < series.length; j++) {
        if (series[j].t - series[i].t > 2 * 60 * 60 * 1000) break;
        if (series[j].d !== series[j - 1].d) transitions++;
      }
      if (transitions >= 3) return true;
    }
  }
  return false;
}

type DirectionRow = { direction?: string | null };
type StatusRow = { status?: string | null };
type GradeRow = { verdict?: string | null; subject_type?: string | null };

function bucketByDirection(rows: DirectionRow[]) {
  const out = { bullish: 0, bearish: 0, neutral: 0, other: 0 };
  for (const r of rows) {
    const d = (r.direction ?? '').toLowerCase();
    if (d === 'bullish') out.bullish++;
    else if (d === 'bearish') out.bearish++;
    else if (d === 'neutral') out.neutral++;
    else out.other++;
  }
  return out;
}

function bucketByStatus(rows: StatusRow[]) {
  const out = { planned: 0, open: 0, closed: 0, cancelled: 0, other: 0 };
  for (const r of rows) {
    const s = (r.status ?? '').toLowerCase();
    if (s === 'planned' || s === 'open' || s === 'closed' || s === 'cancelled') out[s]++;
    else out.other++;
  }
  return out;
}

function buildGradeScoreboard(grades: GradeRow[]) {
  const totals = { right: 0, partial: 0, wrong: 0 };
  const bySubject: Record<string, { right: number; partial: number; wrong: number }> = {};
  for (const g of grades) {
    const v = (g.verdict ?? '').toLowerCase();
    const key = v === 'right' || v === 'partial' || v === 'wrong' ? v : null;
    if (!key) continue;
    totals[key]++;
    const subj = (g.subject_type ?? 'unknown').toLowerCase();
    if (!bySubject[subj]) bySubject[subj] = { right: 0, partial: 0, wrong: 0 };
    bySubject[subj][key]++;
  }
  return { ...totals, by_subject_type: bySubject };
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

    const alertsByDirection = bucketByDirection(dayData.alerts as DirectionRow[]);
    const flagsByDirection = bucketByDirection(dayData.flags as DirectionRow[]);
    const tradesByStatus = bucketByStatus(dayData.trades as StatusRow[]);
    const gradeScoreboard = buildGradeScoreboard(dayData.grades as GradeRow[]);
    const whiplashFlag = detectWhiplash(dayData.alerts as AlertRow[]);

    const closedTrades = (dayData.trades as { status?: string | null; realized_pnl_pct?: number | null }[])
      .filter((t) => (t.status ?? '').toLowerCase() === 'closed' && typeof t.realized_pnl_pct === 'number');
    const tradesPnlTotalPct = closedTrades.length === 0
      ? null
      : closedTrades.reduce((acc, t) => acc + (t.realized_pnl_pct as number), 0);

    const counts = {
      observations: dayData.observations.length,
      flags: dayData.flags.length,
      flags_by_direction: flagsByDirection,
      alerts: dayData.alerts.length,
      alerts_by_direction: alertsByDirection,
      grades: dayData.grades.length,
      trades: dayData.trades.length,
      trades_by_status: tradesByStatus,
      trade_actions: dayData.trade_actions.length,
      thesis_changes: dayData.thesis_changes.length,
      significant_news: dayData.significant_news.length,
      active_biases: dayData.active_biases.length,
    };

    const userMessage = JSON.stringify({
      session_date_utc: start.slice(0, 10),
      now_et: clock.datetime,
      corpus_empty_today: corpusEmpty,
      counts,
      grade_scoreboard: gradeScoreboard,
      whiplash_flag: whiplashFlag,
      trades_pnl_total_pct: tradesPnlTotalPct,
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
    const baseDecomposition = parsed.decomposition ?? null;
    const rabbitHole = String(parsed.rabbit_hole ?? '');
    const baseScorecard = (parsed.scorecard ?? null) as Record<string, unknown> | null;
    const selfAssessmentBase = String(parsed.self_assessment ?? '');
    const tradesAttempted = String(parsed.trades_attempted ?? '');
    const flagAlertWhiplash = String(parsed.flag_alert_whiplash ?? '');
    const gradeScoreboardLine = String(parsed.grade_scoreboard ?? '');
    const tomorrowPosture = String(parsed.tomorrow_posture ?? '');

    // Nest new prose sections into decomposition jsonb (schema has no dedicated columns for these).
    const decomposition: Record<string, unknown> = {
      factors: baseDecomposition,
      trades_attempted: tradesAttempted,
      flag_alert_whiplash: flagAlertWhiplash,
      whiplash_flag: whiplashFlag,
      trades_pnl_total_pct: tradesPnlTotalPct,
      trades_by_status: tradesByStatus,
      alerts_by_direction: alertsByDirection,
    };

    // Extend scorecard jsonb with the structured scoreboard + prose line.
    const scorecard: Record<string, unknown> = {
      ...(baseScorecard ?? {}),
      grade_scoreboard: gradeScoreboard,
      grade_scoreboard_line: gradeScoreboardLine,
    };

    // Append tomorrow posture to self_assessment with a clear header.
    const selfAssessment = tomorrowPosture
      ? `${selfAssessmentBase}\n\n--- Tomorrow posture ---\n${tomorrowPosture}`
      : selfAssessmentBase;

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

    // Slack push — scoreboard + trades + tomorrow posture (first sentence each).
    if (userId) {
      const scoreboardLine = gradeScoreboardLine
        || `${gradeScoreboard.right} right, ${gradeScoreboard.partial} partial, ${gradeScoreboard.wrong} wrong`;
      const tradesOneLiner = (tradesAttempted.split(/(?<=[.!?])\s+/)[0] ?? '').slice(0, 300)
        || (dayData.trades.length === 0
          ? 'No trades committed today.'
          : `${tradesByStatus.closed} closed, ${tradesByStatus.cancelled} cancelled, ${tradesByStatus.open} open, ${tradesByStatus.planned} planned.`);
      const postureFirstSentence = (tomorrowPosture.split(/(?<=[.!?])\s+/)[0] ?? '').slice(0, 300);
      const glance = [
        scoreboardLine.slice(0, 200),
        tradesOneLiner.slice(0, 300),
      ];
      if (postureFirstSentence) glance.push(`Tomorrow: ${postureFirstSentence}`);
      await ctSlackPush(supabase, userId, {
        state: 'RECAP',
        instruments: ['EOD'],
        glance,
      });
    }

    return new Response(JSON.stringify({
      success: true,
      report_id: report.id,
      corpus_empty_today: corpusEmpty,
      counts,
      grade_scoreboard: gradeScoreboard,
      whiplash_flag: whiplashFlag,
      trades_pnl_total_pct: tradesPnlTotalPct,
      duration_ms: Date.now() - startedAt,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error) {
    console.error('[ct-eod-recap] fatal:', error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'failed' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
