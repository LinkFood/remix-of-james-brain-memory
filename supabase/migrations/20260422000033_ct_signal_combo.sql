-- Combination signals: when a sweep AND a DP cluster on the same ticker fire
-- within ±15 min of each other, emit a synthetic 'combo' signal event. Tests
-- whether joint positioning+flow alignment beats either alone.
--
-- The combo event timestamps at the LATER of the two (so forward-return
-- starts after both signals have printed). Direction must match: only
-- emit when sweep direction == dp_cluster direction (DP is always bullish,
-- so combo only emits on bullish sweep).

CREATE OR REPLACE VIEW public.ct_signal_events AS
-- Claude alerts
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
-- Raw sweeps
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
-- Dark pool clusters
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
-- News analyses
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
-- Political trades
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

UNION ALL
-- Combo: bullish sweep + bullish DP cluster on same ticker within ±15 min
SELECT
  'combo'::text                                 AS signal_type,
  'sweep_plus_dp'::text                         AS signal_subtype,
  s.ticker                                      AS instrument,
  'bullish'::text                               AS direction,
  CASE
    WHEN s.premium >= 500000 OR dp.total_notional >= 20000000 THEN 'whale'
    WHEN s.premium >= 200000 OR dp.total_notional >= 5000000  THEN 'large'
    ELSE 'standard'
  END                                           AS conviction_bucket,
  GREATEST(s.snapshot_at, dp.window_start)      AS event_ts,
  (s.id::text || '+' || dp.id::text)            AS source_id
FROM public.ct_sweeps s
JOIN public.ct_dp_clusters dp
  ON dp.ticker = s.ticker
 AND dp.window_start BETWEEN s.snapshot_at - INTERVAL '15 minutes'
                         AND s.snapshot_at + INTERVAL '15 minutes'
WHERE s.ticker IS NOT NULL
  AND s.type IN ('C','P')
  AND s.ask_side_perc IS NOT NULL
  AND (
    (s.type = 'C' AND s.ask_side_perc >= 55) OR
    (s.type = 'P' AND s.ask_side_perc <= 45)
  )  -- sweep is bullish-aligned
;
