/**
 * Calculate Importance Edge Function
 *
 * Uses Anthropic Claude to calculate an importance score (0-10) for content.
 *
 * v1.1 (2026-05-05) — removed dead `messageId` branches per messages Phase A
 * audit (DEAD_REFERENCE verdict). The `messages` table was deliberately
 * dropped 2026-01-23 in the multi-provider-chat → brain-dump architecture
 * pivot. The `messageId` branches in this function were unreached by all
 * live callers (smart-save always passes inline content; importance scores
 * are written to entries.importance_score directly). 0 invocations of the
 * messageId branch in 103 days. See:
 *   - docs/audit/2026-05-05-messages-orphan-phase-a.md
 *   - PR #21 (audit) + this PR (B1 cleanup)
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { extractUserId } from '../_shared/auth.ts';
import { checkRateLimit, getRateLimitHeaders, RATE_LIMIT_CONFIGS } from '../_shared/rateLimit.ts';
import { successResponse, errorResponse, serverErrorResponse } from '../_shared/response.ts';
import { sanitizeString, validateContentLength, parseJsonBody } from '../_shared/validation.ts';
import { callClaude, parseToolUse, CLAUDE_MODELS, ClaudeError } from '../_shared/anthropic.ts';

interface ImportanceRequest {
  content?: string;
  role?: string;
}

Deno.serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return errorResponse(req, 'Authorization required', 401);
    }

    const token = authHeader.replace('Bearer ', '');
    const isServiceRoleCall = token === supabaseKey;

    let userId: string | null = null;
    if (!isServiceRoleCall) {
      const auth = await extractUserId(req);
      if (auth.error || !auth.userId) {
        return errorResponse(req, auth.error || 'Invalid or expired token', 401);
      }
      userId = auth.userId;
    }

    const identifier = isServiceRoleCall ? 'service_role_internal' : (userId || 'anonymous');
    const rateLimitResult = checkRateLimit(`importance:${identifier}`, RATE_LIMIT_CONFIGS.ai);
    if (!rateLimitResult.allowed) {
      return new Response(
        JSON.stringify({ error: 'Rate limit exceeded', retryAfter: Math.ceil(rateLimitResult.resetIn / 1000) }),
        { status: 429, headers: { ...getCorsHeaders(req), ...getRateLimitHeaders(rateLimitResult), 'Content-Type': 'application/json' } }
      );
    }

    const { data: body, error: parseError } = await parseJsonBody<ImportanceRequest>(req);
    if (parseError || !body) {
      return errorResponse(req, parseError || 'Invalid request body', 400);
    }

    const { content: rawContent, role } = body;

    if (!rawContent) {
      return errorResponse(req, 'content is required', 400);
    }

    const messageContent = sanitizeString(rawContent);
    const messageRole = role || 'user';

    const validation = validateContentLength(messageContent, 50000);
    if (!validation.valid) {
      return errorResponse(req, validation.error!, 400);
    }

    const systemPrompt = `You are an AI that analyzes message importance. Rate the importance of messages on a scale of 0-10 where:
0-2: Trivial (greetings, acknowledgments, casual chat)
3-4: Low importance (general questions, simple requests)
5-6: Medium importance (specific information, standard tasks)
7-8: High importance (decisions, commitments, critical information)
9-10: Critical (urgent matters, major decisions, key insights)

Consider: Actionability, Information value, Context, Urgency, Impact.`;

    const claudeResponse = await callClaude({
      model: CLAUDE_MODELS.haiku,
      system: systemPrompt,
      messages: [
        { role: 'user', content: `Analyze this ${messageRole} message and rate its importance:\n\n"${messageContent}"` }
      ],
      tools: [{
        name: 'rate_importance',
        description: 'Rate the importance of a message',
        input_schema: {
          type: 'object',
          properties: {
            score: { type: 'integer', description: 'Importance score from 0 (trivial) to 10 (critical)' },
            reasoning: { type: 'string', description: 'Brief explanation of why this score was assigned' },
          },
          required: ['score', 'reasoning'],
        },
      }],
      tool_choice: { type: 'tool', name: 'rate_importance' },
    });

    const toolResult = parseToolUse(claudeResponse);
    if (!toolResult) {
      return serverErrorResponse(req, 'No tool call in AI response');
    }

    const result = toolResult.input as { score: number; reasoning: string };
    const importanceScore = Math.max(0, Math.min(10, result.score));
    const reasoning = sanitizeString(result.reasoning || '');

    console.log(`Calculated importance: ${importanceScore}/10 - ${reasoning}`);

    return successResponse(req, { importance_score: importanceScore, reasoning, success: true }, 200, rateLimitResult);

  } catch (error) {
    console.error('Error in calculate-importance function:', error);
    if (error instanceof ClaudeError) {
      return errorResponse(req, error.message, error.status);
    }
    return serverErrorResponse(req, error instanceof Error ? error : 'Unknown error occurred');
  }
});
