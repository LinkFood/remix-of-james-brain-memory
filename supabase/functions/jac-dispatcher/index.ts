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
import { callClaude, CLAUDE_MODELS, parseToolUse, parseTextContent, recordTokenUsage, resolveModel } from '../_shared/anthropic.ts';
import type { ModelTier } from '../_shared/anthropic.ts';
import { createAgentLogger } from '../_shared/logger.ts';
import { markdownToMrkdwn } from '../_shared/slack.ts';
import { getUserContext } from '../_shared/context.ts';
import { escapeForLike } from '../_shared/validation.ts';

// Rate limiting
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT = 50;
const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_CONCURRENT_TASKS = 18;
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
type IntentType = 'research' | 'save' | 'search' | 'report' | 'general' | 'code' | 'schedule';

const INTENT_TOOL = {
  name: 'route_intent',
  description: 'Parse the user message and route to the correct JAC agent(s). If the message contains multiple distinct requests, return multiple intents.',
  input_schema: {
    type: 'object' as const,
    properties: {
      intents: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            intent: {
              type: 'string',
              enum: ['research', 'save', 'search', 'report', 'general', 'code', 'schedule'],
              description: 'Use "research" for real-world/current info questions. Use "search" ONLY when user explicitly references their own saved data. Use "save" for notes/reminders. Use "code" for coding tasks. Use "schedule" for recurring automated watches/monitors.',
            },
            summary: {
              type: 'string',
              description: 'Brief 1-sentence summary of this specific request',
            },
            agentType: {
              type: 'string',
              enum: ['jac-research-agent', 'jac-save-agent', 'jac-search-agent', 'jac-code-agent', 'jac-watch-scheduler', 'jac-dispatcher'],
              description: 'Which worker to dispatch for this request',
            },
            extractedQuery: {
              type: 'string',
              description: 'Core query/content for this request. For search: just search terms. For save: PRESERVE FULL MESSAGE including "remind me", times, dates. For research: the topic. For code: the coding request.',
            },
            frequency: {
              type: 'string',
              description: 'How often to run this watch: "daily at 9am", "every weekday at 8am", "weekly on monday", "every 6 hours". Only for schedule intent.',
            },
            watchName: {
              type: 'string',
              description: 'Short name for this watch, e.g. "Austin Zillow Watch". Only for schedule intent.',
            },
            modelTier: {
              type: 'string',
              enum: ['haiku', 'sonnet', 'opus'],
              description: 'AI model quality for the watch. Default haiku (cheapest). Only for schedule intent.',
            },
          },
          required: ['intent', 'summary', 'agentType', 'extractedQuery'],
        },
        description: 'One entry per distinct request. Most messages have 1 intent. Use multiple ONLY when the user explicitly asks for multiple different things (e.g. "research X, save Y, and build Z").',
      },
      response: {
        type: 'string',
        description: 'A brief, natural response acknowledging all request(s) (1-2 sentences)',
      },
    },
    required: ['intents', 'response'],
  },
};

