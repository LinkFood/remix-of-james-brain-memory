-- Schedule ct-news-sweep: every 10 min during US RTH (13-20 UTC, Mon-Fri).
-- Per-ticker Tavily news sweep — complements ct-tavily-news-watcher (rotation)
-- with a full per-ticker loop. Thesis: options front-run news.
SET search_path = public, extensions;

-- Drop any previous schedule so this is idempotent.
DO $$
BEGIN
  PERFORM cron.unschedule('ct-news-sweep-rth');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'ct-news-sweep-rth',
  '*/10 13-20 * * 1-5',
  $body$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-news-sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
    ),
    body := '{}'::jsonb
  );
  $body$
);
