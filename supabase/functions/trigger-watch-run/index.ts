/**
 * trigger-watch-run — Bridge for frontend watch actions
 *
 * Two actions:
 * - run_now: Create child task + fire worker immediately (no effect on schedule)
 * - skip_next: Advance next_run_at to the following occurrence
 *
 * Auth: user JWT (these are human actions from the UI)
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { extractUserId } from '../_shared/auth.ts';

serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  const corsHeaders = getCorsHeaders(req);
  const jsonHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

  try {
    const { userId, error: authError } = await extractUserId(req);
    if (authError || !userId) {
      return new Response(JSON.stringify({ error: authError ?? 'Unauthorized' }), {
        status: 401, headers: jsonHeaders,
      });
    }

    const body = await req.json();
    const { action, watchId } = body;

    if (!watchId || typeof watchId !== 'string') {
      return new Response(JSON.stringify({ error: 'Missing watchId' }), {
        status: 400, headers: jsonHeaders,
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, serviceKey);

    // Validate ownership
    const { data: watch, error: watchError } = await supabase
      .from('agent_tasks')
      .select('*')
      .eq('id', watchId)
      .eq('user_id', userId)
      .not('cron_expression', 'is', null)
      .single();

    if (watchError || !watch) {
      return new Response(JSON.stringify({ error: 'Watch not found or not owned by user' }), {
        status: 404, headers: jsonHeaders,
      });
    }

    const watchInput = (watch.input as Record<string, unknown>) || {};

    if (action === 'run_now') {
      // Fetch last 3 completed children for previousRunContext
      const { data: recentChildren } = await supabase
        .from('agent_tasks')
        .select('id, status, output, completed_at')
        .eq('parent_task_id', watchId)
        .eq('status', 'completed')
        .order('completed_at', { ascending: false })
        .limit(3);

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

      // Count total runs for runNumber
      const { count: totalRuns } = await supabase
        .from('agent_tasks')
        .select('id', { count: 'exact', head: true })
        .eq('parent_task_id', watchId);

      const runNumber = (totalRuns ?? 0) + 1;
      const agentType = (watchInput.agentType as string) || watch.agent || 'jac-research-agent';

      // Create child task
      const { data: childTask, error: insertError } = await supabase
        .from('agent_tasks')
        .insert({
          user_id: userId,
          type: watch.type,
          intent: watch.intent || (watchInput.watchName as string) || 'Watch run',
          agent: agentType,
          status: 'queued',
          input: {
            ...watchInput,
            watchId,
            runNumber,
            previousRunContext: previousRunContext.slice(0, 3000),
          },
          parent_task_id: watchId,
        })
        .select('id')
        .single();

      if (insertError || !childTask) {
        return new Response(JSON.stringify({ error: 'Failed to create child task' }), {
          status: 500, headers: jsonHeaders,
        });
      }

      // Fire worker (fire-and-forget)
      fetch(`${supabaseUrl}/functions/v1/${agentType}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          taskId: childTask.id,
          parentTaskId: watchId,
          userId,
          query: watchInput.query,
          previousRunContext: previousRunContext.slice(0, 3000),
          runNumber,
          watchId,
          modelTier: watchInput.modelTier || 'haiku',
          slack_channel: watchInput.slack_channel,
        }),
      }).catch(err => console.error('[trigger-watch-run] Worker dispatch failed:', err));

      return new Response(JSON.stringify({
        success: true,
        action: 'run_now',
        childTaskId: childTask.id,
      }), { status: 200, headers: jsonHeaders });

    } else if (action === 'skip_next') {
      if (!watch.next_run_at) {
        return new Response(JSON.stringify({ error: 'No scheduled run to skip' }), {
          status: 400, headers: jsonHeaders,
        });
      }

      // Parse cron and compute next occurrence after current next_run_at
      const { parseExpression } = await import('npm:cron-parser@4.9.0');
      const tz = (watchInput.timezone as string) || 'America/New_York';
      const interval = parseExpression(watch.cron_expression, {
        currentDate: new Date(watch.next_run_at),
        tz,
      });
      const nextRunAt = interval.next().toISOString();

      await supabase
        .from('agent_tasks')
        .update({
          next_run_at: nextRunAt,
          updated_at: new Date().toISOString(),
        })
        .eq('id', watchId);

      return new Response(JSON.stringify({
        success: true,
        action: 'skip_next',
        nextRunAt,
      }), { status: 200, headers: jsonHeaders });

    } else {
      return new Response(JSON.stringify({
        error: 'Invalid action. Use "run_now" or "skip_next".',
      }), { status: 400, headers: jsonHeaders });
    }

  } catch (error) {
    console.error('[trigger-watch-run] Error:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Trigger failed',
    }), { status: 500, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } });
  }
});
