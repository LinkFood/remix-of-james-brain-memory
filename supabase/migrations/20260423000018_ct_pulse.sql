-- /pulse v1 — per-ticker weighted signal score.
--
-- ct_pulse_events: normalized row per unique signal event across six source
-- tables (sweeps, news, DP clusters, insider, congress, Claude alerts).
-- Each row has direction (±1/0), base_weight (signal quality), magnitude_mult
-- (size of THIS instance), usd_weight (dollar volume behind it), and a
-- canonical (source_table, source_id) for dedup.
--
-- ct_pulse_timeline: per-ticker, per 5-min bucket, decayed-weighted
-- cumulative score + vote counts + weighted USD. Refreshed by cron every
-- 5 min during RTH.
--
-- SPX is folded into SPY at ingest time. Watchlist tickers only.

SET search_path = public, extensions;

-- ============================================================================
-- Raw event table
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.ct_pulse_events (
  id              BIGSERIAL PRIMARY KEY,
  ticker          TEXT NOT NULL,
  event_ts        TIMESTAMPTZ NOT NULL,
  signal_type     TEXT NOT NULL,        -- sweep | news | dp_cluster | insider | congress | claude_alert
  signal_subtype  TEXT,                  -- whale/large/small, conv5/conv4, officer/director, etc.
  direction       SMALLINT NOT NULL,     -- +1 bullish, -1 bearish, 0 neutral
  base_weight     NUMERIC NOT NULL,      -- 0..1, signal-type quality prior
  magnitude_mult  NUMERIC NOT NULL,      -- 0.1..4.0, log-scale of dollar size
  usd_weight      NUMERIC,               -- raw dollar volume behind this event
  source_table    TEXT NOT NULL,
  source_id       TEXT NOT NULL,
  ingested_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_table, source_id)
);

CREATE INDEX IF NOT EXISTS idx_ct_pulse_events_ticker_ts
  ON public.ct_pulse_events (ticker, event_ts DESC);
CREATE INDEX IF NOT EXISTS idx_ct_pulse_events_type_ts
  ON public.ct_pulse_events (signal_type, event_ts DESC);

ALTER TABLE public.ct_pulse_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated_read_pulse_events" ON public.ct_pulse_events
  FOR SELECT TO authenticated USING (true);

-- ============================================================================
-- Timeline table (materialized per-ticker per-bucket)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.ct_pulse_timeline (
  ticker             TEXT NOT NULL,
  bucket_ts          TIMESTAMPTZ NOT NULL,  -- 5-min bucket start, UTC
  session_date       DATE NOT NULL,
  score              NUMERIC NOT NULL,       -- decayed-weighted cumulative since session open
  bull_votes         INT NOT NULL DEFAULT 0,
  bear_votes         INT NOT NULL DEFAULT 0,
  neutral_votes      INT NOT NULL DEFAULT 0,
  bull_weighted_usd  NUMERIC NOT NULL DEFAULT 0,
  bear_weighted_usd  NUMERIC NOT NULL DEFAULT 0,
  signals_by_type    JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (ticker, bucket_ts)
);

CREATE INDEX IF NOT EXISTS idx_ct_pulse_timeline_session
  ON public.ct_pulse_timeline (session_date DESC, ticker);

ALTER TABLE public.ct_pulse_timeline ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated_read_pulse_timeline" ON public.ct_pulse_timeline
  FOR SELECT TO authenticated USING (true);

