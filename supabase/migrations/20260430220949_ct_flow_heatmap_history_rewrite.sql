-- =============================================================================
-- 20260430220949_ct_flow_heatmap_history_rewrite.sql
--
-- ROOT-CAUSE FIX (Phase 5 of Synthesis Layer): ct_flow_heatmap_history
-- previously read ct_flow_heatmap_snapshots, inheriting the same
-- mixed-semantics bug that ct_flow_heatmap_live and ct_flow_heatmap_diff
-- were rewritten to escape on 2026-04-30 (commit 7844f86, migration
-- 20260430170000_ct_flow_heatmap_live_rewrite.sql).
--
-- Symptom in the wild: the FlowHeatmapDrill panel's "Cell evolution
-- (last 24h)" line chart rendered axes but no line — every history value
-- was ~50x undersized relative to the live cell because snapshots mixed
-- 5-min cron windows and 168h backfill windows. Once snapshots aged out,
-- the per-snapshot DISTINCT ON returned latest 5-min only.
--
-- This rewrite scans ct_flow_alerts directly within (p_since, p_until),
-- buckets time into 5-min slots for ≤7d windows and 15-min slots for >7d
-- windows (so even a 30d replay stays under recharts' practical point
-- count), and groups per (ticker, expiry_bucket_week, time_bucket).
--
-- Same direction logic as the live RPC: inline inferDirection +
-- RepeatedHits-on-null-flag → ask-aggressive. Friday-of-ISO-week mirrors
-- (expiry_date - isodow + 5).
--
-- Window keyed on ingested_at (executed_at is NULL on many UW rows per
-- feedback_ct_flow_alerts_executed_at_null).
--
-- Snapshots remain the single source of truth ONLY for the flow-stack
-- detector baseline distribution — they're untouched there.
--
-- Backwards compatibility: the column name `snapshot_at` is preserved so
-- the FlowHeatmapDrill's defensive `snapshot_at ?? latest_snapshot_at`
-- read continues to work without UI changes.
-- =============================================================================

SET search_path = public, extensions;

DROP FUNCTION IF EXISTS public.ct_flow_heatmap_history(text[], timestamptz, timestamptz, text);

