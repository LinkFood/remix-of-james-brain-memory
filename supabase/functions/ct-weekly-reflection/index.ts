/**
 * ct-weekly-reflection — Sunday 22:00 UTC (5pm ET) weekly self-reflection.
 *
 * Pro quants journal weekly. This is where cross-day patterns become
 * visible — single-day EOD recaps can't see compounding themes, repeated
 * biases, or theme-level P&L drift. Claude writes one himself.
 *
 * Gathers 7 days of: ct_reports, ct_trades closed, ct_grades, ct_book,
 * ct_biases (active + first_seen_at this week), ct_curiosity_findings,
 * ct_regime_inversions + sweep/dp clusters, ct_lessons.
 *
 * Saves to ct_reports with report_type='weekly', embeds the narrative,
 * pushes a Slack summary (worked / didnt_work / next_week_posture).
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { callClaude, CLAUDE_MODELS, parseTextContent, ClaudeError } from '../_shared/anthropic.ts';
import { logClaudeUsage } from '../_shared/claudeUsageLog.ts';
import { WEEKLY_REFLECTION_SYSTEM } from '../_shared/ctPrompts.ts';
import { embedCtItem } from '../_shared/ctEmbed.ts';
import { CT_PROMPT_VERSION } from '../_shared/systemPromptV1.ts';
import { ctSlackPushDirect } from '../_shared/ctSlack.ts';

// ----------------------------------------------------------------------------
// TTS constants — mirror ct-morning-brief's setup so James gets the same
// audio shape. WEEKLY_VOICE_ID lets us pick a different voice for the
// Sunday read (e.g. a calmer, more reflective voice) without affecting the
// daily brief. Falls back to Rachel (same as morning brief) if unset.
// ----------------------------------------------------------------------------
const DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM'; // Rachel
const TTS_MODEL_ID = 'eleven_turbo_v2_5';
const AUDIO_BUCKET = 'ct-audio';

// Append-on to the canonical WEEKLY_REFLECTION_SYSTEM so this function can
// require a narratable `script` field without forking the shared prompt.
// The script is what ElevenLabs speaks on Sunday evening.
const WEEKLY_SCRIPT_ADDENDUM = `

ADDITIONALLY, include a "script" field in the JSON — a 200-400 word narratable prose version of this reflection meant to be listened to, not read. The script must weave the 8 sections (week_summary, worked, didnt_work, theme_attribution, new_biases, calibration_note, next_week_posture, structural_read) into a single flowing spoken-word piece. Numbers stay in. No bullet points, no headers, no markdown. Write it like you're talking to yourself on Sunday evening, reviewing the week before Monday opens. Keep the numbers-first discipline — read specific P&L percentages, win rates, trade counts aloud. If a section is empty, skip it in the script rather than saying "nothing this week".`;

const WEEKLY_REFLECTION_SYSTEM_WITH_SCRIPT = `${WEEKLY_REFLECTION_SYSTEM}${WEEKLY_SCRIPT_ADDENDUM}`;

// ----------------------------------------------------------------------------
// ISO 8601 week number — used for the audio filename. Matches what humans
// call "week 16" etc. Sunday-fires-for-prior-week is fine; we compute off
// the end date so the filename reflects the week James just lived.
// ----------------------------------------------------------------------------
function isoWeekLabel(dateIso: string): string {
  const d = new Date(dateIso + 'T12:00:00Z'); // noon avoids UTC edge cases
  const tmp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = tmp.getUTCDay() || 7; // 1..7, Mon..Sun
  tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((tmp.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${tmp.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

// ----------------------------------------------------------------------------
// TTS helpers — copied shape from ct-morning-brief for consistency. If
// ElevenLabs errors, the weekly report still lands with audio_url=null.
// ----------------------------------------------------------------------------
interface TtsResult {
  ok: boolean;
  status?: number;
  audioBytes?: Uint8Array;
  error?: string;
}

async function renderTts(script: string, apiKey: string, voiceId: string): Promise<TtsResult> {
  try {
    const resp = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: script,
          model_id: TTS_MODEL_ID,
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
      },
    );
    if (!resp.ok) {
      const errText = await resp.text();
      return { ok: false, status: resp.status, error: errText.slice(0, 300) };
    }
    const buf = new Uint8Array(await resp.arrayBuffer());
    return { ok: true, status: resp.status, audioBytes: buf };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function estimateDurationSeconds(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const wpm = 155;
  return Math.round((words / wpm) * 60 * 10) / 10;
}

// ----------------------------------------------------------------------------
// Week window: the 7 days ending at "now". When the cron fires Sunday 22:00
// UTC this covers Mon 22:00 UTC through Sun 22:00 UTC — a full trading
// week including Friday's close.
// ----------------------------------------------------------------------------
function weekBounds(): { start: string; end: string; startDate: string; endDate: string } {
  const end = new Date();
  const start = new Date(end.getTime() - 7 * 24 * 3600_000);
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

// ----------------------------------------------------------------------------
// Trade row we care about for the reflection
// ----------------------------------------------------------------------------
interface ClosedTrade {
  id: string;
  instrument: string;
  side: string;
  status: string;
  thesis_theme: string | null;
  thesis: string | null;
  realized_pnl_pct: number | null;
  close_reason: string | null;
  session_date: string;
  closed_at: string | null;
  conviction: number | null;
}

interface ThemeRollup {
  theme: string;
  count: number;
  sum_pnl_pct: number;
  wins: number;
  losses: number;
  win_rate: number;
}

function rollupThemes(trades: ClosedTrade[]): ThemeRollup[] {
  const map = new Map<string, { count: number; sum: number; wins: number; losses: number }>();
  for (const t of trades) {
    if (typeof t.realized_pnl_pct !== 'number') continue;
    const theme = (t.thesis_theme ?? 'other').toLowerCase();
    const agg = map.get(theme) ?? { count: 0, sum: 0, wins: 0, losses: 0 };
    agg.count += 1;
    agg.sum += t.realized_pnl_pct;
    if (t.realized_pnl_pct > 0) agg.wins += 1;
    else if (t.realized_pnl_pct < 0) agg.losses += 1;
    map.set(theme, agg);
  }
  return Array.from(map.entries())
    .map(([theme, v]) => ({
      theme,
      count: v.count,
      sum_pnl_pct: Number(v.sum.toFixed(3)),
      wins: v.wins,
      losses: v.losses,
      win_rate: v.wins + v.losses > 0 ? Number((v.wins / (v.wins + v.losses)).toFixed(3)) : 0,
    }))
    .sort((a, b) => b.sum_pnl_pct - a.sum_pnl_pct);
}

interface GradeRollup {
  total: number;
  right: number;
  partial: number;
  wrong: number;
  ambiguous: number;
  precision: number;
  by_subject_type: Record<string, { right: number; partial: number; wrong: number; ambiguous: number }>;
}

interface GradeRow {
  verdict?: string | null;
  subject_type?: string | null;
}

function rollupGrades(grades: GradeRow[]): GradeRollup {
  const out: GradeRollup = {
    total: 0,
    right: 0,
    partial: 0,
    wrong: 0,
    ambiguous: 0,
    precision: 0,
    by_subject_type: {},
  };
  for (const g of grades) {
    const v = (g.verdict ?? '').toLowerCase();
    if (v !== 'right' && v !== 'partial' && v !== 'wrong' && v !== 'ambiguous') continue;
    out[v] += 1;
    out.total += 1;
    const subj = (g.subject_type ?? 'unknown').toLowerCase();
    if (!out.by_subject_type[subj]) {
      out.by_subject_type[subj] = { right: 0, partial: 0, wrong: 0, ambiguous: 0 };
    }
    out.by_subject_type[subj][v] += 1;
  }
  const denom = out.right + out.partial + out.wrong;
  out.precision = denom > 0 ? Number((out.right / denom).toFixed(3)) : 0;
  return out;
}

async function gatherWeekData(supabase: SupabaseClient, start: string, end: string, startDate: string, endDate: string) {
  const [
    reports,
    trades,
    grades,
    book,
    biasesActive,
    biasesNewThisWeek,
    curiosity,
    regimeInversions,
    sweepClusters,
    dpClusters,
    lessons,
    openTheses,
  ] = await Promise.all([
    // All ct_reports produced this week (eod + midday + morning_brief)
    supabase.from('ct_reports')
      .select('id, report_type, period_start, period_end, summary, self_assessment, created_at')
      .gte('created_at', start).lte('created_at', end)
      .in('report_type', ['eod', 'midday', 'morning_brief'])
      .order('created_at'),

    // Trades CLOSED this week (regardless of when opened)
    supabase.from('ct_trades')
      .select('id, instrument, side, status, thesis, thesis_theme, realized_pnl_pct, close_reason, session_date, closed_at, conviction')
      .eq('status', 'closed')
      .gte('closed_at', start).lte('closed_at', end)
      .order('closed_at'),

    // Grades issued this week
    supabase.from('ct_grades')
      .select('subject_type, subject_id, instrument, verdict, actual_return_pct, calibration_delta, graded_at')
      .gte('graded_at', start).lte('graded_at', end)
      .order('graded_at'),

    // ct_book — daily P&L series
    supabase.from('ct_book')
      .select('session_date, starting_balance, ending_balance, realized_pnl, realized_pnl_pct, max_drawdown_pct, trades_count, wins, losses, goal_hit')
      .gte('session_date', startDate).lte('session_date', endDate)
      .order('session_date'),

    // Active biases — current state
    supabase.from('ct_biases')
      .select('id, pattern, severity, instruments, observed_count, first_seen_at, last_confirmed')
      .eq('active', true)
      .order('severity', { ascending: false })
      .order('last_confirmed', { ascending: false })
      .limit(20),

    // Biases first seen THIS WEEK
    supabase.from('ct_biases')
      .select('id, pattern, severity, instruments, observed_count, first_seen_at')
      .gte('first_seen_at', start).lte('first_seen_at', end)
      .order('first_seen_at'),

    // Highest-attention curiosity findings this week
    supabase.from('ct_curiosity_findings')
      .select('id, question, finding, attention_score, actionable, related_instruments, created_at')
      .gte('created_at', start).lte('created_at', end)
      .order('attention_score', { ascending: false })
      .limit(10),

    // Regime inversions this week
    supabase.from('ct_regime_inversions')
      .select('ticker, prev_regime, new_regime, flip_level, spot_at_flip, session_date, created_at')
      .gte('created_at', start).lte('created_at', end)
      .order('created_at'),

    // Sweep cluster activity density
    supabase.from('ct_sweep_clusters')
      .select('ticker, attention_score, created_at')
      .gte('created_at', start).lte('created_at', end)
      .order('attention_score', { ascending: false })
      .limit(50),

    // DP cluster activity density
    supabase.from('ct_dp_clusters')
      .select('ticker, attention_score, created_at')
      .gte('created_at', start).lte('created_at', end)
      .order('attention_score', { ascending: false })
      .limit(50),

    // Active lessons — durable principles, capped
    supabase.from('ct_lessons')
      .select('id, lesson, instruments, curation_action, created_at')
      .eq('active', true)
      .order('created_at', { ascending: false })
      .limit(20),

    // Current open theses — frame for next-week posture
    supabase.from('ct_theses')
      .select('instrument, direction, conviction, up_case, down_case, watching, updated_at'),
  ]);

  return {
    reports: reports.data ?? [],
    trades: (trades.data ?? []) as ClosedTrade[],
    grades: (grades.data ?? []) as GradeRow[],
    book: book.data ?? [],
    biases_active: biasesActive.data ?? [],
    biases_new_this_week: biasesNewThisWeek.data ?? [],
    curiosity_top: curiosity.data ?? [],
    regime_inversions: regimeInversions.data ?? [],
    sweep_clusters: sweepClusters.data ?? [],
    dp_clusters: dpClusters.data ?? [],
    lessons_active: lessons.data ?? [],
    open_theses: openTheses.data ?? [],
  };
}

/**
 * Strip ```json fences Claude sometimes adds, then parse — fall back to
 * extracting the first {...} block.
 */
