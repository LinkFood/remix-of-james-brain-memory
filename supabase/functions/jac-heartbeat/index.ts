/**
 * jac-heartbeat — Autonomous Heartbeat for JAC Agent OS
 *
 * Cron: every 30 minutes. JAC reviews his own state and decides whether
 * to proactively surface something useful to the user.
 *
 * Auth: Service role only (cron call).
 * Rate limit: max 3 heartbeat insights per day per user.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { callClaude, CLAUDE_MODELS, parseToolUse } from '../_shared/anthropic.ts';

const HEARTBEAT_TOOL = {
  name: 'heartbeat_decision',
  description: 'Decide whether to proactively surface an insight to the user.',
  input_schema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['surface', 'nothing'],
      },
      title: { type: 'string' },
      body: { type: 'string' },
      priority: {
        type: 'integer',
        minimum: 1,
        maximum: 3,
      },
    },
    required: ['action'],
  },
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204 });
  }

  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized — service role required' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, serviceKey);

  try {
    // 1. Get all users from profiles
    const { data: users, error: usersError } = await supabase
      .from('profiles')
      .select('id');

    if (usersError || !users || users.length === 0) {
      console.log('[jac-heartbeat] No users found');
      return new Response(JSON.stringify({ message: 'No users found' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    let totalSurfaced = 0;

    for (const user of users) {
      const userId = user.id as string;

      // 2. Rate limit: max 3 heartbeat insights per day
      const todayStart = new Date();
      todayStart.setUTCHours(0, 0, 0, 0);
      const { count: heartbeatCount } = await supabase
        .from('brain_insights')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('type', 'heartbeat')
        .gte('created_at', todayStart.toISOString());

      if ((heartbeatCount ?? 0) >= 3) {
        console.log(`[jac-heartbeat] Rate limit reached for user ${userId} (${heartbeatCount}/3 today)`);
        continue;
      }

      // 3. Load context
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const today = new Date().toISOString().split('T')[0];
      const threeDaysOut = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

      // Parallel context loading
      const [reflectionsRes, entriesRes, remindersRes, tasksRes] = await Promise.all([
        // Last 10 reflections
        supabase
          .from('jac_reflections')
          .select('task_type, intent, summary, created_at')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .limit(10),
        // Last 10 entries
        supabase
          .from('entries')
          .select('title, content_type, tags, importance_score, created_at')
          .eq('user_id', userId)
          .eq('archived', false)
          .order('created_at', { ascending: false })
          .limit(10),
        // Upcoming reminders (next 3 days)
        supabase
          .from('entries')
          .select('title, event_date, event_time, content_type')
          .eq('user_id', userId)
          .eq('archived', false)
          .gte('event_date', today)
          .lte('event_date', threeDaysOut)
          .in('content_type', ['reminder', 'event'])
          .order('event_date', { ascending: true })
          .limit(10),
        // Recent completed tasks (3 days)
        supabase
          .from('agent_tasks')
          .select('type, intent, status, created_at')
          .eq('user_id', userId)
          .eq('status', 'completed')
          .gte('created_at', new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString())
          .order('created_at', { ascending: false })
          .limit(10),
      ]);

      const reflections = reflectionsRes.data || [];
      const entries = entriesRes.data || [];
      const reminders = remindersRes.data || [];
      const tasks = tasksRes.data || [];

      // Build context string
      const contextParts: string[] = [];

      if (reflections.length > 0) {
        contextParts.push('RECENT REFLECTIONS:');
        for (const r of reflections) {
          contextParts.push(`  - ${r.intent || r.task_type}: ${r.summary}`);
        }
      }

      if (entries.length > 0) {
        contextParts.push('\nRECENT ENTRIES:');
        for (const e of entries) {
          contextParts.push(`  - "${e.title || 'Untitled'}" (${e.content_type}, importance: ${e.importance_score ?? '?'})`);
        }
      }

      if (reminders.length > 0) {
        contextParts.push('\nUPCOMING REMINDERS/EVENTS:');
        for (const r of reminders) {
          contextParts.push(`  - "${r.title || 'Untitled'}" on ${r.event_date}${r.event_time ? ' at ' + r.event_time : ''}`);
        }
      }

      if (tasks.length > 0) {
        contextParts.push('\nRECENT COMPLETED TASKS:');
        for (const t of tasks) {
          contextParts.push(`  - ${t.type}: ${t.intent || 'no intent'} (${t.status})`);
        }
      }

      if (contextParts.length === 0) {
        console.log(`[jac-heartbeat] No context data for user ${userId}, skipping`);
        continue;
      }

      // 4. Claude Haiku: decide whether to surface something
      const claudeResponse = await callClaude({
        model: CLAUDE_MODELS.haiku,
        system: `You are JAC's autonomous heartbeat. You periodically review the user's state and decide if there's something worth proactively surfacing.

Rules:
- Only surface things that are genuinely useful RIGHT NOW — not generic advice
- Good reasons to surface: forgotten reminders, patterns in recent activity, upcoming deadlines, stale high-priority items
- Bad reasons: generic productivity tips, restating what the user already knows
- If nothing is worth surfacing, choose action "nothing" — this is the RIGHT choice most of the time
- Keep title under 60 chars, body to 1-2 sentences
- Priority: 1 = urgent, 2 = useful, 3 = nice-to-know
- Today's date: ${today}`,
        messages: [{
          role: 'user',
          content: contextParts.join('\n'),
        }],
        tools: [HEARTBEAT_TOOL],
        tool_choice: { type: 'tool', name: 'heartbeat_decision' },
        max_tokens: 512,
        temperature: 0.3,
      });

      const toolResult = parseToolUse(claudeResponse);
      const decision = toolResult?.input;

      if (!decision || decision.action !== 'surface' || !decision.title || !decision.body) {
        console.log(`[jac-heartbeat] Nothing to surface for user ${userId}`);
        continue;
      }

      // 5. Insert into brain_insights with 24h expiry
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const { error: insertError } = await supabase
        .from('brain_insights')
        .insert({
          user_id: userId,
          type: 'heartbeat',
          title: decision.title as string,
          body: decision.body as string,
          priority: (decision.priority as number) || 2,
          entry_ids: [],
          dismissed: false,
          expires_at: expiresAt,
        });

      if (insertError) {
        console.error(`[jac-heartbeat] Insert error for user ${userId}:`, insertError.message);
        continue;
      }

      totalSurfaced++;
      console.log(`[jac-heartbeat] Surfaced insight for user ${userId}: "${decision.title}"`);

      // 6. Optionally notify via Slack
      try {
        const { data: settings } = await supabase
          .from('user_settings')
          .select('settings')
          .eq('user_id', userId)
          .single();

        const slackChannelId = (settings?.settings as Record<string, unknown>)?.slack_channel_id as string | undefined;
        const botToken = Deno.env.get('SLACK_BOT_TOKEN');

        if (slackChannelId && botToken) {
          const slackRes = await fetch('https://slack.com/api/chat.postMessage', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${botToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              channel: slackChannelId,
              text: `:heartbeat: *${decision.title}*\n${decision.body}`,
            }),
          });

          if (slackRes.ok) {
            const slackData = await slackRes.json();
            if (!slackData.ok) {
              console.warn(`[jac-heartbeat] Slack API error:`, slackData.error);
            }
          } else {
            console.warn(`[jac-heartbeat] Slack POST failed:`, slackRes.status);
          }
        }
      } catch (slackErr) {
        // Slack is best-effort — never throw
        console.warn('[jac-heartbeat] Slack notification failed:', slackErr);
      }
    }

    console.log(`[jac-heartbeat] Done: ${totalSurfaced} insights surfaced across ${users.length} users`);

    return new Response(JSON.stringify({
      success: true,
      users: users.length,
      surfaced: totalSurfaced,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('[jac-heartbeat] Error:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Heartbeat failed',
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
