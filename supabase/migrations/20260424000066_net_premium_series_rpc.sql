-- Live Flow Butterfly — signed-rate RPC over ct_net_premium_ticks.
--
-- Replaces the client-side cumsum butterfly with a server-side series RPC
-- that returns raw signed net_call_premium / net_put_premium ticks. The UI
-- then plots the rate (not the running integral) so the chart reflects
-- *now*, not a stale day-long accumulation.
--
-- Modes:
--   p_ticker NOT NULL → raw rows for that ticker, ASC by tick_timestamp.
--   p_ticker NULL     → MARKET aggregate. Per unique tick_timestamp, sum
--                       net_call_premium and net_put_premium across the
--                       watchlist. Emits ticker = 'MARKET'.
--
-- Default p_since = NY-tz midnight today (matches ct_flow_pulse_chart's
-- default window so the live butterfly and the multi-line chart line up).
--
-- Style/security/granting follows 20260424000050_flow_pulse_series.sql and
-- 20260424000063_flow_pulse_chart_rpc.sql.

SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION public.ct_net_premium_series(
  p_ticker TEXT        DEFAULT NULL,
  p_since  TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE(
  tick_timestamp   TIMESTAMPTZ,
  ticker           TEXT,
  net_call_premium NUMERIC,
  net_put_premium  NUMERIC
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
  WITH bounds AS (
    SELECT COALESCE(
      p_since,
      (((now() AT TIME ZONE 'America/New_York')::date)::timestamp AT TIME ZONE 'America/New_York')
    ) AS since_t
  ),
  wl AS (
    SELECT UNNEST(ARRAY['SPY','QQQ','IWM','AAPL','MSFT','GOOGL','AMZN','META','NVDA','TSLA']) AS t
  ),
  filtered AS (
    SELECT
      n.tick_timestamp,
      n.ticker,
      n.net_call_premium,
      n.net_put_premium
    FROM public.ct_net_premium_ticks n, bounds b
    WHERE n.tick_timestamp >= b.since_t
      AND (
        p_ticker IS NOT NULL AND n.ticker = UPPER(p_ticker)
        OR
        p_ticker IS NULL AND n.ticker IN (SELECT t FROM wl)
      )
  )
  SELECT
    tick_timestamp,
    ticker,
    net_call_premium::NUMERIC,
    net_put_premium::NUMERIC
  FROM filtered
  WHERE p_ticker IS NOT NULL
  UNION ALL
  SELECT
    tick_timestamp,
    'MARKET'::TEXT AS ticker,
    SUM(net_call_premium)::NUMERIC AS net_call_premium,
    SUM(net_put_premium)::NUMERIC  AS net_put_premium
  FROM filtered
  WHERE p_ticker IS NULL
  GROUP BY tick_timestamp
  ORDER BY tick_timestamp ASC;
$fn$;

GRANT EXECUTE ON FUNCTION public.ct_net_premium_series(TEXT, TIMESTAMPTZ)
  TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.ct_net_premium_series(TEXT, TIMESTAMPTZ) IS
  'Live Flow Butterfly source. Returns signed net call/put premium ticks from ct_net_premium_ticks. p_ticker NULL → MARKET aggregate across the 10-name watchlist. Default since = NY-tz midnight today.';

-- Realtime publication — let the frontend subscribe to live tick inserts.
-- Idempotent: swallow duplicate_object if already published, and skip
-- silently if the supabase_realtime publication itself doesn't exist.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    BEGIN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.ct_net_premium_ticks;
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END;
  END IF;
END $$;
