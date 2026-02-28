/**
 * health-check — System Health Monitor for JAC Agent OS
 *
 * Returns comprehensive health status of all deployed edge functions,
 * database connectivity, and cron job execution status.
 *
 * Provides:
 * - Overall system health (healthy/degraded/unhealthy)
 * - Individual edge function ping results with response times
 * - Database connection status and query performance
 * - Last successful cron job execution times
 * - Detailed error reporting for debugging
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { handleCors } from '../_shared/cors.ts';
import { successResponse, errorResponse, serverErrorResponse } from '../_shared/response.ts';
import { createAgentLogger } from '../_shared/logger.ts';

// All deployed edge functions to monitor
const EDGE_FUNCTIONS = [
  'jac-dispatcher',
  'jac-research-agent',
  'jac-save-agent', 
  'jac-search-agent',
  'jac-code-agent',
  'assistant-chat',
  'smart-save',
  'search-memory',
  'brain-insights',
  'jac-dashboard-query',
  'jac-kill-switch',
  'generate-embedding',
  'classify-content',
  'calculate-importance',
  'jac-web-search',
  'sync-codebase',
  'read-file',
  'backfill-embeddings',
  'calendar-reminder-check',
  'slack-incoming'
];

// Ping timeout in milliseconds
const PING_TIMEOUT = 5000;

interface EdgeFunctionStatus {
  name: string;
  status: 'healthy' | 'unhealthy' | 'timeout';
  responseTime?: number;
  error?: string;
}

interface CronJobStatus {
  jobname: string;
  lastSuccessfulRun?: string;
  status: 'healthy' | 'stale' | 'never_run';
  daysSinceLastRun?: number;
}

interface DatabaseStatus {
  connected: boolean;
  responseTime?: number;
  error?: string;
}

interface HealthCheckResponse {
  systemStatus: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  database: DatabaseStatus;
  edgeFunctions: EdgeFunctionStatus[];
  cronJobs: CronJobStatus[];
  summary: {
    totalFunctions: number;
    healthyFunctions: number;
    unhealthyFunctions: number;
    totalCronJobs: number;
    staleCronJobs: number;
  };
  errors?: string[];
}

/**
 * Ping an edge function with lightweight health check
 */
