-- Tune the book-manager cron to fire at 13:30 UTC (9:30 ET market open)
-- so the planned→open transition happens at the actual 9:30 fill price,
-- not 30 minutes later at 10:00 ET.
--
-- Previous: */15 14-19 * * 1-5 (10am-3:45pm ET, every 15min)
-- New:      */15 13-19 * * 1-5 (9:30am-3:45pm ET, every 15min)
--           — adds 13:30, 13:45 UTC ticks for fill-at-open behavior
SET search_path = public, extensions;

SELECT cron.unschedule('ct-book-manager');

SELECT cron.schedule(
  'ct-book-manager',
  '*/15 13-19 * * 1-5',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-book-manager',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $cron$
);
