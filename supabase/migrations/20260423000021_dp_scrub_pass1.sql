-- DP scrub Pass 1 — kill the write path.
-- 2026-04-23: Dropping dark-pool-derived signals from active use. Historical
-- data in ct_dark_pool_prints (580k rows) and ct_dp_clusters (730 rows)
-- stays queryable but no new writes. Rationale: we cannot reliably classify
-- DP print direction (bullish/bearish) and the signal was dominating the
-- pulse score with false bullish votes.
--
-- This migration:
--   1. Unschedules ct-dp-cluster cron
--   2. Rewrites ct_populate_pulse_events to stop inserting DP cluster rows
--   3. Drops dark_pool_last_hour from quant card decorator overlay
--
-- ct_dark_pool_prints + ct_dp_clusters tables preserved for historical
-- /edge attribution. ct-flow-ingester DP block removed separately (TS fn).

-- -----------------------------------------------------------------------
-- 1. Unschedule DP cluster cron
-- -----------------------------------------------------------------------

DO $$
BEGIN
  PERFORM cron.unschedule('ct-dp-cluster')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-dp-cluster');
END $$;

-- -----------------------------------------------------------------------
-- 2. Rewrite populate function to skip DP cluster ingest
-- -----------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ct_populate_pulse_events(
  p_since TIMESTAMPTZ DEFAULT (now() - INTERVAL '2 hours')
) RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
  v_inserted INT := 0;
  v_wl TEXT[] := ARRAY['SPY','QQQ','IWM','AAPL','MSFT','NVDA','META','GOOGL','AMZN','TSLA','GLD','USO'];
