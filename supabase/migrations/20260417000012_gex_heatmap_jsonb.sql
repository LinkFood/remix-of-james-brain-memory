-- Return jsonb instead of setof rows to bypass PostgREST's 1000-row
-- max-rows limit. ATM-only over 30 snapshots of SPX can be ~9K rows
-- which gets truncated when returned as setof.
SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION public.ct_gex_heatmap(
  p_ticker    text,
  p_hours     int DEFAULT 6,
  p_snapshots int DEFAULT 30,
  p_atm_only  boolean DEFAULT true
) RETURNS jsonb LANGUAGE sql STABLE AS $fn$
  WITH latest_snaps AS (
    SELECT DISTINCT snap.snapshot_at
    FROM ct_gex_timeseries snap
    WHERE snap.ticker = upper(p_ticker)
      AND snap.snapshot_at >= now() - (p_hours || ' hours')::interval
    ORDER BY snap.snapshot_at DESC
    LIMIT p_snapshots
  )
  SELECT coalesce(jsonb_agg(
    jsonb_build_object(
      'ticker', g.ticker,
      'snapshot_at', g.snapshot_at,
      'strike', g.strike,
      'call_gex', g.call_gex,
      'put_gex', g.put_gex,
      'net_gex', g.net_gex,
      'underlying_price', g.underlying_price,
      'is_atm_band', g.is_atm_band
    )
    ORDER BY g.snapshot_at ASC, g.strike ASC
  ), '[]'::jsonb)
  FROM ct_gex_timeseries g
  JOIN latest_snaps ls ON g.snapshot_at = ls.snapshot_at
  WHERE g.ticker = upper(p_ticker)
    AND (NOT p_atm_only OR g.is_atm_band = true);
$fn$;

GRANT EXECUTE ON FUNCTION public.ct_gex_heatmap(text, int, int, boolean) TO authenticated, service_role, anon;