// Map intents to worker functions
const AGENT_MAP: Record<string, string> = {
  research: 'jac-research-agent',
  save: 'jac-save-agent',
  search: 'jac-search-agent',
  report: 'jac-research-agent',
  general: 'jac-dispatcher',
  code: 'jac-code-agent',
  schedule: 'jac-watch-scheduler',
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

    // Loop detection: 20+ tasks in 60 seconds = runaway
    // Multi-intent creates 1 parent + N children per request, so 20 ≈ 4 multi-intent requests
    const loopWindow = new Date(Date.now() - 60_000).toISOString();
    const { count: recentTaskCount } = await supabaseEarly
      .from('agent_tasks')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .gte('created_at', loopWindow);

    if ((recentTaskCount ?? 0) >= 20) {
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
    // Don't overwrite cancelled tasks. Also update any Slack "Thinking..." messages.
    const staleThreshold = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { data: staleTasks } = await supabase
      .from('agent_tasks')
      .select('id, input')
      .eq('user_id', userId)
      .in('status', ['running', 'queued'])
      .lt('created_at', staleThreshold)
      .is('cron_expression', null);

    if (staleTasks && staleTasks.length > 0) {
      // Mark stale tasks as failed (exclude watch templates — they stay running forever)
      await supabase
        .from('agent_tasks')
        .update({ status: 'failed', error: 'Timed out (stale >10min)', completed_at: new Date().toISOString() })
        .eq('user_id', userId)
        .in('status', ['running', 'queued'])
        .lt('created_at', staleThreshold)
        .is('cron_expression', null);

      // Update any stuck Slack "Thinking..." messages
      const botToken = Deno.env.get('SLACK_BOT_TOKEN');
      if (botToken) {
        for (const task of staleTasks) {
          const input = task.input as Record<string, unknown> | null;
          const ch = input?.slack_channel as string | undefined;
          const ts = input?.slack_thinking_ts as string | undefined;
          if (ch && ts) {
            fetch('https://slack.com/api/chat.update', {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${botToken}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ channel: ch, ts, text: ':warning: Task timed out after 10 minutes. Try again.' }),
            }).catch(() => {});
          }
        }
      }
    }

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

    // 3. Context lookups — brain search, reflections, principles, conversation history (all parallel)
    type BrainResult = { id: string; content: string; title?: string; tags?: string[]; similarity?: number };

    const [brainResult, reflectionsResult, principlesResult, conversationResult] = await Promise.allSettled([
      // 3a. Brain context search — semantic (vector) + keyword hybrid
      (async (): Promise<string> => {
        const results: BrainResult[] = [];
        const seenIds = new Set<string>();

        const searchWords = message.toLowerCase().split(/\s+/)
          .filter((w: string) => w.length >= 3 && !/^(the|and|or|is|it|to|a|an|in|on|at|for|of|my|me|do|what|how|when|where|why|can|you|please|could|would|should|this|that|with|from|have|has|just|about|been|want|need|like|find|get|show|tell|help)$/i.test(w))
          .slice(0, 5);

        // Semantic search via embedding
        const semanticPromise = (async (): Promise<BrainResult[]> => {
          try {
            const embRes = await fetch(`${supabaseUrl}/functions/v1/generate-embedding`, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${serviceKey}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ text: message, input_type: 'query' }),
            });
            if (!embRes.ok) return [];
            const embData = await embRes.json();
            if (!embData.embedding) return [];

            const { data: vectorResults } = await supabase.rpc('search_entries_by_embedding', {
              query_embedding: JSON.stringify(embData.embedding),
              match_threshold: 0.3,
              match_count: 8,
              filter_user_id: userId,
            });
            return (vectorResults || []).map((r: any) => ({
              id: r.id, content: r.content, title: r.title, tags: r.tags, similarity: r.similarity,
            }));
          } catch (err) {
            console.warn('[jac-dispatcher] Semantic search failed:', err);
            return [];
          }
        })();

        // Keyword search (catches exact matches semantic might miss)
        const keywordPromise = (async (): Promise<BrainResult[]> => {
          if (searchWords.length === 0) return [];
          try {
            const orClauses = searchWords
              .map(w => { const ew = escapeForLike(w); return `content.ilike.%${ew}%,title.ilike.%${ew}%`; })
              .join(',');
            const { data } = await supabase
              .from('entries')
              .select('id, content, title, tags')
              .eq('user_id', userId)
              .eq('archived', false)
              .or(orClauses)
              .order('created_at', { ascending: false })
              .limit(8);
            return (data || []) as BrainResult[];
          } catch {
            return [];
          }
        })();

        const [semanticResults, keywordResults] = await Promise.all([semanticPromise, keywordPromise]);

        for (const r of semanticResults) {
          if (!seenIds.has(r.id)) { seenIds.add(r.id); results.push(r); }
        }
        for (const r of keywordResults) {
          if (!seenIds.has(r.id)) { seenIds.add(r.id); results.push(r); }
        }

        if (results.length > 0) {
          return results.slice(0, 5)
            .map((r) =>
              `[${r.title || 'Untitled'}]: ${r.content.slice(0, 300)}${r.tags?.length ? ` [tags: ${r.tags.join(', ')}]` : ''}`
            )
            .join('\n');
        }
        return '';
      })(),

      // 3b. Recent reflections for JAC self-awareness
      (async (): Promise<string> => {
        const { data: recentReflections } = await supabase
          .from('jac_reflections')
          .select('task_type, intent, summary, created_at')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .limit(5);

        if (recentReflections && recentReflections.length > 0) {
          return '\n\n=== JAC\'S RECENT REFLECTIONS ===\n' +
            recentReflections.map((r: { task_type: string; intent: string | null; summary: string }) =>
              `- ${r.task_type}: ${r.intent || 'no intent'} -> ${r.summary}`
            ).join('\n');
        }
        return '';
      })(),

      // 3c. Operating principles for strategic context
      (async (): Promise<string> => {
        const { data: principles } = await supabase
          .from('jac_principles')
          .select('principle, confidence, times_applied')
          .eq('user_id', userId)
          .order('confidence', { ascending: false })
          .limit(5);

        if (principles && principles.length > 0) {
          return '\n\n=== JAC\'S OPERATING PRINCIPLES ===\n' +
            principles.map((p: { principle: string; confidence: number; times_applied: number }) =>
              `- [${Math.round(p.confidence * 100)}%] ${p.principle}`
            ).join('\n');
        }
        return '';
      })(),

      // 3d. Recent conversation history for continuity
      (async () => {
        const { data: recentConvos } = await supabase
          .from('agent_conversations')
          .select('role, content, created_at')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .limit(15);
        return recentConvos;
      })(),
    ]);

    // Extract results (fulfilled → value, rejected → fallback)
    const brainContext = brainResult.status === 'fulfilled' ? brainResult.value : '';
    const reflectionsContext = reflectionsResult.status === 'fulfilled' ? reflectionsResult.value : '';
    const principlesContext = principlesResult.status === 'fulfilled' ? principlesResult.value : '';
    const recentConvos = conversationResult.status === 'fulfilled' ? conversationResult.value : null;

    // Format conversation history for context injection
    let conversationContext = '';
    if (recentConvos && recentConvos.length > 0) {
      const chronological = [...recentConvos].reverse();
      conversationContext = '\n\n=== RECENT CONVERSATION ===\n' +
        chronological.map((c: { role: string; content: string; created_at: string }) => {
          const truncated = c.content.length > 300 ? c.content.slice(0, 300) + '...' : c.content;
          return `${c.role === 'user' ? 'User' : 'JAC'}: ${truncated}`;
        }).join('\n');
    }

    // Build light conversation context for worker agents (last 3 exchanges, shorter truncation)
    const workerConvoContext = recentConvos && recentConvos.length > 0
      ? [...recentConvos].reverse().slice(-6).map((c: { role: string; content: string }) => {
          const truncated = c.content.length > 200 ? c.content.slice(0, 200) + '...' : c.content;
          return `${c.role === 'user' ? 'User' : 'JAC'}: ${truncated}`;
        }).join('\n')
      : '';

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

