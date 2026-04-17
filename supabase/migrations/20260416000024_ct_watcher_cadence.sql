-- ============================================================================
-- Tighten watcher cadence: 30min → 15min. Extend window to 12:30-21:30 UTC
-- (8:30am-5:30pm ET during EDT) so pre-market + post-close are covered.
-- ============================================================================
SET search_path = public, extensions;

-- Drop the old 30min schedule
SELECT cron.unschedule('ct-watcher');

-- New: every 15 min during extended market hours weekdays.
-- 12:30 UTC = 8:30am ET (pre-bell). 21:30 UTC = 5:30pm ET (post-close settle).
-- 15min cron at :00/:15/:30/:45 during those hours. 34 fires/trading day.
SELECT cron.schedule(
  'ct-watcher',
  '0,15,30,45 12-21 * * 1-5',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-watcher',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    )
  $cron$
);
