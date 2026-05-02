-- find_anomalies needs VOLATILE because it creates a temp table.
-- Original migration marked it STABLE -> "CREATE TABLE is not allowed in a non-volatile function".

CREATE OR REPLACE FUNCTION public.find_anomalies(
  p_min_n               int     DEFAULT 20,
  p_deviation_threshold numeric DEFAULT 0.15,
  p_window_days         int     DEFAULT 30
)
RETURNS TABLE (
  dimension_name           text,
  dimension_value          text,
  n                        bigint,
  settled_n                bigint,
  hit_rate_blended         numeric,
  baseline_blended         numeric,
  baseline_delta           numeric,
  abs_baseline_delta       numeric,
  hit_rate_4h              numeric,
  hit_rate_1d              numeric,
  hit_rate_3d              numeric,
  context                  jsonb
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  dims text[] := ARRAY[
    'instrument','side','direction',
    'time_of_day_bucket','dte_bucket','premium_bucket','aggressor',
    'regime','day_of_week','detector_id'
  ];
  d text;
  baseline_blended_v numeric;
BEGIN
  SELECT AVG(CASE WHEN blended_verdict = 'win' THEN 1.0
                  WHEN blended_verdict = 'partial' THEN 0.5
                  WHEN blended_verdict = 'loss' THEN 0.0 END)
  INTO baseline_blended_v
  FROM public.ct_flag_analysis_corpus
  WHERE fire_ts >= now() - make_interval(days => p_window_days);

  CREATE TEMP TABLE _anomalies (
    dimension_name      text,
    dimension_value     text,
    n                   bigint,
    settled_n           bigint,
    hit_rate_blended    numeric,
    hit_rate_4h         numeric,
    hit_rate_1d         numeric,
    hit_rate_3d         numeric
  ) ON COMMIT DROP;

  FOREACH d IN ARRAY dims LOOP
    EXECUTE format($SQL$
      INSERT INTO _anomalies (dimension_name, dimension_value, n, settled_n,
        hit_rate_blended, hit_rate_4h, hit_rate_1d, hit_rate_3d)
      SELECT
        %L,
        COALESCE((%I)::text, '<null>'),
        count(*),
        count(*) FILTER (WHERE blended_verdict IN ('win','loss','partial')),
        AVG(CASE WHEN blended_verdict = 'win' THEN 1.0
                 WHEN blended_verdict = 'partial' THEN 0.5
                 WHEN blended_verdict = 'loss' THEN 0.0 END),
        AVG(CASE WHEN underlying_outcome_4h = 'win' THEN 1.0
                 WHEN underlying_outcome_4h = 'partial' THEN 0.5
                 WHEN underlying_outcome_4h = 'loss' THEN 0.0 END),
        AVG(CASE WHEN underlying_outcome_1d = 'win' THEN 1.0
                 WHEN underlying_outcome_1d = 'partial' THEN 0.5
                 WHEN underlying_outcome_1d = 'loss' THEN 0.0 END),
        AVG(CASE WHEN underlying_outcome_3d = 'win' THEN 1.0
                 WHEN underlying_outcome_3d = 'partial' THEN 0.5
                 WHEN underlying_outcome_3d = 'loss' THEN 0.0 END)
      FROM public.ct_flag_analysis_corpus
      WHERE fire_ts >= now() - make_interval(days => %s)
      GROUP BY 2
    $SQL$, d, d, p_window_days);
  END LOOP;

  RETURN QUERY
  SELECT
    a.dimension_name,
    a.dimension_value,
    a.n,
    a.settled_n,
    ROUND(a.hit_rate_blended, 4)               AS hit_rate_blended,
    ROUND(baseline_blended_v, 4)               AS baseline_blended,
    ROUND(a.hit_rate_blended - baseline_blended_v, 4) AS baseline_delta,
    ROUND(ABS(a.hit_rate_blended - baseline_blended_v), 4) AS abs_baseline_delta,
    ROUND(a.hit_rate_4h, 4),
    ROUND(a.hit_rate_1d, 4),
    ROUND(a.hit_rate_3d, 4),
    jsonb_build_object(
      'window_days', p_window_days,
      'min_n_threshold', p_min_n,
      'deviation_threshold', p_deviation_threshold
    )
  FROM _anomalies a
  WHERE a.settled_n >= p_min_n
    AND ABS(a.hit_rate_blended - baseline_blended_v) >= p_deviation_threshold
  ORDER BY ABS(a.hit_rate_blended - baseline_blended_v) DESC
  LIMIT 20;
END;
$$;

REVOKE ALL ON FUNCTION public.find_anomalies(int, numeric, int) FROM public;
GRANT EXECUTE ON FUNCTION public.find_anomalies(int, numeric, int) TO service_role, anon, authenticated;
