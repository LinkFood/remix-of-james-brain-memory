-- Enhanced cron status RPC — returns full job details + last run info
-- Replaces the simpler get_cron_job_status() from 20260228100008

CREATE OR REPLACE FUNCTION public.get_cron_status()
RETURNS TABLE (
  jobid bigint,
  jobname text,
  schedule text,
  command text,
  active boolean,
  last_run_status text,
  last_run_at timestamptz,
  last_run_duration interval
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Check if pg_cron tables exist
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
    d.end_time - d.start_time AS last_run_duration
  FROM cron.job j
  LEFT JOIN LATERAL (
    SELECT jrd.status, jrd.start_time, jrd.end_time
    FROM cron.job_run_details jrd
    WHERE jrd.jobid = j.jobid
    ORDER BY jrd.start_time DESC LIMIT 1
  ) d ON true
  ORDER BY j.jobname;

EXCEPTION
  WHEN OTHERS THEN
    RETURN;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_cron_status() TO service_role;
GRANT EXECUTE ON FUNCTION public.get_cron_status() TO authenticated;

-- Toggle cron job active status
CREATE OR REPLACE FUNCTION public.toggle_cron_job(job_name text, enabled boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'cron' AND table_name = 'job'
  ) THEN
    RAISE EXCEPTION 'pg_cron not available';
  END IF;

  UPDATE cron.job SET active = enabled WHERE jobname = job_name;
END;
$$;

GRANT EXECUTE ON FUNCTION public.toggle_cron_job(text, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.toggle_cron_job(text, boolean) TO authenticated;
