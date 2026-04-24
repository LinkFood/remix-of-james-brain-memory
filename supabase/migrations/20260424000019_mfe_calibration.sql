-- Max Favorable Excursion (MFE) calibration.
--
-- Endpoint grading (ct_score_multi_horizon) asks: "did spot close in the
-- predicted direction at T+72h?" That misses trades that paid off intraday
-- and reverted. James's eyeball test says high-score prints hit TODAY.
--
-- MFE grader asks: "between event_ts and horizon, did spot REACH any
-- favorable level (MAX for calls, MIN for puts) that a trader could have
-- sold into?" This is what actually matches option trading reality.
--
-- Reports win rate at multiple MFE thresholds (0.5% / 1% / 2% / 5%) and
-- horizons (4h / 24h / 72h).

SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION public.ct_score_mfe_calibration(
  p_days_back    INT DEFAULT 10,
  p_horizon_hrs  INT DEFAULT 24
)
RETURNS TABLE(
  band              TEXT,
  n_rows            BIGINT,
  win_at_0_5pct     NUMERIC,   -- % that hit favorable move >= 0.5%
  win_at_1pct       NUMERIC,
  win_at_2pct       NUMERIC,
  win_at_5pct       NUMERIC,
  avg_mfe_pct       NUMERIC,    -- average favorable move captured
  avg_mae_pct       NUMERIC     -- average max ADVERSE excursion (went wrong way)
)
LANGUAGE sql STABLE
SET search_path = public, extensions
AS $$
WITH scored AS (
  SELECT s.id, s.ticker, s.option_symbol, s.event_ts, s.score, s.classification,
         p0.close AS spot_at_event
  FROM ct_scored_flow s
  LEFT JOIN LATERAL (
    SELECT close FROM ct_price_bars
    WHERE ticker = s.ticker
      AND ts BETWEEN s.event_ts - INTERVAL '30 min' AND s.event_ts + INTERVAL '30 min'
    ORDER BY ABS(EXTRACT(EPOCH FROM (ts - s.event_ts))) ASC
    LIMIT 1
  ) p0 ON TRUE
  WHERE s.ticker = ANY(ARRAY['SPY','QQQ','IWM','AAPL','MSFT','GOOGL','AMZN','META','NVDA','TSLA'])
    AND s.classification IN ('opening_buy','opening_sell')
    AND s.event_ts <= now() - (p_horizon_hrs || ' hours')::interval
    AND s.event_ts >= now() - (p_days_back || ' days')::interval
    AND s.score IS NOT NULL
),
graded AS (
  SELECT
    sc.*,
    CASE
      WHEN length(sc.option_symbol) >= 9
           AND substring(sc.option_symbol, length(sc.option_symbol) - 8, 1) IN ('C','c') THEN 'C'
      WHEN length(sc.option_symbol) >= 9
           AND substring(sc.option_symbol, length(sc.option_symbol) - 8, 1) IN ('P','p') THEN 'P'
      ELSE NULL
    END AS side,
    -- MAX close between event_ts and horizon
    (SELECT MAX(close) FROM ct_price_bars
     WHERE ticker = sc.ticker
       AND ts > sc.event_ts
       AND ts <= sc.event_ts + (p_horizon_hrs || ' hours')::interval) AS max_in_window,
    -- MIN close between event_ts and horizon
    (SELECT MIN(close) FROM ct_price_bars
     WHERE ticker = sc.ticker
       AND ts > sc.event_ts
       AND ts <= sc.event_ts + (p_horizon_hrs || ' hours')::interval) AS min_in_window
  FROM scored sc
  WHERE sc.spot_at_event IS NOT NULL AND sc.spot_at_event > 0
),
with_dir AS (
  SELECT *,
    CASE
      WHEN classification = 'opening_buy'  AND side = 'C' THEN  1
      WHEN classification = 'opening_buy'  AND side = 'P' THEN -1
      WHEN classification = 'opening_sell' AND side = 'C' THEN -1
      WHEN classification = 'opening_sell' AND side = 'P' THEN  1
      ELSE 0
    END AS dir_sign,
    CASE
      WHEN score >= 80 THEN '80-100'
      WHEN score >= 60 THEN '60-79'
      WHEN score >= 40 THEN '40-59'
      WHEN score >= 20 THEN '20-39'
      ELSE '0-19'
    END AS band
  FROM graded
),
mfe AS (
  SELECT *,
    -- Favorable excursion = move in the predicted direction
    CASE
      WHEN dir_sign = 1  THEN (max_in_window - spot_at_event) / spot_at_event * 100
      WHEN dir_sign = -1 THEN (spot_at_event - min_in_window) / spot_at_event * 100
      ELSE NULL
    END AS mfe_pct,
    -- Adverse excursion = max move AGAINST the predicted direction
    CASE
      WHEN dir_sign = 1  THEN (spot_at_event - min_in_window) / spot_at_event * 100
      WHEN dir_sign = -1 THEN (max_in_window - spot_at_event) / spot_at_event * 100
      ELSE NULL
    END AS mae_pct
  FROM with_dir
  WHERE dir_sign <> 0 AND max_in_window IS NOT NULL AND min_in_window IS NOT NULL
)
SELECT
  band,
  COUNT(*) AS n_rows,
  ROUND(AVG(CASE WHEN mfe_pct >= 0.5 THEN 1.0 ELSE 0 END) * 100, 1) AS win_at_0_5pct,
  ROUND(AVG(CASE WHEN mfe_pct >= 1.0 THEN 1.0 ELSE 0 END) * 100, 1) AS win_at_1pct,
  ROUND(AVG(CASE WHEN mfe_pct >= 2.0 THEN 1.0 ELSE 0 END) * 100, 1) AS win_at_2pct,
  ROUND(AVG(CASE WHEN mfe_pct >= 5.0 THEN 1.0 ELSE 0 END) * 100, 1) AS win_at_5pct,
  ROUND(AVG(mfe_pct), 2) AS avg_mfe_pct,
  ROUND(AVG(mae_pct), 2) AS avg_mae_pct
FROM mfe
GROUP BY band
ORDER BY band DESC;
$$;

GRANT EXECUTE ON FUNCTION public.ct_score_mfe_calibration(INT, INT) TO authenticated, service_role;
