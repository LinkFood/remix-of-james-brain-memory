-- =============================================================================
-- 20260420000032_fundamentals_cache.sql
--
-- ct_fundamentals_cache — weekly snapshot of fundamental metrics per ticker.
--
-- Populated by ct-fundamentals-sync (Sun 22:00 UTC) from UW's per-stock
-- financials + income-statements + earnings endpoints:
--   - /api/stock/{ticker}/financials       → pe_ratio, market_cap, eps_ttm,
--                                             revenue_ttm
--   - /api/stock/{ticker}/income-statements → revenue_yoy_growth_pct (latest
--                                              quarter revenue vs year-ago quarter)
--   - /api/stock/{ticker}/earnings          → last_earnings_actual_eps /
--                                              last_earnings_est_eps /
--                                              last_earnings_surprise_pct
--
-- 7-day TTL: ct-fundamentals-sync skips tickers whose most recent
-- as_of_date < 7 days old. Stale-indicator threshold in the UI is 14 days
-- (shown as "stale" badge, still rendered).
--
-- Non-equity tickers (ETFs like USO / GLD) may return partial/empty
-- financials from UW — ALL numeric columns are nullable so the row still
-- stores whatever subset was available. The tile hides nulls gracefully.
--
-- 12 watchlist tickers × 1 call/week = 12 UW calls/week. Trivial budget.
-- =============================================================================

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- Table
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ct_fundamentals_cache (
  id                             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker                         text NOT NULL,
  as_of_date                     date NOT NULL,
  eps_ttm                        numeric,
  revenue_ttm                    numeric,
  pe_ratio                       numeric,
  market_cap                     numeric,
  last_earnings_actual_eps       numeric,
  last_earnings_est_eps          numeric,
  last_earnings_surprise_pct     numeric,
  revenue_yoy_growth_pct         numeric,
  fetched_at                     timestamptz NOT NULL DEFAULT now()
);

-- Unique on (ticker, as_of_date) — one snapshot per ticker per day.
CREATE UNIQUE INDEX IF NOT EXISTS ux_ct_fundamentals_cache_ticker_date
  ON ct_fundamentals_cache (ticker, as_of_date);

-- Newest-first lookup per ticker (drives the tile's "latest" query).
CREATE INDEX IF NOT EXISTS idx_ct_fundamentals_cache_ticker_fetched
  ON ct_fundamentals_cache (ticker, fetched_at DESC);

COMMENT ON TABLE ct_fundamentals_cache IS
  'Weekly per-ticker fundamental snapshot. Populated by ct-fundamentals-sync. 7-day refresh TTL; UI flags rows >14d old as stale.';
COMMENT ON COLUMN ct_fundamentals_cache.pe_ratio IS
  'Trailing P/E from UW financials. Null for ETFs and tickers where UW returns no ratio.';
COMMENT ON COLUMN ct_fundamentals_cache.last_earnings_surprise_pct IS
  '(actual - est) / |est| * 100 from most recent earnings row. Null if either side missing.';
COMMENT ON COLUMN ct_fundamentals_cache.revenue_yoy_growth_pct IS
  'Latest quarter revenue vs same quarter prior year, expressed as pct. Null when insufficient history.';

-- -----------------------------------------------------------------------------
-- RLS — authenticated read, service role full. Matches ct_vix_history.
-- -----------------------------------------------------------------------------
ALTER TABLE ct_fundamentals_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ct_fundamentals_cache_read ON ct_fundamentals_cache;
DROP POLICY IF EXISTS ct_fundamentals_cache_svc  ON ct_fundamentals_cache;

CREATE POLICY ct_fundamentals_cache_read
  ON ct_fundamentals_cache FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY ct_fundamentals_cache_svc
  ON ct_fundamentals_cache FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
