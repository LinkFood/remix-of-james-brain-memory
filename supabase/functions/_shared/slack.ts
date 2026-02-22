/**
 * Shared Slack notification utility for JAC Agent OS
 *
 * Sends agent task results to Slack via bot token (preferred) or webhook fallback.
 * No-op if neither is configured — never throws.
 */

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';

interface SlackPayload {
  taskId: string;
  taskType: string;
  summary: string;
  brainEntryId?: string;
  duration?: number;
  error?: string;
  slackChannel?: string;
  slackThreadTs?: string;
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
 * Silently returns if no bot token or webhook is configured.
 */
export async function notifySlack(
  supabase: SupabaseClient,
  userId: string,
  payload: SlackPayload
): Promise<void> {
  try {
    const emoji = EMOJI_MAP[payload.taskType] || ':robot_face:';
    const isError = !!payload.error;

    const messageText = isError
      ? `:x: *${payload.taskType.toUpperCase()} failed:* ${payload.error}`
      : `${emoji} *${payload.taskType.toUpperCase()}*\n${payload.summary}`;

    // Path 1: Bot token + channel — post directly to the DM (no thread_ts)
    const botToken = Deno.env.get('SLACK_BOT_TOKEN');
    if (payload.slackChannel && botToken) {
      const res = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${botToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          channel: payload.slackChannel,
          text: messageText,
        }),
      });

      if (res.ok) {
        await supabase
          .from('agent_tasks')
          .update({ slack_notified: true })
          .eq('id', payload.taskId);
      } else {
        console.warn('[slack] Bot token reply failed:', res.status);
      }
      return; // Done — don't fall through to webhook
    }

    // Path 2: Webhook fallback — read from user_settings
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

    const durationText = payload.duration
      ? `${Math.round(payload.duration / 1000)}s`
      : 'N/A';
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
