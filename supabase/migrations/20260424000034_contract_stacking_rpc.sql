-- ct_contract_stacking — detect same-contract repeat flow ("stacking")
--
-- Groups scored_flow rows by option_symbol within a rolling window, filters
-- to the Co-Trader watchlist and opening prints, and surfaces contracts
-- that are being accumulated (3+ prints, $100K+ total premium, ask-dominant).
--
-- Output is ordered by premium_total DESC so the biggest stacks float up.
-- `is_accelerating` flags contracts with 3+ prints in the last 15 minutes.
SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION public.ct_contract_stacking(
  p_window_min   INT     DEFAULT 360,
  p_min_prints   INT     DEFAULT 3,
  p_min_premium  NUMERIC DEFAULT 100000,
  p_ticker       TEXT    DEFAULT NULL,
  p_limit        INT     DEFAULT 50
)
RETURNS TABLE(
  option_symbol       TEXT,
  ticker              TEXT,
  strike              NUMERIC,
  expiry              DATE,
  side                TEXT,
  prints_count        INTEGER,
  first_ts            TIMESTAMPTZ,
  last_ts             TIMESTAMPTZ,
  premium_total       NUMERIC,
  avg_score           NUMERIC,
  max_score           NUMERIC,
  ask_dominant_pct    NUMERIC,
  opening_buy_count   INTEGER,
  opening_sell_count  INTEGER,
  last_15min_prints   INTEGER,
  is_accelerating     BOOLEAN
)
LANGUAGE sql STABLE
SET search_path = public, extensions
AS $$
  WITH scoped AS (
    SELECT
      sf.option_symbol,
      sf.ticker,
      sf.strike,
      sf.expiry,
      sf.event_ts,
      sf.classification,
      sf.score,
      sf.premium,
      sf.ask_side_perc
    FROM public.ct_scored_flow sf
    WHERE sf.event_ts >= now() - make_interval(mins => p_window_min)
      AND sf.ticker IN (
        'SPY','QQQ','IWM','AAPL','MSFT','GOOGL','AMZN','META','NVDA','TSLA'
      )
      AND sf.classification IN ('opening_buy','opening_sell')
      AND (p_ticker IS NULL OR sf.ticker = p_ticker)
  ),
  agg AS (
    SELECT
      s.option_symbol,
      MAX(s.ticker)                                                                AS ticker,
      MAX(s.strike)                                                                AS strike,
      MAX(s.expiry)                                                                AS expiry,
      substring(s.option_symbol FROM length(s.option_symbol) - 8 FOR 1)            AS side,
      COUNT(*)::int                                                                AS prints_count,
      MIN(s.event_ts)                                                              AS first_ts,
      MAX(s.event_ts)                                                              AS last_ts,
      COALESCE(SUM(s.premium), 0)::numeric                                         AS premium_total,
      ROUND(AVG(s.score)::numeric, 2)                                              AS avg_score,
      ROUND(MAX(s.score)::numeric, 2)                                              AS max_score,
      CASE
        WHEN COUNT(s.ask_side_perc) = 0 THEN NULL
        ELSE ROUND(AVG(s.ask_side_perc)::numeric, 1)
      END                                                                          AS ask_dominant_pct,
      COUNT(*) FILTER (WHERE s.classification = 'opening_buy')::int                AS opening_buy_count,
      COUNT(*) FILTER (WHERE s.classification = 'opening_sell')::int               AS opening_sell_count,
      COUNT(*) FILTER (WHERE s.event_ts > now() - interval '15 minutes')::int      AS last_15min_prints
    FROM scoped s
    GROUP BY s.option_symbol
  )
  SELECT
    a.option_symbol,
    a.ticker,
    a.strike,
    a.expiry,
    a.side,
    a.prints_count,
    a.first_ts,
    a.last_ts,
    a.premium_total,
    a.avg_score,
    a.max_score,
    a.ask_dominant_pct,
    a.opening_buy_count,
    a.opening_sell_count,
    a.last_15min_prints,
    (a.last_15min_prints >= 3) AS is_accelerating
  FROM agg a
  WHERE a.prints_count >= p_min_prints
    AND a.premium_total >= p_min_premium
  ORDER BY a.premium_total DESC
  LIMIT p_limit
$$;

GRANT EXECUTE ON FUNCTION public.ct_contract_stacking(INT, INT, NUMERIC, TEXT, INT)
  TO authenticated, service_role;
