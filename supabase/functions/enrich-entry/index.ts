/**
 * enrich-entry — The Enrich Layer (External Intelligence)
 *
 * GOAL: Add external context to user's entries.
 *
 * Code dumps → relevant docs, patterns, potential issues
 * Ideas → related articles, research, validation
 * Any dump → web context when helpful
 *
 * Uses AI to determine what enrichment is needed, then fetches external context.
 * Results are cached to avoid repeated lookups.
 */

import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.84.0";
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { extractUserId } from '../_shared/auth.ts';
import { checkRateLimit, RATE_LIMIT_CONFIGS, getRateLimitHeaders } from '../_shared/rateLimit.ts';
import { successResponse, errorResponse, serverErrorResponse } from '../_shared/response.ts';
import { parseJsonBody } from '../_shared/validation.ts';

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
  searchQueries?: string[];
}

serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  try {
    const { userId, error: authError } = await extractUserId(req);
    if (authError || !userId) {
      return errorResponse(req, authError ?? 'Unauthorized', 401);
    }

    // Stricter rate limit for enrichment (it's expensive)
    const rateLimit = checkRateLimit(`enrich:${userId}`, RATE_LIMIT_CONFIGS.ai);
    if (!rateLimit.allowed) {
      return new Response(
        JSON.stringify({ error: 'Rate limit exceeded', retryAfter: Math.ceil(rateLimit.resetIn / 1000) }),
        { status: 429, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json', ...getRateLimitHeaders(rateLimit) } }
      );
    }

    const lovableApiKey = Deno.env.get('LOVABLE_API_KEY')!;
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

    // Check if we already have cached enrichment for this entry
    const { data: existingEntry } = await supabase
      .from('entries')
      .select('extracted_data')
      .eq('id', entryId)
      .eq('user_id', userId)
      .single();

    if (existingEntry?.extracted_data?.enrichment) {
      console.log('Returning cached enrichment for entry:', entryId);
      return successResponse(req, {
        entryId,
        enrichment: existingEntry.extracted_data.enrichment,
        cached: true,
      }, 200, rateLimit);
    }

    // Build enrichment prompt based on content type
    let enrichmentFocus = '';
    switch (contentType) {
      case 'code':
        enrichmentFocus = `This is a CODE entry. Provide:
- What this code does (brief explanation)
- Potential issues or bugs to watch for
- Best practices relevant to this pattern
- Related technologies or libraries that could help
- Common alternatives or improvements`;
        break;
      case 'idea':
        enrichmentFocus = `This is an IDEA entry. Provide:
- Validation: Is this idea sound? Any obvious gaps?
- Related concepts or existing implementations
- Potential challenges to consider
- Suggested next steps to explore this further
- Similar approaches others have taken`;
        break;
      case 'link':
        enrichmentFocus = `This is a LINK entry. Provide:
- What this resource is about (brief summary if identifiable)
- Related resources or alternatives
- Key concepts from this domain
- Why this might be useful to the user`;
        break;
      case 'note':
      case 'document':
        enrichmentFocus = `This is a NOTE/DOCUMENT entry. Provide:
- Key takeaways or summary
- Related topics to explore
- Actionable items if any
- Context that adds depth to this note`;
        break;
      default:
        enrichmentFocus = `Provide useful external context for this entry:
- Key insights or connections
- Related information
- Actionable suggestions
- Relevant context`;
    }

    // Call AI to generate enrichment
    const response = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${lovableApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        messages: [
          {
            role: 'system',
            content: `You are an enrichment engine for a brain-dump app called LinkJac. Your job is to add EXTERNAL CONTEXT to user entries — things they wouldn't know from their own brain.

${enrichmentFocus}

Rules:
- Be CONCISE. Each insight should be 1-3 sentences.
- Be SPECIFIC to the actual content, not generic advice.
- Provide confidence scores (0-1) for each insight.
- Focus on what's genuinely useful, not filler.
- If you can identify specific technologies, patterns, or concepts, name them.
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
}`
          },
          {
            role: 'user',
            content: `Entry to enrich:
Title: ${title || 'Untitled'}
Type: ${contentType}
Tags: ${(tags || []).join(', ')}
Content:
${content.slice(0, 4000)}`
          }
        ],
        temperature: 0.4,
        max_tokens: 2000,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Enrichment AI error:', response.status, errorText);
      return errorResponse(req, 'Enrichment failed', 500);
    }

    const aiData = await response.json();
    const responseContent = aiData.choices?.[0]?.message?.content;

    let enrichment: EnrichmentResult;
    try {
      enrichment = JSON.parse(responseContent);
    } catch {
      console.error('Failed to parse enrichment response:', responseContent);
      enrichment = {
        summary: 'Unable to generate enrichment for this entry.',
        insights: [],
      };
    }

    // Cache the enrichment in extracted_data
    const currentExtractedData = existingEntry?.extracted_data || {};
    await supabase
      .from('entries')
      .update({
        extracted_data: {
          ...currentExtractedData,
          enrichment: {
            ...enrichment,
            generatedAt: new Date().toISOString(),
          },
        },
      })
      .eq('id', entryId)
      .eq('user_id', userId);

    console.log(`Enrichment generated for entry ${entryId}: ${enrichment.insights.length} insights`);

    return successResponse(req, {
      entryId,
      enrichment,
      cached: false,
    }, 200, rateLimit);

  } catch (error) {
    console.error('Error in enrich-entry:', error);
    return serverErrorResponse(req, error instanceof Error ? error : new Error('Unknown error'));
  }
});
