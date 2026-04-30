-- =============================================================================
-- 20260430185500_pause_oi_close_tonight.sql
--
-- One-shot UW budget save: unschedule ct-oi-snapshot-close.
--
-- Manual fire at 18:37 UTC already captured today's mid+close window for
-- all 10 watchlist tickers (with the new rate-limit retry — ~210 calls).
-- The scheduled 20:05 UTC fire would burn another ~250 calls re-doing
-- the same work, with UW already at 77.9% of daily budget.
--
-- This migration unschedules the close cron permanently. A follow-up
-- Saturday migration will re-add it with the same schedule (5 20 * * 1-5)
-- once we're past the budget pinch.
-- =============================================================================

SET search_path = public, extensions;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-oi-snapshot-close') THEN
    PERFORM cron.unschedule('ct-oi-snapshot-close');
  END IF;
END $$;
