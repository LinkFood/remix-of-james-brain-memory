-- ct-signature-watcher cron schedules.
--
-- Two jobs: every minute during RTH (13:00-20:00 UTC weekdays) for fresh
-- print latency, every 5 min off-hours so settlements / late prints still
-- get a look. $cron$/$body$ delimiter nesting per project gotcha.

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-signature-watcher-rth') THEN
    PERFORM cron.unschedule('ct-signature-watcher-rth');
  END IF;

  PERFORM cron.schedule(
    'ct-signature-watcher-rth',
    '* 13-20 * * 1-5',
    $body$SELECT public.invoke_edge_function('ct-signature-watcher', '{}'::jsonb);$body$
  );
END
$cron$;

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-signature-watcher-offhours') THEN
    PERFORM cron.unschedule('ct-signature-watcher-offhours');
  END IF;

  PERFORM cron.schedule(
    'ct-signature-watcher-offhours',
    '*/5 0-12,21-23 * * *',
    $body$SELECT public.invoke_edge_function('ct-signature-watcher', '{}'::jsonb);$body$
  );
END
$cron$;
