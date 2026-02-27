-- Fix cron jobs: old ones used current_setting() which is empty in pg_cron context.
-- New approach: use vault to store the service role key, reference it from cron jobs.

-- Ensure extensions are enabled
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- Unschedule broken cron jobs from the old migration
SELECT cron.unschedule('reminder-morning') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'reminder-morning'
);
SELECT cron.unschedule('reminder-evening') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'reminder-evening'
);
SELECT cron.unschedule('reminder-timed') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'reminder-timed'
);

-- Helper function that calls an edge function using credentials from vault.
-- The service_role_key must be added to vault first (see below).
CREATE OR REPLACE FUNCTION public.invoke_edge_function(
  function_name text,
  body jsonb DEFAULT '{}'::jsonb
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  project_url text;
  svc_key text;
  request_id bigint;
BEGIN
  -- Read credentials from vault
  SELECT decrypted_secret INTO project_url
  FROM vault.decrypted_secrets
  WHERE name = 'project_url'
  LIMIT 1;

  SELECT decrypted_secret INTO svc_key
  FROM vault.decrypted_secrets
  WHERE name = 'service_role_key'
  LIMIT 1;

  IF project_url IS NULL OR svc_key IS NULL THEN
    RAISE WARNING '[invoke_edge_function] vault secrets not configured. Run: SELECT vault.create_secret(''your-url'', ''project_url''); SELECT vault.create_secret(''your-key'', ''service_role_key'');';
    RETURN NULL;
  END IF;

  SELECT net.http_post(
    url := project_url || '/functions/v1/' || function_name,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || svc_key,
      'Content-Type', 'application/json'
    ),
    body := body
  ) INTO request_id;

  RETURN request_id;
END;
$$;

-- Schedule: morning reminder check (8:00 AM UTC = ~2-3 AM Central)
-- Adjust if needed based on user timezone
SELECT cron.schedule(
  'reminder-morning',
  '0 14 * * *',  -- 2 PM UTC = 8 AM Central (CDT) / 9 AM Central (CST)
  $$SELECT public.invoke_edge_function('calendar-reminder-check', '{}'::jsonb);$$
);

-- Schedule: evening reminder check
SELECT cron.schedule(
  'reminder-evening',
  '0 0 * * *',  -- midnight UTC = 6 PM Central (CDT) / 7 PM Central (CST)
  $$SELECT public.invoke_edge_function('calendar-reminder-check', '{}'::jsonb);$$
);

-- Schedule: frequent check for time-specific reminders (every 5 min)
-- More frequent than the old 15-min to improve reminder accuracy
SELECT cron.schedule(
  'reminder-timed',
  '*/5 * * * *',
  $$SELECT public.invoke_edge_function('calendar-reminder-check', '{"timed_only": true}'::jsonb);$$
);

-- Schedule: stale task cleanup (every 30 min)
-- Mark tasks stuck in queued/running for >10 minutes as failed
SELECT cron.schedule(
  'stale-task-cleanup',
  '*/30 * * * *',
  $$
  UPDATE public.agent_tasks
  SET status = 'failed',
      error = 'Task timed out (stale)',
      updated_at = now()
  WHERE status IN ('queued', 'running')
    AND updated_at < now() - interval '10 minutes';
  $$
);

-- NOTE: After applying this migration, you MUST populate vault secrets:
--
--   SELECT vault.create_secret('https://rvhyotvklfowklzjahdd.supabase.co', 'project_url');
--   SELECT vault.create_secret('YOUR_SERVICE_ROLE_KEY_HERE', 'service_role_key');
--
-- Run these in the Supabase SQL Editor (Dashboard → SQL Editor).
-- Without this, the cron jobs will log warnings but not fire.
