-- Schedule ct-midday-recap (Phase 1) + ct-alert-book-commit (Phase 3).
-- Both pull via vault-powered _ct_post pattern used by all ct crons.
--
--   ct-midday-recap         30 16 * * 1-5        = 12:30 ET weekdays
--   ct-alert-book-commit    */15 14-19 * * 1-5   = every 15min 10:00-15:45 ET
--                                                   (same window as ct-book-manager)
SET search_path = public, extensions;

SELECT cron.schedule(
  'ct-midday-recap',
  '30 16 * * 1-5',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-midday-recap',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $cron$
);

SELECT cron.schedule(
  'ct-alert-book-commit',
  '*/15 14-19 * * 1-5',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-alert-book-commit',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $cron$
);
