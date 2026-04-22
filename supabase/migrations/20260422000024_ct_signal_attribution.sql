-- Phase 3+4: Signal events view + edge attribution table + RPC.
-- Unions all historical signals (alerts, sweeps, DP clusters, news, political) into
-- one stream, runs each against ct_forward_return at multiple horizons, aggregates
-- direction-signed alpha into ct_edge_attribution. Truth layer for "does any signal
-- actually predict anything".

-- === ct_signal_events view ==================================================
CREATE OR REPLACE VIEW public.ct_signal_events AS
-- Claude alerts (rich, thin sample — all conv-5)
SELECT
  'claude_alert'::text                    AS signal_type,
  coalesce(alert_trigger, 'generic')      AS signal_subtype,
  instrument                              AS instrument,
  direction                               AS direction,
  'conv5'::text                           AS conviction_bucket,
  created_at                              AS event_ts,
  id::text                                AS source_id
FROM public.ct_alerts, unnest(instruments) AS instrument
WHERE direction IN ('bullish','bearish')

UNION ALL
-- Option sweeps: direction from type + ask_side_perc; skip middle band
SELECT
  'sweep'::text,
  CASE
    WHEN premium >= 500000 THEN 'whale'
    WHEN premium >= 200000 THEN 'large'
    ELSE 'standard'
  END,
  ticker,
  CASE
    WHEN type = 'C' AND ask_side_perc >= 55 THEN 'bullish'
    WHEN type = 'C' AND ask_side_perc <= 45 THEN 'bearish'
    WHEN type = 'P' AND ask_side_perc >= 55 THEN 'bearish'
    WHEN type = 'P' AND ask_side_perc <= 45 THEN 'bullish'
  END,
  'default'::text,
  snapshot_at,
  id::text
FROM public.ct_sweeps
WHERE ticker IS NOT NULL
  AND type IN ('C','P')
  AND ask_side_perc IS NOT NULL
  AND (ask_side_perc >= 55 OR ask_side_perc <= 45)

UNION ALL
-- Dark pool clusters (institutional accumulation = bullish default)
SELECT
  'dp_cluster'::text,
  CASE
    WHEN total_notional >= 20000000 THEN 'whale'
    WHEN total_notional >= 5000000  THEN 'large'
    ELSE 'standard'
  END,
  ticker,
  'bullish'::text,
  CASE
    WHEN attention_score >= 85 THEN 'high'
    WHEN attention_score >= 60 THEN 'med'
    ELSE 'low'
  END,
  window_start,
  id::text
FROM public.ct_dp_clusters
WHERE ticker IS NOT NULL

UNION ALL
-- News analyses with bullish/bearish impact classification
SELECT
  'news'::text,
  coalesce(news_source, 'unknown'),
  instrument,
  impact,
  CASE
    WHEN significance >= 3 THEN 'high'
    WHEN significance = 2  THEN 'med'
    ELSE 'low'
  END,
  created_at,
  id::text
FROM public.ct_news_analyses
WHERE instrument IS NOT NULL
  AND impact IN ('bullish','bearish')

UNION ALL
-- Political trades: buy=bullish, sale=bearish. traded_at is a date; cast to 14:00 UTC
-- (post-open same day) so forward-return has intraday bars to reference.
SELECT
  'political'::text,
  'member_of_congress'::text,
  ticker,
  CASE
    WHEN lower(side) LIKE 'buy%'  THEN 'bullish'
    WHEN lower(side) LIKE 'sale%' OR lower(side) LIKE 'sell%' THEN 'bearish'
  END,
  'default'::text,
  (traded_at::timestamp AT TIME ZONE 'UTC') + INTERVAL '14 hours',
  id::text
FROM public.ct_political_trades
WHERE ticker IS NOT NULL
  AND ticker IN ('SPY','QQQ','IWM','AAPL','MSFT','NVDA','META','GOOGL','AMZN','TSLA','GLD','USO')
  AND (lower(coalesce(side,'')) LIKE 'buy%' OR lower(coalesce(side,'')) LIKE 'sale%' OR lower(coalesce(side,'')) LIKE 'sell%')
;

COMMENT ON VIEW public.ct_signal_events IS
  'Unified signal stream. One row per firing with (signal_type, subtype, instrument, direction, conviction, event_ts). Input to ct_attribute_signals.';

