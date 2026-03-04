-- Reschedule morning brief: 8 AM ET (12:00 UTC) → 6 AM ET (10:00 UTC)
SELECT cron.unschedule('jac-morning-brief')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'jac-morning-brief');

SELECT cron.schedule(
  'jac-morning-brief',
  '0 10 * * *',
  $$SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/jac-morning-brief',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
    ),
    body := '{}'::jsonb
  )$$
);

-- Reschedule brain insights evening: 8 PM ET (01:00 UTC) → 6 PM ET (22:00 UTC)
SELECT cron.unschedule('brain-insights-evening')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'brain-insights-evening');

SELECT cron.schedule(
  'brain-insights-evening',
  '0 22 * * *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'supabase_url' LIMIT 1) || '/functions/v1/brain-insights',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key' LIMIT 1)
    ),
    body := '{}'::jsonb
  );
  $$
);
