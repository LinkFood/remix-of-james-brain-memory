/**
 * Shared authentication utilities for Supabase Edge Functions
 * 
 * Extracts and validates user identity from JWT tokens.
 */

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';

export interface AuthResult {
  userId: string | null;
  error: string | null;
  supabase: SupabaseClient | null;
}

/**
 * Extract user ID from request authorization header
 * 
 * @param request - The incoming request
 * @returns AuthResult with userId, error, and authenticated Supabase client
 */
export async function extractUserId(request: Request): Promise<AuthResult> {
  const authHeader = request.headers.get('authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { userId: null, error: 'Missing or invalid authorization header', supabase: null };
  }

  const token = authHeader.replace('Bearer ', '');

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');

    if (!supabaseUrl || !supabaseAnonKey) {
      return { userId: null, error: 'Server configuration error', supabase: null };
    }

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    // Prefer signing-keys compatible verification via getClaims()
    // This avoids "session not found" failures that can happen with getUser().
    const authAny = supabase.auth as unknown as {
      getClaims?: (jwt: string) => Promise<{ data: { claims?: { sub?: string } } | null; error: { message: string } | null }>;
    };

    if (typeof authAny.getClaims === 'function') {
      const { data, error } = await authAny.getClaims(token);
      const userId = data?.claims?.sub ?? null;

      if (error || !userId) {
        console.error('Auth claims error:', error?.message);
        return { userId: null, error: 'Invalid or expired token', supabase: null };
      }

      return { userId, error: null, supabase };
    }

    // Fallback for older clients
    const { data, error } = await supabase.auth.getUser(token);

    if (error || !data.user) {
      console.error('Auth user error:', error?.message);
      return { userId: null, error: 'Invalid or expired token', supabase: null };
    }

    return { userId: data.user.id, error: null, supabase };
  } catch (err) {
    console.error('Auth exception:', err);
    return { userId: null, error: 'Authentication failed', supabase: null };
  }
}

/**
 * Create a Supabase client with service role for admin operations
 * Use sparingly and only when necessary
 */
export function createServiceClient(): SupabaseClient | null {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl || !serviceRoleKey) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    return null;
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

/**
 * Check if the request is from a trusted internal service
 * (e.g., another edge function calling this one)
 */
export function isServiceRoleRequest(request: Request): boolean {
  const authHeader = request.headers.get('authorization');
  if (!authHeader) return false;

  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!serviceRoleKey) return false;

  return authHeader === `Bearer ${serviceRoleKey}`;
}
