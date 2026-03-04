-- Force-replace stale-task-cleanup cron job
-- The previous migration may not have properly replaced the old version.
-- This ensures watch templates (cron_expression IS NOT NULL) are excluded.

-- Drop ALL versions of this job
SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname = 'stale-task-cleanup';

-- Recreate with watch template protection
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

-- Reset currently-failed watch templates back to running
UPDATE public.agent_tasks
SET status = 'running',
    error = NULL,
    updated_at = now()
WHERE cron_expression IS NOT NULL
  AND cron_active = true
  AND status = 'failed';
