-- Flow Butterfly — net premium split by expiry bucket.
--
-- Adds a 4-series RPC that splits per-minute signed net premium into:
--   - all_net_call    : SUM(ask_prem - bid_prem) for calls, any expiry
--   - all_net_put     : SUM(ask_prem - bid_prem) for puts,  any expiry
--   - next_net_call   : same, restricted to expiry within 7 days of the print
--   - next_net_put    : same, restricted to expiry within 7 days of the print
--
-- Source is ct_flow_alerts raw prints (NOT ct_net_premium_ticks) because the
-- aggregated tick table only carries ALL-expiry totals. Expiry-bucketed series
-- requires the per-print expiry column.
--
-- Convention: signed = ask_side_prem - bid_side_prem (positive = aggressive
-- buying, negative = aggressive selling).
--
-- Modes:
--   p_ticker NOT NULL → rows for that ticker.
--   p_ticker NULL     → MARKET aggregate across the 10-name watchlist;
--                       per minute bucket sum the four columns; emit
--                       ticker = 'MARKET'.
--
-- Default p_since walks back to the most recent weekday's 09:30 ET, so a
-- Saturday/Sunday call still returns Friday's session instead of an empty
-- weekend window.
--
-- Style/security/granting follows 20260424000066_net_premium_series_rpc.sql.

SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION public.ct_net_premium_expiry_split(
  p_ticker TEXT        DEFAULT NULL,
  p_since  TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE(
  tick_timestamp TIMESTAMPTZ,
  ticker         TEXT,
  all_net_call   NUMERIC,
  all_net_put    NUMERIC,
  next_net_call  NUMERIC,
  next_net_put   NUMERIC
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
  WITH bounds AS (
    SELECT COALESCE(
      p_since,
      -- Most recent weekday 09:30 ET. If today is Sat/Sun or before today's
      -- 09:30 ET, walk back day-by-day until we land on a weekday whose
      -- 09:30 ET open is in the past.
      (
        SELECT (d::date + interval '9 hours 30 minutes') AT TIME ZONE 'America/New_York'
        FROM generate_series(
          ((now() AT TIME ZONE 'America/New_York')::date),
          ((now() AT TIME ZONE 'America/New_York')::date) - interval '7 days',
          interval '-1 day'
        ) AS d
        WHERE EXTRACT(ISODOW FROM d) < 6  -- Mon..Fri
          AND ((d::date + interval '9 hours 30 minutes') AT TIME ZONE 'America/New_York') <= now()
        ORDER BY d DESC
        LIMIT 1
      )
    ) AS since_t
  ),
  wl AS (
    SELECT UNNEST(ARRAY['SPY','QQQ','IWM','AAPL','MSFT','GOOGL','AMZN','META','NVDA','TSLA']) AS t
  ),
  filtered AS (
    SELECT
      date_trunc('minute', a.executed_at) AS tick_timestamp,
      a.ticker,
      a.side,
      a.expiry,
      COALESCE((a.raw->>'total_ask_side_prem')::NUMERIC, 0)
        - COALESCE((a.raw->>'total_bid_side_prem')::NUMERIC, 0) AS signed_prem,
      a.executed_at::date AS exec_date
    FROM public.ct_flow_alerts a, bounds b
    WHERE a.executed_at >= b.since_t
      AND (
        (p_ticker IS NOT NULL AND a.ticker = UPPER(p_ticker))
        OR
        (p_ticker IS NULL AND a.ticker IN (SELECT t FROM wl))
      )
  ),
  per_ticker AS (
    SELECT
      tick_timestamp,
      ticker,
      SUM(signed_prem) FILTER (WHERE side = 'call')::NUMERIC                                                    AS all_net_call,
      SUM(signed_prem) FILTER (WHERE side = 'put')::NUMERIC                                                     AS all_net_put,
      SUM(signed_prem) FILTER (WHERE side = 'call' AND expiry IS NOT NULL AND expiry <= exec_date + INTERVAL '7 days')::NUMERIC AS next_net_call,
      SUM(signed_prem) FILTER (WHERE side = 'put'  AND expiry IS NOT NULL AND expiry <= exec_date + INTERVAL '7 days')::NUMERIC AS next_net_put
    FROM filtered
    GROUP BY tick_timestamp, ticker
  )
  SELECT
    tick_timestamp,
    ticker,
    COALESCE(all_net_call,  0)::NUMERIC  AS all_net_call,
    COALESCE(all_net_put,   0)::NUMERIC  AS all_net_put,
    COALESCE(next_net_call, 0)::NUMERIC  AS next_net_call,
    COALESCE(next_net_put,  0)::NUMERIC  AS next_net_put
  FROM per_ticker
  WHERE p_ticker IS NOT NULL
  UNION ALL
  SELECT
    tick_timestamp,
    'MARKET'::TEXT AS ticker,
    COALESCE(SUM(all_net_call),  0)::NUMERIC AS all_net_call,
    COALESCE(SUM(all_net_put),   0)::NUMERIC AS all_net_put,
    COALESCE(SUM(next_net_call), 0)::NUMERIC AS next_net_call,
    COALESCE(SUM(next_net_put),  0)::NUMERIC AS next_net_put
  FROM per_ticker
  WHERE p_ticker IS NULL
  GROUP BY tick_timestamp
  ORDER BY tick_timestamp ASC;
$fn$;

DO $$
BEGIN
  GRANT EXECUTE ON FUNCTION public.ct_net_premium_expiry_split(TEXT, TIMESTAMPTZ)
    TO anon, authenticated, service_role;
END $$;

COMMENT ON FUNCTION public.ct_net_premium_expiry_split(TEXT, TIMESTAMPTZ) IS
  'Flow Butterfly 4-series source. Per-minute signed net premium from ct_flow_alerts split into all-expiry vs next-7-day buckets, by call/put. p_ticker NULL → MARKET aggregate across the 10-name watchlist. Default since = most recent weekday 09:30 ET.';
