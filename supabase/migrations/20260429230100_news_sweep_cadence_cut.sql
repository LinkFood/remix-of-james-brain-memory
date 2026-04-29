-- Drop ct-news-sweep-rth from */10 to */30 during RTH.
-- Audit at 96/4000 Tavily on 2026-04-29: news-sweep was 90 of those (94%).
-- Combined with the new hot-ticker filter and tier-aware caps in the function
-- itself, the */30 cadence + signal-aware sweep takes monthly Tavily spend
-- from ~9,600 to ~1,176 credits.

SET search_path = public, extensions;

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-news-sweep-rth') THEN
    PERFORM cron.unschedule('ct-news-sweep-rth');
  END IF;
  PERFORM cron.schedule(
    'ct-news-sweep-rth',
    '*/30 13-20 * * 1-5',
    $body$SELECT public.invoke_edge_function('ct-news-sweep', '{}'::jsonb);$body$
  );
END
$cron$;
