-- FlowPulse Chart RPC — task #109
--
-- Time-bucketed premium series for the multi-line FlowPulse chart James
-- designed: Calls All / Calls 0-7 / Calls 30+ vs Puts All / Puts 0-7 / Puts 30+.
-- Read on-demand from ct_flow_alerts (raw flow events). Distinct from
-- ct_flow_pulse_series (which reads pre-rolled ct_flow_pulse_ticks); this
-- RPC exposes the underlying call/put split + DTE bands the ticks table
-- doesn't capture.
--
-- Buckets ingested_at into p_bucket_min-minute slots (default 5min).
-- Returns one row per bucket with all 6 series in dollars.
--
-- ct_flow_alerts column reality (verified 2026-04-24):
--   ticker TEXT, side TEXT ('call'|'put'), premium NUMERIC,
--   expiry DATE, ingested_at TIMESTAMPTZ
-- executed_at is consistently NULL on this feed, so ingested_at is the
-- event timestamp.
--
-- DTE = (expiry - ingested_at::date) in days.
-- Bands: short = 0-7, long = 30+. "all" = no DTE filter.
--
-- p_ticker NULL → sums across watchlist; otherwise filters to the one ticker.
-- p_since NULL → today's NY-tz midnight.

SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION public.ct_flow_pulse_chart(
  p_ticker     TEXT DEFAULT NULL,
  p_since      TIMESTAMPTZ DEFAULT NULL,
  p_bucket_min INT DEFAULT 5
)
RETURNS TABLE(
  bucket_time  TIMESTAMPTZ,
  calls_all    NUMERIC,
  calls_short  NUMERIC,
  calls_long   NUMERIC,
  puts_all     NUMERIC,
  puts_short   NUMERIC,
  puts_long    NUMERIC
)
LANGUAGE sql STABLE
SET search_path = public, extensions
AS $fn$
  WITH bounds AS (
    SELECT
      COALESCE(
        p_since,
        (((now() AT TIME ZONE 'America/New_York')::date)::timestamp AT TIME ZONE 'America/New_York')
      ) AS since_t,
      GREATEST(COALESCE(p_bucket_min, 5), 1) AS bucket_min
  ),
  wl AS (
    SELECT UNNEST(ARRAY['SPY','QQQ','IWM','AAPL','MSFT','GOOGL','AMZN','META','NVDA','TSLA']) AS t
  ),
  filtered AS (
    SELECT
      a.ticker,
      a.side,
      a.premium,
      a.expiry,
      a.ingested_at,
      to_timestamp(
        floor(extract(epoch FROM a.ingested_at) / (b.bucket_min * 60)) * (b.bucket_min * 60)
      ) AS bucket_time,
      (a.expiry - a.ingested_at::date) AS dte
    FROM public.ct_flow_alerts a
    CROSS JOIN bounds b
    WHERE a.ingested_at >= b.since_t
      AND a.premium IS NOT NULL
      AND a.side IN ('call','put')
      AND (
        p_ticker IS NULL
          AND a.ticker IN (SELECT t FROM wl)
        OR
        p_ticker IS NOT NULL
          AND a.ticker = UPPER(p_ticker)
      )
  )
  SELECT
    bucket_time,
    COALESCE(SUM(premium) FILTER (WHERE side = 'call'), 0)::NUMERIC AS calls_all,
    COALESCE(SUM(premium) FILTER (WHERE side = 'call' AND dte BETWEEN 0 AND 7), 0)::NUMERIC AS calls_short,
    COALESCE(SUM(premium) FILTER (WHERE side = 'call' AND dte > 30), 0)::NUMERIC AS calls_long,
    COALESCE(SUM(premium) FILTER (WHERE side = 'put'), 0)::NUMERIC AS puts_all,
    COALESCE(SUM(premium) FILTER (WHERE side = 'put' AND dte BETWEEN 0 AND 7), 0)::NUMERIC AS puts_short,
    COALESCE(SUM(premium) FILTER (WHERE side = 'put' AND dte > 30), 0)::NUMERIC AS puts_long
  FROM filtered
  GROUP BY bucket_time
  ORDER BY bucket_time;
$fn$;

GRANT EXECUTE ON FUNCTION public.ct_flow_pulse_chart(TEXT, TIMESTAMPTZ, INT) TO authenticated, service_role;

COMMENT ON FUNCTION public.ct_flow_pulse_chart(TEXT, TIMESTAMPTZ, INT) IS
  'Task #109: time-bucketed call/put premium series with DTE bands (all / 0-7 / 30+) for the FlowPulse multi-line chart. Reads ct_flow_alerts on-demand. Default since=NY-tz midnight, bucket=5min, ticker=null (watchlist aggregate).';
