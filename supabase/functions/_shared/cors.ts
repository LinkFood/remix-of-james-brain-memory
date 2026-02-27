/**
 * Shared CORS headers for Supabase Edge Functions
 *
 * This module provides dynamic CORS handling based on request origin.
 * Allows Vercel deployment, custom domain, and localhost in development.
 */

const ALLOWED_ORIGINS = [
  'https://linkjac.cloud',
  'https://www.linkjac.cloud',
];

// Check if we're in development mode
const isDevelopment = Deno.env.get('ENVIRONMENT') !== 'production';

/**
 * Get CORS headers based on the request origin
 */
export function getCorsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('origin') ?? '';

  // Check if origin is allowed
  const isAllowed =
    ALLOWED_ORIGINS.includes(origin) ||
    origin.endsWith('.vercel.app') ||
    (isDevelopment && (origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1')));

  return {
    'Access-Control-Allow-Origin': isAllowed ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS, PUT, DELETE',
    'Access-Control-Max-Age': '86400',
  };
}

/**
 * Handle CORS preflight requests
 * @returns Response for OPTIONS request, or null if not a preflight request
 */
export function handleCors(request: Request): Response | null {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: getCorsHeaders(request),
    });
  }
  return null;
}

