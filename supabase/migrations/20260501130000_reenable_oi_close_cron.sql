-- =============================================================================
-- 20260501130000_reenable_oi_close_cron.sql
--
-- Re-add ct-oi-snapshot-close (5 20 * * 1-5) — was unscheduled 2026-04-30
-- 18:55 UTC (commit d0d6b9a) to save ~250 UW calls Thursday after a manual
-- backfill fire had already captured the day. Restoring for Friday's close.
-- =============================================================================

SET search_path = public, extensions;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-oi-snapshot-close') THEN
    PERFORM cron.unschedule('ct-oi-snapshot-close');
  END IF;
  PERFORM cron.schedule(
    'ct-oi-snapshot-close',
    '5 20 * * 1-5',
    $cron$ SELECT public.trigger_ct_oi_snapshot_with_slot('close'); $cron$
  );
END $$;
