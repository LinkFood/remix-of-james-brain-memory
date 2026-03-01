/**
 * useCronJobs — Queries get_cron_status() RPC for cron job list + status.
 *
 * Auto-refreshes every 30s. Provides toggleJob() to enable/disable.
 */

import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';

export interface CronJob {
  jobid: number;
  jobname: string;
  schedule: string;
  command: string;
  active: boolean;
  last_run_status: string | null;
  last_run_at: string | null;
  last_run_duration: string | null;
}

export function useCronJobs() {
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchJobs = useCallback(async () => {
    try {
      const { data, error: rpcError } = await supabase.rpc('get_cron_status');

      if (rpcError) {
        setError(rpcError.message);
        return;
      }

      setJobs((data as CronJob[]) || []);
      setError(null);
    } catch (err) {
      console.warn('[useCronJobs] Fetch failed (non-blocking):', err);
      setError('Failed to fetch cron jobs');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchJobs();
  }, [fetchJobs]);

  // Auto-refresh every 30s
  useEffect(() => {
    const interval = setInterval(fetchJobs, 30_000);
    return () => clearInterval(interval);
  }, [fetchJobs]);

  const toggleJob = useCallback(async (jobName: string, enabled: boolean) => {
    try {
      const { error: rpcError } = await supabase.rpc('toggle_cron_job', {
        job_name: jobName,
        enabled,
      });

      if (rpcError) {
        console.error('[useCronJobs] Toggle failed:', rpcError);
        return false;
      }

      // Optimistic update
      setJobs(prev => prev.map(j =>
        j.jobname === jobName ? { ...j, active: enabled } : j
      ));

      return true;
    } catch (err) {
      console.error('[useCronJobs] Toggle failed:', err);
      return false;
    }
  }, []);

  return { jobs, loading, error, refetch: fetchJobs, toggleJob };
}
