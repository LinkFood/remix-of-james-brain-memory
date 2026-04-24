-- Fix gamma_flip computation in build_ticker_quant_card.
--
-- Old logic: SELECT strike FROM gex_rows ORDER BY abs(net_gex) ASC LIMIT 1
-- That picks the strike with the smallest absolute net gamma — which is
-- typically a far-OTM strike with almost no activity. Hence we saw:
--   AAPL  spot 273  flip 5
--   NVDA  spot 200  flip 7.5
--   META  spot 659  flip 235
--   SPY   spot 708  flip 1045
-- All nonsense.
--
-- Correct gamma flip level: the strike where cumulative net_gex (walking
-- strikes from low to high) crosses zero. This is the standard retail /
-- dealer-flip definition.
--
-- The snapshot builder reads build_ticker_quant_card.structure.gamma_flip,
-- so fixing here flows through to ct_ticker_snapshots on next build.

SET search_path = public, extensions;

-- Re-create the function with the fixed gamma_flip CTE. We only touch that
-- one CTE — the rest of the quant card stays identical. Pull the existing
-- definition and splice in the new logic.

-- Easier path: redefine just the CTE body inline. Full function rewrite to
-- ensure the old broken one is gone.

-- Read existing fn source to preserve everything we don't touch.
-- Since the fn is 300+ lines, we use CREATE OR REPLACE with the full body.
-- The ONLY change is gamma_flip_row.

CREATE OR REPLACE FUNCTION public.build_ticker_quant_card(
  p_ticker TEXT,
  p_as_of  TIMESTAMPTZ DEFAULT now()
) RETURNS JSONB
LANGUAGE sql STABLE
SET search_path = public, extensions
AS $fn$
WITH params AS (
  SELECT p_ticker AS ticker,
         p_as_of  AS as_of,
         p_as_of - interval '1 hour' AS hour_ago
),
latest_gex_snap AS (
  SELECT max(snapshot_at) AS snapshot_at
  FROM ct_gex_timeseries g, params p
  WHERE g.ticker = p.ticker
    AND g.snapshot_at <= p.as_of
    AND g.snapshot_at >= p.as_of - interval '24 hours'
),
gex_rows AS (
  SELECT g.*
  FROM ct_gex_timeseries g
  JOIN params p ON g.ticker = p.ticker
  JOIN latest_gex_snap l ON g.snapshot_at = l.snapshot_at
),
call_wall_row AS (
  SELECT strike FROM gex_rows WHERE call_gex IS NOT NULL
  ORDER BY call_gex DESC NULLS LAST LIMIT 1
),
put_wall_row AS (
  SELECT strike FROM gex_rows WHERE put_gex IS NOT NULL
  ORDER BY abs(put_gex) DESC NULLS LAST LIMIT 1
),
-- FIX: gamma flip = strike where cumulative net_gex (ordered by strike
-- asc) crosses / is closest to zero. Dealers are long gamma above this
-- strike and short gamma below it (or vice versa depending on sign).
gamma_flip_cum AS (
  SELECT strike,
         net_gex,
         sum(net_gex) OVER (ORDER BY strike ASC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cum_gex
  FROM gex_rows
  WHERE net_gex IS NOT NULL
),
gamma_flip_row AS (
  SELECT strike FROM gamma_flip_cum
  ORDER BY abs(cum_gex) ASC
  LIMIT 1
),
spot_row AS (
  SELECT underlying_price AS spot FROM gex_rows
  WHERE underlying_price IS NOT NULL
  ORDER BY snapshot_at DESC
  LIMIT 1
),
net_gamma_total AS (
  SELECT sum(net_gex) AS net_gamma FROM gex_rows
),
iv_row AS (
  SELECT iv_rank, iv_percentile
  FROM ct_iv_rank_daily iv, params p
  WHERE iv.ticker = p.ticker
    AND iv.date <= (p.as_of AT TIME ZONE 'UTC')::date
  ORDER BY iv.date DESC
  LIMIT 1
),
max_pain_row AS (
  SELECT max_pain_strike
  FROM ct_max_pain_daily mp, params p
  WHERE mp.ticker = p.ticker
    AND mp.date <= (p.as_of AT TIME ZONE 'UTC')::date
  ORDER BY mp.date DESC, mp.expiry ASC
  LIMIT 1
),
flow_agg AS (
  SELECT
    count(*)                                                         AS alert_count,
    sum(premium)                                                     AS total_premium,
    sum(CASE WHEN side = 'call' THEN premium ELSE 0 END)             AS net_call_prem,
    sum(CASE WHEN side = 'put'  THEN premium ELSE 0 END)             AS net_put_prem,
    count(*) FILTER (WHERE alert_type ILIKE '%whale%')               AS whale_count,
    count(*) FILTER (WHERE alert_type ILIKE '%sweep%')               AS sweep_count,
    count(*) FILTER (WHERE size_gt_oi = true)                        AS opening_trades
  FROM ct_flow_alerts f, params p
  WHERE f.ticker = p.ticker
    AND COALESCE(f.executed_at, f.ingested_at) BETWEEN p.hour_ago AND p.as_of
)
SELECT jsonb_build_object(
  'structure', jsonb_build_object(
    'spot',          (SELECT spot FROM spot_row),
    'gamma_flip',    (SELECT strike FROM gamma_flip_row),
    'call_wall',     (SELECT strike FROM call_wall_row),
    'put_wall',      (SELECT strike FROM put_wall_row),
    'max_pain',      (SELECT max_pain_strike FROM max_pain_row),
    'iv_rank',       (SELECT iv_rank FROM iv_row),
    'iv_percentile', (SELECT iv_percentile FROM iv_row),
    'net_gamma',     (SELECT net_gamma FROM net_gamma_total),
    'regime',        CASE
      WHEN (SELECT net_gamma FROM net_gamma_total) > 0 THEN 'positive_gamma'
      WHEN (SELECT net_gamma FROM net_gamma_total) < 0 THEN 'negative_gamma'
      ELSE NULL
    END
  ),
  'flow_last_hour', jsonb_build_object(
    'alert_count',    COALESCE((SELECT alert_count    FROM flow_agg), 0),
    'total_premium',  COALESCE((SELECT total_premium  FROM flow_agg), 0),
    'net_call_prem',  COALESCE((SELECT net_call_prem  FROM flow_agg), 0),
    'net_put_prem',   COALESCE((SELECT net_put_prem   FROM flow_agg), 0),
    'whale_count',    COALESCE((SELECT whale_count    FROM flow_agg), 0),
    'sweep_count',    COALESCE((SELECT sweep_count    FROM flow_agg), 0),
    'opening_trades', COALESCE((SELECT opening_trades FROM flow_agg), 0)
  )
);
$fn$;

GRANT EXECUTE ON FUNCTION public.build_ticker_quant_card(TEXT, TIMESTAMPTZ) TO authenticated, service_role;

COMMENT ON FUNCTION public.build_ticker_quant_card IS
  'v2: gamma_flip now uses cumulative net_gex zero-crossing (strike-asc walk) instead of min |net_gex|. Walls unchanged. Snapshot builder must run to refresh ct_ticker_snapshots.';