5. "general" → jac-dispatcher (handled inline): Casual chat, greetings, meta questions about JAC.
   ALSO USE FOR: Calendar/schedule queries ("what's on my calendar", "do I have anything today/tomorrow/this week", "upcoming events", "my schedule", "my plans"). The dispatcher has full calendar access.
   ALSO USE FOR: Conversational follow-ups and references to recent chat. If the user references something from RECENT CONVERSATION ("did I tell you about", "what were we talking about", "do you remember", "that thing I mentioned", "tell me more about that", "what about X") — handle as general. You have the conversation history and brain context to answer directly. Do NOT dispatch to search for conversational questions.

6. "code" → jac-code-agent: User wants to write, fix, modify, refactor, or deploy code in a registered project.
   TRIGGERS: "code this", "code me", "fix code", "write code", "add feature", "update code", "refactor", "implement", "PR", "pull request", "deploy function", code-related action requests.
   IMPORTANT: The user MUST be requesting an ACTION on code (write, fix, add, update, refactor, build). Just mentioning a project name or saying "jac agent os" is NOT a code request — that's general conversation about the project. Only route to code when there's a clear coding task.

7. "schedule" → jac-watch-scheduler: User wants to set up a RECURRING automated task.
   TRIGGERS: "watch", "monitor", "check every", "daily search", "recurring", "every morning", "schedule a search", "keep an eye on".
   Extract the frequency (how often), what to do each time, and a short watch name.
   Default to haiku model unless user says "detailed", "thorough", "use sonnet/opus", etc.

MULTI-INTENT: If the user's message contains multiple DISTINCT requests (e.g. "research X, also save Y, and build Z"), return each as a separate entry in the intents array. Each gets its own intent, summary, agentType, and extractedQuery. Most messages have just 1 intent — only split when there are genuinely separate requests.

