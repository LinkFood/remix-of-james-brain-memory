/**
 * jac-morning-brief — Daily Morning Brief for JAC Agent OS
 *
 * Cron: 7 AM Central (13:00 UTC). Compiles overnight activity, schedule,
 * reflections, and insights into a structured brief. Stores as brain_insight
 * and sends to Slack.
 *
 * Auth: Service role only (cron call).
 * Rate limit: 1 morning_brief per day per user (skip if already exists).
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { callClaude, CLAUDE_MODELS, parseToolUse } from '../_shared/anthropic.ts';
import { getUserContext } from '../_shared/context.ts';

const BRIEF_TOOL = {
  name: 'morning_brief',
  description: 'Synthesize the morning brief for the user.',
  input_schema: {
    type: 'object' as const,
    properties: {
      schedule: { type: 'string', description: 'Schedule section -- what is on today and upcoming' },
      activity: { type: 'string', description: 'What JAC Did section -- summary of agent work in last 24h' },
      brain: { type: 'string', description: 'Brain Activity section -- new entries, reflections, patterns' },
      heads_up: { type: 'string', description: 'Heads Up section -- anything notable or requiring attention' },
    },
    required: ['schedule', 'activity', 'brain', 'heads_up'],
  },
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204 });
  }

  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized -- service role required' }), {
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
      console.log('[jac-morning-brief] No users found');
      return new Response(JSON.stringify({ message: 'No users found' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    let totalBriefs = 0;

    for (const user of users) {
      const userId = user.id as string;

      // 2. Rate limit: skip if a morning_brief already exists today
      const todayStart = new Date();
      todayStart.setUTCHours(0, 0, 0, 0);
      const { count: briefCount } = await supabase
        .from('brain_insights')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('type', 'morning_brief')
        .gte('created_at', todayStart.toISOString());

      if ((briefCount ?? 0) >= 1) {
        console.log(`[jac-morning-brief] Brief already sent today for user ${userId}, skipping`);
        continue;
      }

      // 3. Load context in parallel
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const today = new Date().toISOString().split('T')[0];

      const [
        scheduleCtx,
        tasksRes,
        reflectionsRes,
        entriesRes,
        insightsRes,
      ] = await Promise.all([
        // Schedule context (today + overdue + upcoming week)
        getUserContext(supabase, userId),
        // Completed tasks in last 24h
        supabase
          .from('agent_tasks')
          .select('type, intent')
          .eq('user_id', userId)
          .eq('status', 'completed')
          .gte('created_at', oneDayAgo)
          .order('created_at', { ascending: false })
          .limit(20),
        // Reflections from last 24h
        supabase
          .from('jac_reflections')
          .select('summary')
          .eq('user_id', userId)
          .gte('created_at', oneDayAgo)
          .order('created_at', { ascending: false })
          .limit(10),
        // Entries created in last 24h
        supabase
          .from('entries')
          .select('content_type')
          .eq('user_id', userId)
          .gte('created_at', oneDayAgo)
          .order('created_at', { ascending: false })
          .limit(30),
        // Active undismissed insights
        supabase
          .from('brain_insights')
          .select('title')
          .eq('user_id', userId)
          .eq('dismissed', false)
          .neq('type', 'morning_brief')
          .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
          .order('priority', { ascending: true })
          .limit(5),
      ]);

      const tasks = tasksRes.data || [];
      const reflections = reflectionsRes.data || [];
      const entries = entriesRes.data || [];
      const insights = insightsRes.data || [];

      // 4. Build context string
      const contextParts: string[] = [];

      // Schedule
      contextParts.push(scheduleCtx.contextText);

      // Task summary by type
      if (tasks.length > 0) {
        const typeCounts: Record<string, number> = {};
        const notableIntents: string[] = [];
        for (const t of tasks) {
          typeCounts[t.type] = (typeCounts[t.type] || 0) + 1;
          if (t.intent) notableIntents.push(t.intent);
        }
        contextParts.push('\nAGENT TASKS COMPLETED (last 24h):');
        for (const [type, count] of Object.entries(typeCounts)) {
          contextParts.push(`  - ${type}: ${count} task${count > 1 ? 's' : ''}`);
        }
        if (notableIntents.length > 0) {
          contextParts.push('  Notable intents:');
          for (const intent of notableIntents.slice(0, 10)) {
            contextParts.push(`    - "${intent}"`);
          }
        }
      } else {
        contextParts.push('\nAGENT TASKS COMPLETED (last 24h): None');
      }

      // Reflections
      if (reflections.length > 0) {
        contextParts.push('\nREFLECTIONS (last 24h):');
        for (const r of reflections) {
          contextParts.push(`  - ${r.summary}`);
        }
      }

      // Entries by content_type
      if (entries.length > 0) {
        const typeCounts: Record<string, number> = {};
        for (const e of entries) {
          typeCounts[e.content_type] = (typeCounts[e.content_type] || 0) + 1;
        }
        contextParts.push('\nNEW BRAIN ENTRIES (last 24h):');
        for (const [type, count] of Object.entries(typeCounts)) {
          contextParts.push(`  - ${type}: ${count}`);
        }
      }

      // Active insights
      if (insights.length > 0) {
        contextParts.push('\nACTIVE INSIGHTS:');
        for (const i of insights) {
          contextParts.push(`  - ${i.title}`);
        }
      }

      // 5. Call Claude Haiku with forced tool use
      const dateDisplay = new Date().toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });

      const claudeResponse = await callClaude({
        model: CLAUDE_MODELS.haiku,
        system: `You are JAC, a personal AI assistant compiling a morning brief. Be concise, personal, and useful. No fluff. Today is ${dateDisplay}.

Rules:
- Schedule: summarize what's on today and upcoming. Mention overdue items if any.
- Activity: summarize what you (JAC) did overnight — tasks completed, research done, saves made.
- Brain: new entries saved, reflections generated, any patterns noticed.
- Heads Up: anything that needs attention — overdue items, stale tasks, important upcoming deadlines.
- If a section has nothing, say "Nothing to report" — keep it brief.
- Write in second person ("You have 3 events today...").`,
        messages: [{
          role: 'user',
          content: contextParts.join('\n'),
        }],
        tools: [BRIEF_TOOL],
        tool_choice: { type: 'tool', name: 'morning_brief' },
        max_tokens: 1024,
        temperature: 0.3,
      });

      const toolResult = parseToolUse(claudeResponse);
      const brief = toolResult?.input;

      if (!brief || !brief.schedule || !brief.activity || !brief.brain || !brief.heads_up) {
        console.error(`[jac-morning-brief] Failed to generate brief for user ${userId}`);
        continue;
      }

      // 6. Format the brief body
      const briefBody = [
        `*Schedule*\n${brief.schedule}`,
        `*What JAC Did*\n${brief.activity}`,
        `*Brain Activity*\n${brief.brain}`,
        `*Heads Up*\n${brief.heads_up}`,
      ].join('\n\n');

      const titleDate = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

      // 7. Store as brain_insight
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const { error: insertError } = await supabase
        .from('brain_insights')
        .insert({
          user_id: userId,
          type: 'morning_brief',
          title: `Morning Brief \u2014 ${titleDate}`,
          body: briefBody,
          priority: 1,
          entry_ids: [],
          dismissed: false,
          expires_at: expiresAt,
        });

      if (insertError) {
        console.error(`[jac-morning-brief] Insert error for user ${userId}:`, insertError.message);
        continue;
      }

      totalBriefs++;
      console.log(`[jac-morning-brief] Brief generated for user ${userId}`);

      // 8. Send to Slack
      try {
        const { data: settings } = await supabase
          .from('user_settings')
          .select('settings')
          .eq('user_id', userId)
          .single();

        const slackChannelId = (settings?.settings as Record<string, unknown>)?.slack_channel_id as string | undefined;
        const botToken = Deno.env.get('SLACK_BOT_TOKEN');

        if (slackChannelId && botToken) {
          const slackText = `:sunrise: *Good morning \u2014 here's your brief*\n\n`
            + `:calendar: *Schedule*\n${brief.schedule}\n\n`
            + `:robot_face: *What JAC Did*\n${brief.activity}\n\n`
            + `:brain: *Brain Activity*\n${brief.brain}\n\n`
            + `:warning: *Heads Up*\n${brief.heads_up}\n\n`
            + `<https://www.linkjac.cloud/dashboard|Open Dashboard>`;

          const slackRes = await fetch('https://slack.com/api/chat.postMessage', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${botToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              channel: slackChannelId,
              text: slackText,
            }),
          });

          if (slackRes.ok) {
            const slackData = await slackRes.json();
            if (!slackData.ok) {
              console.warn(`[jac-morning-brief] Slack API error:`, slackData.error);
            }
          } else {
            console.warn(`[jac-morning-brief] Slack POST failed:`, slackRes.status);
          }
        }
      } catch (slackErr) {
        // Slack is best-effort -- never throw
        console.warn('[jac-morning-brief] Slack notification failed:', slackErr);
      }
    }

    console.log(`[jac-morning-brief] Done: ${totalBriefs} briefs sent across ${users.length} users`);

    return new Response(JSON.stringify({
      success: true,
      users: users.length,
      briefs: totalBriefs,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('[jac-morning-brief] Error:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Morning brief failed',
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
