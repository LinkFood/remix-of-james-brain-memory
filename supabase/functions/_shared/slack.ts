/**
 * Shared Slack notification utility for JAC Agent OS
 *
 * Reads webhook URL from user_settings.settings JSONB.
 * No-op if no webhook configured — never throws.
 */

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';

interface SlackPayload {
  taskId: string;
  taskType: string;
  summary: string;
  brainEntryId?: string;
  duration?: number;
  error?: string;
}

const EMOJI_MAP: Record<string, string> = {
  research: ':mag:',
  save: ':floppy_disk:',
  search: ':flashlight:',
  report: ':bar_chart:',
  general: ':robot_face:',
  monitor: ':eyes:',
};

/**
 * Send a Slack notification for a completed (or failed) agent task.
 * Silently returns if no webhook is configured.
 */
export async function notifySlack(
  supabase: SupabaseClient,
  userId: string,
  payload: SlackPayload
): Promise<void> {
  try {
    // Read webhook URL from user_settings
    const { data: settings } = await supabase
      .from('user_settings')
      .select('settings')
      .eq('user_id', userId)
      .single();

    const webhookUrl = (settings?.settings as Record<string, unknown>)?.slack_webhook_url as string | undefined;
    if (!webhookUrl) return;

    // Validate webhook URL to prevent SSRF
    try {
      const parsed = new URL(webhookUrl);
      if (parsed.protocol !== 'https:' || parsed.hostname !== 'hooks.slack.com') {
        console.warn('[slack] Invalid webhook URL — must be https://hooks.slack.com/...');
        return;
      }
    } catch {
      console.warn('[slack] Malformed webhook URL');
      return;
    }

    const emoji = EMOJI_MAP[payload.taskType] || ':robot_face:';
    const durationText = payload.duration
      ? `${Math.round(payload.duration / 1000)}s`
      : 'N/A';

    const isError = !!payload.error;
    const statusEmoji = isError ? ':x:' : ':white_check_mark:';

    const blocks = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${emoji} *JAC Agent — ${payload.taskType.toUpperCase()}* ${statusEmoji}\n\n${isError ? `:warning: *Error:* ${payload.error}` : payload.summary}`,
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `Task: \`${payload.taskId.slice(0, 8)}\` | Duration: ${durationText}${payload.brainEntryId ? ` | Brain: \`${payload.brainEntryId.slice(0, 8)}\`` : ''}`,
          },
        ],
      },
    ];

    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blocks }),
    });

    if (res.ok) {
      // Mark task as slack-notified
      await supabase
        .from('agent_tasks')
        .update({ slack_notified: true })
        .eq('id', payload.taskId);
    } else {
      console.warn('[slack] Webhook POST failed:', res.status);
    }
  } catch (err) {
    // Never throw — Slack is best-effort
    console.warn('[slack] Notification failed:', err);
  }
}