-- === ct_edge_attribution table ==============================================
CREATE TABLE IF NOT EXISTS public.ct_edge_attribution (
  id                   BIGSERIAL PRIMARY KEY,
  signal_type          TEXT NOT NULL,
  signal_subtype       TEXT NOT NULL,
  direction            TEXT NOT NULL,
  conviction_bucket    TEXT NOT NULL,
  horizon_mins         INT  NOT NULL,
  lookback_days        INT  NOT NULL,
  n                    INT  NOT NULL,
  mean_alpha_pct       NUMERIC,
  median_alpha_pct     NUMERIC,
  stddev_alpha_pct     NUMERIC,
  hit_rate             NUMERIC,
  sharpe               NUMERIC,
  t_stat               NUMERIC,
  mean_return_pct      NUMERIC,
  mean_spy_return_pct  NUMERIC,
  computed_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (signal_type, signal_subtype, direction, conviction_bucket, horizon_mins, lookback_days)
);

ALTER TABLE public.ct_edge_attribution ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated_read_edge_attribution" ON public.ct_edge_attribution
  FOR SELECT TO authenticated USING (true);

-- === ct_attribute_signals(p_lookback_days) ==================================
-- For each signal event in the lookback window, computes forward return at each
-- horizon via ct_forward_return, signs alpha by direction (bullish +, bearish −),
-- aggregates by (signal_type, subtype, direction, conviction, horizon).
-- Replaces prior rows for the same lookback_days on each run.

CREATE OR REPLACE FUNCTION public.ct_attribute_signals(
  p_lookback_days INT DEFAULT 30
) RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
  v_count INT;
BEGIN
  DELETE FROM public.ct_edge_attribution WHERE lookback_days = p_lookback_days;

  WITH events AS (
    SELECT *
    FROM public.ct_signal_events
    WHERE event_ts >= now() - make_interval(days => p_lookback_days)
      AND direction IN ('bullish','bearish')
      AND instrument IN ('SPY','QQQ','IWM','AAPL','MSFT','NVDA','META','GOOGL','AMZN','TSLA','GLD','USO')
  ),
  horizons(h) AS (VALUES (5),(15),(30),(60),(240),(390)),
  returns AS (
    SELECT
      e.signal_type, e.signal_subtype, e.direction, e.conviction_bucket,
      h.h AS horizon_mins,
      fr.alpha_pct, fr.return_pct, fr.spy_return_pct, fr.valid
    FROM events e
    CROSS JOIN horizons h
    CROSS JOIN LATERAL public.ct_forward_return(e.instrument, e.event_ts, h.h) fr
    WHERE fr.valid AND fr.alpha_pct IS NOT NULL
  ),
  signed AS (
    SELECT
      signal_type, signal_subtype, direction, conviction_bucket, horizon_mins,
      CASE direction WHEN 'bullish' THEN alpha_pct  ELSE -alpha_pct  END AS signed_alpha,
      CASE direction WHEN 'bullish' THEN return_pct ELSE -return_pct END AS signed_return,
      spy_return_pct
    FROM returns
  )
  INSERT INTO public.ct_edge_attribution (
    signal_type, signal_subtype, direction, conviction_bucket, horizon_mins, lookback_days,
    n, mean_alpha_pct, median_alpha_pct, stddev_alpha_pct, hit_rate, sharpe, t_stat,
    mean_return_pct, mean_spy_return_pct
  )
  SELECT
    signal_type, signal_subtype, direction, conviction_bucket, horizon_mins, p_lookback_days,
    count(*),
    round(avg(signed_alpha)::numeric, 4),
    round(percentile_cont(0.5) WITHIN GROUP (ORDER BY signed_alpha)::numeric, 4),
    round(stddev_samp(signed_alpha)::numeric, 4),
    round(avg((signed_alpha > 0)::int::numeric), 4),
    CASE WHEN stddev_samp(signed_alpha) > 0
         THEN round((avg(signed_alpha) / stddev_samp(signed_alpha))::numeric, 4) END,
    CASE WHEN stddev_samp(signed_alpha) > 0 AND count(*) > 1
         THEN round((avg(signed_alpha) / (stddev_samp(signed_alpha) / sqrt(count(*))))::numeric, 4) END,
    round(avg(signed_return)::numeric, 4),
    round(avg(spy_return_pct)::numeric, 4)
  FROM signed
  GROUP BY signal_type, signal_subtype, direction, conviction_bucket, horizon_mins;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

GRANT EXECUTE ON FUNCTION public.ct_attribute_signals(INT) TO authenticated, service_role;

COMMENT ON FUNCTION public.ct_attribute_signals IS
  'Recomputes ct_edge_attribution over the last N days. |t_stat| > 2 ≈ p<0.05 for n>30. Edge = positive mean_alpha_pct with decent n.';
