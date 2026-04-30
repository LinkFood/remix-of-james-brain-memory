-- =============================================================================
-- 20260430170000_ct_flow_heatmap_live_rewrite.sql
--
-- ROOT-CAUSE FIX: ct_flow_heatmap_live and ct_flow_heatmap_diff used to scan
-- ct_flow_heatmap_snapshots, which has mixed semantics — some snapshots are
-- 5-min cron windows, some are 168h backfill rows. DISTINCT ON (ticker,
-- expiry_date) ORDER BY snapshot_at DESC always picked the latest 5-min
-- snapshot, so values appeared ~50x smaller than reality once the backfill
-- snapshots aged out. Toolbar lookback chips (24h/3d/7d/30d) only changed
-- p_max_expiry_days (display range), not the actual flow window — different
-- chips returned identical numbers.
--
-- This migration rewrites both RPCs to scan ct_flow_alerts directly within
-- now() - p_lookback_hours. Snapshots remain useful only for:
--   - ct_flow_heatmap_history (replay timeline)
--   - the flow-stack detector's baseline distribution
-- both of which stay untouched.
--
-- Direction logic mirrors ct_flow_heatmap_strikes (commit 20260430160000):
-- inline inferDirection → RepeatedHits-on-null-flag rule inverts UW's
-- bid/ask premium when alert_rule starts with 'RepeatedHits' (those are
-- accumulation; cheap OTM/0DTE buyers lift at the bid which inverts
-- total_bid_side_prem — trust the rule, not the side-aggregate).
--
-- Friday-of-week helper mirrors fridayOfWeek() in ct-heatmap-snapshot/index.ts:
--   d - (isodow - 1) + 4 = d - isodow + 5
-- ISO weekday: Mon=1..Sun=7. Sat/Sun bucket to the PRIOR Friday so weekend
-- expiries (which don't exist for options anyway) still group sanely.
--
-- Window keyed on ingested_at — UW emits NULL on executed_at for many rows
-- (per feedback_ct_flow_alerts_executed_at_null), and ingested_at is always
-- set.
-- =============================================================================

SET search_path = public, extensions;

-- Drop existing definitions so the new signatures (with p_lookback_hours)
-- replace cleanly. CREATE OR REPLACE rejects parameter-count changes.
DROP FUNCTION IF EXISTS public.ct_flow_heatmap_live(text[], text, numeric, boolean, int);
DROP FUNCTION IF EXISTS public.ct_flow_heatmap_diff(text[], timestamptz, timestamptz, text);


-- =============================================================================
-- RPC 1: ct_flow_heatmap_live
--
-- Scans ct_flow_alerts directly within now() - p_lookback_hours, computes the
-- five math modes inline, filters to the future expiry calendar, and groups
-- per (ticker, expiry_bucket_week).
-- =============================================================================
CREATE OR REPLACE FUNCTION public.ct_flow_heatmap_live(
  p_tickers          text[]   DEFAULT NULL,
  p_math_mode        text     DEFAULT 'aggressive_directional_decay',
  p_min_premium      numeric  DEFAULT 100000,
  p_include_0dte     boolean  DEFAULT false,
  p_max_expiry_days  int      DEFAULT 365,
  p_lookback_hours   int      DEFAULT 168
)
RETURNS TABLE (
  ticker                  text,
  expiry_bucket_week      date,
  expiry_count_in_bucket  int,
  value                   numeric,
  source_alert_count      int,
  contributing_alert_ids  jsonb,
  latest_snapshot_at      timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_now      timestamptz := now();
  v_since    timestamptz := now() - make_interval(hours => GREATEST(p_lookback_hours, 1));
  v_tickers  text[];
BEGIN
  -- Watchlist fallback (matches Agent A pattern)
  v_tickers := COALESCE(
    p_tickers,
    ARRAY['NVDA','AAPL','MSFT','GOOGL','AMZN','META','TSLA','QQQ','SPY','IWM']
  );

  RETURN QUERY
  WITH base AS (
    SELECT
      a.id::text                                                  AS row_id,
      a.alert_id                                                  AS alert_id,
      a.ticker                                                    AS ticker,
      a.strike                                                    AS strike,
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
      COALESCE(a.raw->>'alert_rule', '')                          AS alert_rule
    FROM public.ct_flow_alerts a
    WHERE a.ticker = ANY(v_tickers)
      AND a.ingested_at >= v_since
      AND a.expiry IS NOT NULL
      AND a.premium IS NOT NULL
      AND a.premium > 0
      AND COALESCE(lower(a.side), '') IN ('call','put')
      AND a.expiry::date >= CURRENT_DATE
      AND a.expiry::date <= CURRENT_DATE + p_max_expiry_days
      AND (p_include_0dte OR a.expiry::date > CURRENT_DATE)
  ),
  classified AS (
    -- Inline inferDirection. aggressor = 'ask' | 'bid' | NULL.
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
      END                                                            AS signed_premium,
      -- exp(-age_days / 5) recency weight
      exp(- GREATEST(0, EXTRACT(EPOCH FROM (v_now - c.ingested_at)) / 86400.0) / 5.0)
                                                                     AS decay_weight,
      -- Friday-of-ISO-week (mirrors fridayOfWeek in ct-heatmap-snapshot)
      (c.expiry_date - (extract(isodow from c.expiry_date)::int) + 5)::date
                                                                     AS expiry_bucket_week
    FROM classified c
  ),
  contrib AS (
    SELECT
      s.ticker,
      s.expiry_date,
      s.expiry_bucket_week,
      s.alert_id,
      s.premium,
      s.volume,
      s.open_interest,
      s.signed_premium,
      s.decay_weight,
      s.side_lc,
      -- Mode A: total
      s.premium                                       AS contrib_total,
      -- Mode B: net signed = calls - puts (raw, NOT direction-aware)
      CASE
        WHEN s.side_lc = 'call' THEN  s.premium
        WHEN s.side_lc = 'put'  THEN -s.premium
        ELSE 0
      END                                             AS contrib_net_signed,
      -- Mode C: ask-aggressive directional (raw)
      COALESCE(s.signed_premium, 0)                   AS contrib_aggdir_raw,
      -- Mode C': ask-aggressive directional (decay)
      COALESCE(s.signed_premium, 0) * s.decay_weight  AS contrib_aggdir_decay
    FROM signed s
  ),
  -- Aggregate per (ticker, expiry_bucket_week)
  per_bucket AS (
    SELECT
      c.ticker,
      c.expiry_bucket_week,
      COUNT(DISTINCT c.expiry_date)::int                                     AS n_expiries,
      SUM(c.contrib_total)                                                   AS sum_total,
      SUM(c.contrib_net_signed)                                              AS sum_net_signed,
      SUM(c.contrib_aggdir_raw)                                              AS sum_aggdir_raw,
      SUM(c.contrib_aggdir_decay)                                            AS sum_aggdir_decay,
      SUM(COALESCE(c.volume, 0))                                             AS sum_volume,
      SUM(CASE WHEN c.open_interest IS NULL THEN 0 ELSE c.open_interest END) AS sum_oi,
      bool_and(c.open_interest IS NOT NULL)                                  AS oi_known,
      COUNT(*)::int                                                          AS n_rows
    FROM contrib c
    GROUP BY c.ticker, c.expiry_bucket_week
  ),
  resolved AS (
    SELECT
      pb.ticker,
      pb.expiry_bucket_week,
      pb.n_expiries,
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
  ),
  filtered AS (
    SELECT r.*
    FROM resolved r
    WHERE ABS(COALESCE(r.cell_value, 0)) >= p_min_premium
  ),
  -- Top 100 contributing alert ids per surviving cell, by premium (deduped)
  top_ids AS (
    SELECT
      f.ticker,
      f.expiry_bucket_week,
      jsonb_agg(sub.alert_id ORDER BY sub.premium DESC) AS contributing_alert_ids
    FROM filtered f
    JOIN LATERAL (
      SELECT DISTINCT ON (c2.alert_id) c2.alert_id, c2.premium
      FROM contrib c2
      WHERE c2.ticker             = f.ticker
        AND c2.expiry_bucket_week = f.expiry_bucket_week
        AND c2.alert_id IS NOT NULL
      ORDER BY c2.alert_id, c2.premium DESC NULLS LAST
      LIMIT 100
    ) sub ON true
    GROUP BY f.ticker, f.expiry_bucket_week
  )
  SELECT
    f.ticker::text                                       AS ticker,
    f.expiry_bucket_week::date                           AS expiry_bucket_week,
    f.n_expiries::int                                    AS expiry_count_in_bucket,
    f.cell_value::numeric                                AS value,
    f.n_rows::int                                        AS source_alert_count,
    COALESCE(t.contributing_alert_ids, '[]'::jsonb)      AS contributing_alert_ids,
    v_now                                                AS latest_snapshot_at
  FROM filtered f
  LEFT JOIN top_ids t
    ON t.ticker             = f.ticker
   AND t.expiry_bucket_week = f.expiry_bucket_week
  ORDER BY f.ticker, f.expiry_bucket_week;
END;
$$;

GRANT EXECUTE ON FUNCTION public.ct_flow_heatmap_live(text[], text, numeric, boolean, int, int)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.ct_flow_heatmap_live(text[], text, numeric, boolean, int, int) IS
'Scans ct_flow_alerts directly within now() - p_lookback_hours and aggregates per (ticker, expiry_bucket_week). Math modes: total, net_signed, aggressive_directional_raw, aggressive_directional_decay (default), voi_unusual. p_tickers null falls back to canonical 10-ticker watchlist. p_lookback_hours default 168 (7d). The snapshot table ct_flow_heatmap_snapshots is only used for ct_flow_heatmap_history (replay) and the flow-stack detector baseline — never as the source for the live heatmap, which mixed cron-window vs backfill-window semantics and made values appear ~50x undersized.';


-- =============================================================================
-- RPC 2: ct_flow_heatmap_diff
--
-- Same scan logic as ct_flow_heatmap_live, run twice over the two windows
-- (baseline_window = (p_baseline_at - lookback, p_baseline_at), current_window
-- = (p_current_at - lookback, p_current_at)). Identical semantics on both
-- ends → delta is meaningful.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.ct_flow_heatmap_diff(
  p_tickers         text[],
  p_baseline_at     timestamptz,
  p_current_at      timestamptz,
  p_math_mode       text DEFAULT 'aggressive_directional_decay',
  p_lookback_hours  int  DEFAULT 168
)
RETURNS TABLE (
  ticker             text,
  expiry_bucket_week date,
  baseline_value     numeric,
  current_value      numeric,
  delta_value        numeric,
  delta_pct          numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_lookback_interval interval := make_interval(hours => GREATEST(p_lookback_hours, 1));
  v_baseline_since    timestamptz := p_baseline_at - v_lookback_interval;
  v_current_since     timestamptz := p_current_at  - v_lookback_interval;
BEGIN
  RETURN QUERY
  WITH base AS (
    -- Pull both windows in one pass; flag which window each row belongs to.
    -- A row may be in both windows if the windows overlap — that's fine,
    -- it's counted once per window.
    SELECT
      a.alert_id                                                  AS alert_id,
      a.ticker                                                    AS ticker,
      a.expiry::date                                              AS expiry_date,
      lower(COALESCE(a.side, ''))                                 AS side_lc,
      a.is_ask                                                    AS is_ask,
      a.is_bid                                                    AS is_bid,
      a.premium                                                   AS premium,
      a.ingested_at                                               AS ingested_at,
      NULLIF((a.raw->>'total_ask_side_prem')::text, '')::numeric  AS ask_prem,
      NULLIF((a.raw->>'total_bid_side_prem')::text, '')::numeric  AS bid_prem,
      COALESCE(a.raw->>'alert_rule', '')                          AS alert_rule,
      (a.ingested_at >= v_baseline_since AND a.ingested_at < p_baseline_at) AS in_baseline,
      (a.ingested_at >= v_current_since  AND a.ingested_at < p_current_at)  AS in_current
    FROM public.ct_flow_alerts a
    WHERE a.ticker = ANY(p_tickers)
      AND a.expiry IS NOT NULL
      AND a.premium IS NOT NULL
      AND a.premium > 0
      AND COALESCE(lower(a.side), '') IN ('call','put')
      AND a.ingested_at >= LEAST(v_baseline_since, v_current_since)
      AND a.ingested_at <  GREATEST(p_baseline_at, p_current_at)
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
      END                                                            AS signed_premium,
      (c.expiry_date - (extract(isodow from c.expiry_date)::int) + 5)::date
                                                                     AS expiry_bucket_week
    FROM classified c
  ),
  -- Per-row contribution per window per math mode.
  -- Decay weight is anchored to the window's reference timestamp:
  --   baseline rows decay against p_baseline_at
  --   current  rows decay against p_current_at
  -- so both ends use identical mathematical shape relative to their anchor.
  per_window AS (
    SELECT
      s.ticker,
      s.expiry_bucket_week,
      s.in_baseline,
      s.in_current,
      s.premium,
      s.side_lc,
      s.signed_premium,
      EXTRACT(EPOCH FROM (p_baseline_at - s.ingested_at)) / 86400.0 AS age_days_baseline,
      EXTRACT(EPOCH FROM (p_current_at  - s.ingested_at)) / 86400.0 AS age_days_current
    FROM signed s
  ),
  -- Compute each math mode's per-window aggregate. Aggregate sums for both
  -- windows are computed in the same scan via FILTER.
  per_bucket AS (
    SELECT
      pw.ticker,
      pw.expiry_bucket_week,
      -- Baseline window aggregates
      SUM(pw.premium) FILTER (WHERE pw.in_baseline)               AS baseline_total,
      SUM(CASE WHEN pw.side_lc = 'call' THEN  pw.premium
               WHEN pw.side_lc = 'put'  THEN -pw.premium
               ELSE 0 END) FILTER (WHERE pw.in_baseline)          AS baseline_net_signed,
      SUM(COALESCE(pw.signed_premium, 0)) FILTER (WHERE pw.in_baseline)
                                                                  AS baseline_aggdir_raw,
      SUM(COALESCE(pw.signed_premium, 0)
          * exp(- GREATEST(0, pw.age_days_baseline) / 5.0))
        FILTER (WHERE pw.in_baseline)                             AS baseline_aggdir_decay,
      -- Current window aggregates
      SUM(pw.premium) FILTER (WHERE pw.in_current)                AS current_total,
      SUM(CASE WHEN pw.side_lc = 'call' THEN  pw.premium
               WHEN pw.side_lc = 'put'  THEN -pw.premium
               ELSE 0 END) FILTER (WHERE pw.in_current)           AS current_net_signed,
      SUM(COALESCE(pw.signed_premium, 0)) FILTER (WHERE pw.in_current)
                                                                  AS current_aggdir_raw,
      SUM(COALESCE(pw.signed_premium, 0)
          * exp(- GREATEST(0, pw.age_days_current) / 5.0))
        FILTER (WHERE pw.in_current)                              AS current_aggdir_decay,
      -- VOI is mode-only, recompute via volume/OI sums per window
      -- (omitted for diff — VOI doesn't subtract meaningfully across windows;
      --  return NULL for both sides if math_mode = 'voi_unusual')
      NULL::numeric                                               AS baseline_voi,
      NULL::numeric                                               AS current_voi
    FROM per_window pw
    WHERE pw.in_baseline OR pw.in_current
    GROUP BY pw.ticker, pw.expiry_bucket_week
  ),
  resolved AS (
    SELECT
      pb.ticker,
      pb.expiry_bucket_week,
      CASE p_math_mode
        WHEN 'total'                          THEN pb.baseline_total
        WHEN 'net_signed'                     THEN pb.baseline_net_signed
        WHEN 'aggressive_directional_raw'     THEN pb.baseline_aggdir_raw
        WHEN 'aggressive_directional_decay'   THEN pb.baseline_aggdir_decay
        WHEN 'voi_unusual'                    THEN pb.baseline_voi
        ELSE pb.baseline_aggdir_decay
      END AS baseline_value,
      CASE p_math_mode
        WHEN 'total'                          THEN pb.current_total
        WHEN 'net_signed'                     THEN pb.current_net_signed
        WHEN 'aggressive_directional_raw'     THEN pb.current_aggdir_raw
        WHEN 'aggressive_directional_decay'   THEN pb.current_aggdir_decay
        WHEN 'voi_unusual'                    THEN pb.current_voi
        ELSE pb.current_aggdir_decay
      END AS current_value
    FROM per_bucket pb
  )
  SELECT
    r.ticker::text                                                  AS ticker,
    r.expiry_bucket_week::date                                      AS expiry_bucket_week,
    r.baseline_value::numeric                                       AS baseline_value,
    r.current_value::numeric                                        AS current_value,
    (COALESCE(r.current_value, 0) - COALESCE(r.baseline_value, 0))::numeric
                                                                    AS delta_value,
    CASE
      WHEN r.baseline_value IS NULL OR r.baseline_value = 0 THEN NULL
      ELSE ((COALESCE(r.current_value, 0) - r.baseline_value) / ABS(r.baseline_value))::numeric
    END                                                             AS delta_pct
  FROM resolved r
  WHERE r.baseline_value IS NOT NULL OR r.current_value IS NOT NULL
  ORDER BY r.ticker, r.expiry_bucket_week;
END;
$$;

GRANT EXECUTE ON FUNCTION public.ct_flow_heatmap_diff(text[], timestamptz, timestamptz, text, int)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.ct_flow_heatmap_diff(text[], timestamptz, timestamptz, text, int) IS
'Scans ct_flow_alerts directly over two windows of identical width: baseline = (p_baseline_at - p_lookback_hours, p_baseline_at), current = (p_current_at - p_lookback_hours, p_current_at). Same math + direction logic as ct_flow_heatmap_live (RepeatedHits-on-null-flag → ask-aggressive). Decay weights anchor to each window''s reference timestamp so both sides have identical mathematical shape. delta_pct null when baseline is 0 or missing. voi_unusual returns NULL for both sides — ratio-style modes don''t subtract meaningfully across windows. Snapshot table only used for ct_flow_heatmap_history and detector baseline — never here.';
