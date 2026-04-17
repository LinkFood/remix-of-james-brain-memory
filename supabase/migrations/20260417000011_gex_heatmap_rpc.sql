-- Efficient heatmap query: return the LATEST N distinct snapshots worth of
-- GEX data for a ticker, server-side distinct via CTE. PostgREST can't do
-- DISTINCT natively so we need an RPC here.
SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION public.ct_gex_heatmap(
  p_ticker    text,
  p_hours     int DEFAULT 6,
  p_snapshots int DEFAULT 30,
  p_atm_only  boolean DEFAULT true
) RETURNS TABLE (
  ticker           text,
  snapshot_at      timestamptz,
  strike           numeric,
  call_gex         numeric,
  put_gex          numeric,
  net_gex          numeric,
  underlying_price numeric,
  is_atm_band      boolean
) LANGUAGE sql STABLE AS $fn$
  WITH latest_snaps AS (
    SELECT DISTINCT snap.snapshot_at
    FROM ct_gex_timeseries snap
    WHERE snap.ticker = upper(p_ticker)
      AND snap.snapshot_at >= now() - (p_hours || ' hours')::interval
    ORDER BY snap.snapshot_at DESC
    LIMIT p_snapshots
  )
  SELECT
    g.ticker,
    g.snapshot_at,
    g.strike,
    g.call_gex,
    g.put_gex,
    g.net_gex,
    g.underlying_price,
    g.is_atm_band
  FROM ct_gex_timeseries g
  JOIN latest_snaps ls ON g.snapshot_at = ls.snapshot_at
  WHERE g.ticker = upper(p_ticker)
    AND (NOT p_atm_only OR g.is_atm_band = true)
  ORDER BY g.snapshot_at ASC, g.strike ASC;
$fn$;

GRANT EXECUTE ON FUNCTION public.ct_gex_heatmap(text, int, int, boolean) TO authenticated, service_role, anon;
