-- Multi-horizon calibration RPC: grade scored_flow rows at 4h / 24h / 72h
-- to test whether the signal is intraday vs multi-day. James's read on
-- the tape: high-score prints paid off TODAY. 72h grader says 60-79
-- band loses 66%. That would be consistent with intraday-win + 3d-revert.
SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION public.ct_score_multi_horizon(p_days_back INT DEFAULT 10)
RETURNS TABLE(
  band            TEXT,
  n_4h            BIGINT,
  win_4h_pct      NUMERIC,
  n_24h           BIGINT,
  win_24h_pct     NUMERIC,
  n_72h           BIGINT,
  win_72h_pct     NUMERIC
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
    AND s.event_ts <= now() - INTERVAL '4 hours'
    AND s.event_ts >= now() - (p_days_back || ' days')::interval
    AND s.score IS NOT NULL
),
graded AS (
  SELECT
    sc.*,
    CASE
      WHEN length(sc.option_symbol) >= 9 AND substring(sc.option_symbol, length(sc.option_symbol) - 8, 1) IN ('C','c') THEN 'C'
      WHEN length(sc.option_symbol) >= 9 AND substring(sc.option_symbol, length(sc.option_symbol) - 8, 1) IN ('P','p') THEN 'P'
      ELSE NULL
    END AS side,
    (SELECT close FROM ct_price_bars
     WHERE ticker = sc.ticker
       AND ts BETWEEN sc.event_ts + INTERVAL '3.5 hours' AND sc.event_ts + INTERVAL '4.5 hours'
     ORDER BY ABS(EXTRACT(EPOCH FROM (ts - (sc.event_ts + INTERVAL '4 hours')))) LIMIT 1) AS p4h,
    (SELECT close FROM ct_price_bars
     WHERE ticker = sc.ticker
       AND ts BETWEEN sc.event_ts + INTERVAL '23 hours' AND sc.event_ts + INTERVAL '25 hours'
     ORDER BY ABS(EXTRACT(EPOCH FROM (ts - (sc.event_ts + INTERVAL '24 hours')))) LIMIT 1) AS p24h,
    (SELECT close FROM ct_price_bars
     WHERE ticker = sc.ticker
       AND ts BETWEEN sc.event_ts + INTERVAL '70 hours' AND sc.event_ts + INTERVAL '74 hours'
     ORDER BY ABS(EXTRACT(EPOCH FROM (ts - (sc.event_ts + INTERVAL '72 hours')))) LIMIT 1) AS p72h
  FROM scored sc
  WHERE sc.spot_at_event IS NOT NULL
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
filtered AS (SELECT * FROM with_dir WHERE dir_sign <> 0)
SELECT
  band,
  COUNT(*) FILTER (WHERE p4h IS NOT NULL) AS n_4h,
  ROUND(AVG(CASE WHEN p4h IS NOT NULL AND (p4h - spot_at_event) * dir_sign > 0 THEN 1.0 ELSE 0 END) * 100, 1) AS win_4h_pct,
  COUNT(*) FILTER (WHERE p24h IS NOT NULL) AS n_24h,
  ROUND(AVG(CASE WHEN p24h IS NOT NULL AND (p24h - spot_at_event) * dir_sign > 0 THEN 1.0 ELSE 0 END) * 100, 1) AS win_24h_pct,
  COUNT(*) FILTER (WHERE p72h IS NOT NULL) AS n_72h,
  ROUND(AVG(CASE WHEN p72h IS NOT NULL AND (p72h - spot_at_event) * dir_sign > 0 THEN 1.0 ELSE 0 END) * 100, 1) AS win_72h_pct
FROM filtered
GROUP BY band
ORDER BY band DESC;
$$;

GRANT EXECUTE ON FUNCTION public.ct_score_multi_horizon(INT) TO authenticated, service_role;
