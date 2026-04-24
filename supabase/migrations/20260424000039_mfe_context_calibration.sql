-- MFE calibration sliced by context columns.
--
-- Companion to ct_score_mfe_calibration that answers: does the new context
-- wiring (stacking_agrees / ticker_regime_agrees) actually discriminate
-- direction within each score band? If MFE > MAE materially when the
-- context columns vote yes, the morning's "vol detector not direction"
-- finding is overturned.
--
-- For each score band {<60, 60-69, 70-79, 80+} returns:
--   n_total       — total events with computable MFE/MAE in window
--   avg_mfe_pct   — avg favorable excursion pct
--   avg_mae_pct   — avg adverse excursion pct
--   mfe_when_stacking_agrees — avg MFE on rows where stacking_agrees=TRUE
--   mfe_when_regime_agrees   — avg MFE on rows where ticker_regime_agrees=TRUE
--   n_stacking_agrees        — sample size for the stacking_agrees slice
--   n_regime_agrees          — sample size for the regime_agrees slice
--
-- Direction is derived from option side + classification, mirrors
-- ct_score_mfe_calibration. p_horizon_hrs default 24h matches the morning
-- benchmark.

SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION public.ct_mfe_calibration_with_context(
  p_hours_back  INT DEFAULT 72,
  p_horizon_hrs INT DEFAULT 24
)
RETURNS TABLE(
  band                       TEXT,
  n_total                    BIGINT,
  avg_mfe_pct                NUMERIC,
  avg_mae_pct                NUMERIC,
  mfe_over_mae               NUMERIC,
  n_stacking_agrees          BIGINT,
  mfe_when_stacking_agrees   NUMERIC,
  mae_when_stacking_agrees   NUMERIC,
  n_regime_agrees            BIGINT,
  mfe_when_regime_agrees     NUMERIC,
  mae_when_regime_agrees     NUMERIC,
  n_both_agree               BIGINT,
  mfe_when_both_agree        NUMERIC,
  mae_when_both_agree        NUMERIC
)
LANGUAGE sql STABLE
SET search_path = public, extensions
AS $$
WITH scored AS (
  SELECT
    s.id, s.ticker, s.option_symbol, s.event_ts, s.score, s.classification,
    s.stacking_agrees, s.ticker_regime_agrees,
    p0.close AS spot_at_event
  FROM public.ct_scored_flow s
  LEFT JOIN LATERAL (
    SELECT close FROM public.ct_price_bars
    WHERE ticker = s.ticker
      AND ts BETWEEN s.event_ts - INTERVAL '30 min' AND s.event_ts + INTERVAL '30 min'
    ORDER BY ABS(EXTRACT(EPOCH FROM (ts - s.event_ts))) ASC
    LIMIT 1
  ) p0 ON TRUE
  WHERE s.ticker = ANY(ARRAY['SPY','QQQ','IWM','AAPL','MSFT','GOOGL','AMZN','META','NVDA','TSLA'])
    AND s.classification IN ('opening_buy','opening_sell')
    AND s.event_ts <= now() - (p_horizon_hrs || ' hours')::interval
    AND s.event_ts >= now() - (p_hours_back  || ' hours')::interval
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
    (SELECT MAX(close) FROM public.ct_price_bars
     WHERE ticker = sc.ticker
       AND ts > sc.event_ts
       AND ts <= sc.event_ts + (p_horizon_hrs || ' hours')::interval) AS max_in_window,
    (SELECT MIN(close) FROM public.ct_price_bars
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
      WHEN score >= 80 THEN '80+'
      WHEN score >= 70 THEN '70-79'
      WHEN score >= 60 THEN '60-69'
      ELSE '<60'
    END AS band
  FROM graded
),
mfe AS (
  SELECT *,
    CASE
      WHEN dir_sign = 1  THEN (max_in_window - spot_at_event) / spot_at_event * 100
      WHEN dir_sign = -1 THEN (spot_at_event - min_in_window) / spot_at_event * 100
      ELSE NULL
    END AS mfe_pct,
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
  COUNT(*)::bigint                                                              AS n_total,
  ROUND(AVG(mfe_pct)::numeric, 3)                                               AS avg_mfe_pct,
  ROUND(AVG(mae_pct)::numeric, 3)                                               AS avg_mae_pct,
  CASE
    WHEN AVG(mae_pct) IS NULL OR AVG(mae_pct) = 0 THEN NULL
    ELSE ROUND((AVG(mfe_pct) / AVG(mae_pct))::numeric, 3)
  END                                                                            AS mfe_over_mae,
  COUNT(*) FILTER (WHERE stacking_agrees IS TRUE)::bigint                       AS n_stacking_agrees,
  ROUND(AVG(mfe_pct) FILTER (WHERE stacking_agrees IS TRUE)::numeric, 3)        AS mfe_when_stacking_agrees,
  ROUND(AVG(mae_pct) FILTER (WHERE stacking_agrees IS TRUE)::numeric, 3)        AS mae_when_stacking_agrees,
  COUNT(*) FILTER (WHERE ticker_regime_agrees IS TRUE)::bigint                  AS n_regime_agrees,
  ROUND(AVG(mfe_pct) FILTER (WHERE ticker_regime_agrees IS TRUE)::numeric, 3)   AS mfe_when_regime_agrees,
  ROUND(AVG(mae_pct) FILTER (WHERE ticker_regime_agrees IS TRUE)::numeric, 3)   AS mae_when_regime_agrees,
  COUNT(*) FILTER (WHERE stacking_agrees IS TRUE AND ticker_regime_agrees IS TRUE)::bigint AS n_both_agree,
  ROUND(AVG(mfe_pct) FILTER (WHERE stacking_agrees IS TRUE AND ticker_regime_agrees IS TRUE)::numeric, 3) AS mfe_when_both_agree,
  ROUND(AVG(mae_pct) FILTER (WHERE stacking_agrees IS TRUE AND ticker_regime_agrees IS TRUE)::numeric, 3) AS mae_when_both_agree
FROM mfe
GROUP BY band
ORDER BY
  CASE band WHEN '80+' THEN 0 WHEN '70-79' THEN 1 WHEN '60-69' THEN 2 ELSE 3 END;
$$;

GRANT EXECUTE ON FUNCTION public.ct_mfe_calibration_with_context(INT, INT) TO authenticated, service_role;

COMMENT ON FUNCTION public.ct_mfe_calibration_with_context(INT, INT) IS
  'MFE/MAE per score band {80+, 70-79, 60-69, <60} sliced by stacking_agrees and ticker_regime_agrees. If mfe_when_stacking_agrees > mae materially in 70+ bands, the context wiring is doing real work.';
