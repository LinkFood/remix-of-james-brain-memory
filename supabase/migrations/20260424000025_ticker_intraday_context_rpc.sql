-- Ticker intraday context RPCs for the frontend MacroBanner + /tape views.
--
-- Mirrors the price-bar lookup logic in ct_score_flow_event so a ticker's
-- live regime context matches what the scorer records on each event.
--
--   spot        — ct_ticker_snapshots.spot (snapshot-cached live read);
--                 fallback to the most recent 1m ct_price_bars.close if the
--                 snapshot column is NULL (freshly-added ticker, etc.)
--   prev_close  — last 1m bar whose ts::date < today, within 5 calendar days
--   today_open  — first 1m bar on today's date within 13:30-14:00 UTC
--                 (09:30-10:00 ET). NULL honestly if we're pre-open.
--   as_of       — now()
--
-- Single-row return contract: if no data at all, still return one row with
-- NULL fields so the frontend can render "--" without special-casing empty
-- result sets.

SET search_path = public, extensions;

-- ============================================================================
-- 1. ct_ticker_intraday_context(ticker) — single ticker
-- ============================================================================

CREATE OR REPLACE FUNCTION public.ct_ticker_intraday_context(p_ticker TEXT)
RETURNS TABLE (
  ticker                TEXT,
  spot                  NUMERIC,
  prev_close            NUMERIC,
  today_open            NUMERIC,
  pct_from_prev_close   NUMERIC,
  pct_from_today_open   NUMERIC,
  as_of                 TIMESTAMPTZ
)
LANGUAGE plpgsql STABLE
SET search_path = public, extensions
AS $$
DECLARE
  v_now         TIMESTAMPTZ := now();
  v_today       DATE        := v_now::date;
  v_spot        NUMERIC;
  v_prev_close  NUMERIC;
  v_today_open  NUMERIC;
  v_pct_prev    NUMERIC;
  v_pct_open    NUMERIC;
BEGIN
  -- Spot: snapshot first, then most recent 1m bar as fallback.
  SELECT s.spot INTO v_spot
  FROM public.ct_ticker_snapshots s
  WHERE s.ticker = p_ticker;

  IF v_spot IS NULL THEN
    SELECT close INTO v_spot
    FROM public.ct_price_bars
    WHERE ticker = p_ticker AND timeframe = '1m'
    ORDER BY ts DESC
    LIMIT 1;
  END IF;

  -- Previous trading day close — look back 5 calendar days for holidays.
  SELECT close INTO v_prev_close
  FROM public.ct_price_bars
  WHERE ticker = p_ticker
    AND timeframe = '1m'
    AND ts::date < v_today
    AND ts::date >= (v_today - INTERVAL '5 days')
  ORDER BY ts DESC
  LIMIT 1;

  -- Today's open — first bar between 13:30 and 14:00 UTC (09:30-10:00 ET).
  SELECT close INTO v_today_open
  FROM public.ct_price_bars
  WHERE ticker = p_ticker
    AND timeframe = '1m'
    AND ts::date = v_today
    AND ts >= (v_today || ' 13:30:00+00')::timestamptz
    AND ts <  (v_today || ' 14:00:00+00')::timestamptz
  ORDER BY ts ASC
  LIMIT 1;

  IF v_spot IS NOT NULL AND v_prev_close IS NOT NULL AND v_prev_close <> 0 THEN
    v_pct_prev := ROUND(((v_spot - v_prev_close) / v_prev_close) * 100, 4);
  END IF;
  IF v_spot IS NOT NULL AND v_today_open IS NOT NULL AND v_today_open <> 0 THEN
    v_pct_open := ROUND(((v_spot - v_today_open) / v_today_open) * 100, 4);
  END IF;

  RETURN QUERY SELECT
    p_ticker,
    v_spot,
    v_prev_close,
    v_today_open,
    v_pct_prev,
    v_pct_open,
    v_now;
END $$;

GRANT EXECUTE ON FUNCTION public.ct_ticker_intraday_context(TEXT) TO authenticated, service_role;

COMMENT ON FUNCTION public.ct_ticker_intraday_context(TEXT) IS
  'Intraday regime context for a single ticker: spot, prev close, today open, and the two percent-change fields. Mirrors the scorer''s price-bar lookup logic. Single-row return; NULLs are honest (pre-open, no data).';

-- ============================================================================
-- 2. ct_all_tickers_intraday_context() — 10-ticker batch for MacroBanner
-- ============================================================================

CREATE OR REPLACE FUNCTION public.ct_all_tickers_intraday_context()
RETURNS TABLE (
  ticker                TEXT,
  spot                  NUMERIC,
  prev_close            NUMERIC,
  today_open            NUMERIC,
  pct_from_prev_close   NUMERIC,
  pct_from_today_open   NUMERIC,
  as_of                 TIMESTAMPTZ
)
LANGUAGE plpgsql STABLE
SET search_path = public, extensions
AS $$
DECLARE
  v_tickers TEXT[] := ARRAY['SPY','QQQ','IWM','AAPL','MSFT','GOOGL','AMZN','META','NVDA','TSLA'];
  v_t       TEXT;
BEGIN
  FOREACH v_t IN ARRAY v_tickers LOOP
    RETURN QUERY SELECT * FROM public.ct_ticker_intraday_context(v_t);
  END LOOP;
END $$;

GRANT EXECUTE ON FUNCTION public.ct_all_tickers_intraday_context() TO authenticated, service_role;

COMMENT ON FUNCTION public.ct_all_tickers_intraday_context() IS
  'Batch intraday context for the 10-ticker WATCHLIST (SPY/QQQ/IWM + Mag 7). One row per ticker, NULLs are honest. Used by the MacroBanner.';
