-- Schedule ct-specialist-scoreboard-update nightly at 23:00 UTC, weekdays only.
-- 23:00 UTC = 7pm ET (after market close, after the contract grader has flipped
-- end-of-day track statuses), so the daily snap reflects the day's truth.

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-specialist-scoreboard-nightly') THEN
    PERFORM cron.unschedule('ct-specialist-scoreboard-nightly');
  END IF;

  PERFORM cron.schedule(
    'ct-specialist-scoreboard-nightly',
    '0 23 * * 1-5',
    $body$SELECT public.invoke_edge_function('ct-specialist-scoreboard-update', '{}'::jsonb);$body$
  );
END
$cron$;
