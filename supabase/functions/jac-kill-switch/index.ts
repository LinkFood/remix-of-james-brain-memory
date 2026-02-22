/**
 * jac-kill-switch — Emergency stop for JAC Agent OS
 *
 * Two actions:
 * - stop_all: Cancel all running/queued/pending tasks for user
 * - stop_one: Cancel one specific task
 *
 * Auth: user JWT (cancellation is a human action)
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
    const { action, taskId } = body;

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, serviceKey);

    const now = new Date().toISOString();

    if (action === 'stop_all') {
      // Cancel all running/queued/pending tasks for this user
      const { data: cancelled } = await supabase
        .from('agent_tasks')
        .update({
          status: 'cancelled',
          cancelled_at: now,
          updated_at: now,
          error: 'Cancelled by user',
        })
        .eq('user_id', userId)
        .in('status', ['running', 'queued', 'pending'])
        .select('id');

      const count = cancelled?.length ?? 0;
      const ids = (cancelled ?? []).map((t: { id: string }) => t.id);

      return new Response(JSON.stringify({
        success: true,
        action: 'stop_all',
        cancelled: count,
        cancelledIds: ids,
      }), { status: 200, headers: jsonHeaders });

    } else if (action === 'stop_one' && taskId) {
      // Cancel one specific task (with ownership check)
      const { data: cancelled } = await supabase
        .from('agent_tasks')
        .update({
          status: 'cancelled',
          cancelled_at: now,
          updated_at: now,
          error: 'Cancelled by user',
        })
        .eq('id', taskId)
        .eq('user_id', userId)
        .in('status', ['running', 'queued', 'pending'])
        .select('id');

      const count = cancelled?.length ?? 0;

      return new Response(JSON.stringify({
        success: true,
        action: 'stop_one',
        cancelled: count,
        cancelledIds: count > 0 ? [taskId] : [],
      }), { status: 200, headers: jsonHeaders });

    } else {
      return new Response(JSON.stringify({
        error: 'Invalid action. Use "stop_all" or "stop_one" with taskId.',
      }), { status: 400, headers: jsonHeaders });
    }

  } catch (error) {
    console.error('[jac-kill-switch] Error:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Kill switch error',
    }), { status: 500, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } });
  }
});
