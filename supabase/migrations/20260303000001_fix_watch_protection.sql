-- Fix watch template protection
-- Watch templates (cron_expression IS NOT NULL) sit in 'running' status permanently.
-- The stale task cleanup was cancelling them after 10 minutes.

-- 1. Update stale-task-cleanup to exclude watch templates
SELECT cron.unschedule('stale-task-cleanup')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'stale-task-cleanup');

SELECT cron.schedule(
  'stale-task-cleanup',
  '*/30 * * * *',
  $$
  UPDATE public.agent_tasks
  SET status = 'failed',
      error = 'Task timed out (stale)',
      updated_at = now()
  WHERE status IN ('queued', 'running')
    AND updated_at < now() - interval '10 minutes'
    AND cron_expression IS NULL;
  $$
);

-- 2. Reset cancelled watch templates back to running with future next_run_at
UPDATE public.agent_tasks
SET status = 'running',
    error = NULL,
    cancelled_at = NULL,
    updated_at = now(),
    next_run_at = now() + interval '1 minute'
WHERE cron_expression IS NOT NULL
  AND cron_active = true
  AND status = 'cancelled';

-- 3. Fix timezone in watch input from America/Chicago to America/New_York
UPDATE public.agent_tasks
SET input = jsonb_set(input, '{timezone}', '"America/New_York"'),
    updated_at = now()
WHERE cron_expression IS NOT NULL
  AND input->>'timezone' = 'America/Chicago';
