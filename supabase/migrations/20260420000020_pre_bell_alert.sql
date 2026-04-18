-- Schedule ct-pre-bell-alert — 13:15 UTC Mon-Fri (09:15 ET during DST).
--
-- Fires 15 minutes before the bell. Runs the pre-bell readiness checklist
-- server-side and Slack-pushes ONLY when at least one check is in 'fail'
-- state. The function itself bails early on NYSE holidays, so we don't
-- have to encode the holiday calendar in the cron expression.
--
-- Cadence assumes DST ("summer ET"). During standard time (Nov-Mar) this
-- fires at 08:15 ET — still before the bell, still useful as an early
-- warning. Revisit if standard-time behavior matters.
SET search_path = public, extensions;

SELECT cron.schedule(
  'ct-pre-bell-alert',
  '15 13 * * 1-5',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-pre-bell-alert',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $cron$
);
