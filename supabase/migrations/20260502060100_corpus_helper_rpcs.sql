-- Forensic post-op helper RPCs over ct_flag_analysis_corpus.
--
-- Hit-rate convention (per-axis, computed against settled rows only):
--   strict   = wins / (wins + losses + partials)
--   weighted = (wins + 0.5 * partials) / (wins + losses + partials)
--   "pending" and NULL are excluded from settled count
-- The "hit_rate" field returned by these helpers is the WEIGHTED hit rate.
-- Both strict and weighted are returned in the per-axis jsonb.

------------------------------------------------------------
-- corpus_baseline(p_window_days)
------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.corpus_baseline(p_window_days int DEFAULT 30)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
WITH win AS (
  SELECT *
  FROM public.ct_flag_analysis_corpus
  WHERE fire_ts >= now() - make_interval(days => p_window_days)
),
axis_stats AS (
  SELECT
    'blended'         AS axis, blended_verdict          AS verdict, count(*) n FROM win GROUP BY 1,2
  UNION ALL
  SELECT 'premium',           premium_axis_outcome,        count(*) FROM win GROUP BY 1,2
  UNION ALL
  SELECT 'underlying_4h',     underlying_outcome_4h,       count(*) FROM win GROUP BY 1,2
  UNION ALL
  SELECT 'underlying_1d',     underlying_outcome_1d,       count(*) FROM win GROUP BY 1,2
  UNION ALL
  SELECT 'underlying_3d',     underlying_outcome_3d,       count(*) FROM win GROUP BY 1,2
),
axis_rolled AS (
  SELECT
    axis,
    SUM(CASE WHEN verdict = 'win'     THEN n ELSE 0 END) AS wins,
    SUM(CASE WHEN verdict = 'loss'    THEN n ELSE 0 END) AS losses,
    SUM(CASE WHEN verdict = 'partial' THEN n ELSE 0 END) AS partials,
    SUM(CASE WHEN verdict = 'pending' THEN n ELSE 0 END) AS pending,
    SUM(CASE WHEN verdict IS NULL     THEN n ELSE 0 END) AS ungraded
  FROM axis_stats
  GROUP BY axis
),
axis_jsonb AS (
  SELECT jsonb_object_agg(
    axis,
    jsonb_build_object(
      'wins',     wins,
      'losses',   losses,
      'partials', partials,
      'pending',  pending,
      'ungraded', ungraded,
      'settled_n', wins + losses + partials,
      'hit_rate_strict',
        CASE WHEN (wins + losses + partials) > 0
             THEN ROUND(wins::numeric / (wins + losses + partials), 4)
             ELSE NULL END,
      'hit_rate_weighted',
        CASE WHEN (wins + losses + partials) > 0
             THEN ROUND((wins + 0.5 * partials)::numeric / (wins + losses + partials), 4)
             ELSE NULL END
    )
  ) AS axes
  FROM axis_rolled
),
by_ticker AS (
  SELECT jsonb_agg(jsonb_build_object('instrument', instrument, 'n', n) ORDER BY n DESC) AS rows
  FROM (SELECT instrument, count(*) n FROM win GROUP BY 1) s
),
by_detector AS (
  SELECT jsonb_agg(jsonb_build_object('detector_id', detector_id, 'n', n) ORDER BY n DESC) AS rows
  FROM (SELECT detector_id, count(*) n FROM win GROUP BY 1) s
),
by_regime AS (
  SELECT jsonb_agg(jsonb_build_object('regime', regime, 'n', n) ORDER BY n DESC) AS rows
  FROM (SELECT regime, count(*) n FROM win GROUP BY 1) s
),
by_dte AS (
  SELECT jsonb_agg(jsonb_build_object('dte_bucket', dte_bucket, 'n', n) ORDER BY n DESC) AS rows
  FROM (SELECT dte_bucket, count(*) n FROM win GROUP BY 1) s
),
by_premium AS (
  SELECT jsonb_agg(jsonb_build_object('premium_bucket', premium_bucket, 'n', n) ORDER BY n DESC) AS rows
  FROM (SELECT premium_bucket, count(*) n FROM win GROUP BY 1) s
),
totals AS (
  SELECT
    count(*)                                                        AS total_flags,
    count(*) FILTER (WHERE blended_verdict IS NOT NULL)             AS total_with_grade_row,
    count(*) FILTER (WHERE blended_verdict IN ('win','loss','partial')) AS total_settled,
    count(*) FILTER (WHERE blended_verdict = 'pending')             AS total_pending
  FROM win
)
SELECT jsonb_build_object(
  'window_days',          p_window_days,
  'window_start',         now() - make_interval(days => p_window_days),
  'window_end',           now(),
  'total_flags',          (SELECT total_flags FROM totals),
  'total_with_grade_row', (SELECT total_with_grade_row FROM totals),
  'total_settled',        (SELECT total_settled FROM totals),
  'total_pending',        (SELECT total_pending FROM totals),
  'axes',                 (SELECT axes FROM axis_jsonb),
  'by_ticker',            (SELECT rows FROM by_ticker),
  'by_detector',          (SELECT rows FROM by_detector),
  'by_regime',            (SELECT rows FROM by_regime),
  'by_dte_bucket',        (SELECT rows FROM by_dte),
  'by_premium_bucket',    (SELECT rows FROM by_premium)
);
$$;

