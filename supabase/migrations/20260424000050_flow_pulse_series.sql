-- FlowPulse Phase 2 — series RPC for sparklines.
--
-- Returns per-ticker time-series rows from ct_flow_pulse_ticks since the
-- start of today (NY-tz midnight, falls within the cron's RTH range on
-- weekdays). Also emits a synthesized 'MARKET' ticker per tick_time that
-- is the cross-watchlist aggregate (sum of premium_net, avg of C:P ratio).
--
-- Single RPC call returns everything the sparkline UI needs. Client groups
-- by ticker. Cheap query — ct_flow_pulse_ticks has indexes on (ticker,
-- tick_time DESC) and (tick_time DESC), and one trading day is ~780 rows.

SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION public.ct_flow_pulse_series(
  p_since TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE(
  tick_time      TIMESTAMPTZ,
  ticker         TEXT,
  premium_net    NUMERIC,
  call_put_ratio NUMERIC,
  is_unusual     BOOLEAN
)
LANGUAGE sql
STABLE
SET search_path = public, extensions
AS $fn$
  WITH bounds AS (
    SELECT COALESCE(
      p_since,
      (((now() AT TIME ZONE 'America/New_York')::date)::timestamp AT TIME ZONE 'America/New_York')
    ) AS since_t
  ),
  filtered AS (
    SELECT t.tick_time, t.ticker, t.premium_net, t.call_put_ratio, t.is_unusual
    FROM public.ct_flow_pulse_ticks t, bounds b
    WHERE t.tick_time >= b.since_t
  ),
  per_ticker AS (
    SELECT tick_time, ticker, premium_net, call_put_ratio, is_unusual
    FROM filtered
  ),
  market AS (
    SELECT
      tick_time,
      'MARKET'::text AS ticker,
      SUM(premium_net)::numeric AS premium_net,
      AVG(call_put_ratio)::numeric AS call_put_ratio,
      bool_or(is_unusual) AS is_unusual
    FROM filtered
    GROUP BY tick_time
  )
  SELECT * FROM per_ticker
  UNION ALL
  SELECT * FROM market
  ORDER BY ticker, tick_time;
$fn$;

GRANT EXECUTE ON FUNCTION public.ct_flow_pulse_series(TIMESTAMPTZ) TO authenticated, service_role;
