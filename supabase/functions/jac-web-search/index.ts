/**
 * jac-web-search — Tavily-Powered Web Grounding for Jac
 *
 * GOAL: Fetch structured, RAG-ready web context for combining with brain context.
 * Uses Tavily Search API for structured JSON output (not pre-synthesized answers).
 *
 * When to call:
 * - Entry mentions learning something → search for current resources
 * - Entry is about a tool/technology → search for updates
 * - User explicitly asks "what's new with X" → search
 * - NOT for personal queries (grocery lists, personal notes)
 */

import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { extractUserId, extractUserIdWithServiceRole, isServiceRoleRequest } from '../_shared/auth.ts';
import { checkRateLimit, RATE_LIMIT_CONFIGS, getRateLimitHeaders } from '../_shared/rateLimit.ts';
import { successResponse, errorResponse, serverErrorResponse } from '../_shared/response.ts';
import { parseJsonBody } from '../_shared/validation.ts';

interface WebSearchRequest {
  /** The search query */
  query: string;
  /** Optional context from user's brain to enhance search */
  brainContext?: string;
  /** Search depth: "basic" (faster) or "advanced" (deeper) */
  searchDepth?: 'basic' | 'advanced';
  /** Maximum number of results to return */
  maxResults?: number;
  /** Include Tavily's AI-generated answer summary */
  includeAnswer?: boolean;
}

interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score: number;
  published_date?: string;
}

interface TavilyResponse {
  query: string;
  answer?: string;
  results: TavilyResult[];
  response_time: number;
}

interface WebSearchResult {
  /** Tavily's AI-generated answer (if requested) */
  answer?: string;
  /** Individual search results */
  results: Array<{
    title: string;
    url: string;
    snippet: string;
    relevanceScore: number;
    publishedDate?: string;
  }>;
  /** Combined context string ready for LLM injection */
  contextForLLM: string;
  /** Metadata about the search */
  meta: {
    query: string;
    resultCount: number;
    responseTimeMs: number;
    searchDepth: 'basic' | 'advanced';
  };
}

serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  try {
    // Parse body first (needed for service role auth)
    const { data: body, error: parseError } = await parseJsonBody<WebSearchRequest>(req);

    // Authenticate — supports both JWT and service role + userId in body
    const { userId, error: authError } = await extractUserIdWithServiceRole(
      req,
      body as unknown as Record<string, unknown>
    );
    if (authError || !userId) {
      return errorResponse(req, authError ?? 'Unauthorized', 401);
    }

    // Skip rate limit for internal agent calls
    const isInternal = isServiceRoleRequest(req);
    if (!isInternal) {
      const rateLimit = checkRateLimit(userId, RATE_LIMIT_CONFIGS.search);
      if (!rateLimit.allowed) {
        return new Response(
          JSON.stringify({ error: 'Rate limit exceeded' }),
          {
            status: 429,
            headers: {
              ...getCorsHeaders(req),
              'Content-Type': 'application/json',
              ...getRateLimitHeaders(rateLimit)
            }
          }
        );
      }
    }

    const tavilyApiKey = Deno.env.get('TAVILY_API_KEY');
    if (!tavilyApiKey) {
      console.error('TAVILY_API_KEY not configured');
      return errorResponse(req, 'Web search not configured', 500);
    }
    if (parseError || !body) {
      return errorResponse(req, parseError ?? 'Invalid request body', 400);
    }

    const { 
      query, 
      brainContext, 
      searchDepth = 'basic', 
      maxResults = 5,
      includeAnswer = true,
    } = body;

    if (!query || query.trim().length < 3) {
      return errorResponse(req, 'Query must be at least 3 characters', 400);
    }

    // Enhance query with brain context if available
    let enhancedQuery = query;
    if (brainContext) {
      // Extract key terms from brain context to make search more relevant
      const contextKeywords = brainContext
        .split(/\s+/)
        .filter(word => word.length > 4)
        .slice(0, 5)
        .join(' ');
      
      if (contextKeywords) {
        enhancedQuery = `${query} ${contextKeywords}`;
        console.log(`Enhanced query with brain context: "${enhancedQuery}"`);
      }
    }

    // Add current year for relevance
    const currentYear = new Date().getFullYear();
    if (!enhancedQuery.match(/\d{4}/)) {
      enhancedQuery = `${enhancedQuery} ${currentYear}`;
    }

    console.log(`Tavily search: "${enhancedQuery}" (depth: ${searchDepth})`);

    // Call Tavily Search API
    const tavilyResponse = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        api_key: tavilyApiKey,
        query: enhancedQuery,
        search_depth: searchDepth,
        include_answer: includeAnswer,
        include_raw_content: false,
        max_results: maxResults,
        // Focus on educational/documentation content
        include_domains: [],
        exclude_domains: [],
      }),
    });

    if (!tavilyResponse.ok) {
      const errText = await tavilyResponse.text();
      console.error('Tavily API error:', tavilyResponse.status, errText);
      
      if (tavilyResponse.status === 401) {
        return errorResponse(req, 'Invalid Tavily API key', 500);
      }
      if (tavilyResponse.status === 429) {
        return errorResponse(req, 'Tavily rate limit exceeded', 429);
      }
      
      return errorResponse(req, 'Web search failed', 500);
    }

    const tavilyData: TavilyResponse = await tavilyResponse.json();
    console.log(`Tavily returned ${tavilyData.results.length} results in ${tavilyData.response_time}s`);

    // Transform results into our format
    const results = tavilyData.results.map(r => ({
      title: r.title,
      url: r.url,
      snippet: r.content,
      relevanceScore: r.score,
      publishedDate: r.published_date,
    }));

    // Build context string for LLM injection
    const contextParts: string[] = [];
    
    if (tavilyData.answer) {
      contextParts.push(`=== WEB SUMMARY ===\n${tavilyData.answer}`);
    }
    
    contextParts.push('\n=== WEB SOURCES ===');
    
    for (const result of results) {
      contextParts.push(
        `[${result.title}](${result.url})\n${result.snippet}\n`
      );
    }

    const contextForLLM = contextParts.join('\n');

    const searchResult: WebSearchResult = {
      answer: tavilyData.answer,
      results,
      contextForLLM,
      meta: {
        query: enhancedQuery,
        resultCount: results.length,
        responseTimeMs: Math.round(tavilyData.response_time * 1000),
        searchDepth,
      },
    };

    return successResponse(req, searchResult, 200, rateLimit);

  } catch (error) {
    console.error('Error in jac-web-search:', error);
    return serverErrorResponse(req, error instanceof Error ? error : new Error('Unknown error'));
  }
});
