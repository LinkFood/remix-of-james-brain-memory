/**
 * search-memory — Keyword + Tag Search
 * 
 * GOAL: Find anything in the user's brain.
 * 
 * Uses PostgreSQL keyword matching and tag filtering.
 * No external API keys required.
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
  useSemanticSearch?: boolean; // Now means "smart search" - expanded keyword matching
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
      useSemanticSearch = true, // "Smart search" mode
      startDate,
      endDate,
      contentType,
      minImportance,
      maxImportance,
      tags,
    } = body;
    const limit = parseNumber(body.limit, { min: 1, max: 100, default: 50 }) ?? 50;

    console.log('Search request:', { query: query.substring(0, 50), userId, smartSearch: useSemanticSearch, contentType, tags });

    // Initialize Supabase client
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const supabaseClient = createClient(supabaseUrl, supabaseKey);

    let entries: SearchResult[] = [];
    const escapedQuery = escapeForLike(query);

    if (useSemanticSearch) {
      // "Smart search" - search across multiple fields and expand to word-level matching
      console.log('Using smart search (expanded keyword matching)...');
      
      // Split query into individual words for broader matching
      const searchWords = query.toLowerCase().split(/\s+/).filter(w => w.length >= 2);
      
      // Build OR conditions for each word across content and title
      // Also search in tags array
      const { data: keywordResults, error: keywordError } = await supabaseClient
        .from('entries')
        .select('id, content, title, content_type, content_subtype, tags, importance_score, created_at')
        .eq('user_id', userId)
        .eq('archived', false)
        .or(`content.ilike.%${escapedQuery}%,title.ilike.%${escapedQuery}%`)
        .order('importance_score', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false })
        .limit(limit * 2);

      if (keywordError) throw keywordError;
      
      // If no results from exact match, try word-level matching
      if (!keywordResults || keywordResults.length === 0) {
        console.log('No exact match, trying word-level search...');
        
        // Try searching for individual words
        for (const word of searchWords.slice(0, 3)) { // Limit to first 3 words
          const escapedWord = escapeForLike(word);
          const { data: wordResults, error: wordError } = await supabaseClient
            .from('entries')
            .select('id, content, title, content_type, content_subtype, tags, importance_score, created_at')
            .eq('user_id', userId)
            .eq('archived', false)
            .or(`content.ilike.%${escapedWord}%,title.ilike.%${escapedWord}%`)
            .order('importance_score', { ascending: false, nullsFirst: false })
            .order('created_at', { ascending: false })
            .limit(limit);
          
          if (!wordError && wordResults) {
            // Add unique results
            for (const result of wordResults) {
              if (!entries.find(e => e.id === result.id)) {
                entries.push(result);
              }
            }
          }
        }
      } else {
        entries = keywordResults;
      }
      
      // Also check for tag matches
      if (searchWords.length > 0) {
        const { data: tagResults, error: tagError } = await supabaseClient
          .from('entries')
          .select('id, content, title, content_type, content_subtype, tags, importance_score, created_at')
          .eq('user_id', userId)
          .eq('archived', false)
          .contains('tags', searchWords)
          .order('importance_score', { ascending: false, nullsFirst: false })
          .limit(limit);
        
        if (!tagError && tagResults) {
          // Add unique tag results to the front (they're more relevant)
          for (const result of tagResults) {
            if (!entries.find(e => e.id === result.id)) {
              entries.unshift(result);
            }
          }
        }
      }
      
      console.log(`Smart search returned ${entries.length} results`);
    } else {
      // Standard keyword search - exact phrase matching only
      console.log('Using keyword search...');
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
