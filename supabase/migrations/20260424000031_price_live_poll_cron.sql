-- Schedule ct-price-live-poll: every 2 min during US RTH (13-20 UTC, Mon-Fri).
-- Yahoo Finance 1m bars → ct_price_bars + update ct_ticker_snapshots.spot.
-- Fixes stale-spot / stale-chart on TickerSheet — fills today's 1m bars live
-- so the PriceChart stops saying "LAST SESSION".
SET search_path = public, extensions;

-- Drop any previous schedule so this is idempotent.
DO $$
BEGIN
  PERFORM cron.unschedule('ct-price-live-poll');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'ct-price-live-poll',
  '*/2 13-20 * * 1-5',
  $body$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-price-live-poll',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
    ),
    body := '{}'::jsonb
  );
  $body$
);