function parseReflectionJson(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  try { return JSON.parse(cleaned) as Record<string, unknown>; } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]) as Record<string, unknown>; } catch { return null; } }
    return null;
  }
}

function buildSlackText(reflection: Record<string, unknown>, startDate: string, endDate: string): string {
  const header = `:brain: *Weekly Reflection* · ${startDate} → ${endDate}`;
  const worked = Array.isArray(reflection.worked) ? (reflection.worked as unknown[]).map(String).filter(Boolean) : [];
  const didnt = Array.isArray(reflection.didnt_work) ? (reflection.didnt_work as unknown[]).map(String).filter(Boolean) : [];
  const posture = String(reflection.next_week_posture ?? '').trim();

  const parts: string[] = [header];
  if (worked.length > 0) {
    parts.push('\n*Worked:*\n' + worked.slice(0, 3).map(w => `• ${w}`).join('\n'));
  }
  if (didnt.length > 0) {
    parts.push('\n*Didn\'t work:*\n' + didnt.slice(0, 3).map(w => `• ${w}`).join('\n'));
  }
  if (posture) {
    parts.push(`\n*Next week posture:*\n${posture}`);
  }
  return parts.join('');
}

function buildRichText(reflection: Record<string, unknown>, startDate: string, endDate: string): string {
  const worked = Array.isArray(reflection.worked) ? (reflection.worked as unknown[]).map(String).join(' · ') : '';
  const didnt = Array.isArray(reflection.didnt_work) ? (reflection.didnt_work as unknown[]).map(String).join(' · ') : '';
  const fields = [
    `week_summary: ${String(reflection.week_summary ?? '')}`,
    `worked: ${worked}`,
    `didnt_work: ${didnt}`,
    `new_biases: ${String(reflection.new_biases ?? '')}`,
    `calibration_note: ${String(reflection.calibration_note ?? '')}`,
    `next_week_posture: ${String(reflection.next_week_posture ?? '')}`,
    `structural_read: ${String(reflection.structural_read ?? '')}`,
  ];
  return `WEEKLY_REFLECTION ${startDate}..${endDate}\n${fields.join('\n')}`;
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
    const { start, end, startDate, endDate } = weekBounds();

    // Dedupe: never write more than one weekly report per week. Match any
    // existing 'weekly' row whose period_end falls within the last 6 days.
    const dedupeCutoff = new Date(Date.now() - 6 * 24 * 3600_000).toISOString();
    const { data: existing } = await supabase.from('ct_reports')
      .select('id, period_end')
      .eq('report_type', 'weekly')
      .gte('period_end', dedupeCutoff)
      .order('period_end', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existing) {
      return new Response(JSON.stringify({
        success: true,
        skipped: 'already_have_weekly_in_last_6d',
        existing_id: existing.id,
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Single-user MVP — resolve userId from profiles
    const { data: users } = await supabase.from('profiles').select('id').limit(1);
    const userId = (users?.[0]?.id as string | undefined) ?? null;

    const weekData = await gatherWeekData(supabase, start, end, startDate, endDate);

    // Pre-aggregates to hand Claude so it can lead with numbers, not recompute
    const themeRollup = rollupThemes(weekData.trades);
    const gradesRollup = rollupGrades(weekData.grades);

    // Trading-day count — the book table has one row per session_date the
    // book was open. Zero or one trading day = sparse week.
    const tradingDayCount = weekData.book.length;
    const sparsityFlag = tradingDayCount < 2;

    const activityDensity = {
      regime_inversions: weekData.regime_inversions.length,
      sweep_clusters: weekData.sweep_clusters.length,
      dp_clusters: weekData.dp_clusters.length,
    };

    // Sanity: if the entire corpus is empty (first-ever week, no cron
    // activity), don't waste a Sonnet call. Write a stub weekly row noting
    // sparsity so the UI has something to render.
    const corpusEmpty =
      weekData.reports.length === 0 &&
      weekData.trades.length === 0 &&
      weekData.grades.length === 0 &&
      weekData.book.length === 0;

    const counts = {
      reports: weekData.reports.length,
      trades_closed: weekData.trades.length,
      grades: weekData.grades.length,
      trading_days: tradingDayCount,
      biases_active: weekData.biases_active.length,
      biases_new_this_week: weekData.biases_new_this_week.length,
      curiosity_top: weekData.curiosity_top.length,
      lessons_active: weekData.lessons_active.length,
      ...activityDensity,
    };

    let reflection: Record<string, unknown>;
    let claudeModel = CLAUDE_MODELS.sonnet;

    if (corpusEmpty) {
      // Skip Claude, write a sparse-week stub. No script → no TTS call.
      reflection = {
        week_summary: `Corpus is empty for ${startDate} → ${endDate} — no trades, grades, or reports landed this week. Nothing to reflect on yet.`,
        worked: [],
        didnt_work: [],
        theme_attribution: [],
        new_biases: '',
        calibration_note: '',
        next_week_posture: 'Posture unchanged — wait for data.',
        structural_read: '',
        script: '',
      };
    } else {
      const userMessage = JSON.stringify({
        week_start: startDate,
        week_end: endDate,
        now_utc: new Date().toISOString(),
        sparsity_flag: sparsityFlag,
        trading_days: tradingDayCount,
        counts,
        theme_rollup: themeRollup,
        grades_rollup: gradesRollup,
        activity_density: activityDensity,
        book_series: weekData.book,
        reports: weekData.reports,
        trades_closed: weekData.trades,
        biases_active: weekData.biases_active,
        biases_new_this_week: weekData.biases_new_this_week,
        curiosity_top: weekData.curiosity_top,
        regime_inversions_top: weekData.regime_inversions.slice(0, 10),
        lessons_active: weekData.lessons_active,
        open_theses: weekData.open_theses,
      });

      let claudeText = '';
      const claudeCallStart = Date.now();
      try {
        const res = await callClaude({
          model: claudeModel,
          system: WEEKLY_REFLECTION_SYSTEM_WITH_SCRIPT,
          messages: [{ role: 'user', content: userMessage }],
          max_tokens: 3500, // script adds ~400 words of output
          temperature: 0.3,
        });
        claudeText = parseTextContent(res).trim();
        logClaudeUsage(supabase, {
          source: 'ct-weekly-reflection',
          model: claudeModel,
          usage: res.usage,
          duration_ms: Date.now() - claudeCallStart,
          metadata: { user_id: userId, week_start: startDate, week_end: endDate, sparsity_flag: sparsityFlag },
        });
      } catch (e) {
        console.error('[ct-weekly-reflection] Claude failed:', e instanceof ClaudeError ? e.message : e);
        return new Response(JSON.stringify({ error: 'Claude call failed' }), {
          status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const parsed = parseReflectionJson(claudeText);
      if (!parsed) {
        return new Response(JSON.stringify({
          error: 'Reflection unparsable',
          raw: claudeText.slice(0, 500),
        }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      reflection = parsed;
    }

    const workedArr = Array.isArray(reflection.worked) ? (reflection.worked as unknown[]).map(String) : [];
    const didntArr = Array.isArray(reflection.didnt_work) ? (reflection.didnt_work as unknown[]).map(String) : [];
    const themeAttr = Array.isArray(reflection.theme_attribution) ? reflection.theme_attribution : [];
    const script = String(reflection.script ?? '').trim();

    const summary = String(reflection.week_summary ?? '').slice(0, 4000);
    const selfAssessment = [
      String(reflection.calibration_note ?? ''),
      reflection.new_biases ? `\n--- New biases ---\n${String(reflection.new_biases)}` : '',
      reflection.next_week_posture ? `\n--- Next week posture ---\n${String(reflection.next_week_posture)}` : '',
    ].filter(Boolean).join('').slice(0, 4000);

    const decomposition = {
      subtype: 'weekly',
      week_start: startDate,
      week_end: endDate,
      sparsity_flag: sparsityFlag,
      corpus_empty: corpusEmpty,
      trading_days: tradingDayCount,
      worked: workedArr,
      didnt_work: didntArr,
      theme_attribution: themeAttr,
      theme_rollup_raw: themeRollup,
      new_biases: reflection.new_biases ?? '',
      calibration_note: reflection.calibration_note ?? '',
      next_week_posture: reflection.next_week_posture ?? '',
      structural_read: reflection.structural_read ?? '',
      script, // narratable prose — what ElevenLabs speaks and what the on-demand Narrate fallback uses
      counts,
    };

    const scorecard = {
      grades_rollup: gradesRollup,
      theme_rollup: themeRollup,
      activity_density: activityDensity,
    };

    const { data: report, error: reportErr } = await supabase.from('ct_reports').insert({
      user_id: userId,
      report_type: 'weekly',
      period_start: start,
      period_end: end,
      summary,
      decomposition,
      rabbit_hole: String(reflection.structural_read ?? ''),
      scorecard,
      self_assessment: selfAssessment,
      prompt_version: CT_PROMPT_VERSION,
    }).select('id').maybeSingle();

    if (reportErr || !report) {
      return new Response(JSON.stringify({
        error: 'weekly report insert failed',
        detail: reportErr?.message,
      }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Embed for recall ("what did we reflect on week of X?")
    const embedRes = await embedCtItem(supabase, {
      item_type: 'report',
      item_id: report.id as string,
      text: buildRichText(reflection, startDate, endDate),
      metadata: {
        report_type: 'weekly',
        subtype: 'weekly',
        week_start: startDate,
        week_end: endDate,
        sparsity_flag: sparsityFlag,
        corpus_empty: corpusEmpty,
        created_at: new Date().toISOString(),
      },
    });

    // Slack push — direct (scheduled digest, no dedupe)
    if (userId && !corpusEmpty) {
      try {
        await ctSlackPushDirect(
          supabase,
          userId,
          buildSlackText(reflection, startDate, endDate),
          'weekly_reflection',
        );
      } catch (e) {
        console.warn('[ct-weekly-reflection] slack push failed (non-blocking):', e instanceof Error ? e.message : e);
      }
    }

    // ----------------------------------------------------------------------
    // ElevenLabs TTS — fire-and-forget. Report is already persisted above,
    // so any failure here leaves audio_url=null and the frontend Narrate
    // button can regenerate on demand. WEEKLY_VOICE_ID env var allows a
    // different voice from the weekday morning brief (e.g. slower cadence
    // for reflective Sunday listening).
    // ----------------------------------------------------------------------
    let audioUrl: string | null = null;
    let ttsStatus: number | null = null;
    let ttsError: string | null = null;
    let audioBytes: number | null = null;
    let audioDurationMs: number | null = null;

    if (script && !corpusEmpty) {
      const elevenKey = Deno.env.get('ELEVENLABS_API_KEY');
      const voiceId = Deno.env.get('WEEKLY_VOICE_ID')
        || Deno.env.get('ELEVENLABS_VOICE_ID')
        || DEFAULT_VOICE_ID;

      if (!elevenKey) {
        ttsError = 'ELEVENLABS_API_KEY missing';
      } else {
        const tts = await renderTts(script, elevenKey, voiceId);
        ttsStatus = tts.status ?? null;
        if (tts.ok && tts.audioBytes) {
          audioBytes = tts.audioBytes.byteLength;
          const fileName = `weekly-reflection-${isoWeekLabel(endDate)}.mp3`;
          const { error: upErr } = await supabase.storage
            .from(AUDIO_BUCKET)
            .upload(fileName, tts.audioBytes, { contentType: 'audio/mpeg', upsert: true });
          if (upErr) {
            ttsError = `upload: ${upErr.message}`;
          } else {
            const { data: pub } = supabase.storage.from(AUDIO_BUCKET).getPublicUrl(fileName);
            audioUrl = pub?.publicUrl ?? null;
            audioDurationMs = Math.round(estimateDurationSeconds(script) * 1000);
          }
        } else {
          ttsError = tts.error ?? `status ${tts.status ?? 'unknown'}`;
        }
      }

      // Stamp audio URL + duration onto the weekly report row. Best-effort —
      // if this fails the frontend can still fall back to on-demand narration.
      if (audioUrl) {
        const { error: audioErr } = await supabase
          .from('ct_reports')
          .update({ audio_url: audioUrl, audio_duration_ms: audioDurationMs })
          .eq('id', report.id);
        if (audioErr) {
          console.warn('[ct-weekly-reflection] ct_reports audio stamp failed (non-blocking):', audioErr.message);
        } else {
          console.log(`[ct-weekly-reflection] audio stamped on report ${report.id} — ${audioBytes} bytes, ~${audioDurationMs}ms`);
        }
      }
    }

    return new Response(JSON.stringify({
      success: true,
      report_id: report.id,
      week_start: startDate,
      week_end: endDate,
      sparsity_flag: sparsityFlag,
      corpus_empty: corpusEmpty,
      counts,
      theme_rollup: themeRollup,
      grades_rollup: gradesRollup,
      embed_ok: embedRes.ok,
      embed_error: embedRes.error ?? null,
      audio_url: audioUrl,
      audio_bytes: audioBytes,
      audio_duration_ms: audioDurationMs,
      tts_status: ttsStatus,
      tts_error: ttsError,
      duration_ms: Date.now() - startedAt,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error) {
    console.error('[ct-weekly-reflection] fatal:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'failed',
    }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
