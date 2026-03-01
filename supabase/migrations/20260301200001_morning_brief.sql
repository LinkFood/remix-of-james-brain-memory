-- Morning Brief: daily 7 AM Central brief for JAC Agent OS
-- Expands brain_insights type constraint and schedules cron job

-- Expand brain_insights type constraint to include morning_brief
ALTER TABLE brain_insights DROP CONSTRAINT IF EXISTS brain_insights_type_check;
ALTER TABLE brain_insights ADD CONSTRAINT brain_insights_type_check
  CHECK (type IN ('pattern', 'overdue', 'stale', 'schedule', 'suggestion', 'forgotten', 'unchecked', 'activity', 'heartbeat', 'morning_brief'));

-- Schedule morning brief cron: 7 AM Central = 13:00 UTC
SELECT cron.schedule(
  'jac-morning-brief',
  '0 13 * * *',
  $$SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/jac-morning-brief',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
    ),
    body := '{}'::jsonb
  )$$
);
