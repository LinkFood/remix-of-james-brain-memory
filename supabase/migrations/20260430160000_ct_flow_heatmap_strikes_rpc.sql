-- =============================================================================
-- 20260430160000_ct_flow_heatmap_strikes_rpc.sql
--
-- ct_flow_heatmap_strikes(p_ticker, p_lookback_hours, p_math_mode,
--                         p_min_premium, p_strike_count)
--
-- Per-strike heatmap data for the /heatmap page's per-ticker view. Reads
-- DIRECTLY from ct_flow_alerts (not the snapshot table — the snapshot rows
-- aggregate to expiry_date and bury per-strike in a top_strikes JSON blob).
--
-- For each (ticker, strike, expiry_date, side) bucket within the lookback
-- window, returns the same value math the snapshot writer computes:
--
--   total                          calls + puts (raw $)
--   net_signed                     calls - puts (raw, NOT direction-aware)
--   aggressive_directional_raw     ask-aggressive call $ minus
--                                   ask-aggressive put $ (via inline
--                                   inferDirection — RepeatedHits-on-null-flag
--                                   rule inverts UW's bid/ask premium when
--                                   alert_rule starts with 'RepeatedHits')
--   aggressive_directional_decay   same with exp(-age_days/5) recency weight
--   voi_unusual                    Σvolume / ΣOI for the bucket
--
-- Direction logic mirrors supabase/functions/_shared/directionInference.ts:
--   - If is_ask=true → ask-aggressive
--   - Else if is_bid=true → bid-aggressive
--   - Else if raw.alert_rule starts with 'RepeatedHits' → ask-aggressive
--     (RepeatedHits = active accumulation; cheap OTM/0DTE buyers lift at
--     the bid which inverts total_bid_side_prem — trust the rule, not the
--     side-aggregate)
--   - Else compare raw.total_ask_side_prem vs raw.total_bid_side_prem
--   - aggressiveAsk + call → up (+premium); aggressiveAsk + put → down (-premium)
--   - aggressiveBid + call → down (-premium); aggressiveBid + put → up (+premium)
--
-- voi_unusual returns NULL whenever any contributing row in the bucket has
-- an unknown OI — matches snapshot writer semantics. Filter step uses
-- COALESCE(value, 0) so VOI nulls don't survive the min-premium gate.
--
-- Window: ingested_at >= now() - p_lookback_hours hours (NOT executed_at —
-- UW emits NULL on executed_at for many rows; ingested_at is always set).
--
-- Output side semantics: 'C' if all contributing rows are calls, 'P' if all
-- puts, 'mixed' if both. Group key includes side so per-strike directional
-- imbalance stays visible in the per-ticker grid.
-- =============================================================================

SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION public.ct_flow_heatmap_strikes(
  p_ticker text,
  p_lookback_hours int DEFAULT 168,
  p_math_mode text DEFAULT 'aggressive_directional_decay',
  p_min_premium numeric DEFAULT 50000,
  p_strike_count int DEFAULT 30
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
    -- Pull rows in the window with the columns we need + parsed side/alert_rule
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
  ),
  classified AS (
    -- Inline inferDirection. signed_premium is +premium for "up"
    -- (bullish), -premium for "down" (bearish), NULL when no direction
    -- could be inferred.
    SELECT
      b.*,
      CASE
        -- Mid-print: both sides effectively zero → no signal
        WHEN b.ask_prem IS NOT NULL AND b.bid_prem IS NOT NULL
             AND b.ask_prem < 1 AND b.bid_prem < 1
          THEN NULL::text
        -- Explicit aggressor flags
        WHEN b.is_ask IS TRUE THEN 'ask'
        WHEN b.is_bid IS TRUE THEN 'bid'
        -- RepeatedHits rule: accumulation/buying — both sides map to ask-aggressive
        WHEN b.alert_rule LIKE 'RepeatedHits%' THEN 'ask'
        -- Compare ask-side vs bid-side premium
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
      -- exp(-age_days / 5) recency weight
      exp(- GREATEST(0, EXTRACT(EPOCH FROM (v_now - c.ingested_at)) / 86400.0) / 5.0)
        AS decay_weight
    FROM classified c
  ),
  -- Per-row contribution to each candidate value column
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
      -- Mode A: total
      s.premium                                    AS contrib_total,
      -- Mode B: net signed = calls - puts (raw, NOT direction-aware)
      CASE
        WHEN s.side_lc = 'call' THEN  s.premium
        WHEN s.side_lc = 'put'  THEN -s.premium
        ELSE 0
      END                                          AS contrib_net_signed,
      -- Mode C: ask-aggressive directional (raw)
      COALESCE(s.signed_premium, 0)                AS contrib_aggdir_raw,
      -- Mode C': ask-aggressive directional (decay)
      COALESCE(s.signed_premium, 0) * s.decay_weight AS contrib_aggdir_decay
    FROM signed s
  ),
  -- Aggregate per (ticker, strike, expiry_date, side)
  -- We bucket by side first (C/P), then collapse into 'mixed' below.
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
  -- Collapse C/P pairs at same (ticker, strike, expiry) into 'mixed' rows
  -- where we sum the per-side sub-totals. The strike+expiry is the heatmap
  -- cell key; side="mixed" tells the UI both sides contributed.
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
  -- Top-20 contributing alert ids per surviving cell, by premium
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

GRANT EXECUTE ON FUNCTION public.ct_flow_heatmap_strikes(text, int, text, numeric, int)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.ct_flow_heatmap_strikes(text, int, text, numeric, int) IS
'Per-strike flow-heatmap data for /heatmap per-ticker view. Reads ct_flow_alerts directly (snapshot rows aggregate to expiry_date, not strike). Returns top p_strike_count cells by abs(value) where each cell is (ticker, strike, expiry_date, side). Math modes match ct_flow_heatmap_live: total, net_signed, aggressive_directional_raw, aggressive_directional_decay (default), voi_unusual. Direction logic mirrors _shared/directionInference.ts inline (RepeatedHits-on-null-flag → ask-aggressive). Window keyed on ingested_at (UW emits NULL on executed_at for many rows). side=''mixed'' when both calls and puts contribute.';
