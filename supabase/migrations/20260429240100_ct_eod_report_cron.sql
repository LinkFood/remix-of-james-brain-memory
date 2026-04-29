-- =============================================================================
-- 20260429240100_ct_eod_report_cron.sql
--
-- Schedule ct-eod-report at 21:00 UTC weekdays (5 PM ET). Fires 30 min after
-- ct-eod-summary at 20:30 UTC, giving the journal time to write its row before
-- the report reads it.
-- =============================================================================
SET search_path = public, extensions;

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-eod-report') THEN
    PERFORM cron.unschedule('ct-eod-report');
  END IF;
  PERFORM cron.schedule(
    'ct-eod-report',
    '0 21 * * 1-5',
    $body$SELECT public.invoke_edge_function('ct-eod-report', '{"triggered_by":"scheduled"}'::jsonb);$body$
  );
END
$cron$;
