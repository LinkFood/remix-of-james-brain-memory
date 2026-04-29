-- Cut weekend ct-tavily-news-watcher cron from every 2 hours to twice daily.
-- Markets are closed on weekends; macro news doesn't break every 2h that needs
-- a Tavily fire. 8 AM ET (12 UTC) + 4 PM ET (20 UTC) — wait, weekend cron at
-- 0 */2 fires 12 times/day. Replace with 14,22 UTC = 10 AM ET + 6 PM ET, two
-- weekend briefings. Saves ~80 credits/month.

SET search_path = public, extensions;

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-tavily-news-watcher-weekend') THEN
    PERFORM cron.unschedule('ct-tavily-news-watcher-weekend');
  END IF;
  PERFORM cron.schedule(
    'ct-tavily-news-watcher-weekend',
    '0 14,22 * * 6,0',
    $body$SELECT public.invoke_edge_function('ct-tavily-news-watcher', '{}'::jsonb);$body$
  );
END
$cron$;
