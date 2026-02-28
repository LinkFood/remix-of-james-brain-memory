/**
 * version – System Version Information for JAC Agent OS
 *
 * Returns current system version information including git commit hash,
 * deploy timestamp, and system uptime for monitoring and debugging.
 *
 * Provides:
 * - Git commit hash from environment variable or "unknown"
 * - Deploy timestamp from environment variable or current time
 * - System uptime in seconds since deployment
 * - Status indicator
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleCors } from '../_shared/cors.ts';
import { successResponse, errorResponse, serverErrorResponse } from '../_shared/response.ts';
import { createAgentLogger } from '../_shared/logger.ts';

interface VersionResponse {
  git_commit_hash: string;
  deploy_timestamp: string;
  system_uptime_seconds: number;
  status: string;
}

/**
 * Calculate system uptime in seconds
 */
function calculateUptime(deployTimestamp?: string): number {
  try {
    // First try to use Deno's process uptime if available
    if (typeof performance !== 'undefined' && performance.timeOrigin) {
      return Math.floor((Date.now() - performance.timeOrigin) / 1000);
    }
    
    // Fallback to deployment timestamp if provided
    if (deployTimestamp) {
      const deployTime = new Date(deployTimestamp).getTime();
      if (!isNaN(deployTime)) {
        return Math.floor((Date.now() - deployTime) / 1000);
      }
    }
    
    // Final fallback - assume deployment was at process start
    return Math.floor(Date.now() / 1000) % (24 * 60 * 60); // Max 24 hours
    
  } catch (error) {
    console.warn('[version] Error calculating uptime:', error);
    return 0;
  }
}

serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  try {
    // Only allow GET requests
    if (req.method !== 'GET') {
      return errorResponse(req, 'Method not allowed', 405);
    }

    // Get version information from environment variables
    const gitCommitHash = Deno.env.get('GIT_COMMIT_HASH') || 'unknown';
    const deployTimestamp = Deno.env.get('DEPLOY_TIMESTAMP') || new Date().toISOString();
    
    // Calculate system uptime
    const systemUptimeSeconds = calculateUptime(deployTimestamp);

    const response: VersionResponse = {
      git_commit_hash: gitCommitHash,
      deploy_timestamp: deployTimestamp,
      system_uptime_seconds: systemUptimeSeconds,
      status: 'ok'
    };

    return successResponse(req, response, 200);

  } catch (error) {
    console.error('[version] Unexpected error:', error);
    return serverErrorResponse(req, error);
  }
});