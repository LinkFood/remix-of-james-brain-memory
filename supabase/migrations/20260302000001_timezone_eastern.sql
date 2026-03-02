-- Timezone migration: Central (UTC-6) → Eastern (UTC-5)
-- All timezone-dependent cron jobs shifted -1 hour UTC

-- Reminder morning: 8 AM ET = 13:00 UTC (was 14:00 for CT)
SELECT cron.unschedule('reminder-morning')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'reminder-morning');

SELECT cron.schedule(
  'reminder-morning',
  '0 13 * * *',
  $$SELECT public.invoke_edge_function('calendar-reminder-check', '{}'::jsonb);$$
);

-- Reminder evening: 6 PM ET = 23:00 UTC (was 0:00 for CT)
SELECT cron.unschedule('reminder-evening')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'reminder-evening');

SELECT cron.schedule(
  'reminder-evening',
  '0 23 * * *',
  $$SELECT public.invoke_edge_function('calendar-reminder-check', '{}'::jsonb);$$
);

-- Brain insights morning: 10 AM ET = 15:00 UTC (was 16:00 for CT)
SELECT cron.unschedule('brain-insights-morning')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'brain-insights-morning');

SELECT cron.schedule(
  'brain-insights-morning',
  '0 15 * * *',
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

-- Brain insights evening: 8 PM ET = 01:00 UTC (was 02:00 for CT)
SELECT cron.unschedule('brain-insights-evening')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'brain-insights-evening');

SELECT cron.schedule(
  'brain-insights-evening',
  '0 1 * * *',
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

-- Brain insights cleanup: 10 PM ET = 02:00 UTC (was 03:00 for CT)
SELECT cron.unschedule('brain-insights-cleanup')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'brain-insights-cleanup');

SELECT cron.schedule(
  'brain-insights-cleanup',
  '0 2 * * *',
  $$DELETE FROM public.brain_insights WHERE expires_at < now();$$
);

-- Morning brief: 8 AM ET = 12:00 UTC (was 13:00 for CT)
SELECT cron.unschedule('jac-morning-brief')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'jac-morning-brief');

SELECT cron.schedule(
  'jac-morning-brief',
  '0 12 * * *',
  $$SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/jac-morning-brief',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
    ),
    body := '{}'::jsonb
  )$$
);
