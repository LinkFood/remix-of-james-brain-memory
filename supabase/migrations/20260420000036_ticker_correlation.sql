-- =============================================================================
-- 20260420000036_ticker_correlation.sql
--
-- ct_ticker_correlation_cache — daily pairwise correlation of watchlist
-- tickers over a rolling N-day window (default 30). Populated by
-- ct-correlation-compute (weekdays 22:00 UTC, after EOD).
--
-- Purpose: prevent "unrelated" positions that are actually the same trade.
-- Two longs on SPY + QQQ at 0.92 correlation aren't 2 positions, they're
-- ~1.5 positions of directional beta risk. The /book portfolio warning
-- reads this table to flag over-concentrated correlation structure.
--
-- Shape: one row per unordered pair (ticker_a, ticker_b) per lookback_days.
-- We canonicalize so ticker_a < ticker_b alphabetically — that collapses
-- 144 ordered cells into the 66 unique pairs + 12 diagonals the UI needs.
-- Diagonals (self-pair) are written with correlation = 1.0.
--
-- sample_size is the number of paired daily-close observations used. If
-- ticker history is thin (< 7 days), the row is still written with a
-- small sample_size so the UI can tell "warming up" vs "broken cron".
-- Consumers should treat sample_size < 7 as "insufficient — show sparse".
-- =============================================================================

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- Table
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ct_ticker_correlation_cache (
  id                      bigserial PRIMARY KEY,
  ticker_a                text        NOT NULL,
  ticker_b                text        NOT NULL,
  correlation_pearson     numeric,
  correlation_rolling_20d numeric,
  sample_size             int         NOT NULL DEFAULT 0,
  lookback_days           int         NOT NULL DEFAULT 30,
  computed_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ct_ticker_correlation_cache_pair_unique
    UNIQUE (ticker_a, ticker_b, lookback_days)
);

COMMENT ON TABLE  public.ct_ticker_correlation_cache IS
  'Daily pairwise Pearson correlation of watchlist tickers over rolling N-day window. Populated by ct-correlation-compute (weekdays 22:00 UTC). One row per unordered (ticker_a <= ticker_b) pair per lookback_days. Diagonals written as 1.0.';
COMMENT ON COLUMN public.ct_ticker_correlation_cache.sample_size IS
  'Number of paired daily-return observations used. < 7 = insufficient history; UI should show sparse/warming-up state.';
COMMENT ON COLUMN public.ct_ticker_correlation_cache.correlation_pearson IS
  'Pearson correlation over the full lookback window. NULL = zero variance (all-same price).';
COMMENT ON COLUMN public.ct_ticker_correlation_cache.correlation_rolling_20d IS
  'Same formula applied to the most recent 20 daily returns (subset of the lookback). NULL if fewer than 20 paired observations.';

-- -----------------------------------------------------------------------------
-- Indexes — the hot path is "give me every pair for lookback=30".
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_ct_ticker_correlation_cache_lookback_computed
  ON public.ct_ticker_correlation_cache (lookback_days, computed_at DESC);

CREATE INDEX IF NOT EXISTS idx_ct_ticker_correlation_cache_ticker_a
  ON public.ct_ticker_correlation_cache (ticker_a, lookback_days);

-- -----------------------------------------------------------------------------
-- RLS — authenticated read, service_role full control.
-- -----------------------------------------------------------------------------
ALTER TABLE public.ct_ticker_correlation_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ct_ticker_correlation_cache_read ON public.ct_ticker_correlation_cache;
CREATE POLICY ct_ticker_correlation_cache_read
  ON public.ct_ticker_correlation_cache
  FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS ct_ticker_correlation_cache_svc ON public.ct_ticker_correlation_cache;
CREATE POLICY ct_ticker_correlation_cache_svc
  ON public.ct_ticker_correlation_cache
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- -----------------------------------------------------------------------------
-- Cron — weekdays 22:00 UTC (after US EOD close at 21:00 UTC).
--
-- Weekends skipped because no new closes would arrive; running Sat/Sun
-- would just rewrite the same row. One invocation computes all 66 pairs
-- plus the 12 diagonals in one edge-function call (< 1 sec compute).
-- -----------------------------------------------------------------------------
SELECT cron.schedule(
  'ct-correlation-compute',
  '0 22 * * 1-5',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-correlation-compute',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $cron$
);