async function pingEdgeFunction(functionName: string, supabaseUrl: string, serviceKey: string): Promise<EdgeFunctionStatus> {
  const startTime = Date.now();
  
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), PING_TIMEOUT);
    
    const response = await fetch(`${supabaseUrl}/functions/v1/${functionName}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type': 'application/json'
      },
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    const responseTime = Date.now() - startTime;
    
    // Consider 2xx, 4xx as healthy (function is responding)
    // Only 5xx or network errors are unhealthy
    if (response.status < 500) {
      return {
        name: functionName,
        status: 'healthy',
        responseTime
      };
    } else {
      return {
        name: functionName,
        status: 'unhealthy',
        responseTime,
        error: `HTTP ${response.status}`
      };
    }
    
  } catch (error) {
    const responseTime = Date.now() - startTime;
    
    if (error instanceof Error && error.name === 'AbortError') {
      return {
        name: functionName,
        status: 'timeout',
        responseTime,
        error: 'Request timeout'
      };
    }
    
    return {
      name: functionName,
      status: 'unhealthy',
      responseTime,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Check database connectivity and performance
 */
async function checkDatabaseHealth(supabase: any): Promise<DatabaseStatus> {
  const startTime = Date.now();
  
  try {
    // Simple query to test connectivity
    const { data, error } = await supabase
      .from('agent_tasks')
      .select('id')
      .limit(1);
    
    const responseTime = Date.now() - startTime;
    
    if (error) {
      return {
        connected: false,
        responseTime,
        error: error.message
      };
    }
    
    return {
      connected: true,
      responseTime
    };
    
  } catch (error) {
    const responseTime = Date.now() - startTime;
    return {
      connected: false,
      responseTime,
      error: error instanceof Error ? error.message : 'Unknown database error'
    };
  }
}

/**
 * Get cron job execution status from pg_cron
 */
async function getCronJobStatus(supabase: any): Promise<CronJobStatus[]> {
  try {
    // Query pg_cron.job_run_details for last successful runs
    const { data, error } = await supabase.rpc('get_cron_job_status', {});
    
    if (error) {
      console.warn('Failed to query cron job status:', error);
      return [];
    }
    
    if (!data || !Array.isArray(data)) {
      return [];
    }
    
    return data.map((job: any) => {
      const lastRun = job.last_successful_run;
      const daysSince = lastRun ? 
        Math.floor((Date.now() - new Date(lastRun).getTime()) / (1000 * 60 * 60 * 24)) : 
        null;
      
      let status: 'healthy' | 'stale' | 'never_run' = 'never_run';
      if (lastRun) {
        // Consider jobs stale if they haven't run successfully in 2+ days
        status = (daysSince !== null && daysSince < 2) ? 'healthy' : 'stale';
      }
      
      return {
        jobname: job.jobname,
        lastSuccessfulRun: lastRun,
        status,
        daysSinceLastRun: daysSince
      };
    });
    
  } catch (error) {
    console.warn('Error checking cron job status:', error);
    return [];
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

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    
    if (!supabaseUrl || !serviceKey) {
      return serverErrorResponse(req, 'Missing required environment variables');
    }

    const supabase = createClient(supabaseUrl, serviceKey);
    const startTime = Date.now();
    const errors: string[] = [];

    // Run all health checks in parallel
    const [databaseStatus, edgeFunctionResults, cronJobResults] = await Promise.all([
      checkDatabaseHealth(supabase),
      Promise.all(
        EDGE_FUNCTIONS.map(fn => pingEdgeFunction(fn, supabaseUrl, serviceKey))
      ),
      getCronJobStatus(supabase)
    ]);

    // Collect any errors
    if (!databaseStatus.connected) {
      errors.push(`Database: ${databaseStatus.error}`);
    }

    const unhealthyFunctions = edgeFunctionResults.filter(f => f.status !== 'healthy');
    unhealthyFunctions.forEach(f => {
      errors.push(`${f.name}: ${f.error || f.status}`);
    });

    const staleCronJobs = cronJobResults.filter(j => j.status === 'stale');
    staleCronJobs.forEach(j => {
      errors.push(`Cron job '${j.jobname}' stale (${j.daysSinceLastRun} days)`);
    });

    // Determine overall system status
    let systemStatus: 'healthy' | 'degraded' | 'unhealthy';
    
    if (!databaseStatus.connected) {
      systemStatus = 'unhealthy';
    } else if (unhealthyFunctions.length > 0 || staleCronJobs.length > 0) {
      // System is degraded if some functions are down or cron jobs are stale
      const criticalFunctionsDown = unhealthyFunctions.some(f => 
        ['jac-dispatcher', 'assistant-chat', 'smart-save'].includes(f.name)
      );
      systemStatus = criticalFunctionsDown ? 'unhealthy' : 'degraded';
    } else {
      systemStatus = 'healthy';
    }

    const response: HealthCheckResponse = {
      systemStatus,
      timestamp: new Date().toISOString(),
      database: databaseStatus,
      edgeFunctions: edgeFunctionResults,
      cronJobs: cronJobResults,
      summary: {
        totalFunctions: EDGE_FUNCTIONS.length,
        healthyFunctions: edgeFunctionResults.filter(f => f.status === 'healthy').length,
        unhealthyFunctions: unhealthyFunctions.length,
        totalCronJobs: cronJobResults.length,
        staleCronJobs: staleCronJobs.length
      },
      ...(errors.length > 0 && { errors })
    };

    // Return appropriate HTTP status based on system health
    const httpStatus = systemStatus === 'healthy' ? 200 : 
                      systemStatus === 'degraded' ? 207 : 503;

    return successResponse(req, response, httpStatus);

  } catch (error) {
    console.error('[health-check] Unexpected error:', error);
    return serverErrorResponse(req, error);
  }
});
