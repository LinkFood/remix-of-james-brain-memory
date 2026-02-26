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
import { extractUserId, extractUserIdWithServiceRole } from '../_shared/auth.ts';
import { callClaude, CLAUDE_MODELS, parseToolUse, parseTextContent } from '../_shared/anthropic.ts';
import { createAgentLogger } from '../_shared/logger.ts';
import { markdownToMrkdwn } from '../_shared/slack.ts';
import { getUserContext } from '../_shared/context.ts';

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
type IntentType = 'research' | 'save' | 'search' | 'report' | 'general' | 'code';

const INTENT_TOOL = {
  name: 'route_intent',
  description: 'Parse the user message and route to the correct JAC agent.',
  input_schema: {
    type: 'object' as const,
    properties: {
      intent: {
        type: 'string',
        enum: ['research', 'save', 'search', 'report', 'general', 'code'],
        description: 'Use "research" for any question about the real world or current information. Use "search" ONLY when user explicitly asks to find their own saved brain entries (e.g. "search my brain", "what did I save").',
      },
      summary: {
        type: 'string',
        description: 'A brief 1-sentence summary of what the user wants',
      },
      agentType: {
        type: 'string',
        enum: ['jac-research-agent', 'jac-save-agent', 'jac-search-agent', 'jac-code-agent', 'assistant-chat'],
        description: 'Which worker edge function to dispatch',
      },
      extractedQuery: {
        type: 'string',
        description: 'The core query/content extracted from the user message, stripped of intent words. For search: just the search terms (e.g. "Lovable" from "search my brain for Lovable"). For save: just the content to save. For research: the research topic.',
      },
      response: {
        type: 'string',
        description: 'A brief, natural response to the user acknowledging the request (1-2 sentences)',
      },
    },
    required: ['intent', 'summary', 'agentType', 'extractedQuery', 'response'],
  },
};

// Map intents to worker functions
const AGENT_MAP: Record<string, string> = {
  research: 'jac-research-agent',
  save: 'jac-save-agent',
  search: 'jac-search-agent',
  report: 'jac-research-agent',
  general: 'assistant-chat',
  code: 'jac-code-agent',
};

serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  const corsHeaders = getCorsHeaders(req);
  const jsonHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

  let slackChannel: string | undefined;
  let slackThinkingTs: string | undefined;

  try {
    // Parse body first (needed for service-role auth which reads userId from body)
    let body: { message?: string; userId?: string; slack_channel?: string; slack_thinking_ts?: string; source?: string; context?: { projectId?: string; repoFullName?: string; branch?: string; techStack?: string[] }; type?: string };
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
        status: 400, headers: jsonHeaders,
      });
    }

    // 1. Auth — supports both user JWT and service-role + userId in body
    const { userId, error: authError } = await extractUserIdWithServiceRole(req, body as Record<string, unknown>);
    if (authError || !userId) {
      console.error('[jac-dispatcher] Auth failed:', authError);
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
    const supabaseEarly = createClient(supabaseUrl, serviceKey);

    // Loop detection: 5+ tasks in 60 seconds = runaway
    const loopWindow = new Date(Date.now() - 60_000).toISOString();
    const { count: recentTaskCount } = await supabaseEarly
      .from('agent_tasks')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .gte('created_at', loopWindow);

    if ((recentTaskCount ?? 0) >= 5) {
      // Auto-cancel all running/queued tasks
      const { data: cancelled } = await supabaseEarly
        .from('agent_tasks')
        .update({
          status: 'cancelled',
          cancelled_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          error: 'Loop detected — auto-cancelled',
        })
        .eq('user_id', userId)
        .in('status', ['running', 'queued', 'pending'])
        .select('id');

      const cancelCount = cancelled?.length ?? 0;

      // Slack warning
      const botToken = Deno.env.get('SLACK_BOT_TOKEN');
      if (botToken) {
        try {
          // Find user's Slack channel from a recent task
          const { data: recentTask } = await supabaseEarly
            .from('agent_tasks')
            .select('input')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(1)
            .single();
          const channel = (recentTask?.input as Record<string, unknown>)?.slack_channel as string | undefined;
          if (channel) {
            fetch('https://slack.com/api/chat.postMessage', {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${botToken}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                channel,
                text: `:warning: Loop detected — ${cancelCount} tasks auto-cancelled. Too many requests in 60 seconds. Standing by.`,
              }),
            }).catch(() => {});
          }
        } catch {}
      }

      return new Response(JSON.stringify({
        error: 'Loop detected — too many tasks in 60 seconds. All tasks cancelled.',
        cancelled: cancelCount,
      }), { status: 429, headers: jsonHeaders });
    }
    const supabase = supabaseEarly;

    const { message, slack_channel, slack_thinking_ts, source } = body;
    slackChannel = slack_channel;
    slackThinkingTs = slack_thinking_ts;
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return new Response(JSON.stringify({ error: 'Message is required' }), {
        status: 400, headers: jsonHeaders,
      });
    }

    // 2a. Clean stale tasks (stuck in running/queued > 10 min) before counting
    // Don't overwrite cancelled tasks
    const staleThreshold = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await supabase
      .from('agent_tasks')
      .update({ status: 'failed', error: 'Timed out (stale >10min)', completed_at: new Date().toISOString() })
      .eq('user_id', userId)
      .in('status', ['running', 'queued'])
      .not('status', 'eq', 'cancelled')
      .lt('created_at', staleThreshold);

    // 2b. Concurrent task guard
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

    // 3. Brain context search (keyword-based — embedding endpoint is unreliable)
    let brainContext = '';
    try {
      const searchWords = message.toLowerCase().split(/\s+/)
        .filter((w: string) => w.length >= 3 && !/^(the|and|or|is|it|to|a|an|in|on|at|for|of|my|me|do|what|how|when|where|why|can|you|please|could|would|should|this|that|with|from|have|has|just|about|been|want|need|like|find|get|show|tell|help)$/i.test(w))
        .slice(0, 5);

      if (searchWords.length > 0) {
        // Search across ALL keywords with OR conditions (not just the first one)
        const orClauses = searchWords
          .map(w => `content.ilike.%${w}%,title.ilike.%${w}%`)
          .join(',');
        const { data: contentResults } = await supabase
          .from('entries')
          .select('id, content, title, tags')
          .eq('user_id', userId)
          .eq('archived', false)
          .or(orClauses)
          .order('created_at', { ascending: false })
          .limit(10);

        const results: Array<{ id: string; content: string; title?: string; tags?: string[] }> = [];
        if (contentResults) {
          for (const r of contentResults) {
            if (!results.find(e => e.id === r.id)) results.push(r as any);
          }
        }

        // Tag search for remaining words
        if (results.length < 5) {
          for (const word of searchWords.slice(0, 3)) {
            const { data: tagResults } = await supabase
              .from('entries')
              .select('id, content, title, tags')
              .eq('user_id', userId)
              .eq('archived', false)
              .contains('tags', [word])
              .limit(5);
            if (tagResults) {
              for (const r of tagResults) {
                if (!results.find(e => e.id === r.id)) results.push(r as any);
              }
            }
          }
        }

        if (results.length > 0) {
          brainContext = results.slice(0, 5)
            .map((r) =>
              `[${r.title || 'Untitled'}]: ${r.content.slice(0, 300)}${r.tags?.length ? ` [tags: ${r.tags.join(', ')}]` : ''}`
            )
            .join('\n');
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

Intent routing rules (follow these STRICTLY):

1. "research" → jac-research-agent: User wants NEW or CURRENT information from the internet.
   TRIGGERS: weather, news, prices, scores, "what is", "how much", "look up", "find out", "tell me about", factual questions, anything needing live data.
   DEFAULT: If ambiguous between research and search, choose RESEARCH.

2. "search" → jac-search-agent: User wants to find something THEY PREVIOUSLY SAVED.
   TRIGGERS: "search my brain", "what did I save", "find my notes", "my entries".
   REQUIRED: User must explicitly reference their own saved data. Do NOT pick search just because brain context below has matches.

3. "save" → jac-save-agent: User wants to save/remember/note something. "remind me" → save (with reminder extraction).

4. "report" → jac-research-agent: User wants a comprehensive multi-source analysis.

5. "general" → assistant-chat: Casual chat, greetings, meta questions about JAC.
   ALSO USE FOR: Calendar/schedule queries ("what's on my calendar", "do I have anything today/tomorrow/this week", "upcoming events", "my schedule", "my plans"). The assistant-chat has full calendar access.

6. "code" → jac-code-agent: User wants to write, fix, modify, refactor, or deploy code in a registered project.
   TRIGGERS: "fix", "add feature", "update code", "refactor", "implement", "PR", "pull request", project names like "pixel-perfect" or "exact-match", code-related requests.

IMPORTANT: Brain context below is for YOUR reference only — do NOT route to search just because matching entries exist.
${brainContext ? `\nUser's brain context (for reference only):\n${brainContext}` : ''}

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
    const extractedQuery = (toolResult?.input?.extractedQuery as string) || message;
    let response = (toolResult?.input?.response as string) || "I'm on it.";

    // 4b. Code project lookup — find matching project if intent is code
    // Accept explicit context.projectId from the Code Workspace UI first
    let codeProject: { id: string; name: string; repo_full_name: string } | null = null;
    if (intent === 'code') {
      try {
        if (body.context?.projectId) {
          // Explicit project context from Code Workspace UI — use directly
          const { data: explicitProject } = await supabase
            .from('code_projects')
            .select('id, name, repo_full_name')
            .eq('id', body.context.projectId)
            .eq('user_id', userId)
            .single();
          if (explicitProject) {
            codeProject = explicitProject as { id: string; name: string; repo_full_name: string };
          }
        }

        // Fallback: name-match lookup from message text (for Slack/general use)
        if (!codeProject) {
          const { data: projects } = await supabase
            .from('code_projects')
            .select('id, name, repo_full_name')
            .eq('user_id', userId);

          if (projects && projects.length > 0) {
            const queryLower = extractedQuery.toLowerCase();
            codeProject = projects.find(
              (p: { id: string; name: string; repo_full_name: string }) => queryLower.includes(p.name.toLowerCase())
            ) ?? projects[0]; // fallback to first project if no name match
          }
        }
      } catch (err) {
        console.warn('[jac-dispatcher] Code project lookup failed (non-blocking):', err);
      }
    }

    // 5. Create parent task
    const { data: parentTask, error: parentError } = await supabase
      .from('agent_tasks')
      .insert({
        user_id: userId,
        type: intent,
        status: 'running',
        intent: summary,
        agent: 'jac-dispatcher',
        input: { message, brainContext: brainContext.slice(0, 1000), slack_channel, slack_thinking_ts, source: source || 'web' },
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
      extractedQuery,
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
          input: {
            query: extractedQuery,
            originalMessage: message,
            brainContext: brainContext.slice(0, 2000),
            slack_channel,
            slack_thinking_ts,
            ...(intent === 'code' && codeProject ? {
              projectId: codeProject.id,
              projectName: codeProject.name,
              repoFullName: codeProject.repo_full_name,
            } : {}),
          },
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
          query: extractedQuery,
          originalMessage: message,
          brainContext: brainContext.slice(0, 2000),
          slack_channel,
          slack_thinking_ts,
          ...(intent === 'code' && codeProject ? {
            projectId: codeProject.id,
            projectName: codeProject.name,
            repoFullName: codeProject.repo_full_name,
          } : {}),
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
      // Enrich general responses — always call Claude for general intent (not just when brain context exists)
      const originalResponse = response;

      // Look up code_projects for the user so general intent can answer questions about them
      let codeProjectsContext = '';
      try {
        const { data: userProjects } = await supabase
          .from('code_projects')
          .select('name, repo_full_name, tech_stack, active')
          .eq('user_id', userId)
          .eq('active', true);
        if (userProjects && userProjects.length > 0) {
          codeProjectsContext = `\n\nUser's registered code projects:\n${userProjects.map((p: { name: string; repo_full_name: string; tech_stack?: string[] }) => `- ${p.name} (${p.repo_full_name})${p.tech_stack?.length ? ` [${p.tech_stack.join(', ')}]` : ''}`).join('\n')}`;
        }
      } catch (err) {
        console.warn('[jac-dispatcher] Code projects lookup for general failed:', err);
      }

      // Fetch user context (schedule, overdue items, upcoming events)
      let userContextText = '';
      try {
        const userContext = await getUserContext(supabase, userId);
        userContextText = userContext.contextText;
      } catch (err) {
        console.warn('[jac-dispatcher] getUserContext failed (non-blocking):', err);
      }

      try {
        const generalClaude = await callClaude({
          model: CLAUDE_MODELS.sonnet,
          system: `You are Jac, a personal AI agent. Answer the user's question concisely and thoroughly.

You have several specialized agents:
- Research agent: looks up real-time information from the internet
- Save agent: saves notes and information to the brain
- Search agent: searches previously saved brain entries
- Code agent: reads GitHub repos, plans changes, writes code, creates branches, commits, and opens PRs autonomously. Users can register projects in the Code Workspace, then ask you to fix bugs, add features, refactor code, etc. You'll create a branch, write the code, and open a PR.

If the user asks about your capabilities, mention these agents. For coding questions like "can you code?" — yes, you can write, fix, and modify code in registered GitHub projects via the code agent. If they ask about their projects, check the project list below.

When the user asks about their calendar, schedule, events, overdue items, or what they have coming up — use the schedule context below to give a specific, accurate answer. List actual items with dates and times.
${brainContext ? `\nBrain context:\n${brainContext}` : ''}${codeProjectsContext}${userContextText ? `\n\n${userContextText}` : ''}`,
          messages: [{ role: 'user', content: message }],
          max_tokens: 2048,
          temperature: 0.4,
        });
        const enriched = parseTextContent(generalClaude);
        if (enriched) response = enriched;
      } catch (err) {
        console.warn('[jac-dispatcher] General enrichment failed (non-blocking):', err);
      }

      // Update conversation with enriched response
      if (response !== originalResponse) {
        await supabase.from('agent_conversations')
          .update({ content: response })
          .eq('user_id', userId)
          .eq('role', 'assistant')
          .eq('content', originalResponse)
          .order('created_at', { ascending: false })
          .limit(1);
      }

      // For general intent, mark parent as completed immediately
      await supabase
        .from('agent_tasks')
        .update({ status: 'completed', completed_at: new Date().toISOString() })
        .eq('id', parentTask.id);

      // Reply in Slack — update the thinking message if we have one, otherwise post new
      if (slack_channel) {
        const botToken = Deno.env.get('SLACK_BOT_TOKEN');
        if (botToken) {
          const slackMethod = slack_thinking_ts ? 'chat.update' : 'chat.postMessage';
          fetch(`https://slack.com/api/${slackMethod}`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${botToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              channel: slack_channel,
              text: markdownToMrkdwn(response).slice(0, 3900),
              ...(slack_thinking_ts ? { ts: slack_thinking_ts } : {}),
            }),
          }).then(async (res) => {
            if (res.ok) {
              await supabase.from('agent_tasks')
                .update({ slack_notified: true })
                .eq('id', parentTask.id);
            } else {
              console.warn('[jac-dispatcher] Slack reply failed:', res.status, await res.text().catch(() => ''));
            }
          }).catch(err => {
            console.warn('[jac-dispatcher] Slack reply error:', err);
          });
        }
      }
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

    // Clean up stuck "Thinking..." message in Slack on error
    // Note: body variables (slack_thinking_ts, slack_channel) may not be in scope
    // if the error happened before parsing. Use try/catch to be safe.
    try {
      const botToken = Deno.env.get('SLACK_BOT_TOKEN');
      if (typeof slackThinkingTs === 'string' && typeof slackChannel === 'string' && botToken) {
        fetch('https://slack.com/api/chat.update', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${botToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ channel: slackChannel, ts: slackThinkingTs, text: ':x: Something went wrong. Try again.' }),
        }).catch(() => {});
      }
    } catch {}

    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Internal server error',
    }), { status: 500, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } });
  }
});
