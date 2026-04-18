-- Schedule ct-weekly-reflection — Sunday 22:00 UTC (5pm ET).
--
-- Runs once per week, after the market has been closed for 2 days, before
-- Monday's pre-bell morning brief. The reflection covers the trailing 7 days
-- (Mon 22:00 UTC → Sun 22:00 UTC) so Friday's close is always captured.
--
-- The function itself dedupes on period_end within the trailing 6 days so
-- re-running the cron manually won't write a duplicate weekly row.
SET search_path = public, extensions;

SELECT cron.schedule(
  'ct-weekly-reflection',
  '0 22 * * 0',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-weekly-reflection',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $cron$
);
