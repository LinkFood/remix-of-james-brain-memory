/**
 * Calculate Importance Edge Function
 * 
 * Uses AI to calculate an importance score (0-10) for content.
 * Can update an existing entry or return the score for new content.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.7.1';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { extractUserId } from '../_shared/auth.ts';
import { checkRateLimit, getRateLimitHeaders, RATE_LIMIT_CONFIGS } from '../_shared/rateLimit.ts';
import { successResponse, errorResponse, serverErrorResponse } from '../_shared/response.ts';
import { sanitizeString, validateContentLength, parseJsonBody, isValidUUID } from '../_shared/validation.ts';

interface ImportanceRequest {
  messageId?: string;
  content?: string;
  role?: string;
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  const corsHeaders = getCorsHeaders(req);

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const lovableApiKey = Deno.env.get('LOVABLE_API_KEY')!;
    
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Extract user ID from JWT (optional for this function)
    const { userId } = await extractUserId(req);

    // Rate limiting
    const identifier = userId || 'anonymous';
    const rateLimitResult = checkRateLimit(`importance:${identifier}`, RATE_LIMIT_CONFIGS.ai);
    if (!rateLimitResult.allowed) {
      return new Response(
        JSON.stringify({ error: 'Rate limit exceeded', retryAfter: Math.ceil(rateLimitResult.resetIn / 1000) }),
        { 
          status: 429, 
          headers: { ...corsHeaders, ...getRateLimitHeaders(rateLimitResult), 'Content-Type': 'application/json' }
        }
      );
    }

    // Parse request body
    const { data: body, error: parseError } = await parseJsonBody<ImportanceRequest>(req);
    if (parseError || !body) {
      return errorResponse(req, parseError || 'Invalid request body', 400);
    }

    const { messageId, content: rawContent, role } = body;

    if (!messageId && !rawContent) {
      return errorResponse(req, 'Either messageId or content is required', 400);
    }

    let messageContent = rawContent ? sanitizeString(rawContent) : '';
    let messageRole = role || 'user';

    // If messageId provided, fetch the message
    if (messageId) {
      if (!isValidUUID(messageId)) {
        return errorResponse(req, 'Invalid message ID format', 400);
      }

      const { data: message, error: fetchError } = await supabase
        .from('messages')
        .select('content, role')
        .eq('id', messageId)
        .single();

      if (fetchError) {
        console.error('Error fetching message:', fetchError);
        return errorResponse(req, 'Message not found', 404);
      }

      messageContent = message.content;
      messageRole = message.role;
    }

    // Validate content
    const validation = validateContentLength(messageContent, 50000);
    if (!validation.valid) {
      return errorResponse(req, validation.error!, 400);
    }

    // Call Lovable AI to calculate importance score
    const systemPrompt = `You are an AI that analyzes message importance. Rate the importance of messages on a scale of 0-10 where:
0-2: Trivial (greetings, acknowledgments, casual chat)
3-4: Low importance (general questions, simple requests)
5-6: Medium importance (specific information, standard tasks)
7-8: High importance (decisions, commitments, critical information)
9-10: Critical (urgent matters, major decisions, key insights)

Consider:
- Actionability: Does it require action?
- Information value: Does it contain important facts or decisions?
- Context: Is it a standalone message or part of a conversation?
- Urgency: Is it time-sensitive?
- Impact: What are the consequences?`;

    const response = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${lovableApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Analyze this ${messageRole} message and rate its importance:\n\n"${messageContent}"` }
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'rate_importance',
              description: 'Rate the importance of a message',
              parameters: {
                type: 'object',
                properties: {
                  score: {
                    type: 'integer',
                    minimum: 0,
                    maximum: 10,
                    description: 'Importance score from 0 (trivial) to 10 (critical)'
                  },
                  reasoning: {
                    type: 'string',
                    description: 'Brief explanation of why this score was assigned'
                  }
                },
                required: ['score', 'reasoning'],
                additionalProperties: false
              }
            }
          }
        ],
        tool_choice: { type: 'function', function: { name: 'rate_importance' } }
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Lovable AI error:', response.status, errorText);
      
      if (response.status === 429) {
        return errorResponse(req, 'Rate limit exceeded. Please try again later.', 429);
      }
      if (response.status === 402) {
        return errorResponse(req, 'AI credits exhausted.', 402);
      }

      return serverErrorResponse(req, `AI request failed: ${response.status}`);
    }

    const aiResponse = await response.json();
    console.log('AI Response received');

    // Extract the importance score from tool call
    const toolCall = aiResponse.choices[0]?.message?.tool_calls?.[0];
    if (!toolCall) {
      return serverErrorResponse(req, 'No tool call in AI response');
    }

    const result = JSON.parse(toolCall.function.arguments);
    const importanceScore = Math.max(0, Math.min(10, result.score));
    const reasoning = sanitizeString(result.reasoning || '');

    console.log(`Calculated importance: ${importanceScore}/10 - ${reasoning}`);

    // Update the message with the importance score if messageId provided
    if (messageId) {
      const { error: updateError } = await supabase
        .from('messages')
        .update({ importance_score: importanceScore })
        .eq('id', messageId);

      if (updateError) {
        console.error('Error updating message:', updateError);
        // Don't fail the request, just log it
      }
    }

    return successResponse(req, { 
      importance_score: importanceScore,
      reasoning,
      success: true 
    }, 200, rateLimitResult);

  } catch (error) {
    console.error('Error in calculate-importance function:', error);
    return serverErrorResponse(req, error instanceof Error ? error : 'Unknown error occurred');
  }
});
