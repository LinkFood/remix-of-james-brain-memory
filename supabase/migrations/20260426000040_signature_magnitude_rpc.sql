-- ct_signature_magnitude_stats + ct_contract_threshold_distribution
--
-- Two read-only RPCs feeding the /edge contract-magnitude surface.
--
-- Why this exists: tonight's contract-axis grader gives us peak_contract_pct
-- on every tracked print — magnitude truth that the existing /edge surface
-- (built around direction hit rate) doesn't expose. These two RPCs let the UI
-- rank shapes by ACTUAL contract returns and self-audit the WIN thresholds
-- in ct_config against the empirical peak distribution.
--
-- Both functions are STABLE (no writes) and bucket on existing columns —
-- no joins to ct_signatures so we work even on prints that haven't earned
-- a promoted signature yet. Per tenet 13 (ungated signal access): rank
-- everything we have, don't filter to a curated subset.

SET search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- ct_signature_magnitude_stats
--
-- Groups ct_contract_tracks by (ticker, side, dte_bucket, predicted_source).
-- That tuple is the natural "signature shape" for contract-axis edge:
--   - aggressive_bid_call vs aggressive_ask_call distinguishes the print
--     side that triggered the alert
--   - dte_bucket separates 0DTE scalps from monthlies (different vol regimes)
--   - ticker scopes to the actual underlying (no cross-ticker pooling)
--
-- For each group it returns:
--   - n_tracks                  — sample count
--   - median / p75 / p90 peak   — magnitude distribution (decimal fraction)
--   - win_count / loss_count    — using current track_status (already graded
--                                 by the contract grader)
--   - hit_rate                  — wins / (wins+losses), nullable when both 0
--   - expected_value_pct        — mean of peak_contract_pct treating LOSSes
--                                 as -loss_threshold. Crude proxy for "what
--                                 would buying every signature in this group
--                                 have returned per dollar". Decimal fraction.
--
-- Filters out groups under p_min_n so single-print accidents don't dominate
-- the leaderboard.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ct_signature_magnitude_stats(
  p_since timestamptz DEFAULT (now() - interval '7 days'),
  p_min_n int DEFAULT 3
) RETURNS TABLE (
  signature_label text,
  ticker text,
  side text,
  dte_bucket text,
  predicted_source text,
  n_tracks int,
  median_peak_pct numeric,
  p75_peak_pct numeric,
  p90_peak_pct numeric,
  max_peak_pct numeric,
  win_count int,
  loss_count int,
  working_count int,
  hit_rate numeric,
  expected_value_pct numeric
) LANGUAGE sql STABLE AS $$
  WITH loss_thresh AS (
    SELECT COALESCE(
      (SELECT (value)::numeric FROM public.ct_config
        WHERE key = 'contract_loss_threshold_pct' LIMIT 1),
      0.50
    ) AS v
  ),
  bucketed AS (
    SELECT
      ct.ticker,
      ct.side,
      CASE
        WHEN ct.dte_at_print = 0 THEN '0dte'
        WHEN ct.dte_at_print BETWEEN 1 AND 7 THEN 'short'
        WHEN ct.dte_at_print BETWEEN 8 AND 30 THEN 'mid'
        ELSE 'long'
      END AS dte_bucket,
      ct.predicted_source,
      ct.peak_contract_pct,
      ct.track_status
    FROM public.ct_contract_tracks ct
    WHERE ct.first_tracked_at >= p_since
      AND ct.peak_contract_pct IS NOT NULL
      AND ct.dte_at_print IS NOT NULL
  ),
  grouped AS (
    SELECT
      ticker,
      side,
      dte_bucket,
      predicted_source,
      COUNT(*)::int AS n_tracks,
      percentile_cont(0.50) WITHIN GROUP (ORDER BY peak_contract_pct) AS median_peak_pct,
      percentile_cont(0.75) WITHIN GROUP (ORDER BY peak_contract_pct) AS p75_peak_pct,
      percentile_cont(0.90) WITHIN GROUP (ORDER BY peak_contract_pct) AS p90_peak_pct,
      MAX(peak_contract_pct) AS max_peak_pct,
      SUM(CASE WHEN track_status IN ('WIN', 'EXPIRED_WIN') THEN 1 ELSE 0 END)::int AS win_count,
      SUM(CASE WHEN track_status IN ('LOSS', 'EXPIRED_LOSS') THEN 1 ELSE 0 END)::int AS loss_count,
      SUM(CASE WHEN track_status = 'WORKING' THEN 1 ELSE 0 END)::int AS working_count,
      -- EV = mean(peak on wins/working) - loss_threshold * loss_count / total
      -- Cleaner: average of [peak_contract_pct on non-LOSS, -loss_thresh on LOSS]
      AVG(
        CASE
          WHEN track_status IN ('LOSS', 'EXPIRED_LOSS') THEN -((SELECT v FROM loss_thresh))
          ELSE peak_contract_pct
        END
      ) AS expected_value_pct
    FROM bucketed
    GROUP BY ticker, side, dte_bucket, predicted_source
    HAVING COUNT(*) >= p_min_n
  )
  SELECT
    -- signature_label is a human-readable composite — same shape as
    -- ct_signatures.signature_key but built from contract-track columns.
    -- E.g. "qqq:call:short:aggressive_bid_call"
    LOWER(ticker) || ':' || side || ':' || dte_bucket || ':' || predicted_source AS signature_label,
    ticker,
    side,
    dte_bucket,
    predicted_source,
    n_tracks,
    median_peak_pct,
    p75_peak_pct,
    p90_peak_pct,
    max_peak_pct,
    win_count,
    loss_count,
    working_count,
    CASE
      WHEN (win_count + loss_count) = 0 THEN NULL
      ELSE win_count::numeric / (win_count + loss_count)::numeric
    END AS hit_rate,
    expected_value_pct
  FROM grouped
  ORDER BY expected_value_pct DESC NULLS LAST, n_tracks DESC;
