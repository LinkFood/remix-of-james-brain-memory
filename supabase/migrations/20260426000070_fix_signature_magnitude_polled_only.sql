-- Fix ct_signature_magnitude_stats: exclude never-polled tracks from median
-- Without this filter, ~70% of recent tracks (peak=0, sweep_count=0) dominate
-- the median → all signatures look like 0% even when WINs include +539%.
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
      ct.ticker, ct.side,
      CASE
        WHEN ct.dte_at_print = 0 THEN '0dte'
        WHEN ct.dte_at_print BETWEEN 1 AND 7 THEN 'short'
        WHEN ct.dte_at_print BETWEEN 8 AND 30 THEN 'mid'
        ELSE 'long'
      END AS dte_bucket,
      ct.predicted_source, ct.peak_contract_pct, ct.track_status
    FROM public.ct_contract_tracks ct
    WHERE ct.first_tracked_at >= p_since
      AND ct.peak_contract_pct IS NOT NULL
      AND ct.dte_at_print IS NOT NULL
      AND ct.sweep_count > 0
  ),
  grouped AS (
    SELECT
      ticker, side, dte_bucket, predicted_source,
      COUNT(*)::int AS n_tracks,
      percentile_cont(0.50) WITHIN GROUP (ORDER BY peak_contract_pct) AS median_peak_pct,
      percentile_cont(0.75) WITHIN GROUP (ORDER BY peak_contract_pct) AS p75_peak_pct,
      percentile_cont(0.90) WITHIN GROUP (ORDER BY peak_contract_pct) AS p90_peak_pct,
      MAX(peak_contract_pct) AS max_peak_pct,
      SUM(CASE WHEN track_status IN ('WIN','EXPIRED_WIN') THEN 1 ELSE 0 END)::int AS win_count,
      SUM(CASE WHEN track_status IN ('LOSS','EXPIRED_LOSS') THEN 1 ELSE 0 END)::int AS loss_count,
      SUM(CASE WHEN track_status = 'WORKING' THEN 1 ELSE 0 END)::int AS working_count,
      AVG(CASE WHEN track_status IN ('LOSS','EXPIRED_LOSS')
               THEN -((SELECT v FROM loss_thresh))
               ELSE peak_contract_pct END) AS expected_value_pct
    FROM bucketed
    GROUP BY ticker, side, dte_bucket, predicted_source
  )
  SELECT
    ticker || ':' || side || ':' || dte_bucket || ':' || predicted_source AS signature_label,
    ticker, side, dte_bucket, predicted_source,
    n_tracks, median_peak_pct, p75_peak_pct, p90_peak_pct, max_peak_pct,
    win_count, loss_count, working_count,
    CASE WHEN (win_count + loss_count) > 0
         THEN win_count::numeric / (win_count + loss_count) ELSE NULL END AS hit_rate,
    expected_value_pct
  FROM grouped
  WHERE n_tracks >= p_min_n
  ORDER BY median_peak_pct DESC NULLS LAST, n_tracks DESC;
$$;
