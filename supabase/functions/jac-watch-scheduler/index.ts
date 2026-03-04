/**
 * jac-watch-scheduler — Recurring Watch Engine for JAC Agent OS
 *
 * Called by pg_cron every 5 minutes. Finds watches (recurring tasks)
 * that are due and fires them:
 * 1. Query due watches (cron_active, next_run_at <= now)
 * 2. Check failure circuit breaker (3 consecutive failures = auto-disable)
 * 3. Build previousRunContext from last completed children
 * 4. Create child task + fire worker
 * 5. Advance next_run_at via cron-parser
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { createAgentLogger } from '../_shared/logger.ts';
import { notifySlack } from '../_shared/slack.ts';
import CronParser from 'npm:cron-parser@4.9.0';

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
    // 1. Query due watches (max 10 per cycle)
    const { data: dueWatches, error: queryError } = await supabase
      .from('agent_tasks')
      .select('*')
      .eq('cron_active', true)
      .lte('next_run_at', new Date().toISOString())
      .eq('status', 'running')
      .limit(10);

    if (queryError) {
      console.error('[watch-scheduler] Query error:', queryError);
      return new Response(JSON.stringify({ error: queryError.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (!dueWatches || dueWatches.length === 0) {
      return new Response(JSON.stringify({ processed: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    console.log(`[watch-scheduler] Found ${dueWatches.length} due watch(es)`);
    let processed = 0;

    for (const watch of dueWatches) {
      try {
        const log = createAgentLogger(supabase, watch.id, watch.user_id, 'jac-watch-scheduler');
        const watchInput = (watch.input as Record<string, unknown>) || {};
        const watchName = (watchInput.query as string) || (watchInput.watchName as string) || 'Unnamed watch';
        const agentType = (watchInput.agentType as string) || watch.agent || 'jac-research-agent';

        // 2. Fetch last 3 completed children
        const { data: recentChildren } = await supabase
          .from('agent_tasks')
          .select('id, status, output, completed_at, error')
          .eq('parent_task_id', watch.id)
          .eq('status', 'completed')
          .order('completed_at', { ascending: false })
          .limit(3);

        // 3. Check failure circuit breaker — last 3 children (any status)
        const { data: lastThree } = await supabase
          .from('agent_tasks')
          .select('status')
          .eq('parent_task_id', watch.id)
          .in('status', ['completed', 'failed'])
          .order('created_at', { ascending: false })
          .limit(3);

        const allFailed = lastThree &&
          lastThree.length >= 3 &&
          lastThree.every(t => t.status === 'failed');

        if (allFailed) {
          console.warn(`[watch-scheduler] Auto-disabling watch ${watch.id} — 3 consecutive failures`);

          await supabase
            .from('agent_tasks')
            .update({
              cron_active: false,
              updated_at: new Date().toISOString(),
            })
            .eq('id', watch.id);

          await log.info('watch_auto_disabled', { reason: '3 consecutive failures', watchName });

          try {
            await notifySlack(supabase, watch.user_id, {
              taskId: watch.id,
              taskType: 'monitor',
              summary: `Watch auto-disabled after 3 consecutive failures: "${watchName}"`,
              slackChannel: watchInput.slack_channel as string | undefined,
            });
          } catch (_) {
            // Never throw from Slack code
          }

          continue;
        }

        // 4. Build previousRunContext from completed children
        let previousRunContext = '';
        if (recentChildren && recentChildren.length > 0) {
          previousRunContext = recentChildren
            .map((child, i) => {
              const output = child.output as Record<string, unknown> | null;
              const brief = (output?.brief as string) || 'No output';
              return `--- Run ${recentChildren.length - i} (${child.completed_at}) ---\n${brief.slice(0, 500)}`;
            })
            .reverse()
            .join('\n\n');
        }

        // Count total completed children for run number
        const { count: totalRuns } = await supabase
          .from('agent_tasks')
          .select('id', { count: 'exact', head: true })
          .eq('parent_task_id', watch.id)
          .in('status', ['completed', 'failed', 'running', 'queued']);

        const runNumber = (totalRuns ?? 0) + 1;

        // 5. Create child task
        const { data: childTask, error: insertError } = await supabase
          .from('agent_tasks')
          .insert({
            user_id: watch.user_id,
            type: watch.type,
            intent: watch.intent || watchName,
            agent: agentType,
            status: 'queued',
            input: {
              ...watchInput,
              watchId: watch.id,
              runNumber,
              previousRunContext: previousRunContext.slice(0, 3000),
            },
            parent_task_id: watch.id,
          })
          .select('id')
          .single();

        if (insertError || !childTask) {
          console.error(`[watch-scheduler] Failed to create child task for watch ${watch.id}:`, insertError);
          await log.info('child_task_create_failed', { error: insertError?.message });
          continue;
        }

        await log.info('watch_fired', {
          watchName,
          runNumber,
          childTaskId: childTask.id,
          agentType,
        });

        // 6. Fire worker (fire-and-forget)
        fetch(`${supabaseUrl}/functions/v1/${agentType}`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${serviceKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            taskId: childTask.id,
            parentTaskId: watch.id,
            userId: watch.user_id,
            query: watchInput.query,
            previousRunContext: previousRunContext.slice(0, 3000),
            runNumber,
            watchId: watch.id,
            modelTier: watchInput.modelTier || 'haiku',
            slack_channel: watchInput.slack_channel,
          }),
        }).catch(err => console.error('[watch-scheduler] Worker dispatch failed:', err));

        // 7. Advance next_run_at
        try {
          const interval = CronParser.parseExpression(watch.cron_expression, {
            tz: watchInput.timezone as string || 'America/New_York',
          });
          const nextRun = interval.next().toISOString();

          await supabase
            .from('agent_tasks')
            .update({
              next_run_at: nextRun,
              updated_at: new Date().toISOString(),
            })
            .eq('id', watch.id);

          await log.info('next_run_scheduled', { nextRun, cronExpression: watch.cron_expression });
        } catch (cronErr) {
          console.error(`[watch-scheduler] Cron parse failed for watch ${watch.id}:`, cronErr);
          await log.info('cron_parse_failed', {
            error: cronErr instanceof Error ? cronErr.message : 'Unknown error',
            cronExpression: watch.cron_expression,
          });
        }

        processed++;
      } catch (watchErr) {
        console.error(`[watch-scheduler] Error processing watch ${watch.id}:`, watchErr);
      }
    }

    return new Response(JSON.stringify({ processed, total: dueWatches.length }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('[watch-scheduler] Fatal error:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Watch scheduler failed',
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