IMPORTANT: Brain context below is for YOUR reference only — do NOT route to search just because matching entries exist.
${brainContext ? `\nUser's brain context (for reference only):\n${brainContext}` : ''}${conversationContext}${reflectionsContext}${principlesContext}

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

    // Parse intents — normalize to array (defense against models ignoring array schema)
    interface ParsedIntent {
      intent: IntentType;
      summary: string;
      agentType: string;
      extractedQuery: string;
      frequency?: string;
      watchName?: string;
      modelTier?: string;
    }

    const rawIntents = toolResult?.input?.intents;
    let response = (toolResult?.input?.response as string) || "I'm on it.";

    let parsedIntents: ParsedIntent[];
    if (Array.isArray(rawIntents) && rawIntents.length > 0) {
      parsedIntents = rawIntents.map((i: Record<string, unknown>) => ({
        intent: (i.intent as IntentType) || 'general',
        summary: (i.summary as string) || message.slice(0, 100),
        agentType: (i.agentType as string) || AGENT_MAP[i.intent as string] || 'jac-dispatcher',
        extractedQuery: (i.extractedQuery as string) || message,
        frequency: i.frequency as string | undefined,
        watchName: i.watchName as string | undefined,
        modelTier: i.modelTier as string | undefined,
      }));
    } else {
      // Fallback: single intent from old schema or malformed output
      parsedIntents = [{
        intent: (toolResult?.input?.intent as IntentType) || 'general',
        summary: (toolResult?.input?.summary as string) || message.slice(0, 100),
        agentType: (toolResult?.input?.agentType as string) || 'jac-dispatcher',
        extractedQuery: (toolResult?.input?.extractedQuery as string) || message,
      }];
    }

    // Keyword override: if user explicitly asks to code something and Claude missed it, force code intent
    // Requires "code" + action context (not just mentioning the word "code" in passing)
    const codeKeywordMatch = /\b(code\s+(this|that|it|me|a|the)|fix\s+(the\s+)?code|write\s+code|coding)\b/i.test(message)
      || (/\bcode\b/i.test(message) && /\b(add|fix|update|refactor|implement|build|create|write|change|modify|deploy)\b/i.test(message));
    if (codeKeywordMatch && !parsedIntents.some(i => i.intent === 'code')) {
      console.log('[jac-dispatcher] Keyword override: "code" detected, forcing code intent');
      // Replace the first general intent, or add one
      const generalIdx = parsedIntents.findIndex(i => i.intent === 'general');
      const codeIntent: ParsedIntent = {
        intent: 'code',
        summary: message.slice(0, 100),
        agentType: 'jac-code-agent',
        extractedQuery: message,
      };
      if (generalIdx >= 0) {
        parsedIntents[generalIdx] = codeIntent;
      } else {
        parsedIntents.push(codeIntent);
      }
      // Update response if it was generic
      if (response === "I'm on it." || !response) {
        response = "I'll get coding on that.";
      }
    }

    // Separate dispatchable intents from general
    let dispatchIntents = parsedIntents.filter(i => i.intent !== 'general');

    // 4b. Model routing — pick highest tier across all intents
    let modelTier: ModelTier = 'sonnet';
    try {
      const { data: userSettings } = await supabase
        .from('user_settings')
        .select('preferred_model')
        .eq('user_id', userId)
        .single();

      const preferredModel = userSettings?.preferred_model as string | undefined;

      if (preferredModel?.includes('opus')) {
        modelTier = 'opus';
      } else if (preferredModel?.includes('haiku')) {
        modelTier = 'haiku';
      } else {
        const allIntentTypes = parsedIntents.map(i => i.intent);
        const msgLen = message.length;
        const isComplex = msgLen > 300 || /architect|refactor|redesign|overhaul|migrate|complex/i.test(message);

        if (allIntentTypes.includes('code') && isComplex) {
          modelTier = 'opus';
        } else {
          modelTier = 'sonnet';
        }
      }
    } catch (err) {
      console.warn('[jac-dispatcher] Model routing failed (defaulting to sonnet):', err);
    }

    // 4c. Code project lookup — if any intent is code
    let codeProject: { id: string; name: string; repo_full_name: string } | null = null;
    if (dispatchIntents.some(i => i.intent === 'code')) {
      try {
        if (body.context?.projectId) {
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

        if (!codeProject) {
          const { data: projects } = await supabase
            .from('code_projects')
            .select('id, name, repo_full_name')
            .eq('user_id', userId);

          if (projects && projects.length > 0) {
            const codeIntent = dispatchIntents.find(i => i.intent === 'code')!;
            const queryLower = codeIntent.extractedQuery.toLowerCase();
            const matched = projects.find(
              (p: { id: string; name: string; repo_full_name: string }) => queryLower.includes(p.name.toLowerCase())
            );
            if (matched) {
              codeProject = matched;
            } else if (projects.length === 1) {
              codeProject = projects[0];
            } else if (dispatchIntents.length > 1) {
              // Multi-intent: skip code, dispatch the rest
              console.warn('[jac-dispatcher] Ambiguous code project in multi-intent — skipping code intent');
              dispatchIntents = dispatchIntents.filter(i => i.intent !== 'code');
            } else {
              // Single code intent — ask for clarification
              const projectList = projects.map((p: { id: string; name: string; repo_full_name: string }) => `- ${p.name} (${p.repo_full_name})`).join('\n');
              const ambiguousResponse = `Which project do you want me to work on?\n\n${projectList}\n\nMention the project name in your message and I'll get started.`;
              if (slack_channel) {
                const botToken = Deno.env.get('SLACK_BOT_TOKEN');
                if (botToken) {
                  const slackMethod = slack_thinking_ts ? 'chat.update' : 'chat.postMessage';
                  fetch(`https://slack.com/api/${slackMethod}`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${botToken}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ channel: slack_channel, text: ambiguousResponse, ...(slack_thinking_ts ? { ts: slack_thinking_ts } : {}) }),
                  }).catch(() => {});
                }
              }
              return new Response(JSON.stringify({ response: ambiguousResponse, intent: 'code', status: 'needs_clarification' }), { status: 200, headers: jsonHeaders });
            }
          }
        }
      } catch (err) {
        console.warn('[jac-dispatcher] Code project lookup failed (non-blocking):', err);
      }

      // No project found — skip code for multi-intent, error for single
      if (!codeProject && dispatchIntents.some(i => i.intent === 'code')) {
        if (dispatchIntents.length > 1) {
          dispatchIntents = dispatchIntents.filter(i => i.intent !== 'code');
        } else {
          if (slack_channel) {
            const botToken = Deno.env.get('SLACK_BOT_TOKEN');
            if (botToken) {
              const slackMethod = slack_thinking_ts ? 'chat.update' : 'chat.postMessage';
              fetch(`https://slack.com/api/${slackMethod}`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${botToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ channel: slack_channel, text: "No code projects registered. Go to the Code Workspace to add a GitHub repo first.", ...(slack_thinking_ts ? { ts: slack_thinking_ts } : {}) }),
              }).catch(() => {});
            }
          }
          return new Response(JSON.stringify({ response: "No code projects registered. Head to the Code Workspace to add a GitHub repo first.", intent: 'code', status: 'no_project' }), { status: 200, headers: jsonHeaders });
        }
      }
    }

    // Extract schedule intents before dispatch filtering (handled inline after parent task creation)
    const scheduleIntents = dispatchIntents.filter(i => i.intent === 'schedule');
    if (scheduleIntents.length > 0) {
      dispatchIntents = dispatchIntents.filter(i => i.intent !== 'schedule');
    }

    // Recheck after code project and schedule filtering
    const isGeneralOnly = dispatchIntents.length === 0;

    // 5. Create parent task
    const primaryIntent = isGeneralOnly ? (parsedIntents[0]?.intent || 'general') : dispatchIntents[0].intent;
    const parentSummary = isGeneralOnly
      ? parsedIntents[0]?.summary || message.slice(0, 100)
      : dispatchIntents.length === 1
        ? dispatchIntents[0].summary
        : dispatchIntents.map(i => i.summary.slice(0, 60)).join(' | ');

    const { data: parentTask, error: parentError } = await supabase
      .from('agent_tasks')
      .insert({
        user_id: userId,
        type: primaryIntent,
        status: 'running',
        intent: parentSummary,
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

    await recordTokenUsage(supabase, parentTask.id, CLAUDE_MODELS.sonnet, claudeResponse.usage);

    const log = createAgentLogger(supabase, parentTask.id, userId, 'jac-dispatcher');
    await log.info('intent_parsed', {
      intentCount: parsedIntents.length,
      intents: parsedIntents.map(i => i.intent),
      dispatchCount: dispatchIntents.length,
      modelTier,
    });

    // Handle schedule intents inline (create watch template tasks)
    if (scheduleIntents.length > 0) {
      for (const si of scheduleIntents) {
        try {
          // Parse frequency → cron expression via Haiku
          const cronParseResult = await callClaude({
            model: CLAUDE_MODELS.haiku,
            system: `Convert the frequency description to a cron expression. The user is in America/New_York timezone. Return ONLY valid JSON: { "cron": "cron_expression_here", "description": "human readable description" }. Examples: "daily at 9am" → {"cron": "0 14 * * *", "description": "Daily at 9:00 AM ET"}, "every weekday at 8am" → {"cron": "0 13 * * 1-5", "description": "Weekdays at 8:00 AM ET"}, "weekly on monday" → {"cron": "0 14 * * 1", "description": "Mondays at 9:00 AM ET"}, "every 6 hours" → {"cron": "0 */6 * * *", "description": "Every 6 hours"}`,
            messages: [{ role: 'user', content: `Frequency: "${si.frequency || si.extractedQuery}"` }],
            max_tokens: 100,
            temperature: 0,
          });

          const cronText = parseTextContent(cronParseResult) || '';
          let parsedCron = '0 14 * * *'; // default daily 9am ET
          let cronDescription = 'Daily at 9:00 AM ET';
          try {
            const cronJson = JSON.parse(cronText.replace(/```json?\n?/g, '').replace(/```/g, '').trim());
            parsedCron = cronJson.cron || parsedCron;
            cronDescription = cronJson.description || cronDescription;
          } catch {
            console.warn('[jac-dispatcher] Failed to parse cron JSON, using default');
          }

          // Set next_run_at 5 min from now (scheduler will pick it up)
          const nextRunAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

          const watchName = si.watchName || si.summary.slice(0, 60);
          const watchModelTier = si.modelTier || 'haiku';

          // Get user's Slack channel
          let userSlackChannel = slack_channel;
          if (!userSlackChannel) {
            try {
              const { data: userSettings } = await supabase
                .from('user_settings')
                .select('settings')
                .eq('user_id', userId)
                .single();
              userSlackChannel = (userSettings?.settings as Record<string, unknown>)?.slack_channel_id as string | undefined;
            } catch {}
          }

          // Create the watch template task
          await supabase.from('agent_tasks').insert({
            user_id: userId,
            type: 'research',
            status: 'running', // template stays 'running' while active
            intent: watchName,
            agent: 'jac-watch-scheduler',
            parent_task_id: parentTask.id,
            cron_expression: parsedCron,
            cron_active: true,
            next_run_at: nextRunAt,
            input: {
              query: si.extractedQuery,
              watchName,
              frequency: si.frequency || '',
              originalMessage: message,
              agentType: 'jac-research-agent',
              modelTier: watchModelTier,
              timezone: 'America/New_York',
              slack_channel: userSlackChannel,
              createdAt: new Date().toISOString(),
            },
          });

          response = `Watch created: "${watchName}". Runs ${cronDescription}. I'll start monitoring and send results to Slack.`;

          await log.info('watch_created', { watchName, cron: parsedCron, cronDescription, modelTier: watchModelTier });
        } catch (err) {
          console.error('[jac-dispatcher] Schedule intent failed:', err);
          response = 'Failed to create watch. Try again with a clearer schedule.';
        }
      }
    }

    // 6. Create child tasks (one per dispatch intent)
    const childTaskIds: string[] = [];
    if (!isGeneralOnly) {
      for (const di of dispatchIntents) {
        const { data: childTask } = await supabase
          .from('agent_tasks')
          .insert({
            user_id: userId,
            type: di.intent,
            status: 'queued',
            intent: di.summary,
            agent: di.agentType,
            parent_task_id: parentTask.id,
            input: {
              query: di.extractedQuery,
              originalMessage: message,
              brainContext: brainContext.slice(0, 2000),
              conversation_context: workerConvoContext,
              modelTier,
              slack_channel,
              slack_thinking_ts: childTaskIds.length === 0 ? slack_thinking_ts : undefined,
              ...(di.intent === 'code' && codeProject ? {
                projectId: codeProject.id,
                projectName: codeProject.name,
                repoFullName: codeProject.repo_full_name,
              } : {}),
            },
          })
          .select('id')
          .single();
        if (childTask) childTaskIds.push(childTask.id);
      }
    }

    // 7. Store conversation + dispatch workers or handle general
    // NOTE: For dispatched intents, store conversation immediately (workers add their own responses later).
    // For general intents, defer conversation INSERT until AFTER enrichment to avoid realtime race condition
    // where the initial response leaks through before the enriched response overwrites it.
    const scheduleOnly = scheduleIntents.length > 0 && isGeneralOnly;
    if (scheduleOnly) {
      // Schedule intents were handled inline — store conversation, complete parent task, notify Slack
      await supabase.from('agent_conversations').insert([
        { user_id: userId, role: 'user', content: message, task_ids: [parentTask.id] },
        { user_id: userId, role: 'assistant', content: response, task_ids: [parentTask.id] },
      ]);

      await supabase
        .from('agent_tasks')
        .update({ status: 'completed', completed_at: new Date().toISOString() })
        .eq('id', parentTask.id);

      if (slack_channel) {
        const botToken = Deno.env.get('SLACK_BOT_TOKEN');
        if (botToken) {
          const slackMethod = slack_thinking_ts ? 'chat.update' : 'chat.postMessage';
          fetch(`https://slack.com/api/${slackMethod}`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${botToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              channel: slack_channel,
              text: markdownToMrkdwn(response).slice(0, 3900),
              ...(slack_thinking_ts ? { ts: slack_thinking_ts } : {}),
            }),
          }).catch(() => {});
        }
      }
    } else if (!isGeneralOnly) {
      // Store conversation immediately for dispatched intents (workers add their own responses)
      await supabase.from('agent_conversations').insert([
        { user_id: userId, role: 'user', content: message, task_ids: [parentTask.id] },
        { user_id: userId, role: 'assistant', content: response, task_ids: [parentTask.id] },
      ]);

      for (let i = 0; i < dispatchIntents.length; i++) {
        const di = dispatchIntents[i];
        const childId = childTaskIds[i];
        if (!childId) continue;

        await log.info('worker_dispatched', { agentType: di.agentType, childTaskId: childId, modelTier, intent: di.intent });
        const workerUrl = `${supabaseUrl}/functions/v1/${di.agentType}`;
        fetch(workerUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${serviceKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            taskId: childId,
            parentTaskId: parentTask.id,
            userId,
            query: di.extractedQuery,
            originalMessage: message,
            brainContext: brainContext.slice(0, 2000),
            conversation_context: workerConvoContext,
            modelTier,
            slack_channel,
            slack_thinking_ts: i === 0 ? slack_thinking_ts : undefined,
            ...(di.intent === 'code' && codeProject ? {
              projectId: codeProject.id,
              projectName: codeProject.name,
              repoFullName: codeProject.repo_full_name,
            } : {}),
          }),
        }).then(async (res) => {
          if (!res.ok) {
            const errText = await res.text().catch(() => 'unknown');
            console.error(`[jac-dispatcher] Worker ${di.agentType} returned ${res.status}: ${errText}`);
            await supabase.from('agent_tasks')
              .update({ status: 'failed', error: `Dispatch failed: ${res.status}`, completed_at: new Date().toISOString() })
              .eq('id', childId);
            // Check if parent should complete (all children done)
            const { count: pending } = await supabase
              .from('agent_tasks')
              .select('id', { count: 'exact', head: true })
              .eq('parent_task_id', parentTask.id)
              .in('status', ['queued', 'running']);
            if ((pending ?? 0) === 0) {
              await supabase.from('agent_tasks')
                .update({ status: 'completed', completed_at: new Date().toISOString() })
                .eq('id', parentTask.id)
                .in('status', ['running'])
                .is('cron_expression', null);
            }
          } else if (di.intent === 'research' || di.intent === 'code') {
            // Auto-save thread as brain entry
            try {
              const { data: workerConvo } = await supabase
                .from('agent_conversations')
                .select('content')
                .eq('user_id', userId)
                .eq('role', 'assistant')
                .contains('task_ids', [childId])
                .order('created_at', { ascending: false })
                .limit(1)
                .single();
              const assistantContent = workerConvo?.content as string | undefined;
              if (assistantContent && assistantContent.length > 100) {
                supabase.from('entries').insert({
                  user_id: userId,
                  content: `${message}\n---\n${assistantContent}`.slice(0, 4000),
                  content_type: 'thread',
                  title: `Thread: ${di.summary.slice(0, 80)}`,
                  tags: ['thread', di.intent],
                  source: 'agent',
                }).then(() => {}).catch(() => {});
              }
            } catch {}
          }
        }).catch(async (err) => {
          console.error(`[jac-dispatcher] Worker dispatch failed for ${di.agentType}:`, err);
          await supabase.from('agent_tasks')
            .update({ status: 'failed', error: `Dispatch error: ${err.message || 'network error'}`, completed_at: new Date().toISOString() })
            .eq('id', childId);
          const { count: pending } = await supabase
            .from('agent_tasks')
            .select('id', { count: 'exact', head: true })
            .eq('parent_task_id', parentTask.id)
            .in('status', ['queued', 'running']);
          if ((pending ?? 0) === 0) {
            await supabase.from('agent_tasks')
              .update({ status: 'completed', completed_at: new Date().toISOString() })
              .eq('id', parentTask.id)
              .in('status', ['running'])
              .is('cron_expression', null);
          }
        });
      }
    } else {
      // General intent — enrich with Claude, reply, mark complete
      const originalResponse = response;

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
          system: `You are Jac, a personal AI agent. You're conversational, concise, and have memory. Answer like someone who knows the user and remembers what you've discussed.

You have several specialized agents:
- Research agent: looks up real-time information from the internet
- Save agent: saves notes and information to the brain
- Search agent: searches previously saved brain entries
- Code agent: reads GitHub repos, plans changes, writes code, creates branches, commits, and opens PRs autonomously. Users can register projects in the Code Workspace, then ask you to fix bugs, add features, refactor code, etc. You'll create a branch, write the code, and open a PR.

If the user asks about your capabilities, mention these agents. For coding questions like "can you code?" — yes, you can write, fix, and modify code in registered GitHub projects via the code agent. If they ask about their projects, check the project list below.

When the user asks about their calendar, schedule, events, overdue items, or what they have coming up — use the schedule context below to give a specific, accurate answer. List actual items with dates and times.

CONVERSATION MEMORY: You have recent conversation history below. Use it naturally:
- If the user references something you discussed ("that", "what we talked about", "the thing I mentioned") — resolve it from conversation history and respond directly.
- If the user asks "did I tell you about X" — check both conversation history and brain context. If you find it, confirm and summarize what you know. If not, say you don't have it and offer to save/search.
- If the user asks a follow-up ("what about Y" after discussing X) — connect it to the previous topic.
- Never say "I don't have memory of our conversations" — you DO. Use it.
${brainContext ? `\nBrain context:\n${brainContext}` : ''}${conversationContext}${codeProjectsContext}${userContextText ? `\n\n${userContextText}` : ''}`,
          messages: [{ role: 'user', content: message }],
          max_tokens: 2048,
          temperature: 0.4,
        });
        const enriched = parseTextContent(generalClaude);
        if (enriched) response = enriched;
        const totalUsage = {
          input_tokens: (claudeResponse.usage?.input_tokens || 0) + (generalClaude.usage?.input_tokens || 0),
          output_tokens: (claudeResponse.usage?.output_tokens || 0) + (generalClaude.usage?.output_tokens || 0),
        };
        await recordTokenUsage(supabase, parentTask.id, CLAUDE_MODELS.sonnet, totalUsage);
      } catch (err) {
        console.warn('[jac-dispatcher] General enrichment failed (non-blocking):', err);
      }

      // Store conversation AFTER enrichment (no realtime race — final response only)
      await supabase.from('agent_conversations').insert([
        { user_id: userId, role: 'user', content: message, task_ids: [parentTask.id] },
        { user_id: userId, role: 'assistant', content: response, task_ids: [parentTask.id] },
      ]);

      await supabase
        .from('agent_tasks')
        .update({ status: 'completed', completed_at: new Date().toISOString() })
        .eq('id', parentTask.id);

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
      childTaskId: childTaskIds[0] ?? null,
      childTaskIds,
      intent: primaryIntent,
      agentType: dispatchIntents[0]?.agentType ?? 'jac-dispatcher',
      status: isGeneralOnly ? 'completed' : 'dispatched',
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