REVOKE ALL ON FUNCTION public.corpus_baseline(int) FROM public;
GRANT EXECUTE ON FUNCTION public.corpus_baseline(int) TO service_role, anon, authenticated;

------------------------------------------------------------
-- slice_by(p_dimension, p_filters, p_window_days, p_min_n)
------------------------------------------------------------
-- Allowed dimension columns (whitelist guards dynamic SQL).
-- Allowed filter columns: same whitelist.

CREATE OR REPLACE FUNCTION public.slice_by(
  p_dimension    text,
  p_filters      jsonb DEFAULT '{}'::jsonb,
  p_window_days  int   DEFAULT 30,
  p_min_n        int   DEFAULT 10
)
RETURNS TABLE (
  dimension_value          text,
  n                        bigint,
  settled_n                bigint,
  hit_rate_blended         numeric,
  hit_rate_premium         numeric,
  hit_rate_4h              numeric,
  hit_rate_1d              numeric,
  hit_rate_3d              numeric,
  baseline_delta_blended   numeric,
  baseline_delta_4h        numeric,
  baseline_delta_1d        numeric,
  baseline_delta_3d        numeric,
  per_axis                 jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  allowed_cols text[] := ARRAY[
    'instrument','side','direction','detector_id','source','status',
    'time_of_day_bucket','dte_bucket','premium_bucket','aggressor',
    'regime','regime_v2_ticker','legacy_regime_at_fire',
    'day_of_week','blended_verdict',
    'underlying_outcome_4h','underlying_outcome_1d','underlying_outcome_3d',
    'premium_axis_outcome'
  ];
  filter_clause text := '';
  k text;
  v text;
  q text;
BEGIN
  IF NOT (p_dimension = ANY (allowed_cols)) THEN
    RAISE EXCEPTION 'dimension % not in whitelist', p_dimension
      USING HINT = 'allowed: ' || array_to_string(allowed_cols, ', ');
  END IF;

  -- Build filter clause from jsonb (whitelist each key).
  IF p_filters IS NOT NULL AND p_filters <> '{}'::jsonb THEN
    FOR k, v IN SELECT * FROM jsonb_each_text(p_filters)
    LOOP
      IF NOT (k = ANY (allowed_cols)) THEN
        RAISE EXCEPTION 'filter column % not in whitelist', k;
      END IF;
      filter_clause := filter_clause
        || format(' AND %I = %L', k, v);
    END LOOP;
  END IF;

  q := format($SQL$
    WITH win AS (
      SELECT *
      FROM public.ct_flag_analysis_corpus
      WHERE fire_ts >= now() - make_interval(days => %s)
        %s
    ),
    baseline AS (
      SELECT
        AVG(CASE WHEN blended_verdict = 'win' THEN 1.0
                 WHEN blended_verdict = 'partial' THEN 0.5
                 WHEN blended_verdict = 'loss' THEN 0.0 END) AS hr_blended,
        AVG(CASE WHEN underlying_outcome_4h = 'win' THEN 1.0
                 WHEN underlying_outcome_4h = 'partial' THEN 0.5
                 WHEN underlying_outcome_4h = 'loss' THEN 0.0 END) AS hr_4h,
        AVG(CASE WHEN underlying_outcome_1d = 'win' THEN 1.0
                 WHEN underlying_outcome_1d = 'partial' THEN 0.5
                 WHEN underlying_outcome_1d = 'loss' THEN 0.0 END) AS hr_1d,
        AVG(CASE WHEN underlying_outcome_3d = 'win' THEN 1.0
                 WHEN underlying_outcome_3d = 'partial' THEN 0.5
                 WHEN underlying_outcome_3d = 'loss' THEN 0.0 END) AS hr_3d
      FROM win
    ),
    g AS (
      SELECT
        COALESCE((%I)::text, '<null>') AS dv,
        count(*) AS n,
        count(*) FILTER (WHERE blended_verdict IN ('win','loss','partial')) AS settled_n,
        AVG(CASE WHEN blended_verdict = 'win' THEN 1.0
                 WHEN blended_verdict = 'partial' THEN 0.5
                 WHEN blended_verdict = 'loss' THEN 0.0 END) AS hr_blended,
        AVG(CASE WHEN premium_axis_outcome = 'win' THEN 1.0
                 WHEN premium_axis_outcome = 'partial' THEN 0.5
                 WHEN premium_axis_outcome = 'loss' THEN 0.0 END) AS hr_premium,
        AVG(CASE WHEN underlying_outcome_4h = 'win' THEN 1.0
                 WHEN underlying_outcome_4h = 'partial' THEN 0.5
                 WHEN underlying_outcome_4h = 'loss' THEN 0.0 END) AS hr_4h,
        AVG(CASE WHEN underlying_outcome_1d = 'win' THEN 1.0
                 WHEN underlying_outcome_1d = 'partial' THEN 0.5
                 WHEN underlying_outcome_1d = 'loss' THEN 0.0 END) AS hr_1d,
        AVG(CASE WHEN underlying_outcome_3d = 'win' THEN 1.0
                 WHEN underlying_outcome_3d = 'partial' THEN 0.5
                 WHEN underlying_outcome_3d = 'loss' THEN 0.0 END) AS hr_3d
      FROM win
      GROUP BY 1
    )
    SELECT
      g.dv AS dimension_value,
      g.n,
      g.settled_n,
      ROUND(g.hr_blended, 4),
      ROUND(g.hr_premium, 4),
      ROUND(g.hr_4h,      4),
      ROUND(g.hr_1d,      4),
      ROUND(g.hr_3d,      4),
      ROUND(g.hr_blended - b.hr_blended, 4),
      ROUND(g.hr_4h      - b.hr_4h,      4),
      ROUND(g.hr_1d      - b.hr_1d,      4),
      ROUND(g.hr_3d      - b.hr_3d,      4),
      jsonb_build_object(
        'baseline_blended', ROUND(b.hr_blended, 4),
        'baseline_4h',      ROUND(b.hr_4h,      4),
        'baseline_1d',      ROUND(b.hr_1d,      4),
        'baseline_3d',      ROUND(b.hr_3d,      4)
      )
    FROM g, baseline b
    WHERE g.settled_n >= %s
    ORDER BY g.n DESC
  $SQL$, p_window_days, filter_clause, p_dimension, p_min_n);

  RETURN QUERY EXECUTE q;
END;
$$;

REVOKE ALL ON FUNCTION public.slice_by(text, jsonb, int, int) FROM public;
GRANT EXECUTE ON FUNCTION public.slice_by(text, jsonb, int, int) TO service_role, anon, authenticated;

------------------------------------------------------------
-- find_anomalies(p_min_n, p_deviation_threshold, p_window_days)
------------------------------------------------------------
-- Scans standard dimensions, returns top 20 cells where |hit_rate_blended -
-- baseline_blended| exceeds threshold AND settled_n >= p_min_n.

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
  -- Compute the overall baseline hit_rate_blended once.
  SELECT AVG(CASE WHEN blended_verdict = 'win' THEN 1.0
                  WHEN blended_verdict = 'partial' THEN 0.5
                  WHEN blended_verdict = 'loss' THEN 0.0 END)
  INTO baseline_blended_v
  FROM public.ct_flag_analysis_corpus
  WHERE fire_ts >= now() - make_interval(days => p_window_days);

  -- Drop into a temp table accumulator per dimension, then return the top N.
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
