-- =============================================================================
-- 20260430232100_uw_nightly_to_weekly.sql
--
-- LB8 UW budget reduction — CUT 3.
--
-- Audit + reschedule of three previously-nightly weekday crons. Each was
-- evaluated for whether its handler actually hits Unusual Whales:
--
--   1. ct-attribute-signals-nightly  ('40 22 * * 1-5')
--      → PURE DB. Calls public.ct_attribute_signals(N) SQL function which
--        joins ct_signal_firings + ct_grade_outcomes locally. No HTTP, no
--        UW, no edge function. LEAVE ALONE.
--
--   2. ct-correlation-compute        ('0 22 * * 1-5')
--      → PURE DB. Edge function reads ct_price_candles (already-stored
--        EOD closes), computes Pearson correlation in-memory, writes to
--        ct_ticker_correlation_cache. Header comment in
--        20260420000036_ticker_correlation.sql states "no external API
--        calls". LEAVE ALONE.
--
--   3. ct-price-backfill-nightly     ('30 22 * * 1-5')
--      → UW-TOUCHING. Imports mcpCallToolAsData and calls
--        get_ticker_candles_by_range per ticker × per day. ~10 watchlist
--        tickers × 2-day lookback = ~20 UW calls each weekday = ~100
--        calls/week. Move to Saturday only.
--
-- Move ct-price-backfill-nightly to Saturday 12:30 UTC (Sat 8:30 ET) with
-- a longer lookback (7 days, covering the full prior week). Stagger from
-- ct-correlation-compute and ct-attribute-signals so they don't pile up
-- (they stay weekday — they're cheap; this migration only touches the
-- UW-spending one).
--
-- Estimated savings: ~75-100 UW calls/week → 0 weekday + ~75 Saturday.
-- Net weekday: ~20 calls/day × 5 = 100 calls/week reclaimed for live RTH.
--
-- Saturday 12:30 UTC chosen because:
--   - UW budget is fresh (UTC day rolled over)
--   - James doesn't run Saturday backtests until later in the day
--   - No conflict with weekly distill-principles (Sun 3 UTC)
-- =============================================================================

DO $$
BEGIN
  -- Decision 1 + 2 documented above; no schedule change for those.
  -- They remain on '40 22 * * 1-5' and '0 22 * * 1-5' respectively because
  -- they don't spend UW budget — moving them adds zero savings and would
  -- reduce intelligence freshness on /edge for nothing in return.

  -- Decision 3: ct-price-backfill-nightly → Saturday only, lookback 7d.
  -- Idempotent: unschedule both old + new names, then schedule once.
  PERFORM cron.unschedule('ct-price-backfill-nightly')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-price-backfill-nightly');

  PERFORM cron.unschedule('ct-price-backfill-weekly')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-price-backfill-weekly');

  PERFORM cron.schedule(
    'ct-price-backfill-weekly',
    '30 12 * * 6',
    $body$ SELECT public.trigger_ct_price_backfill(7); $body$
  );
END $$;
