-- Rider — get_cron_status() gains last_successful_run.
--
-- Phase A finding (2026-05-16): get_cron_status() returns last_run_status +
-- last_run_at for the single most-recent run regardless of status. An
-- autonomous-execution audit asking "when did job X last *succeed*" cannot
-- be answered — a job whose latest run failed shows the failed run's
-- timestamp and no path to the last good one.
--
-- Fix: additive last_successful_run column from a second LEFT JOIN LATERAL
-- filtered to status='succeeded'. All existing return columns preserved in
-- order (CLAUDE.md RPC rule); the new column is appended. A return-type
-- change requires DROP FUNCTION before CREATE.

SET search_path = public, extensions;

DROP FUNCTION IF EXISTS public.get_cron_status();

CREATE FUNCTION public.get_cron_status()
RETURNS TABLE (
  jobid bigint,
  jobname text,
  schedule text,
  command text,
  active boolean,
  last_run_status text,
  last_run_at timestamptz,
  last_run_duration interval,
  last_successful_run timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'cron' AND table_name = 'job'
  ) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    j.jobid,
    j.jobname::text,
    j.schedule::text,
    j.command::text,
    j.active,
    d.status AS last_run_status,
    d.start_time AS last_run_at,
    d.end_time - d.start_time AS last_run_duration,
    s.start_time AS last_successful_run
  FROM cron.job j
  LEFT JOIN LATERAL (
    SELECT jrd.status, jrd.start_time, jrd.end_time
    FROM cron.job_run_details jrd
    WHERE jrd.jobid = j.jobid
    ORDER BY jrd.start_time DESC LIMIT 1
  ) d ON true
  LEFT JOIN LATERAL (
    SELECT jrd.start_time
    FROM cron.job_run_details jrd
    WHERE jrd.jobid = j.jobid AND jrd.status = 'succeeded'
    ORDER BY jrd.start_time DESC LIMIT 1
  ) s ON true
  ORDER BY j.jobname;

EXCEPTION
  WHEN OTHERS THEN
    RETURN;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_cron_status() TO service_role;
GRANT EXECUTE ON FUNCTION public.get_cron_status() TO authenticated;
