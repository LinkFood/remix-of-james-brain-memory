/**
 * generate-embedding — Vector Embeddings
 * 
 * GOAL: Create embeddings for semantic search.
 * 
 * Uses Lovable AI's embedding model to generate vectors.
 * Rate limited. Input validated.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.84.0";
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { checkRateLimit, RATE_LIMIT_CONFIGS, getRateLimitHeaders } from '../_shared/rateLimit.ts';
import { successResponse, errorResponse, serverErrorResponse } from '../_shared/response.ts';
import { sanitizeString, validateContentLength, parseJsonBody } from '../_shared/validation.ts';

interface EmbeddingRequest {
  text: string;
}

serve(async (req) => {
  // Handle CORS preflight
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  const corsHeaders = getCorsHeaders(req);

  try {
    // Get authorization header
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return errorResponse(req, 'Authentication required', 401);
    }

    const jwt = authHeader.replace('Bearer ', '');

    // Initialize Supabase client
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    // Check if this is a service role call (from other edge functions)
    const isServiceRoleCall = jwt === supabaseServiceRoleKey;

    let userId: string;

    if (isServiceRoleCall) {
      // Service role calls are trusted
      userId = 'service_role_internal';
      console.log('Service role call detected - trusted internal request');
    } else {
      // Regular user call - validate JWT via claims (does not depend on session records)
      const supabase = createClient(supabaseUrl, supabaseAnonKey, {
        global: { headers: { Authorization: authHeader } },
      });

      const authAny = supabase.auth as unknown as {
        getClaims?: (token: string) => Promise<{ data: { claims?: { sub?: string } } | null; error: { message: string } | null }>;
      };

      if (typeof authAny.getClaims === 'function') {
        const { data, error } = await authAny.getClaims(jwt);
        const sub = data?.claims?.sub ?? null;
        if (error || !sub) {
          console.error('Invalid token (claims):', error?.message);
          return errorResponse(req, 'Invalid authentication token', 401);
        }
        userId = sub;
      } else {
        const { data: { user }, error: authError } = await supabase.auth.getUser(jwt);
        if (authError || !user) {
          console.error('Invalid token (user):', authError?.message);
          return errorResponse(req, 'Invalid authentication token', 401);
        }
        userId = user.id;
      }

      console.log(`Authenticated user: ${userId}`);
    }

    // Apply rate limiting (AI operations: 50 req/min)
    const rateLimit = checkRateLimit(userId, RATE_LIMIT_CONFIGS.ai);
    if (!rateLimit.allowed) {
      return new Response(
        JSON.stringify({
          error: 'Rate limit exceeded. Please try again later.',
          retryAfter: Math.ceil(rateLimit.resetIn / 1000),
        }),
        {
          status: 429,
          headers: {
            ...corsHeaders,
            ...getRateLimitHeaders(rateLimit),
            'Content-Type': 'application/json',
          },
        }
      );
    }

    // Parse request body
    const { data: body, error: parseError } = await parseJsonBody<EmbeddingRequest>(req);
    if (parseError || !body) {
      return errorResponse(req, parseError ?? 'Invalid request body', 400);
    }

    // Validate text input
    const text = sanitizeString(body.text);
    if (!text) {
      return errorResponse(req, 'Text is required', 400);
    }

    // Validate text length (max 50k characters)
    const validation = validateContentLength(text, 50000);
    if (!validation.valid) {
      return errorResponse(req, validation.error ?? 'Text validation failed', 400);
    }

    const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
    if (!LOVABLE_API_KEY) {
      return errorResponse(req, 'LOVABLE_API_KEY is not configured', 500);
    }

    // Generate embedding using Lovable AI
    const response = await fetch('https://ai.gateway.lovable.dev/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${LOVABLE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'text-embedding-3-small',
        input: text,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Lovable AI embedding error:', response.status, errorText);
      return errorResponse(req, `Failed to generate embedding: ${response.status}`, 500);
    }

    const data = await response.json();
    const embedding = data.data[0].embedding;

    return successResponse(req, { embedding }, 200, rateLimit);
  } catch (error) {
    console.error('Error in generate-embedding function:', error);
    return serverErrorResponse(req, error instanceof Error ? error : new Error('Unknown error'));
  }
});
