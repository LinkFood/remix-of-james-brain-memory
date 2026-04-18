-- ct-session-analog nightly build cron
--
-- Fires weekdays at 21:30 UTC (~5:30pm ET post-close EDT). The trigger RPC is
-- defined in 20260420000016_session_analogs.sql — it defaults to
-- `{ mode: 'build', session_date: today }`.
--
-- Cost: one Voyage embedding call per trading day (~$0.00002). Negligible.
SET search_path = public, extensions;

SELECT cron.schedule(
  'ct-session-analog',
  '30 21 * * 1-5',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-session-analog',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    )
  $cron$
);
