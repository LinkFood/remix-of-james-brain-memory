/**
 * Shared response utilities for Supabase Edge Functions
 * 
 * Provides consistent response formatting across all functions.
 */

import { getCorsHeaders } from './cors.ts';
import { getRateLimitHeaders, type RateLimitResult } from './rateLimit.ts';

/**
 * Create a successful JSON response
 */
export function successResponse<T>(
  request: Request,
  data: T,
  status = 200,
  rateLimitResult?: RateLimitResult
): Response {
  const headers: Record<string, string> = {
    ...getCorsHeaders(request),
    'Content-Type': 'application/json',
  };

  if (rateLimitResult) {
    Object.assign(headers, getRateLimitHeaders(rateLimitResult));
  }

  return new Response(JSON.stringify(data), {
    status,
    headers,
  });
}

/**
 * Create an error JSON response
 */
export function errorResponse(
  request: Request,
  message: string,
  status = 400,
  details?: Record<string, unknown>
): Response {
  const body: Record<string, unknown> = { error: message };
  if (details) {
    body.details = details;
  }

  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...getCorsHeaders(request),
      'Content-Type': 'application/json',
    },
  });
}

/**
 * Create a streaming response for SSE
 */
export function streamResponse(
  request: Request,
  stream: ReadableStream
): Response {
  return new Response(stream, {
    headers: {
      ...getCorsHeaders(request),
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

/**
 * Create an unauthorized response
 */
export function unauthorizedResponse(request: Request, message = 'Unauthorized'): Response {
  return errorResponse(request, message, 401);
}

/**
 * Create a not found response
 */
export function notFoundResponse(request: Request, message = 'Not found'): Response {
  return errorResponse(request, message, 404);
}

/**
 * Create a rate limit exceeded response
 */
export function rateLimitResponse(request: Request, retryAfterSeconds: number): Response {
  return new Response(
    JSON.stringify({
      error: 'Rate limit exceeded',
      retryAfter: retryAfterSeconds,
    }),
    {
      status: 429,
      headers: {
        ...getCorsHeaders(request),
        'Content-Type': 'application/json',
        'Retry-After': retryAfterSeconds.toString(),
      },
    }
  );
}

/**
 * Create a server error response
 */
export function serverErrorResponse(
  request: Request,
  error: Error | string,
  includeStack = false
): Response {
  const message = error instanceof Error ? error.message : error;
  const body: Record<string, unknown> = { error: 'Internal server error' };

  // Only include details in development
  if (Deno.env.get('ENVIRONMENT') !== 'production') {
    body.message = message;
    if (includeStack && error instanceof Error && error.stack) {
      body.stack = error.stack;
    }
  }

  return new Response(JSON.stringify(body), {
    status: 500,
    headers: {
      ...getCorsHeaders(request),
      'Content-Type': 'application/json',
    },
  });
}