BEGIN
  -- ---------- SWEEPS ----------
  INSERT INTO public.ct_pulse_events (
    ticker, event_ts, signal_type, signal_subtype, direction,
    base_weight, magnitude_mult, usd_weight, source_table, source_id
  )
  SELECT
    CASE WHEN ticker = 'SPX' THEN 'SPY' ELSE ticker END,
    snapshot_at,
    'sweep',
    CASE
      WHEN premium >= 500000 THEN 'whale'
      WHEN premium >= 100000 THEN 'large'
      ELSE 'small'
    END,
    CASE
      WHEN type = 'C' AND ask_side_perc >= 55 THEN  1
      WHEN type = 'C' AND ask_side_perc <= 45 THEN -1
      WHEN type = 'P' AND ask_side_perc <= 45 THEN  1
      WHEN type = 'P' AND ask_side_perc >= 55 THEN -1
      ELSE 0
    END,
    CASE
      WHEN premium >= 500000 THEN 0.7
      WHEN premium >= 100000 THEN 0.5
      ELSE 0.1
    END,
    CASE
      WHEN premium >= 25000000 THEN 4.0
      WHEN premium >=  5000000 THEN 3.0
      WHEN premium >=  1000000 THEN 2.0
      WHEN premium >=   100000 THEN 1.0
      ELSE 0.5
    END,
    premium,
    'ct_sweeps',
    id::TEXT
  FROM public.ct_sweeps
  WHERE snapshot_at >= p_since
    AND (ticker = ANY(v_wl) OR ticker = 'SPX')
    AND type IN ('C','P')
    AND ask_side_perc IS NOT NULL
    AND (ask_side_perc >= 55 OR ask_side_perc <= 45)
    AND premium IS NOT NULL
  ON CONFLICT (source_table, source_id) DO NOTHING;

  -- ---------- NEWS ----------
  INSERT INTO public.ct_pulse_events (
    ticker, event_ts, signal_type, signal_subtype, direction,
    base_weight, magnitude_mult, usd_weight, source_table, source_id
  )
  SELECT
    CASE WHEN instrument = 'SPX' THEN 'SPY' ELSE instrument END,
    created_at,
    'news',
    COALESCE(news_source, 'unknown'),
    CASE impact WHEN 'bullish' THEN 1 WHEN 'bearish' THEN -1 ELSE 0 END,
    CASE
      WHEN significance >= 4 THEN 0.7
      WHEN significance = 3  THEN 0.4
      WHEN significance = 2  THEN 0.3
      ELSE 0.05
    END,
    CASE
      WHEN significance >= 4 THEN 2.0
      WHEN significance = 3  THEN 1.5
      WHEN significance = 2  THEN 1.0
      ELSE 0.5
    END,
    NULL,
    'ct_news_analyses',
    id::TEXT
  FROM public.ct_news_analyses
  WHERE created_at >= p_since
    AND (instrument = ANY(v_wl) OR instrument = 'SPX')
    AND impact IN ('bullish','bearish','neutral','mixed')
  ON CONFLICT (source_table, source_id) DO NOTHING;

  -- DP CLUSTERS — REMOVED 2026-04-23 (cannot reliably classify direction)

  -- ---------- INSIDER TRADES ----------
  INSERT INTO public.ct_pulse_events (
    ticker, event_ts, signal_type, signal_subtype, direction,
    base_weight, magnitude_mult, usd_weight, source_table, source_id
  )
  SELECT
    ticker,
    COALESCE(trade_date::timestamptz, filing_date::timestamptz),
    'insider',
    COALESCE(transaction_type, 'unknown'),
    CASE
      WHEN upper(transaction_type) LIKE 'P%' OR upper(transaction_type) LIKE 'BUY%' OR upper(transaction_type) LIKE 'A%' THEN 1
      WHEN upper(transaction_type) LIKE 'S%' OR upper(transaction_type) LIKE 'SELL%' OR upper(transaction_type) LIKE 'D%' THEN -1
      ELSE 0
    END,
    CASE
      WHEN upper(transaction_type) LIKE 'P%' OR upper(transaction_type) LIKE 'BUY%' OR upper(transaction_type) LIKE 'A%' THEN 1.0
      ELSE 0.3
    END,
    CASE
      WHEN value_usd >= 10000000 THEN 4.0
      WHEN value_usd >=  1000000 THEN 3.0
      WHEN value_usd >=   100000 THEN 2.0
      WHEN value_usd >=    10000 THEN 1.0
      ELSE 0.5
    END,
    value_usd,
    'ct_insider_trades',
    id::TEXT
  FROM public.ct_insider_trades
  WHERE COALESCE(trade_date::timestamptz, filing_date::timestamptz) >= p_since
    AND ticker = ANY(v_wl)
    AND transaction_type IS NOT NULL
  ON CONFLICT (source_table, source_id) DO NOTHING;

  -- ---------- CONGRESS TRADES ----------
  INSERT INTO public.ct_pulse_events (
    ticker, event_ts, signal_type, signal_subtype, direction,
    base_weight, magnitude_mult, usd_weight, source_table, source_id
  )
  SELECT
    ticker,
    (traded_at::timestamp AT TIME ZONE 'UTC') + INTERVAL '14 hours',
    'congress',
    COALESCE(chamber, 'unknown'),
    CASE
      WHEN lower(side) LIKE 'buy%' THEN 1
      WHEN lower(side) LIKE 'sale%' OR lower(side) LIKE 'sell%' THEN -1
      ELSE 0
    END,
    0.4,
    CASE
      WHEN amount_band_usd ILIKE '%1,000,001%'     THEN 4.0
      WHEN amount_band_usd ILIKE '%500,001 - %'    THEN 3.0
      WHEN amount_band_usd ILIKE '%100,001 - %'    THEN 2.0
      WHEN amount_band_usd ILIKE '%50,001 - %'     THEN 1.5
      WHEN amount_band_usd ILIKE '%15,001 - %'     THEN 1.0
      ELSE 0.5
    END,
    NULL,
    'ct_political_trades',
    id::TEXT
  FROM public.ct_political_trades
  WHERE traded_at >= (p_since AT TIME ZONE 'UTC')::date - 1
    AND ticker = ANY(v_wl)
    AND side IS NOT NULL
  ON CONFLICT (source_table, source_id) DO NOTHING;

  -- ---------- CLAUDE ALERTS ----------
  INSERT INTO public.ct_pulse_events (
    ticker, event_ts, signal_type, signal_subtype, direction,
    base_weight, magnitude_mult, usd_weight, source_table, source_id
  )
  SELECT
    CASE WHEN inst = 'SPX' THEN 'SPY' ELSE inst END,
    created_at,
    'claude_alert',
    'conv' || conviction::text,
    CASE direction WHEN 'bullish' THEN 1 WHEN 'bearish' THEN -1 ELSE 0 END,
    CASE
      WHEN conviction = 5 THEN 0.6
      WHEN conviction = 4 THEN 0.4
      WHEN conviction = 3 THEN 0.25
      ELSE 0.1
    END,
    1.0,
    NULL,
    'ct_alerts',
    id::text || ':' || inst
  FROM public.ct_alerts, unnest(instruments) AS inst
  WHERE created_at >= p_since
    AND (inst = ANY(v_wl) OR inst = 'SPX')
    AND direction IN ('bullish','bearish','neutral')
    AND conviction IS NOT NULL
  ON CONFLICT (source_table, source_id) DO NOTHING;

  SELECT count(*) INTO v_inserted
  FROM public.ct_pulse_events
  WHERE ingested_at >= now() - INTERVAL '1 minute';

  RETURN v_inserted;
END $$;

-- -----------------------------------------------------------------------
-- 3. Purge DP cluster rows from pulse events + recompute timeline
-- -----------------------------------------------------------------------

DELETE FROM public.ct_pulse_events WHERE signal_type = 'dp_cluster';

-- Rerun timeline so today's lines rebalance without DP contributions
SELECT public.ct_refresh_pulse_timeline();

-- -----------------------------------------------------------------------
-- 4. Deprecation markers (human-readable, no schema change)
-- -----------------------------------------------------------------------

COMMENT ON TABLE public.ct_dark_pool_prints IS
  'DEPRECATED 2026-04-23 — historical only, no new writes. Retained for lookback attribution.';
COMMENT ON TABLE public.ct_dp_clusters IS
  'DEPRECATED 2026-04-23 — historical only, no new writes. Retained for lookback attribution.';
