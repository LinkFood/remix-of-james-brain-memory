/**
 * ct-preset-apply — one-click risk profile for ct_config.
 *
 * Body: { preset: 'conservative' | 'moderate' | 'aggressive' | 'paranoid' | 'default' }
 *
 * Calls public.apply_config_preset(preset, applied_by) and then pushes a
 * Slack notification summarizing the change. Slack is best-effort and is
 * never allowed to fail the request — the DB write is the source of truth.
 *
 * Auth: authenticated user (JWT). applied_by is the JWT user ID, recorded
 * in the audit log row. If the JWT is missing (dev/service-role calls),
 * applied_by is stored NULL.
 *
 * The RPC does its own validation (unknown preset name → exception). We
 * catch and map to 400. Anything else that blows up is 500.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { extractUserId } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';

const VALID_PRESETS = ['conservative', 'moderate', 'aggressive', 'paranoid', 'default'] as const;
type Preset = typeof VALID_PRESETS[number];

interface ApplyResult {
  preset: string;
  log_id: string;
  keys_changed: number;
  keys_skipped: number;
  diff_summary: Array<{ key: string; old: unknown; new: unknown }>;
}

function etTimeString(now: Date): string {
  return now.toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

const PRESET_EMOJI: Record<Preset, string> = {
  conservative: ':shield:',
  moderate:     ':gear:',
  aggressive:   ':zap:',
  paranoid:     ':rotating_light:',
  default:      ':gear:',
};

async function pushSlack(
  supabase: ReturnType<typeof createClient>,
  userId: string | null,
  result: ApplyResult,
): Promise<void> {
  try {
    const botToken = Deno.env.get('SLACK_BOT_TOKEN');
    if (!botToken) return;

    // Look up channel from user_settings if we have a user; otherwise no-op.
    let channel: string | undefined;
    if (userId) {
      const { data } = await supabase
        .from('user_settings')
        .select('settings')
        .eq('user_id', userId)
        .single();
      channel = (data?.settings as Record<string, unknown> | null)?.slack_channel_id as string | undefined;
    }
    if (!channel) return;

    const emoji = PRESET_EMOJI[result.preset as Preset] ?? ':gear:';
    const timeET = etTimeString(new Date());
    const topChanges = result.diff_summary
      .slice(0, 3)
      .map((d) => `\`${d.key}\`: ${JSON.stringify(d.old)} → ${JSON.stringify(d.new)}`)
      .join('\n');
    const tail = result.diff_summary.length > 3
      ? `\n_+${result.diff_summary.length - 3} more_`
      : '';
    const skippedNote = result.keys_skipped > 0
      ? ` · ${result.keys_skipped} key${result.keys_skipped === 1 ? '' : 's'} skipped (not seeded)`
      : '';

    const text = `${emoji} *Preset applied: ${result.preset}* · ${result.keys_changed} config key${result.keys_changed === 1 ? '' : 's'} changed${skippedNote} · ${timeET} ET`
      + (result.keys_changed > 0 ? `\n${topChanges}${tail}` : '');

    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ channel, text }),
    });
    if (!res.ok) {
      console.warn('[ct-preset-apply] slack post failed:', res.status);
    }
  } catch (err) {
    // Slack is best-effort — never throw.
    console.warn('[ct-preset-apply] slack error:', (err as Error).message);
  }
}

serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  const corsHeaders = getCorsHeaders(req);
  const jsonHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: jsonHeaders,
    });
  }

  let body: { preset?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400, headers: jsonHeaders,
    });
  }

  const preset = body.preset;
  if (!preset || !VALID_PRESETS.includes(preset as Preset)) {
    return new Response(JSON.stringify({
      error: `Unknown preset: ${preset}. Valid: ${VALID_PRESETS.join(', ')}`,
    }), { status: 400, headers: jsonHeaders });
  }

  // Auth is optional here — JWT gives us applied_by. Service role calls also OK.
  const { userId } = await extractUserId(req);

  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) {
    return new Response(JSON.stringify({ error: 'Server misconfigured' }), {
      status: 500, headers: jsonHeaders,
    });
  }
  const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });

  const { data, error } = await supabase.rpc('apply_config_preset', {
    p_preset:     preset,
    p_applied_by: userId ?? null,
  });

  if (error) {
    const msg = error.message || 'RPC error';
    const isUnknown = msg.toLowerCase().includes('unknown preset');
    return new Response(JSON.stringify({ error: msg }), {
      status: isUnknown ? 400 : 500, headers: jsonHeaders,
    });
  }

  const result = data as ApplyResult;

  // Fire-and-forget Slack push; do not block the response on it.
  await pushSlack(supabase, userId, result);

  return new Response(JSON.stringify(result), {
    status: 200, headers: jsonHeaders,
  });
});
