/**
 * Co-trader Slack push — minimal, best-effort, never throws.
 *
 * Pulls channel from user_settings.settings.slack_channel_id (same
 * pattern as JAC). Posts via SLACK_BOT_TOKEN. Silent no-op if
 * either is missing.
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';

export interface CtSlackPayload {
  state: 'FLAG' | 'ALERT' | 'RECAP' | 'DISAGREEMENT';
  instruments: string[];
  glance: string[];
  conviction?: number;
  horizon?: string;
  alert_trigger?: string;
}

function pickEmoji(state: CtSlackPayload['state']): string {
  switch (state) {
    case 'ALERT':       return ':rotating_light:';
    case 'FLAG':        return ':triangular_flag_on_post:';
    case 'RECAP':       return ':clipboard:';
    case 'DISAGREEMENT':return ':crossed_swords:';
    default:            return ':chart_with_upwards_trend:';
  }
}

export async function ctSlackPush(
  supabase: SupabaseClient,
  userId: string,
  payload: CtSlackPayload
): Promise<void> {
  try {
    const botToken = Deno.env.get('SLACK_BOT_TOKEN');
    if (!botToken) return;

    const { data: settings } = await supabase
      .from('user_settings')
      .select('settings')
      .eq('user_id', userId)
      .maybeSingle();
    const channelId = (settings?.settings as Record<string, unknown> | null)?.slack_channel_id as string | undefined;
    if (!channelId) return;

    const emoji = pickEmoji(payload.state);
    const header = `${emoji} *${payload.state}* · ${payload.instruments.join(', ')}${payload.conviction ? ` · conv ${payload.conviction}` : ''}${payload.horizon ? ` · ${payload.horizon}` : ''}${payload.alert_trigger ? ` · ${payload.alert_trigger}` : ''}`;
    const body = payload.glance.map(g => `• ${g}`).join('\n');
    const text = `${header}\n${body}`;

    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ channel: channelId, text, mrkdwn: true }),
    });

    if (!res.ok) {
      console.warn('[ctSlack] post failed:', res.status);
      return;
    }
    const json = await res.json().catch(() => ({}));
    if (!json.ok) console.warn('[ctSlack] slack ok:false —', json.error);
  } catch (e) {
    console.warn('[ctSlack] exception (non-blocking):', e instanceof Error ? e.message : e);
  }
}
