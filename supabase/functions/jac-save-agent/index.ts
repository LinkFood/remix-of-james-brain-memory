/**
 * jac-save-agent — Save Worker for JAC Agent OS
 *
 * Thin wrapper around smart-save that adds JAC observability:
 * task status transitions, step logging, Slack notifications.
 * Called by jac-dispatcher via service role fetch.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { notifySlack } from '../_shared/slack.ts';
import { createAgentLogger } from '../_shared/logger.ts';

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

  let taskId: string | undefined;
  let parentTaskId: string | undefined;
  let userId: string | undefined;
  const startTime = Date.now();

  try {
    const body = await req.json();
    taskId = body.taskId;
    parentTaskId = body.parentTaskId;
    userId = body.userId;
    const query = body.query as string;
    const slack_channel = body.slack_channel as string | undefined;
    const slack_thread_ts = body.slack_thread_ts as string | undefined;

    if (!taskId || !userId || !query) {
      return new Response(JSON.stringify({ error: 'Missing required fields' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const log = createAgentLogger(supabase, taskId, userId, 'jac-save-agent');

    // 1. Update task → running
    await supabase
      .from('agent_tasks')
      .update({ status: 'running', updated_at: new Date().toISOString() })
      .eq('id', taskId);

    await log.info('task_started', { query });

    // 2. Call smart-save internally
    const saveStep = await log.step('smart_save', { query });
    const saveRes = await fetch(`${supabaseUrl}/functions/v1/smart-save`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ userId, content: query, source: 'jac-agent' }),
    });

    if (!saveRes.ok) {
      const errText = await saveRes.text();
      await saveStep.fail(`HTTP ${saveRes.status}: ${errText.slice(0, 200)}`);
      throw new Error(`smart-save failed: ${saveRes.status}`);
    }

    const saveData = await saveRes.json();
    const entryId = saveData.entry?.id;
    const entryTitle = saveData.entry?.title || 'Untitled';
    const entryType = saveData.entry?.type || 'note';

    await saveStep();
    await log.info('save_result', { entryId, entryTitle, entryType });

    const duration = Date.now() - startTime;

    // 3. Update task → completed
    await supabase
      .from('agent_tasks')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        output: { entryId, entryTitle, entryType, durationMs: duration },
      })
      .eq('id', taskId);

    // 4. Check if parent task should be completed
    if (parentTaskId) {
      const { count: pendingChildren } = await supabase
        .from('agent_tasks')
        .select('id', { count: 'exact', head: true })
        .eq('parent_task_id', parentTaskId)
        .in('status', ['queued', 'running']);

      if ((pendingChildren ?? 0) === 0) {
        await supabase
          .from('agent_tasks')
          .update({
            status: 'completed',
            completed_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', parentTaskId);
      }
    }

    // 5. Slack notification
    const slackStep = await log.step('slack_notify');
    await notifySlack(supabase, userId, {
      taskId,
      taskType: 'save',
      summary: `Saved: "${entryTitle}" (${entryType})`,
      brainEntryId: entryId,
      duration,
      slackChannel: slack_channel,
      slackThreadTs: slack_thread_ts,
    });
    await slackStep();

    // 6. Store result as assistant message
    await supabase.from('agent_conversations').insert({
      user_id: userId,
      role: 'assistant',
      content: `Saved to brain: "${entryTitle}" (${entryType})${entryId ? `\nEntry: ${entryId.slice(0, 8)}` : ''}`,
      task_ids: [taskId],
    });

    await log.info('task_completed', { durationMs: duration, entryId });

    return new Response(JSON.stringify({
      success: true,
      entryId,
      entryTitle,
      entryType,
      durationMs: duration,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('[jac-save-agent] Error:', error);

    if (taskId) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await supabase
        .from('agent_tasks')
        .update({
          status: 'failed',
          error: errorMessage,
          updated_at: new Date().toISOString(),
        })
        .eq('id', taskId);

      if (parentTaskId) {
        await supabase
          .from('agent_tasks')
          .update({
            status: 'failed',
            error: `Child task failed: ${errorMessage}`,
            completed_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', parentTaskId);
      }

      if (userId) {
        const log = createAgentLogger(supabase, taskId, userId, 'jac-save-agent');
        await log.info('task_failed', { error: errorMessage, durationMs: Date.now() - startTime });

        await notifySlack(supabase, userId, {
          taskId,
          taskType: 'save',
          summary: '',
          error: errorMessage,
          duration: Date.now() - startTime,
          slackChannel: slack_channel,
          slackThreadTs: slack_thread_ts,
        });
      }
    }

    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Save agent failed',
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
