-- Schedule ct-score-self-grade nightly at 22:00 UTC (6pm ET, post-close).
SET search_path = public, extensions;

DO $$
BEGIN PERFORM cron.unschedule('ct-score-self-grade-nightly'); EXCEPTION WHEN OTHERS THEN NULL; END $$;

SELECT cron.schedule(
  'ct-score-self-grade-nightly',
  '0 22 * * *',
  $body$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-score-self-grade',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
    ),
    body := jsonb_build_object('window_days', 7)
  );
  $body$
);
