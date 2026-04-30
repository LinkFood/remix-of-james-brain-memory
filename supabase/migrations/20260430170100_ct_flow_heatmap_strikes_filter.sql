-- =============================================================================
-- 20260430170100_ct_flow_heatmap_strikes_filter.sql
--
-- ct_flow_heatmap_strikes: filter past expiries.
--
-- The original (20260430160000) had no `expiry_date` floor, so the per-ticker
-- view rendered expired strikes (any expiry whose date had already passed)
-- alongside live ones. Add:
--
--   1. p_include_0dte boolean DEFAULT false — symmetry with ct_flow_heatmap_live
--   2. WHERE expiry_date >= CURRENT_DATE                 (no past expiries)
--      AND  (p_include_0dte OR expiry_date > CURRENT_DATE)  (gate today)
--
-- All other math identical to the prior version: RepeatedHits-on-null-flag
-- inversion, ingested_at window, voi_unusual NULL semantics, side='mixed'
-- on call+put cells, top-N by abs(value).
-- =============================================================================

SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION public.ct_flow_heatmap_strikes(
  p_ticker text,
  p_lookback_hours int DEFAULT 168,
  p_math_mode text DEFAULT 'aggressive_directional_decay',
  p_min_premium numeric DEFAULT 50000,
  p_strike_count int DEFAULT 30,
  p_include_0dte boolean DEFAULT false
)
RETURNS TABLE (
  ticker text,
  strike numeric,
  expiry_date date,
  side text,
  value numeric,
  source_alert_count int,
  contributing_alert_ids jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_now timestamptz := now();
  v_since timestamptz := now() - make_interval(hours => GREATEST(p_lookback_hours, 1));
BEGIN
  RETURN QUERY
  WITH base AS (
    SELECT
      a.id::text                                    AS row_id,
      a.alert_id                                    AS alert_id,
      a.ticker                                      AS ticker,
      a.strike                                      AS strike,
      a.expiry                                      AS expiry,
      lower(COALESCE(a.side, ''))                   AS side_lc,
      a.is_ask                                      AS is_ask,
      a.is_bid                                      AS is_bid,
      a.premium                                     AS premium,
      a.volume                                      AS volume,
      a.open_interest                               AS open_interest,
      a.ingested_at                                 AS ingested_at,
      a.raw                                         AS raw,
      NULLIF((a.raw->>'total_ask_side_prem')::text, '')::numeric AS ask_prem,
      NULLIF((a.raw->>'total_bid_side_prem')::text, '')::numeric AS bid_prem,
      COALESCE(a.raw->>'alert_rule', '')            AS alert_rule
    FROM public.ct_flow_alerts a
    WHERE a.ticker = p_ticker
      AND a.ingested_at >= v_since
      AND a.expiry IS NOT NULL
      AND a.strike IS NOT NULL
      AND a.premium IS NOT NULL
      AND a.premium > 0
      AND COALESCE(lower(a.side), '') IN ('call','put')
      -- Hide expired strikes (past today) and gate 0DTE behind the toggle.
      AND a.expiry::date >= CURRENT_DATE
      AND (p_include_0dte OR a.expiry::date > CURRENT_DATE)
  ),
  classified AS (
    SELECT
      b.*,
      CASE
        WHEN b.ask_prem IS NOT NULL AND b.bid_prem IS NOT NULL
             AND b.ask_prem < 1 AND b.bid_prem < 1
          THEN NULL::text
        WHEN b.is_ask IS TRUE THEN 'ask'
        WHEN b.is_bid IS TRUE THEN 'bid'
        WHEN b.alert_rule LIKE 'RepeatedHits%' THEN 'ask'
        WHEN b.ask_prem IS NOT NULL AND b.bid_prem IS NOT NULL THEN
          CASE
            WHEN b.ask_prem > b.bid_prem THEN 'ask'
            WHEN b.bid_prem > b.ask_prem THEN 'bid'
            ELSE NULL::text
          END
        WHEN b.ask_prem IS NOT NULL AND b.ask_prem > 0
             AND (b.bid_prem IS NULL OR b.bid_prem = 0) THEN 'ask'
        WHEN b.bid_prem IS NOT NULL AND b.bid_prem > 0
             AND (b.ask_prem IS NULL OR b.ask_prem = 0) THEN 'bid'
        ELSE NULL::text
      END AS aggressor
    FROM base b
  ),
  signed AS (
    SELECT
      c.*,
      CASE
        WHEN c.aggressor = 'ask' AND c.side_lc = 'call' THEN  c.premium
        WHEN c.aggressor = 'ask' AND c.side_lc = 'put'  THEN -c.premium
        WHEN c.aggressor = 'bid' AND c.side_lc = 'call' THEN -c.premium
        WHEN c.aggressor = 'bid' AND c.side_lc = 'put'  THEN  c.premium
        ELSE NULL::numeric
      END AS signed_premium,
      exp(- GREATEST(0, EXTRACT(EPOCH FROM (v_now - c.ingested_at)) / 86400.0) / 5.0)
        AS decay_weight
    FROM classified c
  ),
  contrib AS (
    SELECT
      s.ticker,
      s.strike,
      s.expiry::date                               AS expiry_date,
      s.side_lc,
      s.alert_id,
      s.premium,
      s.volume,
      s.open_interest,
      s.signed_premium,
      s.decay_weight,
      s.premium                                    AS contrib_total,
      CASE
        WHEN s.side_lc = 'call' THEN  s.premium
        WHEN s.side_lc = 'put'  THEN -s.premium
        ELSE 0
      END                                          AS contrib_net_signed,
      COALESCE(s.signed_premium, 0)                AS contrib_aggdir_raw,
      COALESCE(s.signed_premium, 0) * s.decay_weight AS contrib_aggdir_decay
    FROM signed s
  ),
  per_side_bucket AS (
    SELECT
      c.ticker,
      c.strike,
      c.expiry_date,
      CASE WHEN c.side_lc = 'call' THEN 'C' WHEN c.side_lc = 'put' THEN 'P' END AS side,
      SUM(c.contrib_total)        AS sum_total,
      SUM(c.contrib_net_signed)   AS sum_net_signed,
      SUM(c.contrib_aggdir_raw)   AS sum_aggdir_raw,
      SUM(c.contrib_aggdir_decay) AS sum_aggdir_decay,
      SUM(COALESCE(c.volume, 0))                            AS sum_volume,
      SUM(CASE WHEN c.open_interest IS NULL THEN 0 ELSE c.open_interest END) AS sum_oi,
      bool_and(c.open_interest IS NOT NULL)                 AS oi_known,
      COUNT(*)::int                                         AS n_rows
    FROM contrib c
    GROUP BY c.ticker, c.strike, c.expiry_date, c.side_lc
  ),
  per_cell AS (
    SELECT
      psb.ticker,
      psb.strike,
      psb.expiry_date,
      CASE
        WHEN COUNT(*) = 1 THEN MAX(psb.side)
        ELSE 'mixed'
      END AS side,
      SUM(psb.sum_total)        AS sum_total,
      SUM(psb.sum_net_signed)   AS sum_net_signed,
      SUM(psb.sum_aggdir_raw)   AS sum_aggdir_raw,
      SUM(psb.sum_aggdir_decay) AS sum_aggdir_decay,
      SUM(psb.sum_volume)       AS sum_volume,
      SUM(psb.sum_oi)           AS sum_oi,
      bool_and(psb.oi_known)    AS oi_known,
      SUM(psb.n_rows)::int      AS n_rows
    FROM per_side_bucket psb
    GROUP BY psb.ticker, psb.strike, psb.expiry_date
  ),
  resolved AS (
    SELECT
      pc.ticker,
      pc.strike,
      pc.expiry_date,
      pc.side,
      pc.n_rows,
      CASE p_math_mode
        WHEN 'total'                          THEN pc.sum_total
        WHEN 'net_signed'                     THEN pc.sum_net_signed
        WHEN 'aggressive_directional_raw'     THEN pc.sum_aggdir_raw
        WHEN 'aggressive_directional_decay'   THEN pc.sum_aggdir_decay
        WHEN 'voi_unusual' THEN
          CASE WHEN pc.oi_known AND pc.sum_oi > 0
               THEN pc.sum_volume / pc.sum_oi
               ELSE NULL END
        ELSE pc.sum_aggdir_decay
      END AS cell_value
    FROM per_cell pc
  ),
  filtered AS (
    SELECT r.*
    FROM resolved r
    WHERE ABS(COALESCE(r.cell_value, 0)) >= p_min_premium
  ),
  ranked AS (
    SELECT
      f.*,
      ROW_NUMBER() OVER (ORDER BY ABS(f.cell_value) DESC) AS rn
    FROM filtered f
  ),
  top_n AS (
    SELECT r.*
    FROM ranked r
    WHERE r.rn <= GREATEST(p_strike_count, 1)
  ),
  top_ids AS (
    SELECT
      tn.ticker,
      tn.strike,
      tn.expiry_date,
      jsonb_agg(sub.alert_id ORDER BY sub.premium DESC) AS contributing_alert_ids
    FROM top_n tn
    JOIN LATERAL (
      SELECT c2.alert_id, c2.premium
      FROM contrib c2
      WHERE c2.ticker      = tn.ticker
        AND c2.strike      = tn.strike
        AND c2.expiry_date = tn.expiry_date
        AND c2.alert_id IS NOT NULL
      ORDER BY c2.premium DESC NULLS LAST
      LIMIT 20
    ) sub ON true
    GROUP BY tn.ticker, tn.strike, tn.expiry_date
  )
  SELECT
    tn.ticker::text                                      AS ticker,
    tn.strike::numeric                                   AS strike,
    tn.expiry_date::date                                 AS expiry_date,
    tn.side::text                                        AS side,
    tn.cell_value::numeric                               AS value,
    tn.n_rows::int                                       AS source_alert_count,
    COALESCE(ti.contributing_alert_ids, '[]'::jsonb)     AS contributing_alert_ids
  FROM top_n tn
  LEFT JOIN top_ids ti
    ON ti.ticker      = tn.ticker
   AND ti.strike      = tn.strike
   AND ti.expiry_date = tn.expiry_date
  ORDER BY ABS(tn.cell_value) DESC;
END;
$$;

-- Drop the prior 5-arg signature so PostgREST resolves the new one cleanly.
DROP FUNCTION IF EXISTS public.ct_flow_heatmap_strikes(text, int, text, numeric, int);

GRANT EXECUTE ON FUNCTION public.ct_flow_heatmap_strikes(text, int, text, numeric, int, boolean)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.ct_flow_heatmap_strikes(text, int, text, numeric, int, boolean) IS
'Per-strike flow-heatmap data for /heatmap per-ticker view. Reads ct_flow_alerts directly. Returns top p_strike_count cells by abs(value) where each cell is (ticker, strike, expiry_date, side). Math modes match ct_flow_heatmap_live: total, net_signed, aggressive_directional_raw, aggressive_directional_decay (default), voi_unusual. Direction logic mirrors _shared/directionInference.ts inline (RepeatedHits-on-null-flag → ask-aggressive). Window keyed on ingested_at. Filters out past-expiry rows (expiry_date >= CURRENT_DATE); p_include_0dte gates today''s expiry. side=''mixed'' when both calls and puts contribute.';
