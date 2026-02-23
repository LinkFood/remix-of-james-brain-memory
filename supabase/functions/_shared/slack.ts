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
  slackThinkingTs?: string;
  sources?: Array<{ title: string; url: string }>;
}

/**
 * Convert Markdown to Slack mrkdwn format.
 * - ## Header → *Header*
 * - **bold** → *bold*
 * - [text](url) → <url|text>
 * - `code` stays as `code`
 */
export function markdownToMrkdwn(text: string): string {
  return text
    // Headers: ## Foo → *Foo*
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    // Bold: **text** or __text__ → *text*
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/__(.+?)__/g, '*$1*')
    // Links: [text](url) → <url|text>
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>')
    // Italic: _text_ (only single underscores not already converted)
    // Slack uses _ for italic already, so this is a no-op
    // Strikethrough: ~~text~~ → ~text~
    .replace(/~~(.+?)~~/g, '~$1~');
}

/**
 * Format source URLs for Slack display.
 */
export function formatSourcesForSlack(
  sources: Array<{ title: string; url: string }>,
  max = 5
): string {
  if (!sources || sources.length === 0) return '';
  const items = sources.slice(0, max)
    .map(s => `• <${s.url}|${s.title}>`)
    .join('\n');
  return `\n\n*Sources:*\n${items}`;
}

/**
 * Truncate text at a sentence boundary instead of mid-word.
 * Appends "...truncated" if text was cut.
 */
export function truncateAtSentence(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  // Leave room for the suffix
  const cutoff = maxLen - 14; // "...truncated" = 12 + 2 buffer
  const slice = text.slice(0, cutoff);
  // Find last sentence boundary
  const lastSentence = Math.max(
    slice.lastIndexOf('. '),
    slice.lastIndexOf('.\n'),
    slice.lastIndexOf('! '),
    slice.lastIndexOf('? ')
  );
  const breakPoint = lastSentence > cutoff * 0.5 ? lastSentence + 1 : cutoff;
  return text.slice(0, breakPoint).trimEnd() + ' ...truncated';
}

const EMOJI_MAP: Record<string, string> = {
  research: ':mag:',
  save: ':floppy_disk:',
  search: ':flashlight:',
  report: ':bar_chart:',
  general: ':robot_face:',
  monitor: ':eyes:',
  code: ':computer:',
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

    const formattedSummary = isError
      ? payload.error!
      : markdownToMrkdwn(payload.summary);
    const sourcesText = !isError && payload.sources
      ? formatSourcesForSlack(payload.sources)
      : '';
    const rawMessage = isError
      ? `:x: *${payload.taskType.toUpperCase()} failed:* ${formattedSummary}`
      : `${emoji} *${payload.taskType.toUpperCase()}*\n${formattedSummary}${sourcesText}`;
    const messageText = truncateAtSentence(rawMessage, 3900);

    // Path 1: Bot token + channel — update thinking message or post new
    const botToken = Deno.env.get('SLACK_BOT_TOKEN');
    if (payload.slackChannel && botToken) {
      const slackMethod = payload.slackThinkingTs ? 'chat.update' : 'chat.postMessage';
      const res = await fetch(`https://slack.com/api/${slackMethod}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${botToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          channel: payload.slackChannel,
          text: messageText,
          ...(payload.slackThinkingTs ? { ts: payload.slackThinkingTs } : {}),
        }),
      });

      if (res.ok) {
        const resData = await res.json();
        if (resData.ok) {
          await supabase
            .from('agent_tasks')
            .update({ slack_notified: true })
            .eq('id', payload.taskId);
        } else {
          console.warn('[slack] Slack API ok:false —', resData.error);
        }
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
          text: truncateAtSentence(`${emoji} *JAC Agent — ${payload.taskType.toUpperCase()}* ${statusEmoji}\n\n${isError ? `:warning: *Error:* ${payload.error}` : `${formattedSummary}${sourcesText}`}`, 3900),
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
