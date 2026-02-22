/**
 * Structured activity logger for JAC Agent OS
 *
 * Every agent step is recorded to agent_activity_log for full
 * end-to-end observability. The frontend subscribes via realtime
 * so users see exactly what's happening as it happens.
 *
 * Usage:
 *   const log = createAgentLogger(supabase, taskId, userId, 'jac-research-agent');
 *   const done = await log.step('web_search', { query: '...' });
 *   // ... do the work ...
 *   done({ resultCount: 5 });  // completes the step with duration
 *
 *   // Or for failures:
 *   done.fail('Tavily returned 500');
 */

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';

export interface StepResult {
  (detail?: Record<string, unknown>): Promise<void>;
  fail: (error: string, detail?: Record<string, unknown>) => Promise<void>;
}

export interface AgentLogger {
  step: (stepName: string, detail?: Record<string, unknown>) => Promise<StepResult>;
  info: (stepName: string, detail?: Record<string, unknown>) => Promise<void>;
}

export function createAgentLogger(
  supabase: SupabaseClient,
  taskId: string,
  userId: string,
  agent: string
): AgentLogger {

  async function insertLog(
    step: string,
    status: 'started' | 'completed' | 'failed' | 'skipped',
    detail: Record<string, unknown> = {},
    durationMs?: number
  ): Promise<void> {
    try {
      await supabase.from('agent_activity_log').insert({
        task_id: taskId,
        user_id: userId,
        agent,
        step,
        status,
        detail,
        duration_ms: durationMs ?? null,
      });
    } catch (err) {
      // Never let logging break the agent
      console.warn(`[logger] Failed to log step "${step}":`, err);
    }
  }

  return {
    /**
     * Start a timed step. Returns a function to call when done.
     */
    async step(stepName: string, detail: Record<string, unknown> = {}): Promise<StepResult> {
      const startTime = Date.now();
      await insertLog(stepName, 'started', detail);

      const complete = async (endDetail?: Record<string, unknown>) => {
        const duration = Date.now() - startTime;
        await insertLog(stepName, 'completed', { ...detail, ...endDetail }, duration);
      };

      complete.fail = async (error: string, endDetail?: Record<string, unknown>) => {
        const duration = Date.now() - startTime;
        await insertLog(stepName, 'failed', { ...detail, ...endDetail, error }, duration);
      };

      return complete;
    },

    /**
     * Log an instant event (no duration tracking).
     */
    async info(stepName: string, detail: Record<string, unknown> = {}): Promise<void> {
      await insertLog(stepName, 'completed', detail, 0);
    },
  };
}