CREATE OR REPLACE FUNCTION public.ct_flow_heatmap_history(
  p_tickers     text[],
  p_since       timestamptz,
  p_until       timestamptz,
  p_math_mode   text DEFAULT 'aggressive_directional_decay'
)
RETURNS TABLE (
  ticker             text,
  expiry_bucket_week date,
  snapshot_at        timestamptz,
  value              numeric,
  source_alert_count int
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_window_hours    numeric;
  v_bucket_minutes  int;
  v_bucket_interval interval;
BEGIN
  -- Decide bucket width from window size:
  --   ≤ 7 days → 5-min buckets (~2,016 points / 7d × ticker × bucket_week)
  --   > 7 days → 15-min buckets (keeps point count bounded for replay)
  v_window_hours := GREATEST(0, EXTRACT(EPOCH FROM (p_until - p_since)) / 3600.0);
  IF v_window_hours <= 24 * 7 THEN
    v_bucket_minutes := 5;
  ELSE
    v_bucket_minutes := 15;
  END IF;
  v_bucket_interval := make_interval(mins => v_bucket_minutes);

  RETURN QUERY
  WITH base AS (
    SELECT
      a.alert_id                                                  AS alert_id,
      a.ticker                                                    AS ticker,
      a.expiry::date                                              AS expiry_date,
      lower(COALESCE(a.side, ''))                                 AS side_lc,
      a.is_ask                                                    AS is_ask,
      a.is_bid                                                    AS is_bid,
      a.premium                                                   AS premium,
      a.volume                                                    AS volume,
      a.open_interest                                             AS open_interest,
      a.ingested_at                                               AS ingested_at,
      NULLIF((a.raw->>'total_ask_side_prem')::text, '')::numeric  AS ask_prem,
      NULLIF((a.raw->>'total_bid_side_prem')::text, '')::numeric  AS bid_prem,
      COALESCE(a.raw->>'alert_rule', '')                          AS alert_rule,
      -- Snap ingested_at down to the bucket start
      date_trunc('minute', a.ingested_at)
        - make_interval(mins => MOD(EXTRACT(MINUTE FROM a.ingested_at)::int, v_bucket_minutes))
                                                                  AS bucket_at
    FROM public.ct_flow_alerts a
    WHERE a.ticker = ANY(p_tickers)
      AND a.ingested_at >= p_since
      AND a.ingested_at <  p_until
      AND a.expiry IS NOT NULL
      AND a.premium IS NOT NULL
      AND a.premium > 0
      AND COALESCE(lower(a.side), '') IN ('call','put')
  ),
  classified AS (
    -- Inline inferDirection — mirrors the live RPC. aggressor = 'ask' | 'bid' | NULL.
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
      END                                                            AS signed_premium,
      -- Decay weight anchors to the bucket end (= bucket_at + interval) so each
      -- bucket's contribution is as-of that point in time.
      exp(- GREATEST(0,
            EXTRACT(EPOCH FROM ((c.bucket_at + v_bucket_interval) - c.ingested_at)) / 86400.0
          ) / 5.0)                                                   AS decay_weight,
      (c.expiry_date - (extract(isodow from c.expiry_date)::int) + 5)::date
                                                                     AS expiry_bucket_week
    FROM classified c
  ),
  contrib AS (
    SELECT
      s.ticker,
      s.expiry_bucket_week,
      s.bucket_at,
      s.alert_id,
      s.premium,
      s.volume,
      s.open_interest,
      s.signed_premium,
      s.decay_weight,
      s.side_lc,
      s.premium                                       AS contrib_total,
      CASE
        WHEN s.side_lc = 'call' THEN  s.premium
        WHEN s.side_lc = 'put'  THEN -s.premium
        ELSE 0
      END                                             AS contrib_net_signed,
      COALESCE(s.signed_premium, 0)                   AS contrib_aggdir_raw,
      COALESCE(s.signed_premium, 0) * s.decay_weight  AS contrib_aggdir_decay
    FROM signed s
  ),
  per_bucket AS (
    SELECT
      c.ticker,
      c.expiry_bucket_week,
      c.bucket_at,
      SUM(c.contrib_total)                                                   AS sum_total,
      SUM(c.contrib_net_signed)                                              AS sum_net_signed,
      SUM(c.contrib_aggdir_raw)                                              AS sum_aggdir_raw,
      SUM(c.contrib_aggdir_decay)                                            AS sum_aggdir_decay,
      SUM(COALESCE(c.volume, 0))                                             AS sum_volume,
      SUM(CASE WHEN c.open_interest IS NULL THEN 0 ELSE c.open_interest END) AS sum_oi,
      bool_and(c.open_interest IS NOT NULL)                                  AS oi_known,
      COUNT(*)::int                                                          AS n_rows
    FROM contrib c
    GROUP BY c.ticker, c.expiry_bucket_week, c.bucket_at
  ),
  resolved AS (
    SELECT
      pb.ticker,
      pb.expiry_bucket_week,
      pb.bucket_at,
      pb.n_rows,
      CASE p_math_mode
        WHEN 'total'                          THEN pb.sum_total
        WHEN 'net_signed'                     THEN pb.sum_net_signed
        WHEN 'aggressive_directional_raw'     THEN pb.sum_aggdir_raw
        WHEN 'aggressive_directional_decay'   THEN pb.sum_aggdir_decay
        WHEN 'voi_unusual' THEN
          CASE WHEN pb.oi_known AND pb.sum_oi > 0
               THEN pb.sum_volume / pb.sum_oi
               ELSE NULL END
        ELSE pb.sum_aggdir_decay
      END AS cell_value
    FROM per_bucket pb
  )
  SELECT
    r.ticker::text                                  AS ticker,
    r.expiry_bucket_week::date                      AS expiry_bucket_week,
    r.bucket_at                                     AS snapshot_at,
    r.cell_value::numeric                           AS value,
    r.n_rows::int                                   AS source_alert_count
  FROM resolved r
  ORDER BY r.ticker, r.expiry_bucket_week, r.bucket_at ASC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.ct_flow_heatmap_history(text[], timestamptz, timestamptz, text)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.ct_flow_heatmap_history(text[], timestamptz, timestamptz, text) IS
'Time-series replay of ct_flow_alerts within (p_since, p_until). Buckets ingested_at into 5-min slots for ≤7d windows, 15-min slots for >7d. Same direction logic + math modes as ct_flow_heatmap_live (inferDirection inline, RepeatedHits-on-null-flag → ask-aggressive, Friday-of-ISO-week bucketing). Decay weight anchors to each bucket''s end so each point is as-of that time. Replaces the snapshot-table read which inherited mixed-semantics 5-min vs 168h-backfill rows. Snapshot table now used only for flow-stack detector baseline.';
