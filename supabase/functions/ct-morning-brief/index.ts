/**
 * ct-morning-brief — structured pre-market brief (v1.1).
 *
 * Fires at 10:45 UTC (6:45 AM ET) weekdays. The first thing James reads
 * before the bell. Gathers Friday's EOD + trades + book + weekend news +
 * late-session clusters + overnight holds + active biases, asks Claude
 * to stitch them into a JSON report, persists to ct_reports, embeds via
 * Voyage, pushes a dense Slack summary, and renders a TTS script.
 *
 * NO UW calls. Everything derives from existing ct_* tables.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { callClaude, CLAUDE_MODELS, parseTextContent, ClaudeError } from '../_shared/anthropic.ts';
import { logClaudeUsage } from '../_shared/claudeUsageLog.ts';
import { MORNING_BRIEF_SYSTEM, PROMPT_VERSION } from '../_shared/morningBriefPrompt.ts';
import { embedCtItem } from '../_shared/ctEmbed.ts';
import { ctSlackPushDirect } from '../_shared/ctSlack.ts';

const DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM'; // Rachel
const TTS_MODEL_ID = 'eleven_turbo_v2_5';
const AUDIO_BUCKET = 'ct-audio';

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Figure out "yesterday's session date" — for Monday this is Friday.
 * Everything else stays calendar-previous-day.
 */
