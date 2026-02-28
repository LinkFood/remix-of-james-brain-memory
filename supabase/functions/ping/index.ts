/**
 * ping — Lightweight Health Probe for JAC Agent OS
 *
 * Returns a simple "pong" response with timestamp for load balancers
 * and monitoring systems that need a fast, lightweight health check.
 *
 * Provides:
 * - Status indicator ("pong")
 * - Current timestamp in ISO format
 * - No authentication required
 * - CORS support for cross-origin requests
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleCors } from '../_shared/cors.ts';
import { successResponse, errorResponse } from '../_shared/response.ts';

interface PingResponse {
  status: string;
  timestamp: string;
}

serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  try {
    // Only allow GET requests
    if (req.method !== 'GET') {
      return errorResponse(req, 'Method not allowed', 405);
    }

    const response: PingResponse = {
      status: 'pong',
      timestamp: new Date().toISOString()
    };

    return successResponse(req, response, 200);

  } catch (error) {
    console.error('[ping] Unexpected error:', error);
    return errorResponse(req, 'Internal server error', 500);
  }
});