$$;

GRANT EXECUTE ON FUNCTION public.ct_signature_magnitude_stats(timestamptz, int)
  TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.ct_signature_magnitude_stats(timestamptz, int) IS
  'Magnitude-axis ranking of contract-track signatures (ticker × side × dte_bucket × predicted_source). Returns median/p75/p90 peak %, win/loss/working counts, hit rate, and a crude expected-value-per-dollar metric. Sorted by EV desc. Read-only — feeds /edge SignatureMagnitude section.';


-- ---------------------------------------------------------------------------
-- ct_contract_threshold_distribution
--
-- Per DTE bucket: actual peak distribution + the WIN threshold currently in
-- ct_config + recommended thresholds at P60 / P75 of observed peaks.
--
-- Use this to answer "is the 0DTE 50% threshold tight or loose given what
-- the contracts actually did over the last week?" If only 5% of 0DTE peaks
-- cleared 50%, the threshold is too tight — almost nothing grades WIN. If
-- 80% cleared it, the threshold is too loose — WIN means nothing.
--
-- recommended_p60 = the threshold that would catch the top 40% of tracks
--   in the bucket (i.e. set the bar where empirically 40% of signatures
--   hit it). Same idea for p75.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ct_contract_threshold_distribution(
  p_since timestamptz DEFAULT (now() - interval '7 days')
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
) LANGUAGE sql STABLE AS $$
  WITH thresholds AS (
    SELECT
      key,
      (value)::numeric AS v
    FROM public.ct_config
    WHERE key IN (
      'contract_grade_threshold_0dte',
      'contract_grade_threshold_short',
      'contract_grade_threshold_mid',
      'contract_grade_threshold_long'
    )
  ),
  bucket_thresh AS (
    SELECT '0dte' AS bucket, 1 AS bucket_order,
      COALESCE((SELECT v FROM thresholds WHERE key = 'contract_grade_threshold_0dte'), 0.50) AS thr
    UNION ALL
    SELECT 'short', 2,
      COALESCE((SELECT v FROM thresholds WHERE key = 'contract_grade_threshold_short'), 0.50)
    UNION ALL
    SELECT 'mid', 3,
      COALESCE((SELECT v FROM thresholds WHERE key = 'contract_grade_threshold_mid'), 1.00)
    UNION ALL
    SELECT 'long', 4,
      COALESCE((SELECT v FROM thresholds WHERE key = 'contract_grade_threshold_long'), 2.00)
  ),
  bucketed AS (
    SELECT
      CASE
        WHEN ct.dte_at_print = 0 THEN '0dte'
        WHEN ct.dte_at_print BETWEEN 1 AND 7 THEN 'short'
        WHEN ct.dte_at_print BETWEEN 8 AND 30 THEN 'mid'
        ELSE 'long'
      END AS bucket,
      ct.peak_contract_pct
    FROM public.ct_contract_tracks ct
    WHERE ct.first_tracked_at >= p_since
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
      -- "set the bar so 40% of tracks clear it" → 60th percentile.
      percentile_cont(0.60) WITHIN GROUP (ORDER BY peak_contract_pct) AS recommended_p60_pct,
      -- "set the bar so 25% of tracks clear it" → 75th percentile.
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
$$;

GRANT EXECUTE ON FUNCTION public.ct_contract_threshold_distribution(timestamptz)
  TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.ct_contract_threshold_distribution(timestamptz) IS
  'Per-DTE-bucket actual peak distribution vs current ct_config WIN threshold. Returns p50/p75/p90, % of tracks crossing the bar, and recommended p60/p75 calibration values. Read-only — feeds /edge ThresholdCalibration panel.';