-- ============================================================================
-- Populate events from source tables
-- ============================================================================

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
    CASE impact
      WHEN 'bullish' THEN  1
      WHEN 'bearish' THEN -1
      ELSE 0
    END,
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

  -- ---------- DARK POOL CLUSTERS ----------
  -- Default bullish (accumulation). Magnitude from total_notional.
  INSERT INTO public.ct_pulse_events (
    ticker, event_ts, signal_type, signal_subtype, direction,
    base_weight, magnitude_mult, usd_weight, source_table, source_id
  )
  SELECT
    CASE WHEN ticker = 'SPX' THEN 'SPY' ELSE ticker END,
    window_start,
    'dp_cluster',
    CASE
      WHEN total_notional >= 20000000 THEN 'whale'
      WHEN total_notional >=  5000000 THEN 'large'
      ELSE 'standard'
    END,
    1,  -- default bullish (institutional accumulation)
    CASE
      WHEN total_notional >= 20000000 THEN 0.9
      WHEN total_notional >=  5000000 THEN 0.5
      ELSE 0.3
    END,
    CASE
      WHEN total_notional >= 100000000 THEN 4.0
      WHEN total_notional >=  25000000 THEN 3.0
      WHEN total_notional >=   5000000 THEN 2.0
      WHEN total_notional >=   1000000 THEN 1.0
      ELSE 0.5
    END,
    total_notional,
    'ct_dp_clusters',
    id::TEXT
  FROM public.ct_dp_clusters
  WHERE window_start >= p_since
    AND (ticker = ANY(v_wl) OR ticker = 'SPX')
  ON CONFLICT (source_table, source_id) DO NOTHING;

  -- ---------- INSIDER TRADES ----------
  -- Buy (P=Purchase, A=Acquisition) = bullish, weight 1.0. Sell (S,D) = bearish, weight 0.3.
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
  -- Use amount_band midpoint for magnitude. side maps to direction.
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
      WHEN lower(side) LIKE 'buy%' THEN  1
      WHEN lower(side) LIKE 'sale%' OR lower(side) LIKE 'sell%' THEN -1
      ELSE 0
    END,
    0.4,
    -- Amount band midpoint heuristic
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
    CASE direction
      WHEN 'bullish' THEN  1
      WHEN 'bearish' THEN -1
      ELSE 0
    END,
    CASE
      WHEN conviction = 5 THEN 0.6
      WHEN conviction = 4 THEN 0.4
      WHEN conviction = 3 THEN 0.25
      ELSE 0.1
    END,
    1.0,  -- flat magnitude — all claude alerts are same "size"
    NULL,
    'ct_alerts',
    id::text || ':' || inst
  FROM public.ct_alerts, unnest(instruments) AS inst
  WHERE created_at >= p_since
    AND (inst = ANY(v_wl) OR inst = 'SPX')
    AND direction IN ('bullish','bearish','neutral')
    AND conviction IS NOT NULL
  ON CONFLICT (source_table, source_id) DO NOTHING;

  -- Return aggregate count of rows written across all sources
  SELECT count(*) INTO v_inserted
  FROM public.ct_pulse_events
  WHERE ingested_at >= now() - INTERVAL '1 minute';

  RETURN v_inserted;
END $$;

GRANT EXECUTE ON FUNCTION public.ct_populate_pulse_events(TIMESTAMPTZ) TO authenticated, service_role;

-- ============================================================================
-- Timeline refresh — computes decayed-weighted cumulative score per ticker
-- at 5-min buckets from today's market open through the current bucket.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.ct_refresh_pulse_timeline()
RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
  v_inserted INT := 0;
  v_wl TEXT[] := ARRAY['SPY','QQQ','IWM','AAPL','MSFT','NVDA','META','GOOGL','AMZN','TSLA','GLD','USO'];
  v_today DATE := (now() AT TIME ZONE 'UTC')::date;
  v_open TIMESTAMPTZ := v_today::timestamp + INTERVAL '13 hours 30 minutes';  -- 9:30 ET = 13:30 UTC
  v_now TIMESTAMPTZ := now();
