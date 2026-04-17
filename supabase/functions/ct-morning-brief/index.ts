/**
 * ct-morning-brief — daily spoken pre-market brief.
 *
 * Gathers context (heartbeat, flow, DP, news, theses, graded flags) →
 * Claude Sonnet writes a 90s script → ElevenLabs TTS renders MP3 →
 * MP3 uploaded to Supabase Storage (`ct-audio`) → row inserted into
 * ct_morning_briefs. If ElevenLabs fails, script is still persisted
 * (audio_url = null) so the written brief is never lost.
 *
 * Cron: weekdays at 10:45 UTC (6:45am ET during EDT).
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { callClaude, CLAUDE_MODELS, parseTextContent, ClaudeError } from '../_shared/anthropic.ts';
import { MORNING_BRIEF_SYSTEM } from '../_shared/morningBriefPrompt.ts';
import { CT_PROMPT_VERSION } from '../_shared/systemPromptV1.ts';

const DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM'; // Rachel
const TTS_MODEL_ID = 'eleven_turbo_v2_5';
const AUDIO_BUCKET = 'ct-audio';

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function last24hrIso(): string {
  return new Date(Date.now() - 24 * 3600_000).toISOString();
}

async function gatherContext(supabase: SupabaseClient) {
  const since = last24hrIso();

  const [heartbeat, flow, darkPool, news, theses, flags, grades, gex] = await Promise.all([
    supabase.from('ct_heartbeats').select('status_line, watching, current_reads, created_at').order('created_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('ct_flow_alerts').select('ticker, option_symbol, strike, expiry, side, is_otm, size, premium, price, underlying_price, executed_at, alert_type').gte('ingested_at', since).order('premium', { ascending: false, nullsFirst: false }).limit(20),
    supabase.from('ct_dark_pool_prints').select('ticker, size, price, notional_value, executed_at').gte('ingested_at', since).order('notional_value', { ascending: false }).limit(10),
    supabase.from('ct_news_analyses').select('instrument, news_headline, impact, significance, claude_take, created_at').gte('created_at', since).gte('significance', 3).order('significance', { ascending: false }).limit(15),
    supabase.from('ct_theses').select('instrument, direction, conviction, up_case, down_case, watching, rationale, updated_at'),
    supabase.from('ct_flags').select('id, instruments, direction, conviction, horizon, glance, grade_id, created_at').gte('created_at', since).order('created_at', { ascending: false }).limit(20),
    supabase.from('ct_grades').select('subject_type, subject_id, instrument, claimed_direction, verdict, actual_return_pct, graded_at').gte('graded_at', since).order('graded_at', { ascending: false }).limit(20),
    supabase.from('ct_gex_snapshots').select('index_symbol, call_wall, put_wall, gamma_flip, zero_gamma, total_gex, snapshot_at').order('snapshot_at', { ascending: false }).limit(4),
  ]);

  return {
    latest_heartbeat: heartbeat.data ?? null,
    flow_top20: flow.data ?? [],
    dark_pool_top10: darkPool.data ?? [],
    overnight_news_sig3plus: news.data ?? [],
    open_theses: theses.data ?? [],
    recent_flags_24hr: flags.data ?? [],
    recent_grades_24hr: grades.data ?? [],
    latest_gex: gex.data ?? [],
  };
}

/**
 * Rough speech duration estimate — 155 wpm is typical for narrated briefs.
 * We count whitespace-separated tokens.
 */
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
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: script,
          model_id: TTS_MODEL_ID,
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
          },
        }),
      },
    );

    if (!resp.ok) {
      const errText = await resp.text();
      console.error(`[ct-morning-brief] ElevenLabs ${resp.status}:`, errText.slice(0, 300));
      return { ok: false, status: resp.status, error: errText.slice(0, 300) };
    }

    const buf = new Uint8Array(await resp.arrayBuffer());
    return { ok: true, status: resp.status, audioBytes: buf };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[ct-morning-brief] ElevenLabs fetch threw:', msg);
    return { ok: false, error: msg };
  }
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
    // 1) Context
    const ctx = await gatherContext(supabase);
    const corpusEmpty =
      !ctx.latest_heartbeat &&
      ctx.flow_top20.length === 0 &&
      ctx.open_theses.length === 0 &&
      ctx.overnight_news_sig3plus.length === 0;

    // 2) Claude writes the script
    let script = '';
    try {
      const res = await callClaude({
        model: CLAUDE_MODELS.sonnet,
        system: MORNING_BRIEF_SYSTEM,
        messages: [{ role: 'user', content: JSON.stringify({
          for_date: forDate,
          now_utc: new Date().toISOString(),
          corpus_empty: corpusEmpty,
          ...ctx,
        }) }],
        max_tokens: 1200,
        temperature: 0.4,
      });
      script = parseTextContent(res).trim();
    } catch (e) {
      console.error('[ct-morning-brief] Claude failed:', e instanceof ClaudeError ? e.message : e);
      return new Response(JSON.stringify({ error: 'Claude call failed' }), {
        status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!script) {
      return new Response(JSON.stringify({ error: 'Empty script from Claude' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // 3) ElevenLabs TTS
    const elevenKey = Deno.env.get('ELEVENLABS_API_KEY');
    const voiceId = Deno.env.get('ELEVENLABS_VOICE_ID') || DEFAULT_VOICE_ID;

    let audioUrl: string | null = null;
    let ttsStatus: number | null = null;
    let ttsError: string | null = null;
    let audioBytes: number | null = null;

    if (!elevenKey) {
      console.warn('[ct-morning-brief] ELEVENLABS_API_KEY missing — persisting script only');
      ttsError = 'ELEVENLABS_API_KEY missing';
    } else {
      const tts = await renderTts(script, elevenKey, voiceId);
      ttsStatus = tts.status ?? null;
      if (tts.ok && tts.audioBytes) {
        audioBytes = tts.audioBytes.byteLength;

        // 4) Upload MP3
        const fileName = `brief-${forDate}.mp3`;
        const { error: upErr } = await supabase.storage
          .from(AUDIO_BUCKET)
          .upload(fileName, tts.audioBytes, {
            contentType: 'audio/mpeg',
            upsert: true,
          });

        if (upErr) {
          console.error('[ct-morning-brief] Storage upload failed:', upErr.message);
          ttsError = `upload: ${upErr.message}`;
        } else {
          const { data: pub } = supabase.storage.from(AUDIO_BUCKET).getPublicUrl(fileName);
          audioUrl = pub?.publicUrl ?? null;
        }
      } else {
        ttsError = tts.error ?? `status ${tts.status ?? 'unknown'}`;
      }
    }

    // 5) Persist row (always — audio_url may be null)
    const duration = audioUrl ? estimateDurationSeconds(script) : null;
    const { data: row, error: insErr } = await supabase
      .from('ct_morning_briefs')
      .upsert({
        for_date: forDate,
        script,
        audio_url: audioUrl,
        duration_seconds: duration,
        prompt_version: CT_PROMPT_VERSION,
      }, { onConflict: 'for_date' })
      .select('id, for_date, audio_url, duration_seconds')
      .maybeSingle();

    if (insErr || !row) {
      return new Response(JSON.stringify({
        error: 'brief insert failed',
        detail: insErr?.message,
      }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({
      success: true,
      for_date: row.for_date,
      audio_url: row.audio_url,
      script_length: script.length,
      estimated_duration_seconds: duration,
      audio_bytes: audioBytes,
      tts_status: ttsStatus,
      tts_error: ttsError,
      corpus_empty: corpusEmpty,
      duration_ms: Date.now() - startedAt,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (error) {
    console.error('[ct-morning-brief] fatal:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'failed',
    }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
