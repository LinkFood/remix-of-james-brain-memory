/**
 * assistant-chat — Conversational AI with Brain Context
 *
 * Provides direct conversational responses with full brain context.
 * No intent routing — that's handled by jac-dispatcher.
 * Focus: casual chat, calendar queries, and brain-aware responses.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { extractUserId } from '../_shared/auth.ts';
import { callClaude, CLAUDE_MODELS, parseTextContent, recordTokenUsage } from '../_shared/anthropic.ts';
import { getUserContext } from '../_shared/context.ts';
import { escapeForLike } from '../_shared/validation.ts';

serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  const corsHeaders = getCorsHeaders(req);
  const jsonHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

  try {
    // Auth
    const { userId, error: authError } = await extractUserId(req);
    if (authError || !userId) {
      return new Response(JSON.stringify({ error: authError ?? 'Unauthorized' }), {
        status: 401, headers: jsonHeaders,
      });
    }

    // Parse request
    const { message } = await req.json();
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return new Response(JSON.stringify({ error: 'Message is required' }), {
        status: 400, headers: jsonHeaders,
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, serviceKey);

    // Brain context search — semantic + keyword hybrid
    let brainContext = '';
    try {
      const results: Array<{ id: string; content: string; title?: string; tags?: string[]; similarity?: number }> = [];
      const seenIds = new Set<string>();

      // Extract search keywords
      const searchWords = message.toLowerCase().split(/\s+/)
        .filter((w: string) => w.length >= 3 && !/^(the|and|or|is|it|to|a|an|in|on|at|for|of|my|me|do|what|how|when|where|why|can|you|please|could|would|should|this|that|with|from|have|has|just|about|been|want|need|like|find|get|show|tell|help)$/i.test(w))
        .slice(0, 5);

      // Semantic search via embedding
      const semanticPromise = (async () => {
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
          console.warn('[assistant-chat] Semantic search failed:', err);
          return [];
        }
      })();

      // Keyword search
      const keywordPromise = (async () => {
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
          return (data || []) as Array<{ id: string; content: string; title?: string; tags?: string[] }>;
        } catch {
          return [];
        }
      })();

      const [semanticResults, keywordResults] = await Promise.all([semanticPromise, keywordPromise]);

      // Combine results (semantic first, then keyword)
      for (const r of semanticResults) {
        if (!seenIds.has(r.id)) { seenIds.add(r.id); results.push(r); }
      }
      for (const r of keywordResults) {
        if (!seenIds.has(r.id)) { seenIds.add(r.id); results.push(r); }
      }

      if (results.length > 0) {
        brainContext = results.slice(0, 5)
          .map((r) =>
            `[${r.title || 'Untitled'}]: ${r.content.slice(0, 300)}${r.tags?.length ? ` [tags: ${r.tags.join(', ')}]` : ''}`
          )
          .join('\n');
      }
    } catch (err) {
      console.warn('[assistant-chat] Brain context search failed (non-blocking):', err);
    }

    // User context (schedule, etc.)
    let userContextText = '';
    try {
      const userContext = await getUserContext(supabase, userId);
      userContextText = userContext.contextText;
    } catch (err) {
      console.warn('[assistant-chat] getUserContext failed (non-blocking):', err);
    }

    // Code projects context
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
      console.warn('[assistant-chat] Code projects lookup failed (non-blocking):', err);
    }

    // Recent conversation history for continuity
    let conversationContext = '';
    try {
      const { data: recentConvos } = await supabase
        .from('agent_conversations')
        .select('role, content, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(10);
      
      if (recentConvos && recentConvos.length > 0) {
        const chronological = [...recentConvos].reverse();
        conversationContext = '\n\n=== RECENT CONVERSATION ===\n' +
          chronological.map((c: { role: string; content: string; created_at: string }) => {
            const truncated = c.content.length > 300 ? c.content.slice(0, 300) + '...' : c.content;
            return `${c.role === 'user' ? 'User' : 'JAC'}: ${truncated}`;
          }).join('\n');
      }
    } catch (err) {
      console.warn('[assistant-chat] Conversation history failed (non-blocking):', err);
    }

    // Generate response with Claude
    const systemPrompt = `You are Jac, a personal AI agent. You're conversational, concise, and have memory. Answer like someone who knows the user and remembers what you've discussed.

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
${brainContext ? `\nBrain context:\n${brainContext}` : ''}${conversationContext}${codeProjectsContext}${userContextText ? `\n\n${userContextText}` : ''}`;

    const claudeResponse = await callClaude({
      model: CLAUDE_MODELS.sonnet,
      system: systemPrompt,
      messages: [{ role: 'user', content: message }],
      max_tokens: 2048,
      temperature: 0.4,
    });

    const responseText = parseTextContent(claudeResponse) || "I'm here to help. What do you need?";

    // Create a task record for token tracking
    const { data: task } = await supabase
      .from('agent_tasks')
      .insert({
        user_id: userId,
        type: 'general',
        status: 'completed',
        intent: message.slice(0, 100),
        agent: 'assistant-chat',
        input: { message },
        output: { response: responseText },
        completed_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    if (task) {
      await recordTokenUsage(supabase, task.id, CLAUDE_MODELS.sonnet, claudeResponse.usage);
    }

    return new Response(JSON.stringify({
      response: responseText,
      usage: claudeResponse.usage,
    }), {
      status: 200,
      headers: jsonHeaders,
    });

  } catch (error) {
    console.error('[assistant-chat] Error:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Internal server error',
    }), {
      status: 500,
      headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
    });
  }
});
