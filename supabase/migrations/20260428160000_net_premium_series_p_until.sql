-- ct_net_premium_series + ct_net_premium_expiry_split — add optional p_until
-- upper-bound for historical reads.
--
-- The Flow Butterfly chart wants to show past sessions (single day or multi-day
-- range) without overlay — same shape, just shifted to a past window. The
-- existing RPCs accept only p_since; this adds an optional p_until so the
-- frontend can scope to a closed [start, end] range. When p_until is NULL the
-- behavior is unchanged (live "today" with no upper bound).
--
-- The chart's live cp mode reads ct_net_premium_expiry_split (4-series live
-- view) — both RPCs need p_until so all historical paths are covered. mode 'bb'
-- (ct_flow_pulse_chart) is intentionally not extended; the UI hides bb in past
-- mode for v1.
--
-- Bodies are otherwise identical to the prior migrations — same default-since
-- logic, same MARKET aggregate, same realtime publication registration (no-op
-- via CREATE OR REPLACE; publication ADD lives in the earlier migration and is
-- idempotent).

SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION public.ct_net_premium_series(
  p_ticker TEXT        DEFAULT NULL,
  p_since  TIMESTAMPTZ DEFAULT NULL,
  p_until  TIMESTAMPTZ DEFAULT NULL
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
      AND (p_until IS NULL OR n.tick_timestamp <= p_until)
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

GRANT EXECUTE ON FUNCTION public.ct_net_premium_series(TEXT, TIMESTAMPTZ, TIMESTAMPTZ)
  TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.ct_net_premium_series(TEXT, TIMESTAMPTZ, TIMESTAMPTZ) IS
  'Flow Butterfly source. Returns signed net call/put premium ticks from ct_net_premium_ticks. p_ticker NULL → MARKET aggregate across the 10-name watchlist. Default since = NY-tz midnight today. Optional p_until upper bound for historical date-range reads (NULL = live, no upper bound).';

-- Same p_until extension on the 4-series expiry-split RPC (powers the live cp
-- mode of the Flow Butterfly). Body identical to
-- 20260425000002_net_premium_expiry_split_rpc_fix_timestamp.sql modulo the new
-- upper-bound predicate.

DROP FUNCTION IF EXISTS public.ct_net_premium_expiry_split(TEXT, TIMESTAMPTZ);

CREATE OR REPLACE FUNCTION public.ct_net_premium_expiry_split(
  p_ticker TEXT        DEFAULT NULL,
  p_since  TIMESTAMPTZ DEFAULT NULL,
  p_until  TIMESTAMPTZ DEFAULT NULL
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
      AND (p_until IS NULL OR COALESCE(a.executed_at, a.ingested_at) <= p_until)
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

GRANT EXECUTE ON FUNCTION public.ct_net_premium_expiry_split(TEXT, TIMESTAMPTZ, TIMESTAMPTZ)
  TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.ct_net_premium_expiry_split(TEXT, TIMESTAMPTZ, TIMESTAMPTZ) IS
  'Flow Butterfly cp-mode source (4 series, expiry-split). Returns per-minute signed net premium for calls/puts in two slices (all-expiry, 0-7 DTE). p_ticker NULL → MARKET aggregate. Optional p_until upper bound for historical date-range reads (NULL = live, no upper bound).';
