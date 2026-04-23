-- Force ct-attribute-signals-nightly to run fresh NOW so pg_cron's
-- last_run_status flips from 'failed' to 'succeeded' and the health-check
-- stops re-detecting the stale failure. Otherwise we wait until 22:40 UTC
-- tonight and eat Slack noise all day.
--
-- Strategy: reschedule to */1 (every minute) temporarily, let it fire once,
-- then a follow-up migration restores the 22:40 schedule.

DO $$
BEGIN
  PERFORM cron.unschedule('ct-attribute-signals-nightly')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-attribute-signals-nightly');

  PERFORM cron.schedule(
    'ct-attribute-signals-nightly',
    '* * * * *',
    $body$
      SELECT public.ct_attribute_signals(7)  AS rows_written_7d,
             public.ct_attribute_signals(14) AS rows_written_14d,
             public.ct_attribute_signals(30) AS rows_written_30d;
    $body$
  );
END $$;