BEGIN
  -- Recency half-lives per signal type (in hours):
  --   sweep:          0.75
  --   news:           6.0
  --   dp_cluster:     2.0
  --   insider:        336.0   (14 days)
  --   congress:       720.0   (30 days)
  --   claude_alert:   1.0

  -- Build all 5-min buckets from session open to now.
  WITH buckets AS (
    SELECT
      t AS ticker,
      b AS bucket_ts
    FROM unnest(v_wl) AS t
    CROSS JOIN generate_series(
      v_open,
      date_trunc('minute', v_now) + INTERVAL '5 minutes',
      INTERVAL '5 minutes'
    ) AS b
    WHERE b <= v_now
  ),
  weighted AS (
    -- For each (ticker, bucket), sum all events up to bucket_ts with recency decay
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
      sum(CASE WHEN e.direction = -1 THEN coalesce(e.usd_weight, 0) ELSE 0 END) AS bear_usd,
      jsonb_object_agg(
        e.signal_type,
        jsonb_build_object(
          'n', count(*),
          'bull', sum(CASE WHEN e.direction =  1 THEN 1 ELSE 0 END),
          'bear', sum(CASE WHEN e.direction = -1 THEN 1 ELSE 0 END)
        )
      ) FILTER (WHERE e.signal_type IS NOT NULL) AS signals_by_type
    FROM buckets b
    LEFT JOIN public.ct_pulse_events e
      ON e.ticker = b.ticker
     AND e.event_ts BETWEEN v_open AND b.bucket_ts
    GROUP BY b.ticker, b.bucket_ts
  )
  INSERT INTO public.ct_pulse_timeline (
    ticker, bucket_ts, session_date,
    score, bull_votes, bear_votes, neutral_votes,
    bull_weighted_usd, bear_weighted_usd, signals_by_type, updated_at
  )
  SELECT
    ticker, bucket_ts, v_today,
    COALESCE(score, 0),
    COALESCE(bull_votes, 0),
    COALESCE(bear_votes, 0),
    COALESCE(neutral_votes, 0),
    COALESCE(bull_usd, 0),
    COALESCE(bear_usd, 0),
    COALESCE(signals_by_type, '{}'::jsonb),
    now()
  FROM weighted
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

GRANT EXECUTE ON FUNCTION public.ct_refresh_pulse_timeline() TO authenticated, service_role;

-- ============================================================================
-- Combined orchestrator: populate + refresh in one call. This is what the
-- cron triggers.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.ct_pulse_tick()
RETURNS jsonb
LANGUAGE sql
AS $$
  SELECT jsonb_build_object(
    'events_populated', public.ct_populate_pulse_events(now() - INTERVAL '2 hours'),
    'timeline_rows', public.ct_refresh_pulse_timeline(),
    'ran_at', now()
  );
$$;

GRANT EXECUTE ON FUNCTION public.ct_pulse_tick() TO authenticated, service_role;

-- ============================================================================
-- Current snapshot RPC for quant card injection (returns latest bucket per
-- ticker with score + slope + votes + weighted USD).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.ct_pulse_snapshot(p_ticker TEXT)
RETURNS jsonb
LANGUAGE sql STABLE
AS $$
  WITH today AS (
    SELECT *
    FROM public.ct_pulse_timeline
    WHERE ticker = upper(p_ticker)
      AND session_date = (now() AT TIME ZONE 'UTC')::date
    ORDER BY bucket_ts DESC
    LIMIT 4
  ),
  latest AS (SELECT * FROM today LIMIT 1),
  fifteen_ago AS (SELECT * FROM today OFFSET 3 LIMIT 1)
  SELECT jsonb_build_object(
    'score',               (SELECT score FROM latest),
    'slope_15m',           (SELECT (l.score - COALESCE(f.score, 0)) FROM latest l LEFT JOIN fifteen_ago f ON true),
    'bull_votes',          (SELECT bull_votes FROM latest),
    'bear_votes',          (SELECT bear_votes FROM latest),
    'bull_weighted_usd',   (SELECT bull_weighted_usd FROM latest),
    'bear_weighted_usd',   (SELECT bear_weighted_usd FROM latest),
    'signals_by_type',     (SELECT signals_by_type FROM latest),
    'bucket_ts',           (SELECT bucket_ts FROM latest)
  );
$$;

GRANT EXECUTE ON FUNCTION public.ct_pulse_snapshot(TEXT) TO authenticated, service_role;

-- ============================================================================
-- Cron: every 5 min during RTH weekdays (14:00-21:00 UTC = 10am-5pm ET)
-- ============================================================================

DO $$
BEGIN
  PERFORM cron.unschedule('ct-pulse-tick')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-pulse-tick');
  PERFORM cron.schedule(
    'ct-pulse-tick',
    '*/5 13-21 * * 1-5',
    $body$ SELECT public.ct_pulse_tick(); $body$
  );
END $$;
