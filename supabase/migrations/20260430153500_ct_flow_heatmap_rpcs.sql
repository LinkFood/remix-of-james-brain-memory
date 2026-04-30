-- ct_flow_heatmap RPCs: live, history, diff
-- Reads from ct_flow_heatmap_snapshots (Agent A schema)
-- Math modes: total | net_signed | aggressive_directional_raw | aggressive_directional_decay (default) | voi_unusual

-- =============================================================================
-- RPC 1: ct_flow_heatmap_live
-- Latest snapshot per (ticker, expiry_date), aggregated to expiry_bucket_week
-- =============================================================================
CREATE OR REPLACE FUNCTION public.ct_flow_heatmap_live(
  p_tickers text[] DEFAULT NULL,
  p_math_mode text DEFAULT 'aggressive_directional_decay',
  p_min_premium numeric DEFAULT 100000,
  p_include_0dte boolean DEFAULT false,
  p_max_expiry_days int DEFAULT 365
)
RETURNS TABLE (
  ticker text,
  expiry_bucket_week date,
  expiry_count_in_bucket int,
  value numeric,
  source_alert_count int,
  contributing_alert_ids jsonb,
  latest_snapshot_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_tickers text[];
BEGIN
  -- Watchlist fallback (matches Agent A pattern)
  v_tickers := COALESCE(
    p_tickers,
    ARRAY['NVDA','AAPL','MSFT','GOOGL','AMZN','META','TSLA','QQQ','SPY','IWM']
  );

  RETURN QUERY
  WITH latest_per_expiry AS (
    SELECT DISTINCT ON (s.ticker, s.expiry_date)
      s.ticker,
      s.expiry_date,
      s.expiry_bucket_week,
      s.total_premium,
      s.net_signed_premium,
      s.aggressive_directional_premium_raw,
      s.aggressive_directional_premium_decay,
      s.voi_unusual_score,
      s.contributing_alert_ids,
      s.source_alert_count,
      s.snapshot_at
    FROM public.ct_flow_heatmap_snapshots s
    WHERE s.ticker = ANY(v_tickers)
      AND s.expiry_date >= CURRENT_DATE
      AND s.expiry_date <= CURRENT_DATE + p_max_expiry_days
      AND (p_include_0dte OR s.expiry_date > CURRENT_DATE)
    ORDER BY s.ticker, s.expiry_date, s.snapshot_at DESC
  ),
  resolved AS (
    SELECT
      l.ticker,
      l.expiry_date,
      l.expiry_bucket_week,
      CASE p_math_mode
        WHEN 'total' THEN l.total_premium
        WHEN 'net_signed' THEN l.net_signed_premium
        WHEN 'aggressive_directional_raw' THEN l.aggressive_directional_premium_raw
        WHEN 'aggressive_directional_decay' THEN l.aggressive_directional_premium_decay
        WHEN 'voi_unusual' THEN l.voi_unusual_score
        ELSE l.aggressive_directional_premium_decay
      END AS value,
      l.contributing_alert_ids,
      l.source_alert_count,
      l.snapshot_at
    FROM latest_per_expiry l
  ),
  filtered AS (
    SELECT *
    FROM resolved r
    WHERE ABS(COALESCE(r.value, 0)) >= p_min_premium
  ),
  exploded_ids AS (
    -- Explode contributing_alert_ids per (ticker, week) so we can dedupe + cap
    SELECT
      f.ticker,
      f.expiry_bucket_week,
      jsonb_array_elements(COALESCE(f.contributing_alert_ids, '[]'::jsonb)) AS alert_id
    FROM filtered f
  ),
  deduped_ids AS (
    SELECT
      e.ticker,
      e.expiry_bucket_week,
      jsonb_agg(DISTINCT e.alert_id) AS dedup_ids_full
    FROM exploded_ids e
    GROUP BY e.ticker, e.expiry_bucket_week
  ),
  capped_ids AS (
    SELECT
      d.ticker,
      d.expiry_bucket_week,
      CASE
        WHEN jsonb_array_length(d.dedup_ids_full) > 100
        THEN (SELECT jsonb_agg(elem) FROM (SELECT elem FROM jsonb_array_elements(d.dedup_ids_full) elem LIMIT 100) sub)
        ELSE d.dedup_ids_full
      END AS dedup_ids
    FROM deduped_ids d
  )
  SELECT
    f.ticker,
    f.expiry_bucket_week,
    COUNT(DISTINCT f.expiry_date)::int AS expiry_count_in_bucket,
    SUM(f.value)::numeric AS value,
    SUM(f.source_alert_count)::int AS source_alert_count,
    COALESCE(c.dedup_ids, '[]'::jsonb) AS contributing_alert_ids,
    MAX(f.snapshot_at) AS latest_snapshot_at
  FROM filtered f
  LEFT JOIN capped_ids c
    ON c.ticker = f.ticker AND c.expiry_bucket_week = f.expiry_bucket_week
  GROUP BY f.ticker, f.expiry_bucket_week, c.dedup_ids
  ORDER BY f.ticker, f.expiry_bucket_week;
END;
$$;

GRANT EXECUTE ON FUNCTION public.ct_flow_heatmap_live(text[], text, numeric, boolean, int) TO authenticated, service_role;

COMMENT ON FUNCTION public.ct_flow_heatmap_live(text[], text, numeric, boolean, int) IS
'Latest flow-heatmap snapshot per (ticker, expiry_date), filtered + aggregated to expiry_bucket_week. Math modes: total, net_signed, aggressive_directional_raw, aggressive_directional_decay (default), voi_unusual. p_tickers null falls back to canonical 10-ticker watchlist.';


-- =============================================================================
-- RPC 2: ct_flow_heatmap_history
-- All snapshots in window, aggregated per (ticker, expiry_bucket_week, snapshot_at)
-- =============================================================================
CREATE OR REPLACE FUNCTION public.ct_flow_heatmap_history(
  p_tickers text[],
  p_since timestamptz,
  p_until timestamptz,
  p_math_mode text DEFAULT 'aggressive_directional_decay'
)
RETURNS TABLE (
  ticker text,
  expiry_bucket_week date,
  snapshot_at timestamptz,
  value numeric,
  source_alert_count int
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  RETURN QUERY
  WITH resolved AS (
    SELECT
      s.ticker,
      s.expiry_bucket_week,
      s.snapshot_at,
      s.source_alert_count,
      CASE p_math_mode
        WHEN 'total' THEN s.total_premium
        WHEN 'net_signed' THEN s.net_signed_premium
        WHEN 'aggressive_directional_raw' THEN s.aggressive_directional_premium_raw
        WHEN 'aggressive_directional_decay' THEN s.aggressive_directional_premium_decay
        WHEN 'voi_unusual' THEN s.voi_unusual_score
        ELSE s.aggressive_directional_premium_decay
      END AS value
    FROM public.ct_flow_heatmap_snapshots s
    WHERE s.ticker = ANY(p_tickers)
      AND s.snapshot_at >= p_since
      AND s.snapshot_at <= p_until
  )
  SELECT
    r.ticker,
    r.expiry_bucket_week,
    r.snapshot_at,
    SUM(r.value)::numeric AS value,
    SUM(r.source_alert_count)::int AS source_alert_count
  FROM resolved r
  GROUP BY r.ticker, r.expiry_bucket_week, r.snapshot_at
  ORDER BY r.ticker, r.expiry_bucket_week, r.snapshot_at ASC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.ct_flow_heatmap_history(text[], timestamptz, timestamptz, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.ct_flow_heatmap_history(text[], timestamptz, timestamptz, text) IS
'All flow-heatmap snapshots in [p_since, p_until], aggregated per (ticker, expiry_bucket_week, snapshot_at). Returns time-series suitable for replay or trend rendering.';


-- =============================================================================
-- RPC 3: ct_flow_heatmap_diff
-- Snap to nearest snapshot <= each input timestamp, FULL OUTER JOIN per bucket
-- =============================================================================
CREATE OR REPLACE FUNCTION public.ct_flow_heatmap_diff(
  p_tickers text[],
  p_baseline_at timestamptz,
  p_current_at timestamptz,
  p_math_mode text DEFAULT 'aggressive_directional_decay'
)
RETURNS TABLE (
  ticker text,
  expiry_bucket_week date,
  baseline_value numeric,
  current_value numeric,
  delta_value numeric,
  delta_pct numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  RETURN QUERY
  WITH baseline_latest AS (
    -- Per (ticker, expiry_date), the most recent snapshot at or before p_baseline_at
    SELECT DISTINCT ON (s.ticker, s.expiry_date)
      s.ticker,
      s.expiry_date,
      s.expiry_bucket_week,
      s.total_premium,
      s.net_signed_premium,
      s.aggressive_directional_premium_raw,
      s.aggressive_directional_premium_decay,
      s.voi_unusual_score
    FROM public.ct_flow_heatmap_snapshots s
    WHERE s.ticker = ANY(p_tickers)
      AND s.snapshot_at <= p_baseline_at
    ORDER BY s.ticker, s.expiry_date, s.snapshot_at DESC
  ),
  current_latest AS (
    SELECT DISTINCT ON (s.ticker, s.expiry_date)
      s.ticker,
      s.expiry_date,
      s.expiry_bucket_week,
      s.total_premium,
      s.net_signed_premium,
      s.aggressive_directional_premium_raw,
      s.aggressive_directional_premium_decay,
      s.voi_unusual_score
    FROM public.ct_flow_heatmap_snapshots s
    WHERE s.ticker = ANY(p_tickers)
      AND s.snapshot_at <= p_current_at
    ORDER BY s.ticker, s.expiry_date, s.snapshot_at DESC
  ),
  baseline_resolved AS (
    SELECT
      b.ticker,
      b.expiry_bucket_week,
      CASE p_math_mode
        WHEN 'total' THEN b.total_premium
        WHEN 'net_signed' THEN b.net_signed_premium
        WHEN 'aggressive_directional_raw' THEN b.aggressive_directional_premium_raw
        WHEN 'aggressive_directional_decay' THEN b.aggressive_directional_premium_decay
        WHEN 'voi_unusual' THEN b.voi_unusual_score
        ELSE b.aggressive_directional_premium_decay
      END AS value
    FROM baseline_latest b
  ),
  current_resolved AS (
    SELECT
      c.ticker,
      c.expiry_bucket_week,
      CASE p_math_mode
        WHEN 'total' THEN c.total_premium
        WHEN 'net_signed' THEN c.net_signed_premium
        WHEN 'aggressive_directional_raw' THEN c.aggressive_directional_premium_raw
        WHEN 'aggressive_directional_decay' THEN c.aggressive_directional_premium_decay
        WHEN 'voi_unusual' THEN c.voi_unusual_score
        ELSE c.aggressive_directional_premium_decay
      END AS value
    FROM current_latest c
  ),
  baseline_agg AS (
    SELECT
      b.ticker,
      b.expiry_bucket_week,
      SUM(b.value)::numeric AS value
    FROM baseline_resolved b
    GROUP BY b.ticker, b.expiry_bucket_week
  ),
  current_agg AS (
    SELECT
      c.ticker,
      c.expiry_bucket_week,
      SUM(c.value)::numeric AS value
    FROM current_resolved c
    GROUP BY c.ticker, c.expiry_bucket_week
  )
  SELECT
    COALESCE(b.ticker, c.ticker) AS ticker,
    COALESCE(b.expiry_bucket_week, c.expiry_bucket_week) AS expiry_bucket_week,
    b.value AS baseline_value,
    c.value AS current_value,
    (COALESCE(c.value, 0) - COALESCE(b.value, 0))::numeric AS delta_value,
    CASE
      WHEN b.value IS NULL OR b.value = 0 THEN NULL
      ELSE ((COALESCE(c.value, 0) - b.value) / ABS(b.value))::numeric
    END AS delta_pct
  FROM baseline_agg b
  FULL OUTER JOIN current_agg c
    ON b.ticker = c.ticker AND b.expiry_bucket_week = c.expiry_bucket_week
  ORDER BY ticker, expiry_bucket_week;
END;
$$;

GRANT EXECUTE ON FUNCTION public.ct_flow_heatmap_diff(text[], timestamptz, timestamptz, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.ct_flow_heatmap_diff(text[], timestamptz, timestamptz, text) IS
'Diff between two timestamps. Snaps to nearest snapshot <= each input per (ticker, expiry_date). FULL OUTER JOIN ensures buckets present only on one side appear with NULL on the missing side. delta_pct null when baseline is 0 or missing.';
