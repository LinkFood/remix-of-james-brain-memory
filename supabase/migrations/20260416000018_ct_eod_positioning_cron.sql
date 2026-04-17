-- ct-eod-positioning cron + RPC
-- Daily EOD snapshot of max pain (per expiry) + IV rank for watchlist + SPX.
-- Runs weekdays at 21:00 UTC (~5pm ET during EDT, post-market close).
SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION public.trigger_ct_eod_positioning()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions
AS $fn$ SELECT public._ct_post('ct-eod-positioning'); $fn$;
GRANT EXECUTE ON FUNCTION public.trigger_ct_eod_positioning() TO authenticated, service_role;

-- Weekdays at 21:00 UTC (~5pm ET EDT, post-close)
SELECT cron.schedule(
  'ct-eod-positioning',
  '0 21 * * 1-5',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-eod-positioning',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    )
  $cron$
);
