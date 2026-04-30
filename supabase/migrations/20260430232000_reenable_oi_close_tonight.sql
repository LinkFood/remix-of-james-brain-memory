-- =============================================================================
-- 20260430232000_reenable_oi_close_tonight.sql
--
-- Re-add ct-oi-snapshot-close immediately. Earlier today (commit d0d6b9a)
-- it was paused for Thursday's UW budget. Markets closed; UW limit hit at
-- 21:00 UTC; resets midnight UTC. Re-enabling now means Friday's 20:05 UTC
-- close fire runs normally. The remote-scheduled agent for Friday morning
-- (trig_01WTvsphoauozF1XoXJ2ZqXe) becomes a no-op idempotent re-add.
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
