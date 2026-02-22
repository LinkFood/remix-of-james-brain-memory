/**
 * task-dispatcher — Intent analysis & agent orchestration
 * 
 * Analyzes user intent via Claude, creates agent_tasks, and spawns workers.
 * Pass 1: Foundation only — worker agents are placeholders for Pass 2.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { extractUserId } from '../_shared/auth.ts';
import { checkRateLimit, getRateLimitHeaders } from '../_shared/rateLimit.ts';
import { successResponse, errorResponse, serverErrorResponse } from '../_shared/response.ts';
import { parseJsonBody, sanitizeString } from '../_shared/validation.ts';
import { callClaude, parseToolUse, CLAUDE_MODELS, ClaudeError } from '../_shared/anthropic.ts';

interface DispatchRequest {
  intent: string;
  context?: Record<string, unknown>;
}

interface AgentPlan {
  taskType: string;
  agents: Array<{ name: string; description: string; input: Record<string, unknown> }>;
  reasoning: string;
}

Deno.serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  try {
    const { userId, error: authError } = await extractUserId(req);
    if (authError || !userId) {
      return errorResponse(req, authError || 'Authorization required', 401);
    }

    // Rate limit: 30 dispatches per hour
    const rateLimitResult = checkRateLimit(`dispatch:${userId}`, { maxRequests: 30, windowMs: 3600000 });
    if (!rateLimitResult.allowed) {
      return new Response(
        JSON.stringify({ error: 'Rate limit exceeded', retryAfter: Math.ceil(rateLimitResult.resetIn / 1000) }),
        { status: 429, headers: { ...getCorsHeaders(req), ...getRateLimitHeaders(rateLimitResult), 'Content-Type': 'application/json' } }
      );
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { data: body, error: parseError } = await parseJsonBody<DispatchRequest>(req);
    if (parseError || !body) {
      return errorResponse(req, parseError || 'Invalid request body', 400);
    }

    const intent = sanitizeString(body.intent || '');
    if (!intent || intent.length < 3) {
      return errorResponse(req, 'Intent is required (min 3 chars)', 400);
    }

    // Check concurrent task limit
    const { count: runningCount } = await supabase
      .from('agent_tasks')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .in('status', ['pending', 'running']);

    if ((runningCount || 0) >= 10) {
      return errorResponse(req, 'Too many concurrent tasks (max 10). Wait for some to complete.', 429);
    }

    // Check daily limit
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const { count: dailyCount } = await supabase
      .from('agent_tasks')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .gte('created_at', todayStart.toISOString());

    if ((dailyCount || 0) >= 200) {
      return errorResponse(req, 'Daily task limit reached (200/day). Try again tomorrow.', 429);
    }

    // Analyze intent with Claude
    const claudeResponse = await callClaude({
      model: CLAUDE_MODELS.haiku,
      system: `You are a task dispatcher for LinkJac. Analyze the user's intent and determine what agent(s) to spawn.

Available agents (Pass 1 — more coming):
- "search": Search the user's brain entries
- "save": Save new content to the brain
- "enrich": Enrich an existing entry with external context
- "report": Generate a brain report
- "general": General-purpose task

Determine the task type and which agents are needed. Be concise.`,
      messages: [{ role: 'user', content: `User intent: "${intent}"\n\nContext: ${JSON.stringify(body.context || {})}` }],
      tools: [{
        name: 'plan_task',
        description: 'Plan the task execution',
        input_schema: {
          type: 'object',
          properties: {
            taskType: { type: 'string', enum: ['search', 'save', 'enrich', 'report', 'general'] },
            agents: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  description: { type: 'string' },
                  input: { type: 'object' },
                },
                required: ['name', 'description'],
              },
            },
            reasoning: { type: 'string' },
          },
          required: ['taskType', 'agents', 'reasoning'],
        },
      }],
      tool_choice: { type: 'tool', name: 'plan_task' },
      max_tokens: 1000,
    });

    const toolResult = parseToolUse(claudeResponse);
    if (!toolResult) {
      return serverErrorResponse(req, 'Failed to analyze intent');
    }

    const plan = toolResult.input as unknown as AgentPlan;

    // Create parent task
    const { data: parentTask, error: insertError } = await supabase
      .from('agent_tasks')
      .insert({
        user_id: userId,
        type: plan.taskType,
        status: 'running',
        intent,
        agent: 'dispatcher',
        input: { context: body.context || {}, plan },
      })
      .select()
      .single();

    if (insertError) {
      console.error('Failed to create task:', insertError);
      return serverErrorResponse(req, 'Failed to create task');
    }

    console.log(`Task ${parentTask.id} created: ${plan.taskType} with ${plan.agents.length} agents`);

    // TODO (Pass 2): Spawn worker agents via parallel fetch
    // For now, mark as completed with the plan
    await supabase
      .from('agent_tasks')
      .update({
        status: 'completed',
        output: {
          plan,
          message: 'Task dispatched successfully. Worker agents coming in Pass 2.',
        },
      })
      .eq('id', parentTask.id);

    return successResponse(req, {
      taskId: parentTask.id,
      plan,
      status: 'completed',
      message: 'Task dispatched. Worker agents coming in Pass 2.',
    }, 200, rateLimitResult);

  } catch (error) {
    console.error('Error in task-dispatcher:', error);
    if (error instanceof ClaudeError) {
      return errorResponse(req, error.message, error.status);
    }
    return serverErrorResponse(req, error instanceof Error ? error : 'Unknown error');
  }
});
