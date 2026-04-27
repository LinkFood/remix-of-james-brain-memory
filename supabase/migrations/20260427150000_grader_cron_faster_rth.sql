-- Shorten ct-print-grader cadence during RTH so contract tracks land
-- close to print time instead of waiting up to 30min. Without this,
-- /tape P/L chips show empty on prints created in the gap between
-- :00 and :30 sweeps — actively hit on 2026-04-27 first portfolio
-- test (manually invoked at 14:30 to backfill 149→297 tracks).
--
-- New schedule: every 10min weekdays 13:00-21:00 UTC (RTH + 1h after).
-- Off-hours: 0,30 hourly so EOD grading + overnight tracks still tick.
SET search_path = public, extensions;

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-print-grader') THEN
    PERFORM cron.unschedule('ct-print-grader');
  END IF;
  -- RTH lane: every 10min, weekdays, 13:00-21:00 UTC.
  PERFORM cron.schedule(
    'ct-print-grader-rth',
    '*/10 13-20 * * 1-5',
    $body$SELECT public.invoke_edge_function('ct-print-grader', '{}'::jsonb);$body$
  );
  -- Off-hours lane: :00 + :30 every hour, every day. Catches EOD grading,
  -- weekend backfill, overnight track maturation. Same function, same cap.
  PERFORM cron.schedule(
    'ct-print-grader-offhours',
    '0,30 0-12,21-23 * * *',
    $body$SELECT public.invoke_edge_function('ct-print-grader', '{}'::jsonb);$body$
  );
  -- Saturday + Sunday full-day :00,:30 (the off-hours pattern above
  -- excludes weekend RTH window because there's no RTH; pg_cron's
  -- DOW=*/* + the hour list 0-12,21-23 already covers Sat/Sun fully).
END
$cron$;
