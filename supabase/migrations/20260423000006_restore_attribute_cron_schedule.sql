-- Restore ct-attribute-signals-nightly to 22:40 UTC weekdays after the
-- forced fresh-run migration (20260423000004) temporarily set it to */1.
-- Now that last_run_status is 'succeeded', the health-check stops flagging it.

DO $$
BEGIN
  PERFORM cron.unschedule('ct-attribute-signals-nightly')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-attribute-signals-nightly');

  PERFORM cron.schedule(
    'ct-attribute-signals-nightly',
    '40 22 * * 1-5',
    $body$
      SELECT public.ct_attribute_signals(7)  AS rows_written_7d,
             public.ct_attribute_signals(14) AS rows_written_14d,
             public.ct_attribute_signals(30) AS rows_written_30d;
    $body$
  );
END $$;
