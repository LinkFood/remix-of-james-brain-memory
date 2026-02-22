/**
 * jac-search-agent — Search Worker for JAC Agent OS
 *
 * Thin wrapper around search-memory that adds JAC observability:
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
  let slackChannel: string | undefined;
  let slackThinkingTs: string | undefined;
  const startTime = Date.now();

  try {
    const body = await req.json();
    taskId = body.taskId;
    parentTaskId = body.parentTaskId;
    userId = body.userId;
    const query = body.query as string;
    slackChannel = body.slack_channel as string | undefined;
    slackThinkingTs = body.slack_thinking_ts as string | undefined;

    if (!taskId || !userId || !query) {
      return new Response(JSON.stringify({ error: 'Missing required fields' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const log = createAgentLogger(supabase, taskId, userId, 'jac-search-agent');

    // 1. Update task → running
    await supabase
      .from('agent_tasks')
      .update({ status: 'running', updated_at: new Date().toISOString() })
      .eq('id', taskId);

    await log.info('task_started', { query });

    // 2. Call search-memory internally
    const searchStep = await log.step('search_memory', { query });
    const searchRes = await fetch(`${supabaseUrl}/functions/v1/search-memory`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ userId, query, limit: 10 }),
    });

    if (!searchRes.ok) {
      const errText = await searchRes.text();
      await searchStep.fail(`HTTP ${searchRes.status}: ${errText.slice(0, 200)}`);
      throw new Error(`search-memory failed: ${searchRes.status}`);
    }

    const searchData = await searchRes.json();
    const results = searchData.results || [];
    const resultCount = results.length;

    await searchStep({ resultCount });

    const duration = Date.now() - startTime;

    // 3. Build summary for output
    const resultSummary = results
      .slice(0, 3)
      .map((r: { title?: string; content: string; similarity?: number }) =>
        `*${r.title || 'Untitled'}* (${r.similarity ? `${(r.similarity * 100).toFixed(0)}% match` : 'match'})\n${r.content.slice(0, 300).trim()}${r.content.length > 300 ? '...' : ''}`
      )
      .join('\n\n');

    // 4. Update task → completed (guard: only if still running — cancelled tasks stay cancelled)
    await supabase
      .from('agent_tasks')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        output: {
          results: results.slice(0, 10).map((r: { id: string; title?: string; content: string; similarity?: number }) => ({
            id: r.id,
            title: r.title || 'Untitled',
            snippet: r.content.slice(0, 200),
            similarity: r.similarity,
          })),
          resultCount,
          durationMs: duration,
        },
      })
      .eq('id', taskId)
      .in('status', ['running']);

    // 5. Check if parent task should be completed
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
          .eq('id', parentTaskId)
          .in('status', ['running']);
      }
    }

    // 6. Slack notification
    const slackStep = await log.step('slack_notify');
    await notifySlack(supabase, userId, {
      taskId,
      taskType: 'search',
      summary: `Found ${resultCount} results for: "${query.slice(0, 60)}"\n\n${resultSummary || 'No matching entries.'}`,
      duration,
      slackChannel,
      slackThinkingTs,
    });
    await slackStep();

    // 7. Store result as assistant message
    const responseContent = resultCount > 0
      ? `Found ${resultCount} brain entries matching "${query}":\n\n${resultSummary}`
      : `No brain entries found matching "${query}".`;

    await supabase.from('agent_conversations').insert({
      user_id: userId,
      role: 'assistant',
      content: responseContent,
      task_ids: [taskId],
    });

    await log.info('task_completed', { durationMs: duration, resultCount });

    return new Response(JSON.stringify({
      success: true,
      resultCount,
      results: results.slice(0, 10),
      durationMs: duration,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('[jac-search-agent] Error:', error);

    if (taskId) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await supabase
        .from('agent_tasks')
        .update({
          status: 'failed',
          error: errorMessage,
          updated_at: new Date().toISOString(),
        })
        .eq('id', taskId)
        .in('status', ['running', 'queued']);

      if (parentTaskId) {
        await supabase
          .from('agent_tasks')
          .update({
            status: 'failed',
            error: `Child task failed: ${errorMessage}`,
            completed_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', parentTaskId)
          .in('status', ['running', 'queued']);
      }

      if (userId) {
        const log = createAgentLogger(supabase, taskId, userId, 'jac-search-agent');
        await log.info('task_failed', { error: errorMessage, durationMs: Date.now() - startTime });

        await notifySlack(supabase, userId, {
          taskId,
          taskType: 'search',
          summary: '',
          error: errorMessage,
          duration: Date.now() - startTime,
          slackChannel,
          slackThinkingTs,
        });
      }
    }

    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Search agent failed',
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
