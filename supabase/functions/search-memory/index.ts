/**
 * search-memory — Semantic + Keyword Search
 * 
 * GOAL: Find anything in the user's brain.
 * 
 * Uses embeddings for semantic search, falls back to keyword search.
 * Filters by date, type, tags, importance.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { extractUserId } from '../_shared/auth.ts';
import { checkRateLimit, RATE_LIMIT_CONFIGS, getRateLimitHeaders } from '../_shared/rateLimit.ts';
import { successResponse, errorResponse, serverErrorResponse } from '../_shared/response.ts';
import { validateSearchQuery, escapeForLike, parseNumber, parseJsonBody } from '../_shared/validation.ts';

interface SearchRequest {
  query: string;
  useSemanticSearch?: boolean;
  startDate?: string;
  endDate?: string;
  contentType?: string;
  minImportance?: number;
  maxImportance?: number;
  tags?: string[];
  limit?: number;
}

interface SearchResult {
  id: string;
  content: string;
  title: string | null;
  content_type: string;
  content_subtype: string | null;
  tags: string[];
  importance_score: number | null;
  created_at: string;
  similarity?: number;
}

serve(async (req) => {
  // Handle CORS preflight
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  const corsHeaders = getCorsHeaders(req);

  try {
    // Authenticate user
    const { userId, error: authError } = await extractUserId(req);
    if (authError || !userId) {
      return errorResponse(req, authError ?? 'Unauthorized', 401);
    }

    // Check rate limit (search is limited to 30 req/min)
    const rateLimit = checkRateLimit(userId, RATE_LIMIT_CONFIGS.search);
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
    const { data: body, error: parseError } = await parseJsonBody<SearchRequest>(req);
    if (parseError || !body) {
      return errorResponse(req, parseError ?? 'Invalid request body', 400);
    }

    // Validate and sanitize query
    const queryValidation = validateSearchQuery(body.query);
    if (!queryValidation.valid || !queryValidation.sanitized) {
      return errorResponse(req, queryValidation.error ?? 'Invalid query', 400);
    }

    const query = queryValidation.sanitized;
    const {
      useSemanticSearch = true,
      startDate,
      endDate,
      contentType,
      minImportance,
      maxImportance,
      tags,
    } = body;
    const limit = parseNumber(body.limit, { min: 1, max: 100, default: 50 }) ?? 50;

    console.log('Search request:', { query: query.substring(0, 50), userId, useSemanticSearch, contentType, tags });

    // Initialize Supabase client
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const supabaseClient = createClient(supabaseUrl, supabaseKey);

    let entries: SearchResult[] = [];

    // Use semantic search if requested
    if (useSemanticSearch) {
      try {
        console.log('Attempting semantic search...');

        // Generate embedding for the search query
        const embeddingResponse = await fetch(`${supabaseUrl}/functions/v1/generate-embedding`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${supabaseKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ text: query }),
        });

        if (!embeddingResponse.ok) {
          console.error('Failed to generate query embedding, falling back to keyword search');
          throw new Error('Embedding generation failed');
        }

        const embeddingData = await embeddingResponse.json();
        const queryEmbedding = embeddingData.embedding;

        console.log('Generated query embedding, searching...');

        // Use the semantic search function
        const { data: semanticResults, error: semanticError } = await supabaseClient.rpc(
          'search_entries_by_embedding',
          {
            query_embedding: `[${queryEmbedding.join(',')}]`,
            filter_user_id: userId,
            match_count: limit * 2,
            match_threshold: 0.3,
          }
        );

        if (semanticError) {
          console.error('Semantic search RPC error:', semanticError);
          throw semanticError;
        }

        console.log(`Semantic search returned ${semanticResults?.length ?? 0} results`);
        entries = semanticResults ?? [];
      } catch (semanticError) {
        console.error('Semantic search failed, falling back to keyword search:', semanticError);

        // Fall back to keyword search with escaped query
        const escapedQuery = escapeForLike(query);
        const { data: keywordResults, error: keywordError } = await supabaseClient
          .from('entries')
          .select('id, content, title, content_type, content_subtype, tags, importance_score, created_at')
          .eq('user_id', userId)
          .eq('archived', false)
          .or(`content.ilike.%${escapedQuery}%,title.ilike.%${escapedQuery}%`)
          .order('created_at', { ascending: false })
          .limit(limit * 2);

        if (keywordError) throw keywordError;
        entries = keywordResults ?? [];
      }
    } else {
      // Standard keyword search with escaped query
      console.log('Using keyword search...');
      const escapedQuery = escapeForLike(query);
      const { data: keywordResults, error: keywordError } = await supabaseClient
        .from('entries')
        .select('id, content, title, content_type, content_subtype, tags, importance_score, created_at')
        .eq('user_id', userId)
        .eq('archived', false)
        .or(`content.ilike.%${escapedQuery}%,title.ilike.%${escapedQuery}%`)
        .order('created_at', { ascending: false })
        .limit(limit * 2);

      if (keywordError) throw keywordError;
      entries = keywordResults ?? [];
    }

    // Apply filters
    let filteredEntries = entries;

    // Date filters
    if (startDate) {
      const start = new Date(startDate);
      filteredEntries = filteredEntries.filter((e) => new Date(e.created_at) >= start);
    }
    if (endDate) {
      const end = new Date(endDate);
      filteredEntries = filteredEntries.filter((e) => new Date(e.created_at) <= end);
    }

    // Content type filter
    if (contentType) {
      filteredEntries = filteredEntries.filter((e) => e.content_type === contentType);
    }

    // Importance filters
    if (minImportance !== undefined) {
      filteredEntries = filteredEntries.filter(
        (e) => e.importance_score !== null && e.importance_score >= minImportance
      );
    }
    if (maxImportance !== undefined) {
      filteredEntries = filteredEntries.filter(
        (e) => e.importance_score !== null && e.importance_score <= maxImportance
      );
    }

    // Tags filter
    if (tags && Array.isArray(tags) && tags.length > 0) {
      filteredEntries = filteredEntries.filter(
        (e) => e.tags && tags.some((tag: string) => e.tags.includes(tag))
      );
    }

    // Limit results
    const results = filteredEntries.slice(0, limit);

    console.log(`Returning ${results.length} filtered results`);

    return successResponse(
      req,
      {
        results,
        total: results.length,
        query,
        semantic: useSemanticSearch,
      },
      200,
      rateLimit
    );
  } catch (error) {
    console.error('Error in search-memory function:', error);
    return serverErrorResponse(req, error instanceof Error ? error : new Error('Unknown error'));
  }
});
