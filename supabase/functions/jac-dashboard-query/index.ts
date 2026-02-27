/**
 * jac-dashboard-query — Jac's Brain for Dashboard Transformation
 *
 * GOAL: Process Jac queries and return structured dashboard commands.
 * Instead of just text responses, this returns instructions for how
 * the dashboard should transform to visually answer the user's question.
 *
 * Returns:
 * - highlightEntryIds: entries to highlight/pulse
 * - connections: pairs of entries to draw lines between
 * - clusters: groups of entries to cluster visually
 * - insightCard: a Jac explanation card
 * - surfaceEntryIds: entries to bring to top
 * - enrichmentTargets: entries to enrich with external context
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.84.0";
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { extractUserId } from '../_shared/auth.ts';
import { checkRateLimit, RATE_LIMIT_CONFIGS, getRateLimitHeaders } from '../_shared/rateLimit.ts';
import { successResponse, errorResponse, serverErrorResponse } from '../_shared/response.ts';
import { parseJsonBody } from '../_shared/validation.ts';
import { callClaude, parseTextContent, CLAUDE_MODELS } from '../_shared/anthropic.ts';

interface DashboardQueryRequest {
  query: string;
  conversationHistory?: Array<{ role: string; content: string }>;
}

interface DashboardCommand {
  /** Text response from Jac */
  message: string;
  /** Entry IDs to highlight with a glow effect */
  highlightEntryIds: string[];
  /** Pairs of connected entries */
  connections: Array<{ from: string; to: string; label?: string; strength: number }>;
  /** Groups of related entries */
  clusters: Array<{ label: string; entryIds: string[]; color?: string }>;
  /** Jac's insight card content */
  insightCard: {
    title: string;
    body: string;
    type: 'insight' | 'pattern' | 'suggestion' | 'question';
  } | null;
  /** Entries to surface to the top of the view */
  surfaceEntryIds: string[];
  /** Entries that should get external enrichment */
  enrichmentTargets: string[];
}

serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  try {
    const { userId, error: authError } = await extractUserId(req);
    if (authError || !userId) {
      return errorResponse(req, authError ?? 'Unauthorized', 401);
    }

    const rateLimit = checkRateLimit(userId, RATE_LIMIT_CONFIGS.standard);
    if (!rateLimit.allowed) {
      return new Response(
        JSON.stringify({ error: 'Rate limit exceeded' }),
        { status: 429, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json', ...getRateLimitHeaders(rateLimit) } }
      );
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { data: body, error: parseError } = await parseJsonBody<DashboardQueryRequest>(req);
    if (parseError || !body) {
      return errorResponse(req, parseError ?? 'Invalid request body', 400);
    }

    const { query, conversationHistory = [] } = body;
    if (!query) {
      return errorResponse(req, 'query is required', 400);
    }

    // Fetch user's entries for context
    const { data: entries } = await supabase
      .from('entries')
      .select('id, content, title, content_type, tags, importance_score, created_at, starred')
      .eq('user_id', userId)
      .eq('archived', false)
      .order('created_at', { ascending: false })
      .limit(50);

    // Fetch relationships
    const { data: relationships } = await supabase
      .from('entry_relationships')
      .select('entry_id, related_entry_id, similarity_score')
      .eq('user_id', userId)
      .gte('similarity_score', 0.6)
      .order('similarity_score', { ascending: false })
      .limit(100);

    const entriesContext = (entries || [])
      .map((e: any) => `[${e.id}] "${e.title || 'Untitled'}" (${e.content_type}, tags: ${(e.tags || []).join(',')}, importance: ${e.importance_score || '?'}, created: ${e.created_at.split('T')[0]})${e.starred ? ' ★' : ''}: ${e.content.slice(0, 200)}`)
      .join('\n');

    const relationsContext = (relationships || [])
      .map((r: any) => `${r.entry_id} <-> ${r.related_entry_id} (similarity: ${r.similarity_score.toFixed(2)})`)
      .join('\n');

    // Call Claude to generate dashboard commands
    const systemPrompt = `You are Jac, an AI assistant for LinkJac (a brain dump app). Instead of just answering with text, you transform the user's dashboard to VISUALLY SHOW the answer.

You receive the user's entries and their relationships. You must return a JSON object that controls the dashboard.

Available actions:
1. highlightEntryIds: Array of entry IDs to make glow/pulse on dashboard
2. connections: Array of {from: entryId, to: entryId, label: "why connected", strength: 0-1}
3. clusters: Array of {label: "theme name", entryIds: [...], color: "optional css color"}
4. insightCard: {title: "Jac thinks:", body: "Your insight here", type: "insight|pattern|suggestion|question"} or null
5. surfaceEntryIds: Array of entry IDs to show at the top of the dashboard
6. enrichmentTargets: Array of entry IDs that need external context (code that needs docs, ideas that need validation)
7. message: A concise text response (1-3 sentences)

Rules:
- Use ACTUAL entry IDs from the data provided
- Be specific and data-driven
- If asked about patterns, look at tags, types, and dates
- If asked about connections, use the relationship data
- If asked about forgotten items, find entries not recently accessed or with no connections
- Keep insights short and punchy
- For enrichmentTargets, only suggest code, idea, or high-importance entries
- Maximum 10 entries in any array
- Always include a message and insightCard
- ALWAYS respond with valid JSON only, no markdown fences

USER'S ENTRIES:
${entriesContext || 'No entries yet.'}

KNOWN RELATIONSHIPS:
${relationsContext || 'No relationships computed yet.'}`;

    const claudeMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    for (const msg of conversationHistory.slice(-4)) {
      claudeMessages.push({ role: msg.role as 'user' | 'assistant', content: msg.content });
    }
    claudeMessages.push({ role: 'user', content: query });

    const aiResponse = await callClaude({
      model: CLAUDE_MODELS.haiku,
      system: systemPrompt,
      messages: claudeMessages,
      max_tokens: 3000,
      temperature: 0.4,
    });

    const responseContent = parseTextContent(aiResponse);

    let dashboardCommand: DashboardCommand;
    try {
      const parsed = JSON.parse(responseContent);
      dashboardCommand = {
        message: parsed.message || "I looked through your brain but couldn't find anything specific.",
        highlightEntryIds: parsed.highlightEntryIds || [],
        connections: parsed.connections || [],
        clusters: parsed.clusters || [],
        insightCard: parsed.insightCard || null,
        surfaceEntryIds: parsed.surfaceEntryIds || [],
        enrichmentTargets: parsed.enrichmentTargets || [],
      };
    } catch {
      console.error('Failed to parse dashboard command:', responseContent);
      dashboardCommand = {
        message: responseContent || "I encountered an error processing your question.",
        highlightEntryIds: [],
        connections: [],
        clusters: [],
        insightCard: null,
        surfaceEntryIds: [],
        enrichmentTargets: [],
      };
    }

    return successResponse(req, dashboardCommand, 200, rateLimit);

  } catch (error) {
    console.error('Error in jac-dashboard-query:', error);
    return serverErrorResponse(req, error instanceof Error ? error : new Error('Unknown error'));
  }
});
