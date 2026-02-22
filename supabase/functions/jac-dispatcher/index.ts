/**
 * jac-dispatcher — Boss Agent for JAC Agent OS
 *
 * The brain of the swarm. Receives user messages, searches the brain for context,
 * parses intent via Claude, creates tasks, dispatches workers, returns immediately.
 *
 * Flow:
 * 1. Auth + rate limit + concurrent guard
 * 2. Brain context search (embedding → semantic match)
 * 3. Claude Sonnet intent parse with tool_choice
 * 4. Create parent + child tasks in agent_tasks
 * 5. Store conversation in agent_conversations
 * 6. Fire-and-forget worker edge function
 * 7. Return { response, taskId, status: 'dispatched' }
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { extractUserId } from '../_shared/auth.ts';
import { callClaude, CLAUDE_MODELS, parseToolUse } from '../_shared/anthropic.ts';
import { createAgentLogger } from '../_shared/logger.ts';

// Rate limiting
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT = 50;
const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_CONCURRENT_TASKS = 10;
const DAILY_TASK_LIMIT = 200;

function checkRateLimit(userId: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(userId);
  if (!entry || now > entry.resetTime) {
    rateLimitMap.set(userId, { count: 1, resetTime: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (entry.count >= RATE_LIMIT) return false;
  entry.count++;
  return true;
}

// Intent types the dispatcher can route
type IntentType = 'research' | 'save' | 'search' | 'report' | 'general';

const INTENT_TOOL = {
  name: 'route_intent',
  description: 'Parse the user message and route to the correct JAC agent.',
  input_schema: {
    type: 'object' as const,
    properties: {
      intent: {
        type: 'string',
        enum: ['research', 'save', 'search', 'report', 'general'],
        description: 'The type of task to dispatch',
      },
      summary: {
        type: 'string',
        description: 'A brief 1-sentence summary of what the user wants',
      },
      agentType: {
        type: 'string',
        enum: ['jac-research-agent', 'smart-save', 'search-memory', 'assistant-chat'],
        description: 'Which worker edge function to dispatch',
      },
      response: {
        type: 'string',
        description: 'A brief, natural response to the user acknowledging the request (1-2 sentences)',
      },
    },
    required: ['intent', 'summary', 'agentType', 'response'],
  },
};

// Map intents to worker functions
const AGENT_MAP: Record<string, string> = {
  research: 'jac-research-agent',
  save: 'smart-save',
  search: 'search-memory',
  report: 'jac-research-agent',
  general: 'assistant-chat',
};

serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  const corsHeaders = getCorsHeaders(req);
  const jsonHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

  try {
    // 1. Auth
    const { userId, error: authError } = await extractUserId(req);
    if (authError || !userId) {
      return new Response(JSON.stringify({ error: authError ?? 'Unauthorized' }), {
        status: 401, headers: jsonHeaders,
      });
    }

    // Rate limit
    if (!checkRateLimit(userId)) {
      return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), {
        status: 429, headers: jsonHeaders,
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, serviceKey);

    // Parse body
    let body: { message?: string };
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
        status: 400, headers: jsonHeaders,
      });
    }
    const { message } = body;
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return new Response(JSON.stringify({ error: 'Message is required' }), {
        status: 400, headers: jsonHeaders,
      });
    }

    // 2. Concurrent task guard
    const { count: runningCount } = await supabase
      .from('agent_tasks')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .in('status', ['running', 'queued']);

    if ((runningCount ?? 0) >= MAX_CONCURRENT_TASKS) {
      return new Response(JSON.stringify({
        error: 'Too many tasks running. Please wait for some to complete.',
        running: runningCount,
      }), { status: 429, headers: jsonHeaders });
    }

    // Daily limit guard
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const { count: dailyCount } = await supabase
      .from('agent_tasks')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .gte('created_at', todayStart.toISOString());

    if ((dailyCount ?? 0) >= DAILY_TASK_LIMIT) {
      return new Response(JSON.stringify({
        error: 'Daily task limit reached. Try again tomorrow.',
        dailyCount,
      }), { status: 429, headers: jsonHeaders });
    }

    // 3. Brain context search
    let brainContext = '';
    try {
      const embResponse = await fetch(`${supabaseUrl}/functions/v1/generate-embedding`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text: message }),
      });

      if (embResponse.ok) {
        const embData = await embResponse.json();
        if (embData.embedding) {
          const { data: results } = await supabase.rpc('search_entries_by_embedding', {
            query_embedding: JSON.stringify(embData.embedding),
            match_threshold: 0.55,
            match_count: 5,
            filter_user_id: userId,
          });
          if (results && results.length > 0) {
            brainContext = results
              .map((r: { title?: string; content: string; tags?: string[] }) =>
                `[${r.title || 'Untitled'}]: ${r.content.slice(0, 300)}${r.tags?.length ? ` [tags: ${r.tags.join(', ')}]` : ''}`
              )
              .join('\n');
          }
        }
      }
    } catch (err) {
      console.warn('[jac-dispatcher] Brain search failed (non-blocking):', err);
    }

    // 4. Intent parsing via Claude Sonnet
    const systemPrompt = `You are JAC, a personal AI agent dispatcher. The user sends you a message and you decide what to do with it.

Your job:
- Parse the user's intent
- Pick the right agent to handle it
- Write a brief, confident response acknowledging what you're doing

Intent routing:
- "research" → jac-research-agent: User wants to learn about something, needs web research, wants info synthesized
- "save" → smart-save: User wants to save/remember/note something to their brain
- "search" → search-memory: User wants to find something in their brain
- "report" → jac-research-agent: User wants a comprehensive report or analysis
- "general" → assistant-chat: General conversation, questions about their data, simple requests

${brainContext ? `\nUser's brain context (relevant entries):\n${brainContext}` : ''}

Be concise. Be confident. Don't ask questions — just act.`;

    const claudeResponse = await callClaude({
      model: CLAUDE_MODELS.sonnet,
      system: systemPrompt,
      messages: [{ role: 'user', content: message }],
      tools: [INTENT_TOOL],
      tool_choice: { type: 'tool', name: 'route_intent' },
      max_tokens: 1024,
      temperature: 0.3,
    });

    const toolResult = parseToolUse(claudeResponse);

    // Fallback if tool parsing fails
    const intent: IntentType = (toolResult?.input?.intent as IntentType) || 'general';
    const summary = (toolResult?.input?.summary as string) || message.slice(0, 100);
    const agentType = (toolResult?.input?.agentType as string) || AGENT_MAP[intent] || 'assistant-chat';
    const response = (toolResult?.input?.response as string) || "I'm on it.";

    // 5. Create parent task
    const { data: parentTask, error: parentError } = await supabase
      .from('agent_tasks')
      .insert({
        user_id: userId,
        type: intent,
        status: 'running',
        intent: summary,
        agent: 'jac-dispatcher',
        input: { message, brainContext: brainContext.slice(0, 1000) },
      })
      .select('id')
      .single();

    if (parentError || !parentTask) {
      console.error('[jac-dispatcher] Failed to create parent task:', parentError);
      return new Response(JSON.stringify({ error: 'Failed to create task' }), {
        status: 500, headers: jsonHeaders,
      });
    }

    // Initialize logger now that we have a taskId
    const log = createAgentLogger(supabase, parentTask.id, userId, 'jac-dispatcher');
    await log.info('intent_parsed', {
      intent,
      agentType,
      summary,
      hasBrainContext: brainContext.length > 0,
    });

    // 6. Create child task (if dispatching to a worker)
    let childTaskId: string | null = null;
    if (intent !== 'general') {
      const { data: childTask } = await supabase
        .from('agent_tasks')
        .insert({
          user_id: userId,
          type: intent,
          status: 'queued',
          intent: summary,
          agent: agentType,
          parent_task_id: parentTask.id,
          input: { query: message, brainContext: brainContext.slice(0, 2000) },
        })
        .select('id')
        .single();

      childTaskId = childTask?.id ?? null;
    }

    // 7. Store conversation
    const taskIds = [parentTask.id];
    if (childTaskId) taskIds.push(childTaskId);

    await supabase.from('agent_conversations').insert([
      { user_id: userId, role: 'user', content: message, task_ids: taskIds },
      { user_id: userId, role: 'assistant', content: response, task_ids: taskIds },
    ]);

    // 8. Fire-and-forget worker dispatch
    if (intent !== 'general' && childTaskId) {
      await log.info('worker_dispatched', { agentType, childTaskId });
      const workerUrl = `${supabaseUrl}/functions/v1/${agentType}`;
      fetch(workerUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          taskId: childTaskId,
          parentTaskId: parentTask.id,
          userId,
          query: message,
          brainContext: brainContext.slice(0, 2000),
        }),
      }).then(async (res) => {
        if (!res.ok) {
          const errText = await res.text().catch(() => 'unknown');
          console.error(`[jac-dispatcher] Worker ${agentType} returned ${res.status}: ${errText}`);
          // Mark child task as failed so it doesn't stay stuck
          await supabase.from('agent_tasks')
            .update({ status: 'failed', error: `Dispatch failed: ${res.status}`, completed_at: new Date().toISOString() })
            .eq('id', childTaskId);
          // Mark parent as failed too
          await supabase.from('agent_tasks')
            .update({ status: 'failed', error: `Worker ${agentType} failed to start`, completed_at: new Date().toISOString() })
            .eq('id', parentTask.id);
        }
      }).catch(async (err) => {
        console.error(`[jac-dispatcher] Worker dispatch failed for ${agentType}:`, err);
        // Mark tasks as failed so they don't stay stuck in queued/running
        await supabase.from('agent_tasks')
          .update({ status: 'failed', error: `Dispatch error: ${err.message || 'network error'}`, completed_at: new Date().toISOString() })
          .eq('id', childTaskId);
        await supabase.from('agent_tasks')
          .update({ status: 'failed', error: `Worker ${agentType} unreachable`, completed_at: new Date().toISOString() })
          .eq('id', parentTask.id);
      });
    } else if (intent === 'general') {
      // For general intent, mark parent as completed immediately
      await supabase
        .from('agent_tasks')
        .update({ status: 'completed', completed_at: new Date().toISOString() })
        .eq('id', parentTask.id);
    }

    // 9. Return immediately
    return new Response(JSON.stringify({
      response,
      taskId: parentTask.id,
      childTaskId,
      intent,
      agentType,
      status: intent === 'general' ? 'completed' : 'dispatched',
    }), { status: 200, headers: jsonHeaders });

  } catch (error) {
    console.error('[jac-dispatcher] Error:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Internal server error',
    }), { status: 500, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } });
  }
});
