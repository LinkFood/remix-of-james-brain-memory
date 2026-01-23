/**
 * Shared rate limiting utilities for Supabase Edge Functions
 * 
 * Implements in-memory rate limiting with automatic cleanup.
 */

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

// In-memory rate limit storage
const rateLimitMap = new Map<string, RateLimitEntry>();

// Cleanup old entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap.entries()) {
    if (now > entry.resetTime) {
      rateLimitMap.delete(key);
    }
  }
}, 5 * 60 * 1000);

export interface RateLimitConfig {
  /** Maximum number of requests allowed in the window */
  maxRequests: number;
  /** Time window in milliseconds */
  windowMs: number;
}

export interface RateLimitResult {
  /** Whether the request is allowed */
  allowed: boolean;
  /** Number of remaining requests in the window */
  remaining: number;
  /** Milliseconds until the rate limit resets */
  resetIn: number;
}

/**
 * Default rate limit configurations for different function types
 */
export const RATE_LIMIT_CONFIGS = {
  /** Standard operations (100 req/min) */
  standard: { maxRequests: 100, windowMs: 60 * 1000 },
  /** AI operations (50 req/min) - more expensive */
  ai: { maxRequests: 50, windowMs: 60 * 1000 },
  /** Search operations (30 req/min) */
  search: { maxRequests: 30, windowMs: 60 * 1000 },
  /** Heavy operations (10 req/min) - exports, reports */
  heavy: { maxRequests: 10, windowMs: 60 * 1000 },
  /** Very restrictive (5 req/min) - destructive operations */
  restrictive: { maxRequests: 5, windowMs: 60 * 1000 },
} as const;

/**
 * Check if a request is within rate limits
 * 
 * @param identifier - Unique identifier for rate limiting (usually user ID)
 * @param config - Rate limit configuration
 * @returns RateLimitResult indicating if request is allowed
 */
export function checkRateLimit(
  identifier: string,
  config: RateLimitConfig
): RateLimitResult {
  const now = Date.now();
  const key = identifier;
  const entry = rateLimitMap.get(key);

  // No existing entry or expired - create new
  if (!entry || now > entry.resetTime) {
    rateLimitMap.set(key, {
      count: 1,
      resetTime: now + config.windowMs,
    });

    return {
      allowed: true,
      remaining: config.maxRequests - 1,
      resetIn: config.windowMs,
    };
  }

  // Check if limit exceeded
  if (entry.count >= config.maxRequests) {
    return {
      allowed: false,
      remaining: 0,
      resetIn: entry.resetTime - now,
    };
  }

  // Increment counter
  entry.count++;

  return {
    allowed: true,
    remaining: config.maxRequests - entry.count,
    resetIn: entry.resetTime - now,
  };
}

/**
 * Get rate limit headers to include in response
 */
export function getRateLimitHeaders(result: RateLimitResult): Record<string, string> {
  return {
    'X-RateLimit-Remaining': result.remaining.toString(),
    'X-RateLimit-Reset': Math.ceil(result.resetIn / 1000).toString(),
  };
}

/**
 * Combined check that returns early response if rate limited
 */
export function enforceRateLimit(
  identifier: string,
  config: RateLimitConfig,
  corsHeaders: Record<string, string>
): { allowed: true; result: RateLimitResult } | { allowed: false; response: Response } {
  const result = checkRateLimit(identifier, config);

  if (!result.allowed) {
    return {
      allowed: false,
      response: new Response(
        JSON.stringify({
          error: 'Rate limit exceeded',
          retryAfter: Math.ceil(result.resetIn / 1000),
        }),
        {
          status: 429,
          headers: {
            ...corsHeaders,
            ...getRateLimitHeaders(result),
            'Content-Type': 'application/json',
          },
        }
      ),
    };
  }

  return { allowed: true, result };
}
