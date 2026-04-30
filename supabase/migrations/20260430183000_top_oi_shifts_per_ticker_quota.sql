-- =============================================================================
-- 20260430183000_top_oi_shifts_per_ticker_quota.sql
--
-- Fix coverage gap in OvernightPositioning panel.
--
-- Original RPC sorts globally by ABS(oi_delta_1d) DESC and returns top 50.
-- Index options (SPY/IWM/QQQ) have higher contract-count volumes than single
-- names, so they crowd out single-name shifts. Result: post-earnings days
-- like 2026-04-30 (MSFT/GOOGL/AMZN/META reported Wed close) the panel showed
-- ZERO rows for those 4 tickers despite each having 5-23 real OI shifts.
--
-- Fix: add p_per_ticker_limit parameter. When set (default 5), the RPC
-- returns the top N PER TICKER via PARTITION BY ticker ROW_NUMBER, then
-- caps the total at p_limit across all tickers. Every ticker gets fair
-- representation. When p_per_ticker_limit IS NULL the old global-top-N
-- behavior is preserved for any caller that explicitly opts out.
-- =============================================================================

SET search_path = public, extensions;

DROP FUNCTION IF EXISTS public.ct_top_oi_shifts(INT, TEXT);

CREATE OR REPLACE FUNCTION public.ct_top_oi_shifts(
  p_limit             INT  DEFAULT 50,
  p_ticker            TEXT DEFAULT NULL,
  p_per_ticker_limit  INT  DEFAULT 5
)
RETURNS TABLE(
  ticker                 TEXT,
  option_symbol          TEXT,
  strike                 NUMERIC,
  expiry                 DATE,
  side                   TEXT,
  oi_today               INTEGER,
  oi_yesterday           INTEGER,
  delta_contracts        INTEGER,
  delta_pct              NUMERIC,
  dollars_at_risk        NUMERIC,
  spot                   NUMERIC,
  distance_from_spot_pct NUMERIC,
  snap_date              DATE,
  snap_slot              TEXT
)
LANGUAGE sql STABLE
SET search_path = public, extensions
AS $$
  WITH latest_date AS (
    SELECT MAX(snap_date) AS d FROM ct_oi_snapshots
    WHERE oi_delta_1d IS NOT NULL
      AND (p_ticker IS NULL OR ticker = p_ticker)
  ),
  today_snap AS (
    SELECT DISTINCT ON (s.ticker, s.option_symbol)
      s.ticker, s.option_symbol, s.strike, s.expiry, s.side,
      s.oi, s.oi_delta_1d, s.snap_date, s.snap_slot
    FROM ct_oi_snapshots s, latest_date ld
    WHERE s.snap_date = ld.d
      AND s.oi_delta_1d IS NOT NULL
      AND (p_ticker IS NULL OR s.ticker = p_ticker)
    ORDER BY s.ticker, s.option_symbol,
      CASE s.snap_slot WHEN 'close' THEN 3 WHEN 'mid' THEN 2 WHEN 'open' THEN 1 ELSE 0 END DESC
  ),
  ranked AS (
    SELECT
      t.*,
      ROW_NUMBER() OVER (PARTITION BY t.ticker ORDER BY ABS(t.oi_delta_1d) DESC) AS rn_per_ticker
    FROM today_snap t
  )
  SELECT
    r.ticker,
    r.option_symbol,
    r.strike,
    r.expiry,
    r.side,
    r.oi                                             AS oi_today,
    (r.oi - r.oi_delta_1d)                           AS oi_yesterday,
    r.oi_delta_1d                                    AS delta_contracts,
    CASE
      WHEN (r.oi - r.oi_delta_1d) > 0
        THEN ROUND(100.0 * r.oi_delta_1d::numeric / (r.oi - r.oi_delta_1d), 1)
      ELSE NULL
    END                                              AS delta_pct,
    ABS(r.oi_delta_1d) * COALESCE(r.strike, 0) * 100 AS dollars_at_risk,
    ts.spot,
    CASE
      WHEN ts.spot IS NOT NULL AND ts.spot > 0 AND r.strike IS NOT NULL
        THEN ROUND(100.0 * (r.strike - ts.spot) / ts.spot, 2)
      ELSE NULL
    END                                              AS distance_from_spot_pct,
    r.snap_date,
    r.snap_slot
  FROM ranked r
  LEFT JOIN ct_ticker_snapshots ts ON ts.ticker = r.ticker
  WHERE p_per_ticker_limit IS NULL OR r.rn_per_ticker <= p_per_ticker_limit
  ORDER BY r.ticker, r.rn_per_ticker
  LIMIT GREATEST(1, LEAST(p_limit, 200));
$$;

GRANT EXECUTE ON FUNCTION public.ct_top_oi_shifts(INT, TEXT, INT) TO authenticated, service_role;

COMMENT ON FUNCTION public.ct_top_oi_shifts(INT, TEXT, INT) IS
  'Top-N overnight OI shifts by |oi_delta_1d|. p_per_ticker_limit (default 5) ensures fair coverage across all watchlist tickers; pass NULL for global top-N. p_limit caps the total returned.';
