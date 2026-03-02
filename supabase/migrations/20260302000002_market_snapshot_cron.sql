-- Market Snapshot: weekdays at 5 PM Eastern (21:00 UTC during EDT)
-- Fetches market quotes and saves daily close summary to the brain

SELECT cron.schedule(
  'market-snapshot',
  '0 21 * * 1-5',
  $$SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/market-snapshot',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
    ),
    body := '{}'::jsonb
  )$$
);