function priorSessionDate(today: Date = new Date()): string {
  const d = new Date(today);
  const dow = d.getUTCDay(); // 0 Sun, 1 Mon, 6 Sat
  let back = 1;
  if (dow === 1) back = 3;       // Monday → Friday
  else if (dow === 0) back = 2;  // Sunday (edge) → Friday
  else if (dow === 6) back = 1;  // Saturday (edge) → Friday
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

/**
 * ISO timestamp of 22:00 UTC on the prior session date. This is our
 * "since Friday close" cutoff for weekend news.
 */
function priorCloseIso(prior: string): string {
  return `${prior}T22:00:00.000Z`;
}

/**
 * ISO timestamp 4 hours before close on the prior session (i.e. last
 * 4hrs of that session: 18:00 UTC → 22:00 UTC).
 */
function lastFourHoursStart(prior: string): string {
  return `${prior}T18:00:00.000Z`;
}

async function gatherContext(supabase: SupabaseClient) {
  const now = new Date();
  const priorDate = priorSessionDate(now);
  const priorClose = priorCloseIso(priorDate);
  const priorLateStart = lastFourHoursStart(priorDate);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 3600_000).toISOString();
  const todayDate = todayIsoDate();

  const [
    heartbeat,
    eodReport,
    dailyRecap,
    yTrades,
    yBook,
    weekendNews,
    lateSweeps,
    lateDps,
    regimeInversions,
    openTrades,
    biases,
    recentBiasChanges,
    curiosity,
    theses,
  ] = await Promise.all([
    // Latest watcher state — carries current_reads (gamma, regime, walls)
    supabase.from('ct_heartbeats')
      .select('status_line, watching, current_reads, created_at')
      .order('created_at', { ascending: false }).limit(1).maybeSingle(),

    // Friday's EOD report — summary + self_assessment (decomposition has tomorrow_posture via daily recap too)
    supabase.from('ct_reports')
      .select('summary, decomposition, self_assessment, scorecard, period_end, created_at')
      .eq('report_type', 'eod')
      .order('created_at', { ascending: false }).limit(1).maybeSingle(),

    // ct_daily_recaps is the cleaner source of tomorrow_posture
    supabase.from('ct_daily_recaps')
      .select('recap, what_worked, what_didnt, tomorrow_posture, pnl_pct, session_date')
      .eq('session_date', priorDate).maybeSingle(),

    // Yesterday's trades — all statuses so we can group
    supabase.from('ct_trades')
      .select('id, instrument, side, contract_type, strike, expiry, status, entry_price, entry_premium, close_price, close_premium, realized_pnl_pct, close_reason, thesis, conviction, source, session_date, opened_at, closed_at')
      .eq('session_date', priorDate)
      .order('opened_at', { ascending: true, nullsFirst: false }),

    // Yesterday's book — P&L, HWM, drawdown
    supabase.from('ct_book')
      .select('session_date, starting_balance, ending_balance, realized_pnl, unrealized_pnl, realized_pnl_pct, high_water_mark, trades_count, wins, losses, max_drawdown_pct, goal_hit, daily_recap')
      .eq('session_date', priorDate).maybeSingle(),

    // Weekend news — since prior close @ 22:00 UTC, significance 3+
    supabase.from('ct_news_analyses')
      .select('instrument, news_headline, impact, significance, claude_take, news_timestamp, created_at')
      .gte('created_at', priorClose)
      .gte('significance', 3)
      .order('significance', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(15),

    // Last 4 hours of Friday session sweep clusters
    supabase.from('ct_sweep_clusters')
      .select('ticker, window_start, window_end, sweep_count, total_premium, dominant_side, largest_single_premium, call_count, put_count, attention_score, created_at')
      .gte('created_at', priorLateStart)
      .lte('created_at', priorClose)
      .order('attention_score', { ascending: false })
      .limit(10),

    // Last 4 hours of Friday session DP clusters
    supabase.from('ct_dp_clusters')
      .select('ticker, window_start, window_end, print_count, total_notional, largest_single_notional, attention_score, created_at')
      .gte('created_at', priorLateStart)
      .lte('created_at', priorClose)
      .order('attention_score', { ascending: false })
      .limit(10),

    // Regime inversions on the prior session date
    supabase.from('ct_regime_inversions')
      .select('ticker, prev_regime, new_regime, prev_net_gamma, new_net_gamma, flip_level, spot_at_flip, created_at, session_date')
      .eq('session_date', priorDate)
      .order('created_at', { ascending: true }),

    // Overnight holds — any ct_trade still open from prior sessions
    supabase.from('ct_trades')
      .select('id, instrument, side, contract_type, strike, expiry, entry_price, entry_premium, stop_price, target_price, thesis, conviction, session_date, opened_at')
      .eq('status', 'open')
      .lt('session_date', todayDate)
      .order('opened_at', { ascending: true, nullsFirst: false }),

    // Active biases — descending severity
    supabase.from('ct_biases')
      .select('id, pattern, instruments, severity, observed_count, last_confirmed')
      .eq('active', true)
      .order('severity', { ascending: false })
      .order('last_confirmed', { ascending: false })
      .limit(5),

    // Bias changes in last 7 days — proxy for "recent self-corrections"
    supabase.from('ct_biases')
      .select('pattern, severity, observed_count, last_confirmed, first_seen_at')
      .gte('last_confirmed', sevenDaysAgo)
      .order('last_confirmed', { ascending: false })
      .limit(5),

    // Last curiosity finding on prior session — sometimes the best overnight read
    supabase.from('ct_curiosity_findings')
      .select('question, finding, attention_score, actionable, related_instruments, created_at')
      .eq('session_date', priorDate)
      .gte('attention_score', 50)
      .order('attention_score', { ascending: false })
      .limit(3),

    // Current theses — just the frame
    supabase.from('ct_theses')
      .select('instrument, direction, conviction, up_case, down_case, watching, updated_at'),
  ]);

  // Detect unreverted regime flips. An inversion is "carrying" if there's
  // no later same-ticker inversion in the opposite direction during the
  // prior session.
  const inversions = regimeInversions.data ?? [];
  const byTicker = new Map<string, typeof inversions>();
  for (const inv of inversions) {
    const arr = byTicker.get(inv.ticker) ?? [];
    arr.push(inv);
    byTicker.set(inv.ticker, arr);
  }
  const carryingInversions: Array<typeof inversions[number] & { carried: boolean }> = [];
  for (const [, arr] of byTicker) {
    // arr is chronological. The last one is the net state at EOD.
    const last = arr[arr.length - 1];
    carryingInversions.push({ ...last, carried: true });
  }

  // Group yesterday's trades by status for the prompt
  const trades = yTrades.data ?? [];
  const tradesByStatus = {
    filled: trades.filter(t => t.status === 'open' && t.opened_at),
    closed: trades.filter(t => t.status === 'closed'),
    cancelled: trades.filter(t => t.status === 'cancelled'),
    planned_only: trades.filter(t => t.status === 'planned'),
  };

  return {
    prior_session_date: priorDate,
    today_date: todayDate,
    latest_heartbeat: heartbeat.data ?? null,
    friday_eod_report: eodReport.data ?? null,
    friday_daily_recap: dailyRecap.data ?? null,
    friday_trades_by_status: tradesByStatus,
    friday_book: yBook.data ?? null,
    weekend_news_sig3plus: weekendNews.data ?? [],
    friday_late_sweeps: lateSweeps.data ?? [],
    friday_late_dps: lateDps.data ?? [],
    friday_regime_inversions_carrying: carryingInversions,
    overnight_open_trades: openTrades.data ?? [],
    active_biases: biases.data ?? [],
    recent_bias_changes_7d: recentBiasChanges.data ?? [],
    friday_curiosity_findings: curiosity.data ?? [],
    open_theses: theses.data ?? [],
  };
}

function estimateDurationSeconds(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const wpm = 155;
  return Math.round((words / wpm) * 60 * 10) / 10;
}

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

/**
 * Strip ```json fences Claude sometimes adds, then parse — fall back to
 * extracting the first {...} block.
 */
function parseBriefJson(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  try { return JSON.parse(cleaned) as Record<string, unknown>; } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]) as Record<string, unknown>; } catch { return null; } }
    return null;
  }
}

