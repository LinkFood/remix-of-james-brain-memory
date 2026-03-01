/**
 * jac-reflect — Reflection Worker for JAC Agent OS
 *
 * Called fire-and-forget by worker agents after task completion.
 * Generates a 1-2 sentence reflection on the completed task via Claude Haiku,
 * embeds it, stores in jac_reflections, and finds connected brain entries.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { callClaude, CLAUDE_MODELS, parseTextContent } from '../_shared/anthropic.ts';

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
    const body = await req.json();
    const userId = body.userId as string;
    const taskId = body.taskId as string;

    if (!userId || !taskId) {
      return new Response(JSON.stringify({ error: 'Missing userId or taskId' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 1. Load the completed task
    const { data: task, error: taskError } = await supabase
      .from('agent_tasks')
      .select('id, type, intent, output, status')
      .eq('id', taskId)
      .single();

    if (taskError || !task) {
      console.error('[jac-reflect] Task not found:', taskId, taskError?.message);
      return new Response(JSON.stringify({ error: 'Task not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 2. Load last 5 reflections for context
    const { data: recentReflections } = await supabase
      .from('jac_reflections')
      .select('task_type, intent, summary')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(5);

    const reflectionContext = (recentReflections || [])
      .map((r: { task_type: string; intent: string | null; summary: string }) =>
        `- ${r.task_type}: ${r.intent || 'no intent'} -> ${r.summary}`
      )
      .join('\n');

    // 3. Call Claude Haiku to generate reflection
    const taskOutput = typeof task.output === 'object' ? JSON.stringify(task.output).slice(0, 2000) : String(task.output || '').slice(0, 2000);

    const claudeResponse = await callClaude({
      model: CLAUDE_MODELS.haiku,
      system: `You are JAC's reflection engine. Generate a 1-2 sentence reflection on a completed task. Focus on what was accomplished, what was learned, or what patterns you notice. Be concise and specific.`,
      messages: [{
        role: 'user',
        content: `Task type: ${task.type}
Intent: ${task.intent || 'none'}
Status: ${task.status}
Output: ${taskOutput}
${reflectionContext ? `\nRecent reflections:\n${reflectionContext}` : ''}

Generate a 1-2 sentence reflection.`,
      }],
      max_tokens: 256,
      temperature: 0.4,
    });

    const summary = parseTextContent(claudeResponse);
    if (!summary) {
      console.warn('[jac-reflect] Claude returned empty reflection');
      return new Response(JSON.stringify({ error: 'Empty reflection' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 4. Generate embedding
    let embedding: number[] | null = null;
    try {
      const embRes = await fetch(`${supabaseUrl}/functions/v1/generate-embedding`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text: `${task.type} | ${task.intent || ''} | ${summary}`, input_type: 'document' }),
      });

      if (embRes.ok) {
        const embData = await embRes.json();
        embedding = embData.embedding || null;
      } else {
        console.warn('[jac-reflect] Embedding generation failed:', embRes.status);
      }
    } catch (err) {
      console.warn('[jac-reflect] Embedding fetch error:', err);
    }

    // 5. Find related entries via semantic search
    let connections: string[] = [];
    if (embedding) {
      try {
        const { data: related } = await supabase.rpc('search_entries_by_embedding', {
          query_embedding: JSON.stringify(embedding),
          match_threshold: 0.5,
          match_count: 5,
          filter_user_id: userId,
        });

        if (related && related.length > 0) {
          connections = related.map((r: { id: string }) => r.id);
        }
      } catch (err) {
        console.warn('[jac-reflect] Related entries search failed:', err);
      }
    }

    // 6. Insert into jac_reflections
    const { error: insertError } = await supabase
      .from('jac_reflections')
      .insert({
        user_id: userId,
        task_id: taskId,
        task_type: task.type,
        intent: task.intent,
        summary,
        connections: connections.length > 0 ? connections : null,
        embedding: embedding ? JSON.stringify(embedding) : null,
      });

    if (insertError) {
      console.error('[jac-reflect] Insert error:', insertError);
      return new Response(JSON.stringify({ error: insertError.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    console.log(`[jac-reflect] Reflection saved for task ${taskId}: ${summary.slice(0, 100)}`);

    return new Response(JSON.stringify({
      success: true,
      summary: summary.slice(0, 200),
      connections: connections.length,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('[jac-reflect] Error:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Reflection failed',
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
