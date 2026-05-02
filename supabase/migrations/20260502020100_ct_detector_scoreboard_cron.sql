-- =============================================================================
-- 20260502020100_ct_detector_scoreboard_cron.sql
--
-- #9 detector lifecycle Phase B — cron scheduling.
--
-- Cadence: every 30 min during RTH (Mon-Fri 13-20 UTC = 9-16 ET) +
-- hourly off-hours. Two cron jobs to express the split cleanly.
-- =============================================================================
SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION public.trigger_ct_detector_scoreboard()
RETURNS bigint LANGUAGE sql SECURITY DEFINER
SET search_path = public, extensions
AS $fn$ SELECT public.invoke_edge_function('ct-detector-scoreboard-update', '{}'::jsonb); $fn$;

GRANT EXECUTE ON FUNCTION public.trigger_ct_detector_scoreboard() TO authenticated, service_role;

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-detector-scoreboard-update-rth') THEN
    PERFORM cron.unschedule('ct-detector-scoreboard-update-rth');
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-detector-scoreboard-update-offhours') THEN
    PERFORM cron.unschedule('ct-detector-scoreboard-update-offhours');
  END IF;

  -- RTH: every 30 min, weekdays 13-20 UTC (9 AM - 4 PM ET).
  PERFORM cron.schedule(
    'ct-detector-scoreboard-update-rth',
    '*/30 13-20 * * 1-5',
    $body$ SELECT public.trigger_ct_detector_scoreboard(); $body$
  );

  -- Off-hours: hourly, every other time. Daily 0-12 UTC + 21-23 UTC weekdays
  -- + every hour on weekends. Using two simpler entries instead of one
  -- complex regex for legibility.
  PERFORM cron.schedule(
    'ct-detector-scoreboard-update-offhours',
    '0 0-12,21-23 * * 1-5',
    $body$ SELECT public.trigger_ct_detector_scoreboard(); $body$
  );

  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-detector-scoreboard-update-weekend') THEN
    PERFORM cron.unschedule('ct-detector-scoreboard-update-weekend');
  END IF;
  PERFORM cron.schedule(
    'ct-detector-scoreboard-update-weekend',
    '0 * * * 0,6',
    $body$ SELECT public.trigger_ct_detector_scoreboard(); $body$
  );
END
$cron$;

COMMENT ON FUNCTION public.trigger_ct_detector_scoreboard IS
  '#9 lifecycle cron trigger. Three schedules: */30 RTH weekdays, hourly off-hours weekdays, hourly weekends.';
