-- Ship 1 (v2) — ct_contract_threshold_distribution(p_window_days int) 5-bucket overload.
--
-- Companion to grader threshold recalibration (20260514191932). The prior
-- 4-bucket RPC (0dte / short=1-7 / mid=8-30 / long=31+) folds the 1_3d high-vol
-- scalp regime together with the 4_14d swing regime, which masks per-bucket
-- drift in the grader's actual decision shape. This migration adds a new
-- signature `(p_window_days int)` returning the grader's 5-bucket shape
-- (0dte / 1_3d / 4_14d / 15_45d / 46d_plus) and reads the win bar straight
-- from the per-bucket grader.alarm_win_pct.* config keys.
--
-- Backward-compat: the original `(p_since timestamptz DEFAULT ...)` overload
-- stays in place untouched — existing /edge surface keeps working. New
-- consumers (notably the threshold_calibration_drift_detector warden invariant
-- in migration 20260514191934) call the 5-bucket overload via
-- ct_contract_threshold_distribution(p_window_days => 7).
--
-- CREATE OR REPLACE FUNCTION is signature-scoped (see
-- feedback_create_or_replace_overload_orphan.md). This migration ADDS an
-- overload — not a DROP+CREATE — so PostgREST won't PGRST203 on the existing
-- `(p_since timestamptz)` callers.
--
-- Unit reconciliation: ct_config grader.alarm_win_pct.* is stored as percent-int
-- (e.g. 13 means 13pct). peak_contract_pct is stored as decimal fraction
-- (e.g. 0.13 means 13pct). This RPC reports current_threshold_pct as decimal
-- (configured percent-int divided by 100) so consumers can compare like-for-like
-- against the percentile_cont outputs.

SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION public.ct_contract_threshold_distribution(
  p_window_days int
) RETURNS TABLE (
  dte_bucket text,
  bucket_order int,
  n_tracks int,
  current_threshold_pct numeric,
  median_peak_pct numeric,
  p75_peak_pct numeric,
  p90_peak_pct numeric,
  max_peak_pct numeric,
  n_above_threshold int,
  pct_above_threshold numeric,
  recommended_p60_pct numeric,
  recommended_p75_pct numeric
) LANGUAGE sql STABLE AS $fn$
  WITH win_cfg AS (
    SELECT
      key,
      ((value)::text)::numeric AS pct_int
    FROM public.ct_config
    WHERE category = 'grader'
      AND key IN (
        'grader.alarm_win_pct.0dte',
        'grader.alarm_win_pct.1_3d',
        'grader.alarm_win_pct.4_14d',
        'grader.alarm_win_pct.15_45d',
        'grader.alarm_win_pct.46d_plus'
      )
  ),
  bucket_thresh AS (
    SELECT '0dte' AS bucket, 1 AS bucket_order,
      COALESCE(
        (SELECT pct_int / 100.0 FROM win_cfg WHERE key = 'grader.alarm_win_pct.0dte'),
        0.13
      ) AS thr
    UNION ALL
    SELECT '1_3d', 2,
      COALESCE(
        (SELECT pct_int / 100.0 FROM win_cfg WHERE key = 'grader.alarm_win_pct.1_3d'),
        0.10
      )
    UNION ALL
    SELECT '4_14d', 3,
      COALESCE(
        (SELECT pct_int / 100.0 FROM win_cfg WHERE key = 'grader.alarm_win_pct.4_14d'),
        0.05
      )
    UNION ALL
    SELECT '15_45d', 4,
      COALESCE(
        (SELECT pct_int / 100.0 FROM win_cfg WHERE key = 'grader.alarm_win_pct.15_45d'),
        0.05
      )
    UNION ALL
    SELECT '46d_plus', 5,
      COALESCE(
        (SELECT pct_int / 100.0 FROM win_cfg WHERE key = 'grader.alarm_win_pct.46d_plus'),
        0.05
      )
  ),
  bucketed AS (
    SELECT
      CASE
        WHEN ct.dte_at_print = 0 THEN '0dte'
        WHEN ct.dte_at_print BETWEEN 1 AND 3 THEN '1_3d'
        WHEN ct.dte_at_print BETWEEN 4 AND 14 THEN '4_14d'
        WHEN ct.dte_at_print BETWEEN 15 AND 45 THEN '15_45d'
        ELSE '46d_plus'
      END AS bucket,
      ct.peak_contract_pct
    FROM public.ct_contract_tracks ct
    WHERE ct.first_tracked_at >= now() - make_interval(days => GREATEST(p_window_days, 1))
      AND ct.peak_contract_pct IS NOT NULL
      AND ct.dte_at_print IS NOT NULL
  ),
  agg AS (
    SELECT
      bucket,
      COUNT(*)::int AS n_tracks,
      percentile_cont(0.50) WITHIN GROUP (ORDER BY peak_contract_pct) AS median_peak_pct,
      percentile_cont(0.75) WITHIN GROUP (ORDER BY peak_contract_pct) AS p75_peak_pct,
      percentile_cont(0.90) WITHIN GROUP (ORDER BY peak_contract_pct) AS p90_peak_pct,
      MAX(peak_contract_pct) AS max_peak_pct,
      percentile_cont(0.60) WITHIN GROUP (ORDER BY peak_contract_pct) AS recommended_p60_pct,
      percentile_cont(0.75) WITHIN GROUP (ORDER BY peak_contract_pct) AS recommended_p75_pct
    FROM bucketed
    GROUP BY bucket
  ),
  above AS (
    SELECT
      b.bucket,
      SUM(CASE WHEN b.peak_contract_pct >= bt.thr THEN 1 ELSE 0 END)::int AS n_above
    FROM bucketed b
    JOIN bucket_thresh bt ON bt.bucket = b.bucket
    GROUP BY b.bucket
  )
  SELECT
    bt.bucket AS dte_bucket,
    bt.bucket_order,
    COALESCE(a.n_tracks, 0) AS n_tracks,
    bt.thr AS current_threshold_pct,
    a.median_peak_pct,
    a.p75_peak_pct,
    a.p90_peak_pct,
    a.max_peak_pct,
    COALESCE(ab.n_above, 0) AS n_above_threshold,
    CASE
      WHEN COALESCE(a.n_tracks, 0) = 0 THEN NULL
      ELSE COALESCE(ab.n_above, 0)::numeric / a.n_tracks::numeric
    END AS pct_above_threshold,
    a.recommended_p60_pct,
    a.recommended_p75_pct
  FROM bucket_thresh bt
  LEFT JOIN agg a ON a.bucket = bt.bucket
  LEFT JOIN above ab ON ab.bucket = bt.bucket
  ORDER BY bt.bucket_order;
$fn$;

GRANT EXECUTE ON FUNCTION public.ct_contract_threshold_distribution(int)
  TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.ct_contract_threshold_distribution(int) IS
  '5-bucket-canonical (Ship 1, 2026-05-14) per-DTE-bucket actual peak distribution vs live ct_config grader.alarm_win_pct.* thresholds. Buckets match the production grader shape: 0dte / 1_3d / 4_14d / 15_45d / 46d_plus. p_window_days = lookback for first_tracked_at filter. current_threshold_pct is reported in decimal fraction (config percent-int / 100) so it compares like-for-like against peak_contract_pct percentiles. Backward-compat sibling overload (p_since timestamptz) still returns the 4-bucket shape.';
