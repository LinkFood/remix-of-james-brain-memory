-- =============================================================================
-- 20260424000020_top_oi_shifts_rpc.sql
--
-- Co-Trader — Overnight Positioning View.
--
-- When James opens the site at 7:30am, he wants to see at a glance "what
-- positioned overnight across all 10 tickers" without drilling each one.
--
-- This RPC returns the top-N biggest |oi_delta_1d| contracts, scoped to our
-- 10-ticker watchlist (filter by p_ticker to drill per-ticker). For each row
-- it returns:
--   - option identity (symbol, strike, expiry, side)
--   - OI today vs yesterday with delta contracts + delta %
--   - dollars at risk (delta × strike × 100)
--   - current spot + distance from strike (bullish/bearish read at a glance)
--
-- Feeds: /tape overnight positioning strip, TickerSheet OI Shifts section,
-- specialistRunner context injection.
-- =============================================================================

SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION public.ct_top_oi_shifts(
  p_limit  INT  DEFAULT 20,
  p_ticker TEXT DEFAULT NULL
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
  )
  SELECT
    t.ticker,
    t.option_symbol,
    t.strike,
    t.expiry,
    t.side,
    t.oi                                             AS oi_today,
    (t.oi - t.oi_delta_1d)                           AS oi_yesterday,
    t.oi_delta_1d                                    AS delta_contracts,
    CASE
      WHEN (t.oi - t.oi_delta_1d) > 0
        THEN ROUND(100.0 * t.oi_delta_1d::numeric / (t.oi - t.oi_delta_1d), 1)
      ELSE NULL
    END                                              AS delta_pct,
    ABS(t.oi_delta_1d) * COALESCE(t.strike, 0) * 100 AS dollars_at_risk,
    ts.spot,
    CASE
      WHEN ts.spot IS NOT NULL AND ts.spot > 0 AND t.strike IS NOT NULL
        THEN ROUND(100.0 * (t.strike - ts.spot) / ts.spot, 2)
      ELSE NULL
    END                                              AS distance_from_spot_pct,
    t.snap_date,
    t.snap_slot
  FROM today_snap t
  LEFT JOIN ct_ticker_snapshots ts ON ts.ticker = t.ticker
  ORDER BY ABS(t.oi_delta_1d) DESC
  LIMIT GREATEST(1, LEAST(p_limit, 100));
$$;

GRANT EXECUTE ON FUNCTION public.ct_top_oi_shifts(INT, TEXT) TO authenticated, service_role;

COMMENT ON FUNCTION public.ct_top_oi_shifts(INT, TEXT) IS
  'Top-N overnight OI shifts by |oi_delta_1d|. Global view (p_ticker=NULL) or per-ticker. Feeds /tape positioning strip, TickerSheet section, and specialistRunner context injection.';
