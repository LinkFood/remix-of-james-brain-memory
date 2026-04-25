-- Flow Butterfly — fix timestamp bucketing in ct_net_premium_expiry_split.
--
-- Root cause: ct_flow_alerts.executed_at is populated on only ~1.3% of rows
-- (576 of 44,773 total). The original RPC grouped by date_trunc('minute',
-- executed_at) and filtered WHERE executed_at >= since_t — dropping 98.7%
-- of data. Chart rendered empty on today's session.
--
-- Fix: fall back to ingested_at when executed_at is NULL. Close-enough proxy
-- for charting (ingest cron fires every 3 min; per-print delay inside that
-- window is negligible for a session-level running sum).

DROP FUNCTION IF EXISTS public.ct_net_premium_expiry_split(TEXT, TIMESTAMPTZ);

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
      (
        SELECT (d::date + interval '9 hours 30 minutes') AT TIME ZONE 'America/New_York'
        FROM generate_series(
          ((now() AT TIME ZONE 'America/New_York')::date),
          ((now() AT TIME ZONE 'America/New_York')::date) - interval '7 days',
          interval '-1 day'
        ) AS d
        WHERE EXTRACT(ISODOW FROM d) < 6
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
      date_trunc('minute', COALESCE(a.executed_at, a.ingested_at)) AS tick_timestamp,
      a.ticker,
      a.side,
      a.expiry,
      COALESCE((a.raw->>'total_ask_side_prem')::NUMERIC, 0)
        - COALESCE((a.raw->>'total_bid_side_prem')::NUMERIC, 0) AS signed_prem,
      COALESCE(a.executed_at, a.ingested_at)::date AS exec_date
    FROM public.ct_flow_alerts a, bounds b
    WHERE COALESCE(a.executed_at, a.ingested_at) >= b.since_t
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

GRANT EXECUTE ON FUNCTION public.ct_net_premium_expiry_split(TEXT, TIMESTAMPTZ)
  TO anon, authenticated, service_role;
