-- Fix: ct_refresh_pulse_timeline had nested aggregates (jsonb_object_agg
-- wrapping count/sum). PostgreSQL rejects. Split the signals-by-type
-- rollup into its own CTE, join to the main weighted aggregate.

CREATE OR REPLACE FUNCTION public.ct_refresh_pulse_timeline()
RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
  v_inserted INT := 0;
  v_wl TEXT[] := ARRAY['SPY','QQQ','IWM','AAPL','MSFT','NVDA','META','GOOGL','AMZN','TSLA','GLD','USO'];
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
