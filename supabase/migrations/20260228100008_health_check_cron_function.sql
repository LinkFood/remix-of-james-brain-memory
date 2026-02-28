-- Create helper function to query cron job status
-- This function safely queries pg_cron tables and returns job execution status

CREATE OR REPLACE FUNCTION public.get_cron_job_status()
RETURNS TABLE(
  jobname text,
  last_successful_run timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Check if pg_cron extension and tables exist
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables 
    WHERE table_schema = 'cron' AND table_name = 'job_run_details'
  ) THEN
    -- Return empty result if pg_cron is not available
    RETURN;
  END IF;

  -- Return last successful run for each job
  RETURN QUERY
  SELECT 
    j.jobname::text,
    MAX(jrd.end_time) as last_successful_run
  FROM cron.job j
  LEFT JOIN cron.job_run_details jrd ON j.jobid = jrd.jobid 
    AND jrd.return_message = 'completed successfully'
  GROUP BY j.jobname
  ORDER BY j.jobname;
  
EXCEPTION
  WHEN OTHERS THEN
    -- If any error occurs (permissions, missing tables, etc.), return empty
    RETURN;
END;
$$;

-- Grant execute permission to service role
GRANT EXECUTE ON FUNCTION public.get_cron_job_status() TO service_role;
