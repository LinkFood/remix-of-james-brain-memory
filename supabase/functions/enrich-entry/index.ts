/**
 * enrich-entry — The Enrich Layer (External Intelligence)
 * 
 * Uses Anthropic Claude to add external context to user's entries.
 */

import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.84.0";
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { extractUserId } from '../_shared/auth.ts';
import { checkRateLimit, RATE_LIMIT_CONFIGS, getRateLimitHeaders } from '../_shared/rateLimit.ts';
import { successResponse, errorResponse, serverErrorResponse } from '../_shared/response.ts';
import { parseJsonBody } from '../_shared/validation.ts';
import { callClaude, parseTextContent, CLAUDE_MODELS, ClaudeError } from '../_shared/anthropic.ts';

interface EnrichRequest {
  entryId: string;
  content: string;
  contentType: string;
  title?: string;
  tags?: string[];
}

interface EnrichmentResult {
  summary: string;
  insights: Array<{
    type: 'documentation' | 'pattern' | 'suggestion' | 'context' | 'warning' | 'related';
    title: string;
    content: string;
    confidence: number;
    source?: string;
  }>;
}

serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  try {
    const { userId, error: authError } = await extractUserId(req);
    if (authError || !userId) {
      return errorResponse(req, authError ?? 'Unauthorized', 401);
    }

    const rateLimit = checkRateLimit(`enrich:${userId}`, RATE_LIMIT_CONFIGS.ai);
    if (!rateLimit.allowed) {
      return new Response(
        JSON.stringify({ error: 'Rate limit exceeded', retryAfter: Math.ceil(rateLimit.resetIn / 1000) }),
        { status: 429, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json', ...getRateLimitHeaders(rateLimit) } }
      );
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { data: body, error: parseError } = await parseJsonBody<EnrichRequest>(req);
    if (parseError || !body) {
      return errorResponse(req, parseError ?? 'Invalid request body', 400);
    }

    const { entryId, content, contentType, title, tags } = body;
    if (!entryId || !content) {
      return errorResponse(req, 'entryId and content are required', 400);
    }

    // Check cache
    const { data: existingEntry } = await supabase
      .from('entries')
      .select('extracted_data')
      .eq('id', entryId)
      .eq('user_id', userId)
      .single();

    if (existingEntry?.extracted_data?.enrichment) {
      console.log('Returning cached enrichment for entry:', entryId);
      return successResponse(req, { entryId, enrichment: existingEntry.extracted_data.enrichment, cached: true }, 200, rateLimit);
    }

    // Build enrichment focus based on content type
    let enrichmentFocus = '';
    switch (contentType) {
      case 'code':
        enrichmentFocus = `This is a CODE entry. Provide: what this code does, potential issues, best practices, related technologies, common alternatives.`;
        break;
      case 'idea':
        enrichmentFocus = `This is an IDEA entry. Provide: validation/gaps, related concepts, potential challenges, next steps, similar approaches.`;
        break;
      case 'link':
        enrichmentFocus = `This is a LINK entry. Provide: what this resource is about, related resources, key concepts, why it's useful.`;
        break;
      case 'note':
      case 'document':
        enrichmentFocus = `This is a NOTE/DOCUMENT entry. Provide: key takeaways, related topics, actionable items, additional context.`;
        break;
      default:
        enrichmentFocus = `Provide useful external context: key insights, related information, actionable suggestions, relevant context.`;
    }

    const systemPrompt = `You are an enrichment engine for a brain-dump app called LinkJac. Your job is to add EXTERNAL CONTEXT to user entries.

${enrichmentFocus}

Rules:
- Be CONCISE. Each insight should be 1-3 sentences.
- Be SPECIFIC to the actual content, not generic advice.
- Provide confidence scores (0-1) for each insight.
- Focus on what's genuinely useful, not filler.
- Maximum 5 insights per entry.

Respond as JSON with this structure:
{
  "summary": "One-sentence summary of what enrichment you found",
  "insights": [
    {
      "type": "documentation|pattern|suggestion|context|warning|related",
      "title": "Short title",
      "content": "The insight content",
      "confidence": 0.8,
      "source": "Optional source reference"
    }
  ]
}`;

    const claudeResponse = await callClaude({
      model: CLAUDE_MODELS.haiku,
      system: systemPrompt,
      messages: [{
        role: 'user',
        content: `Entry to enrich:\nTitle: ${title || 'Untitled'}\nType: ${contentType}\nTags: ${(tags || []).join(', ')}\nContent:\n${content.slice(0, 4000)}`,
      }],
      temperature: 0.4,
      max_tokens: 2000,
    });

    const responseText = parseTextContent(claudeResponse);

    let enrichment: EnrichmentResult;
    try {
      enrichment = JSON.parse(responseText);
    } catch {
      console.error('Failed to parse enrichment response:', responseText);
      enrichment = { summary: 'Unable to generate enrichment for this entry.', insights: [] };
    }

    // Cache enrichment
    const currentExtractedData = existingEntry?.extracted_data || {};
    await supabase
      .from('entries')
      .update({
        extracted_data: {
          ...currentExtractedData,
          enrichment: { ...enrichment, generatedAt: new Date().toISOString() },
        },
      })
      .eq('id', entryId)
      .eq('user_id', userId);

    console.log(`Enrichment generated for entry ${entryId}: ${enrichment.insights.length} insights`);

    return successResponse(req, { entryId, enrichment, cached: false }, 200, rateLimit);

  } catch (error) {
    console.error('Error in enrich-entry:', error);
    if (error instanceof ClaudeError) {
      return errorResponse(req, error.message, error.status);
    }
    return serverErrorResponse(req, error instanceof Error ? error : new Error('Unknown error'));
  }
});
