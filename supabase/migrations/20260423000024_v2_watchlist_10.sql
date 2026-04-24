-- Co-Trader v2 scrub — Phase 0.4: watchlist trimmed to 10 tickers.
--
-- Removed GLD, USO (and ES, which was never in pulse). Day trader's specialist
-- model only wants options-flow-rich names. These RPCs hardcoded the 12-ticker
-- v_wl array, so patching the ct_config row is not enough — we must rebuild
-- the functions.
--
-- Bodies are copied verbatim from:
--   - 20260423000021_dp_scrub_pass1.sql   (ct_populate_pulse_events latest)
--   - 20260423000019_ct_pulse_refresh_fix.sql (ct_refresh_pulse_timeline latest)
--
-- ONLY the v_wl array changes. If either source migration is superseded later,
-- rebase this one off the newer version — don't let v_wl drift.

-- -----------------------------------------------------------------------
-- 1. ct_populate_pulse_events — 10-ticker v_wl
-- -----------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ct_populate_pulse_events(
  p_since TIMESTAMPTZ DEFAULT (now() - INTERVAL '2 hours')
) RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
  v_inserted INT := 0;
  v_wl TEXT[] := ARRAY['SPY','QQQ','IWM','AAPL','MSFT','GOOGL','AMZN','META','NVDA','TSLA'];
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
-- 2. ct_refresh_pulse_timeline — 10-ticker v_wl
-- -----------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ct_refresh_pulse_timeline()
RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
  v_inserted INT := 0;
  v_wl TEXT[] := ARRAY['SPY','QQQ','IWM','AAPL','MSFT','GOOGL','AMZN','META','NVDA','TSLA'];
  v_today DATE := (now() AT TIME ZONE 'UTC')::date;
  v_open TIMESTAMPTZ := v_today::timestamp + INTERVAL '13 hours 30 minutes';
  v_now TIMESTAMPTZ := now();
BEGIN
  WITH buckets AS (
    SELECT t AS ticker, b AS bucket_ts
    FROM unnest(v_wl) AS t
    CROSS JOIN generate_series(
      v_open,
      date_trunc('minute', v_now) + INTERVAL '5 minutes',
      INTERVAL '5 minutes'
    ) AS b
    WHERE b <= v_now
  ),
  -- Main aggregation: weighted score + flat counts
  weighted AS (
    SELECT
      b.ticker,
      b.bucket_ts,
      sum(
        e.direction * e.base_weight * e.magnitude_mult
        * power(0.5, extract(epoch FROM (b.bucket_ts - e.event_ts)) / 3600.0 / CASE e.signal_type
            WHEN 'sweep'         THEN 0.75
            WHEN 'news'          THEN 6.0
            WHEN 'dp_cluster'    THEN 2.0
            WHEN 'insider'       THEN 336.0
            WHEN 'congress'      THEN 720.0
            WHEN 'claude_alert'  THEN 1.0
            ELSE 2.0 END)
      ) AS score,
      sum(CASE WHEN e.direction =  1 THEN 1 ELSE 0 END) AS bull_votes,
      sum(CASE WHEN e.direction = -1 THEN 1 ELSE 0 END) AS bear_votes,
      sum(CASE WHEN e.direction =  0 THEN 1 ELSE 0 END) AS neutral_votes,
      sum(CASE WHEN e.direction =  1 THEN coalesce(e.usd_weight, 0) ELSE 0 END) AS bull_usd,
      sum(CASE WHEN e.direction = -1 THEN coalesce(e.usd_weight, 0) ELSE 0 END) AS bear_usd
    FROM buckets b
    LEFT JOIN public.ct_pulse_events e
      ON e.ticker = b.ticker
     AND e.event_ts BETWEEN v_open AND b.bucket_ts
    GROUP BY b.ticker, b.bucket_ts
  ),
  -- Separate rollup: per (ticker, bucket, signal_type) counts,
  -- then aggregate into a single JSONB object per (ticker, bucket).
  by_type AS (
    SELECT
      b.ticker,
      b.bucket_ts,
      e.signal_type,
      count(*) AS n,
      sum(CASE WHEN e.direction =  1 THEN 1 ELSE 0 END) AS bull,
      sum(CASE WHEN e.direction = -1 THEN 1 ELSE 0 END) AS bear
    FROM buckets b
    LEFT JOIN public.ct_pulse_events e
      ON e.ticker = b.ticker
     AND e.event_ts BETWEEN v_open AND b.bucket_ts
    WHERE e.signal_type IS NOT NULL
    GROUP BY b.ticker, b.bucket_ts, e.signal_type
  ),
  signals AS (
    SELECT
      ticker,
      bucket_ts,
      jsonb_object_agg(
        signal_type,
        jsonb_build_object('n', n, 'bull', bull, 'bear', bear)
      ) AS signals_by_type
    FROM by_type
    GROUP BY ticker, bucket_ts
  )
  INSERT INTO public.ct_pulse_timeline (
    ticker, bucket_ts, session_date,
    score, bull_votes, bear_votes, neutral_votes,
    bull_weighted_usd, bear_weighted_usd, signals_by_type, updated_at
  )
  SELECT
    w.ticker, w.bucket_ts, v_today,
    COALESCE(w.score, 0),
    COALESCE(w.bull_votes, 0),
    COALESCE(w.bear_votes, 0),
    COALESCE(w.neutral_votes, 0),
    COALESCE(w.bull_usd, 0),
    COALESCE(w.bear_usd, 0),
    COALESCE(s.signals_by_type, '{}'::jsonb),
    now()
  FROM weighted w
  LEFT JOIN signals s ON s.ticker = w.ticker AND s.bucket_ts = w.bucket_ts
  ON CONFLICT (ticker, bucket_ts) DO UPDATE SET
    score = EXCLUDED.score,
    bull_votes = EXCLUDED.bull_votes,
    bear_votes = EXCLUDED.bear_votes,
    neutral_votes = EXCLUDED.neutral_votes,
    bull_weighted_usd = EXCLUDED.bull_weighted_usd,
    bear_weighted_usd = EXCLUDED.bear_weighted_usd,
    signals_by_type = EXCLUDED.signals_by_type,
    updated_at = now();

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END $$;

-- -----------------------------------------------------------------------
-- 3. Purge timeline rows for dropped tickers + rerun for clean state
-- -----------------------------------------------------------------------

DELETE FROM public.ct_pulse_timeline WHERE ticker IN ('GLD','USO');
DELETE FROM public.ct_pulse_events   WHERE ticker IN ('GLD','USO');

SELECT public.ct_refresh_pulse_timeline();
