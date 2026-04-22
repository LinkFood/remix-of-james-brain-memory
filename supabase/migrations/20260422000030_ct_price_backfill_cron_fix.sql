-- Prior migration built the cron invocation via net.http_post inline; align with
-- the project's _ct_post_with_body() pattern so it matches every other ct-* cron
-- and doesn't re-implement Vault-read logic.
--
-- Also adds a manual-trigger wrapper for ad-hoc runs from the app.

CREATE OR REPLACE FUNCTION public.trigger_ct_price_backfill(_lookback_days INT DEFAULT 2)
RETURNS jsonb
LANGUAGE sql
AS $fn$
  SELECT public._ct_post_with_body(
    'ct-price-backfill',
    jsonb_build_object('lookback_days', _lookback_days)
  );
$fn$;

GRANT EXECUTE ON FUNCTION public.trigger_ct_price_backfill(INT) TO authenticated, service_role;

-- Re-schedule the cron to use the wrapper.
DO $$
BEGIN
  PERFORM cron.unschedule('ct-price-backfill-nightly')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-price-backfill-nightly');

  PERFORM cron.schedule(
    'ct-price-backfill-nightly',
    '30 22 * * 1-5',
    $body$ SELECT public.trigger_ct_price_backfill(2); $body$
  );
END $$;
