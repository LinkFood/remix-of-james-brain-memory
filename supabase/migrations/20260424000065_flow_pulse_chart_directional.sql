-- FlowPulse Chart RPC — directional butterfly extension
--
-- Rebuilds public.ct_flow_pulse_chart to power the butterfly chart with TWO
-- mode tabs (frontend selects which side of the centerline to plot):
--
--   1. CONTRACT-TYPE mode  (top = calls, bottom = puts)
--      Columns: calls_all / calls_short / calls_long
--               puts_all  / puts_short  / puts_long
--      Simple — call premium grows above zero, put premium grows below zero.
--      Preserved verbatim from the prior RPC so v1 mode keeps working.
--
--   2. DIRECTIONAL mode    (top = bullish, bottom = bearish)
--      Columns: bullish_all / bullish_short / bullish_long
--               bearish_all / bearish_short / bearish_long
--
--      Bullish = bought-calls (aggressive ASK) + sold-puts (aggressive BID).
--               Buyers reach across the spread to take long-delta exposure;
--               put-sellers collect premium betting price stays above strike.
--      Bearish = bought-puts (aggressive ASK) + sold-calls (aggressive BID).
--               Mirror logic.
--
--      Aggression is read from the underlying UW alert payload via the raw
--      JSON fields total_ask_side_prem / total_bid_side_prem on each alert.
--      Coverage check 2026-04-24: 100% of recent rows + 100% of week-old
--      rows have both fields populated. Almost every alert is purely ASK
--      or purely BID (one side is 0). Mid-prints (~0.5%) and empty rows
--      (~0.7%) are excluded from the directional sums — they show up in
--      contract-type mode but not in directional mode, by design.
--
-- DTE bands: short = 0–7 days to expiry, long = 30+ days. "all" = no DTE filter.
-- NULL expiry → treated as long (30+) for the band filter, same fallback as
-- the prior RPC.
--
-- p_ticker NULL  → aggregates across the watchlist (10 tickers).
-- p_since  NULL  → today's NY-tz midnight.
-- p_bucket_min   → bucket size in minutes, default 5.

SET search_path = public, extensions;

DROP FUNCTION IF EXISTS public.ct_flow_pulse_chart(TEXT, TIMESTAMPTZ, INT);

CREATE OR REPLACE FUNCTION public.ct_flow_pulse_chart(
  p_ticker     TEXT DEFAULT NULL,
  p_since      TIMESTAMPTZ DEFAULT NULL,
  p_bucket_min INT DEFAULT 5
)
RETURNS TABLE(
  bucket_time   TIMESTAMPTZ,
  calls_all     NUMERIC,
  calls_short   NUMERIC,
  calls_long    NUMERIC,
  puts_all      NUMERIC,
  puts_short    NUMERIC,
  puts_long     NUMERIC,
  bullish_all   NUMERIC,
  bullish_short NUMERIC,
  bullish_long  NUMERIC,
  bearish_all   NUMERIC,
  bearish_short NUMERIC,
  bearish_long  NUMERIC
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
      COALESCE((a.expiry - a.ingested_at::date), 365) AS dte,
      COALESCE(NULLIF(a.raw->>'total_ask_side_prem','')::NUMERIC, 0) AS ask_prem,
      COALESCE(NULLIF(a.raw->>'total_bid_side_prem','')::NUMERIC, 0) AS bid_prem
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
  ),
  classified AS (
    -- Tag each alert with its directional bucket. We read aggression off the
    -- raw payload (ask>bid = aggressive buy, bid>ask = aggressive sell).
    -- Mid-prints and empty rows fall through to NULL and are excluded from
    -- bullish/bearish totals — they still count in calls_*/puts_*.
    SELECT
      bucket_time,
      side,
      premium,
      dte,
      CASE
        WHEN ask_prem > bid_prem AND side = 'call' THEN 'bullish'  -- bought call
        WHEN bid_prem > ask_prem AND side = 'put'  THEN 'bullish'  -- sold put
        WHEN ask_prem > bid_prem AND side = 'put'  THEN 'bearish'  -- bought put
        WHEN bid_prem > ask_prem AND side = 'call' THEN 'bearish'  -- sold call
        ELSE NULL  -- mid-print or empty
      END AS direction
    FROM filtered
  )
  SELECT
    bucket_time,
    -- Contract-type mode (preserved)
    COALESCE(SUM(CASE WHEN side = 'call' THEN premium ELSE 0 END), 0)::NUMERIC AS calls_all,
    COALESCE(SUM(CASE WHEN side = 'call' AND dte BETWEEN 0 AND 7 THEN premium ELSE 0 END), 0)::NUMERIC AS calls_short,
    COALESCE(SUM(CASE WHEN side = 'call' AND dte > 30 THEN premium ELSE 0 END), 0)::NUMERIC AS calls_long,
    COALESCE(SUM(CASE WHEN side = 'put'  THEN premium ELSE 0 END), 0)::NUMERIC AS puts_all,
    COALESCE(SUM(CASE WHEN side = 'put'  AND dte BETWEEN 0 AND 7 THEN premium ELSE 0 END), 0)::NUMERIC AS puts_short,
    COALESCE(SUM(CASE WHEN side = 'put'  AND dte > 30 THEN premium ELSE 0 END), 0)::NUMERIC AS puts_long,
    -- Directional mode
    COALESCE(SUM(CASE WHEN direction = 'bullish' THEN premium ELSE 0 END), 0)::NUMERIC AS bullish_all,
    COALESCE(SUM(CASE WHEN direction = 'bullish' AND dte BETWEEN 0 AND 7 THEN premium ELSE 0 END), 0)::NUMERIC AS bullish_short,
    COALESCE(SUM(CASE WHEN direction = 'bullish' AND dte > 30 THEN premium ELSE 0 END), 0)::NUMERIC AS bullish_long,
    COALESCE(SUM(CASE WHEN direction = 'bearish' THEN premium ELSE 0 END), 0)::NUMERIC AS bearish_all,
    COALESCE(SUM(CASE WHEN direction = 'bearish' AND dte BETWEEN 0 AND 7 THEN premium ELSE 0 END), 0)::NUMERIC AS bearish_short,
    COALESCE(SUM(CASE WHEN direction = 'bearish' AND dte > 30 THEN premium ELSE 0 END), 0)::NUMERIC AS bearish_long
  FROM classified
  GROUP BY bucket_time
  ORDER BY bucket_time;
$fn$;

GRANT EXECUTE ON FUNCTION public.ct_flow_pulse_chart(TEXT, TIMESTAMPTZ, INT)
  TO authenticated, anon, service_role;

COMMENT ON FUNCTION public.ct_flow_pulse_chart(TEXT, TIMESTAMPTZ, INT) IS
  'FlowPulse butterfly chart RPC. Returns 12 numeric series per bucket: contract-type (calls_*/puts_*) and directional (bullish_*/bearish_*). Bullish = bought-calls + sold-puts; bearish = bought-puts + sold-calls. Aggression read from raw->total_ask_side_prem / total_bid_side_prem. DTE bands: short 0-7, long 30+. Default since=NY-tz midnight, bucket=5min, ticker=null (watchlist aggregate).';
