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
import { extractUserId, extractUserIdWithServiceRole, isServiceRoleRequest } from '../_shared/auth.ts';
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
    // Parse request body first (needed for service role auth)
    const { data: body, error: parseError } = await parseJsonBody<SearchRequest>(req);

    // Authenticate user — supports both JWT and service role + userId in body
    const { userId, error: authError } = await extractUserIdWithServiceRole(
      req,
      body as unknown as Record<string, unknown>
    );
    if (authError || !userId) {
      return errorResponse(req, authError ?? 'Unauthorized', 401);
    }

    // Skip rate limit for internal agent calls
    const isInternal = isServiceRoleRequest(req);
    let rateLimit: ReturnType<typeof checkRateLimit> | undefined;
    if (!isInternal) {
      rateLimit = checkRateLimit(userId, RATE_LIMIT_CONFIGS.search);
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
    }
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
      // Smart search: try semantic (vector) search first, then fall back to keyword
      console.log('Using smart search (semantic + keyword)...');

      const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
      const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

      // Try vector-based semantic search first
      let semanticResults: SearchResult[] = [];
      if (query.length >= 3) {
        try {
          const embResponse = await fetch(`${supabaseUrl}/functions/v1/generate-embedding`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${supabaseServiceKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ text: query }),
          });

          if (embResponse.ok) {
            const embData = await embResponse.json();
            if (embData.embedding) {
              const { data: vectorResults, error: vectorError } = await supabaseClient.rpc(
                'search_entries_by_embedding',
                {
                  query_embedding: JSON.stringify(embData.embedding),
                  match_threshold: 0.5,
                  match_count: limit,
                  filter_user_id: userId,
                }
              );

              if (!vectorError && vectorResults && vectorResults.length > 0) {
                semanticResults = vectorResults.map((r: any) => ({
                  ...r,
                  similarity: r.similarity,
                }));
                console.log(`Semantic search found ${semanticResults.length} results`);
              }
            }
          }
        } catch (embErr) {
          console.warn('Semantic search failed, falling back to keyword:', embErr);
        }
      }

      // Always also do keyword search to catch exact matches semantic might miss
      const searchWords = query.toLowerCase().split(/\s+/).filter((w: string) => w.length >= 2);

      // Build OR conditions: exact phrase match + individual word matches
      const orConditions: string[] = [
        `content.ilike.%${escapedQuery}%`,
        `title.ilike.%${escapedQuery}%`,
      ];
      // Add individual word ilike matches for better recall
      for (const word of searchWords) {
        const escapedWord = escapeForLike(word);
        orConditions.push(`content.ilike.%${escapedWord}%`);
        orConditions.push(`title.ilike.%${escapedWord}%`);
      }
      // Deduplicate conditions
      const uniqueConditions = [...new Set(orConditions)];

      const { data: keywordResults, error: keywordError } = await supabaseClient
        .from('entries')
        .select('id, content, title, content_type, content_subtype, tags, importance_score, created_at')
        .eq('user_id', userId)
        .eq('archived', false)
        .or(uniqueConditions.join(','))
        .order('importance_score', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false })
        .limit(limit);

      if (keywordError) throw keywordError;

      // Merge: semantic results first (they have similarity scores), then keyword-only results
      const seenIds = new Set<string>();

      // Add semantic results first (already ranked by similarity)
      for (const result of semanticResults) {
        if (!seenIds.has(result.id)) {
          seenIds.add(result.id);
          entries.push(result);
        }
      }

      // Add keyword results that weren't in semantic results
      for (const result of (keywordResults || [])) {
        if (!seenIds.has(result.id)) {
          seenIds.add(result.id);
          entries.push(result);
        }
      }

      // Also check tag matches
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
          for (const result of tagResults) {
            if (!seenIds.has(result.id)) {
              seenIds.add(result.id);
              entries.push(result);
            }
          }
        }
      }

      console.log(`Smart search returned ${entries.length} results (${semanticResults.length} semantic, rest keyword)`);
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
