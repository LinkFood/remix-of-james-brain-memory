-- Wire the missing auto-scoring trigger.
--
-- 2026-04-24 09:35 ET: market opened, 56 flow events landed in ct_flow_alerts
-- but ZERO hit ct_scored_flow — because there was no cron calling
-- ct_score_existing_flow(). The ingester stuffs raw alerts, the scorer
-- function exists, but nothing connects them. Manual trigger closed the
-- gap for today; this cron closes it permanently.
--
-- Runs every 2 min during the same window as ct-flow-ingester (10-22 UTC
-- weekdays). Called directly from pg_cron — no HTTP round-trip, no edge
-- function wrapper, no extra UW budget. Scorer is a pure plpgsql function
-- operating on already-ingested data.

SET search_path = public, extensions;

DO $$
BEGIN
  PERFORM cron.unschedule('ct-score-flow-continuous');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'ct-score-flow-continuous',
  '*/2 10-22 * * 1-5',
  $cron$SELECT public.ct_score_existing_flow()$cron$
);
