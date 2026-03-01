-- Heartbeat + Cron Jobs: autonomous initiative for JAC
-- Adds heartbeat insight type and 3 new cron jobs

-- Expand brain_insights type constraint to include 'heartbeat' and 'activity'
-- Drop old constraint and recreate with new values
ALTER TABLE brain_insights DROP CONSTRAINT IF EXISTS brain_insights_type_check;
ALTER TABLE brain_insights ADD CONSTRAINT brain_insights_type_check
  CHECK (type IN ('pattern', 'overdue', 'stale', 'schedule', 'suggestion', 'heartbeat', 'activity'));

-- Cron job: jac-heartbeat every 30 minutes
SELECT cron.schedule(
  'jac-heartbeat',
  '*/30 * * * *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/jac-heartbeat',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
    ),
    body := '{}'::jsonb
  );
  $$
);

-- Cron job: distill-principles weekly Sunday 3 AM UTC
SELECT cron.schedule(
  'distill-principles',
  '0 3 * * 0',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/distill-principles',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
    ),
    body := '{}'::jsonb
  );
  $$
);

-- Cron job: memory-decay-sweep daily 4 AM UTC
-- Archives entries with importance < 3, access_count = 0, older than 90 days
SELECT cron.schedule(
  'memory-decay-sweep',
  '0 4 * * *',
  $$
  UPDATE entries
  SET archived = true, updated_at = now()
  WHERE importance_score < 3
    AND (access_count IS NULL OR access_count = 0)
    AND created_at < now() - interval '90 days'
    AND archived = false;
  $$
);