function buildSlackText(brief: Record<string, unknown>): string {
  const posture = String(brief.fresh_posture ?? '').trim();
  const watching = Array.isArray(brief.pre_open_watching)
    ? (brief.pre_open_watching as unknown[]).map(s => String(s)).filter(Boolean).slice(0, 3)
    : [];
  const header = ':coffee: *Morning Brief* · ' + todayIsoDate();
  const postureLine = posture ? `\n${posture}` : '';
  const watchLines = watching.length
    ? '\n\n*Pre-open watching:*\n' + watching.map(w => `• ${w}`).join('\n')
    : '';
  return `${header}${postureLine}${watchLines}`;
}

function buildRichText(brief: Record<string, unknown>, priorDate: string): string {
  const fields = [
    `friday_recap: ${String(brief.friday_recap ?? '')}`,
    `weekend_news: ${String(brief.weekend_news ?? '')}`,
    `carryover: ${String(brief.friday_structural_carryover ?? '')}`,
    `open_trades: ${String(brief.open_trades_check ?? '')}`,
    `fresh_posture: ${String(brief.fresh_posture ?? '')}`,
    `pre_open: ${Array.isArray(brief.pre_open_watching) ? (brief.pre_open_watching as unknown[]).join(' · ') : ''}`,
  ];
  return `MORNING_BRIEF ${todayIsoDate()} | prior:${priorDate}\n${fields.join('\n')}`;
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
  const forDate = todayIsoDate();

  try {
    const ctx = await gatherContext(supabase);
    const corpusEmpty =
      !ctx.latest_heartbeat &&
      !ctx.friday_eod_report &&
      !ctx.friday_daily_recap &&
      (ctx.weekend_news_sig3plus.length === 0) &&
      (ctx.friday_late_sweeps.length === 0) &&
      (ctx.friday_late_dps.length === 0) &&
      (ctx.friday_regime_inversions_carrying.length === 0) &&
      (ctx.overnight_open_trades.length === 0);

    // Resolve userId from profiles — single-user MVP
    const { data: users } = await supabase.from('profiles').select('id').limit(1);
    const userId = (users?.[0]?.id as string | undefined) ?? null;

    // Claude writes the structured brief
    let claudeText = '';
    const claudeCallStart = Date.now();
    try {
      const res = await callClaude({
        model: CLAUDE_MODELS.sonnet,
        system: MORNING_BRIEF_SYSTEM,
        messages: [{
          role: 'user',
          content: JSON.stringify({
            for_date: forDate,
            now_utc: new Date().toISOString(),
            corpus_empty: corpusEmpty,
            ...ctx,
          }),
        }],
        max_tokens: 1500,
        temperature: 0.3,
      });
      claudeText = parseTextContent(res).trim();
      logClaudeUsage(supabase, {
        source: 'ct-morning-brief',
        model: CLAUDE_MODELS.sonnet,
        usage: res.usage,
        duration_ms: Date.now() - claudeCallStart,
        metadata: { user_id: userId, for_date: forDate, corpus_empty: corpusEmpty },
      });
    } catch (e) {
      console.error('[ct-morning-brief] Claude failed:', e instanceof ClaudeError ? e.message : e);
      return new Response(JSON.stringify({ error: 'Claude call failed' }), {
        status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const brief = parseBriefJson(claudeText);
    if (!brief) {
      return new Response(JSON.stringify({ error: 'Brief unparsable', raw: claudeText.slice(0, 500) }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const script = String(brief.script ?? '').trim();

    // Persist to ct_reports as report_type='morning_brief'
    const periodStart = `${ctx.prior_session_date}T20:00:00.000Z`; // Friday 4pm ET close
    const periodEnd = new Date().toISOString();

    const { data: report, error: reportErr } = await supabase.from('ct_reports').insert({
      user_id: userId,
      report_type: 'morning_brief',
      period_start: periodStart,
      period_end: periodEnd,
      summary: String(brief.fresh_posture ?? brief.friday_recap ?? '(empty)').slice(0, 4000),
      decomposition: {
        subtype: 'pre_market',
        friday_recap: brief.friday_recap ?? null,
        weekend_news: brief.weekend_news ?? null,
        friday_structural_carryover: brief.friday_structural_carryover ?? null,
        open_trades_check: brief.open_trades_check ?? null,
        fresh_posture: brief.fresh_posture ?? null,
        pre_open_watching: brief.pre_open_watching ?? [],
        script,
        corpus_empty: corpusEmpty,
        prior_session_date: ctx.prior_session_date,
        counts: {
          weekend_news: ctx.weekend_news_sig3plus.length,
          friday_late_sweeps: ctx.friday_late_sweeps.length,
          friday_late_dps: ctx.friday_late_dps.length,
          friday_regime_inversions_carrying: ctx.friday_regime_inversions_carrying.length,
          overnight_open_trades: ctx.overnight_open_trades.length,
          active_biases: ctx.active_biases.length,
        },
      },
      rabbit_hole: '',
      scorecard: null,
      self_assessment: String(brief.fresh_posture ?? '').slice(0, 4000),
      prompt_version: PROMPT_VERSION,
    }).select('id').maybeSingle();

    if (reportErr || !report) {
      return new Response(JSON.stringify({
        error: 'morning_brief report insert failed',
        detail: reportErr?.message,
      }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Embed for later recall
    const embedRes = await embedCtItem(supabase, {
      item_type: 'report',
      item_id: report.id as string,
      text: buildRichText(brief, ctx.prior_session_date),
      metadata: {
        report_type: 'morning_brief',
        subtype: 'pre_market',
        for_date: forDate,
        prior_session_date: ctx.prior_session_date,
        prompt_version: PROMPT_VERSION,
        corpus_empty: corpusEmpty,
      },
    });

    // Slack push — dense summary (no dedupe, it's a scheduled digest)
    if (userId) {
      try {
        await ctSlackPushDirect(supabase, userId, buildSlackText(brief), 'morning_brief');
      } catch (e) {
        console.warn('[ct-morning-brief] slack push failed (non-blocking):', e instanceof Error ? e.message : e);
      }
    }

    // ElevenLabs TTS — only if we have a script
    let audioUrl: string | null = null;
    let ttsStatus: number | null = null;
    let ttsError: string | null = null;
    let audioBytes: number | null = null;

    if (script) {
      const elevenKey = Deno.env.get('ELEVENLABS_API_KEY');
      const voiceId = Deno.env.get('ELEVENLABS_VOICE_ID') || DEFAULT_VOICE_ID;

      if (!elevenKey) {
        ttsError = 'ELEVENLABS_API_KEY missing';
      } else {
        const tts = await renderTts(script, elevenKey, voiceId);
        ttsStatus = tts.status ?? null;
        if (tts.ok && tts.audioBytes) {
          audioBytes = tts.audioBytes.byteLength;
          const fileName = `brief-${forDate}.mp3`;
          const { error: upErr } = await supabase.storage
            .from(AUDIO_BUCKET)
            .upload(fileName, tts.audioBytes, { contentType: 'audio/mpeg', upsert: true });
          if (upErr) {
            ttsError = `upload: ${upErr.message}`;
          } else {
            const { data: pub } = supabase.storage.from(AUDIO_BUCKET).getPublicUrl(fileName);
            audioUrl = pub?.publicUrl ?? null;
          }
        } else {
          ttsError = tts.error ?? `status ${tts.status ?? 'unknown'}`;
        }
      }
    }

    // Back-compat: also upsert the narratable script into ct_morning_briefs
    // so the existing audio player / frontend keeps working.
    const duration = audioUrl && script ? estimateDurationSeconds(script) : null;
    const audioDurationMs = duration != null ? Math.round(duration * 1000) : null;
    await supabase.from('ct_morning_briefs').upsert({
      for_date: forDate,
      script,
      audio_url: audioUrl,
      duration_seconds: duration,
      prompt_version: PROMPT_VERSION,
    }, { onConflict: 'for_date' });

    // Stamp the ct_reports row with audio URL + duration so any report_type
    // (not just morning_brief) can carry narration going forward.
    if (audioUrl) {
      const { error: audioErr } = await supabase
        .from('ct_reports')
        .update({ audio_url: audioUrl, audio_duration_ms: audioDurationMs })
        .eq('id', report.id);
      if (audioErr) {
        console.warn('[ct-morning-brief] ct_reports audio stamp failed (non-blocking):', audioErr.message);
      } else {
        console.log(`[ct-morning-brief] audio stamped on report ${report.id} — ${audioBytes} bytes, ~${audioDurationMs}ms`);
      }
    }

    return new Response(JSON.stringify({
      success: true,
      report_id: report.id,
      for_date: forDate,
      prior_session_date: ctx.prior_session_date,
      corpus_empty: corpusEmpty,
      audio_url: audioUrl,
      tts_status: ttsStatus,
      tts_error: ttsError,
      audio_bytes: audioBytes,
      embed_ok: embedRes.ok,
      embed_error: embedRes.error ?? null,
      counts: {
        weekend_news: ctx.weekend_news_sig3plus.length,
        friday_late_sweeps: ctx.friday_late_sweeps.length,
        friday_late_dps: ctx.friday_late_dps.length,
        friday_regime_inversions_carrying: ctx.friday_regime_inversions_carrying.length,
        overnight_open_trades: ctx.overnight_open_trades.length,
        active_biases: ctx.active_biases.length,
      },
      duration_ms: Date.now() - startedAt,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error) {
    console.error('[ct-morning-brief] fatal:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'failed',
    }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
