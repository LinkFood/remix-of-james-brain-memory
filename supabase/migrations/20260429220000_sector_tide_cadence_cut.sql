-- =============================================================================
-- 20260429220000_sector_tide_cadence_cut.sql
--
-- Drop ct-sector-tide-ingester from */5 to */15 during RTH.
--
-- Audit 2026-04-29 21:00 UTC at 91.7% UW close: sector-tide consumed 1,051
-- calls/day (5.7% of daily budget) by firing every 5 minutes across 11 sectors.
-- The data has TWO consumers:
--   1) claudeReadSurface.ts → reads "most recent snapshot per sector within
--      window" — only ever uses one row per sector per call
--   2) ct-hypothesis-proposer (fires 11/15/19 UTC = 3 times/day)
-- Neither needs 5-minute granularity. */15 still captures every meaningful
-- sector-tide shift well within the freshness window the consumers use.
--
-- New throughput: 33 fires/RTH-day × 11 sectors = 363 calls (was ~1,051).
-- Frees ~688 calls/day = ~3.4% of daily budget.
-- =============================================================================
SET search_path = public, extensions;

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-sector-tide-ingester') THEN
    PERFORM cron.unschedule('ct-sector-tide-ingester');
  END IF;
  PERFORM cron.schedule(
    'ct-sector-tide-ingester',
    '*/15 13-20 * * 1-5',
    $body$SELECT public.invoke_edge_function('ct-sector-tide-ingester', '{}'::jsonb);$body$
  );
END
$cron$;
