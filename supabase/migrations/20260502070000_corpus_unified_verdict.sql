-- Path B execution: extend corpus to include legacy single-axis grades.
-- LEFT JOIN ct_flag_grades alongside ct_specialist_grade_axes.
-- Add unified_verdict (COALESCE v2 -> legacy), grade_source, verdict_axes_available.
-- 'invalidated_early' (99 rows in ct_flag_grades) maps to its own 'invalidated'
-- bucket and is EXCLUDED from hit-rate math but reported separately.
--
-- DROP CASCADE removes corpus_baseline (SQL function with static dep on the MV);
-- this migration recreates it. slice_by + find_anomalies use dynamic EXECUTE
-- format() and survive the drop, but we recreate them too to switch column
-- references to unified_verdict.

DROP MATERIALIZED VIEW IF EXISTS public.ct_flag_analysis_corpus CASCADE;

CREATE MATERIALIZED VIEW public.ct_flag_analysis_corpus AS
WITH flag_base AS (
  SELECT
    f.id                              AS flag_id,
    f.specialist_ticker,
    f.instrument,
    f.option_symbol,
    f.strike,
    f.expiry,
    f.side,
    f.direction,
    f.score,
    f.detector_id,
    f.source,
    f.status,
    f.confirmed_t1,
    f.horizon_hours,
    f.entry_price,
    f.target_price,
    f.invalidation_price,
    f.tags,
    f.source_flow_ids,
    f.pulse_net_premium_at_fire,
    f.pulse_slope_5min_at_fire,
    f.pulse_regime_at_fire           AS legacy_regime_at_fire,
    f.created_at                     AS fire_ts,
    (f.created_at AT TIME ZONE 'America/New_York')::date  AS fire_date_et,
    (f.created_at AT TIME ZONE 'America/New_York')::time  AS fire_time_et,
    EXTRACT(DOW  FROM (f.created_at AT TIME ZONE 'America/New_York'))::int AS dow_et,
    EXTRACT(HOUR FROM (f.created_at AT TIME ZONE 'America/New_York'))::int AS hour_et,
    (
      EXTRACT(EPOCH FROM ((f.created_at AT TIME ZONE 'America/New_York')::time - TIME '09:30'))/60.0
    )::int                            AS minutes_from_open_et,
    CASE WHEN f.expiry IS NULL THEN NULL
         ELSE (f.expiry - (f.created_at AT TIME ZONE 'America/New_York')::date)
    END                               AS dte_days,
    date_trunc('hour', f.created_at)
      + INTERVAL '5 min'
      * (EXTRACT(MINUTE FROM f.created_at)::int / 5)  AS bucket_ts_5m
  FROM public.ct_flags f
),
flag_with_buckets AS (
  SELECT
    fb.*,
    CASE
      WHEN minutes_from_open_et IS NULL              THEN NULL
      WHEN minutes_from_open_et <  0                  THEN 'pre_market'
      WHEN minutes_from_open_et <  30                 THEN 'open_0930_1000'
      WHEN minutes_from_open_et <  60                 THEN 'open_1000_1030'
      WHEN minutes_from_open_et < 120                 THEN 'morning_1030_1130'
      WHEN minutes_from_open_et < 180                 THEN 'midmorning_1130_1230'
      WHEN minutes_from_open_et < 270                 THEN 'midday_1230_1400'
      WHEN minutes_from_open_et < 330                 THEN 'afternoon_1400_1500'
      WHEN minutes_from_open_et < 390                 THEN 'close_1500_1600'
      ELSE 'after_hours'
    END                                              AS time_of_day_bucket,
    CASE dow_et
      WHEN 0 THEN 'sun' WHEN 1 THEN 'mon' WHEN 2 THEN 'tue'
      WHEN 3 THEN 'wed' WHEN 4 THEN 'thu' WHEN 5 THEN 'fri' WHEN 6 THEN 'sat'
    END                                              AS day_of_week,
    CASE
      WHEN dte_days IS NULL    THEN NULL
      WHEN dte_days <= 0        THEN '0DTE'
      WHEN dte_days <= 3        THEN '1-3d'
      WHEN dte_days <= 14       THEN '4-14d'
      WHEN dte_days <= 45       THEN '15-45d'
      ELSE '46+d'
    END                                              AS dte_bucket
  FROM flag_base fb
),
trigger_ctx AS (
  SELECT
    fb.flag_id,
    SUM(sf.premium)::numeric                          AS trigger_premium_total,
    AVG(sf.ask_side_perc)::numeric                    AS trigger_ask_side_perc_avg,
    MAX(sf.score)::numeric                            AS trigger_scored_flow_score_max,
    MAX(sf.iv_rank_at_event)::numeric                 AS trigger_iv_rank_max,
    array_agg(DISTINCT sf.classification) FILTER (WHERE sf.classification IS NOT NULL)
                                                       AS trigger_classifications
  FROM flag_base fb
  LEFT JOIN public.ct_scored_flow sf
    ON fb.source_flow_ids IS NOT NULL
   AND sf.id = ANY (fb.source_flow_ids)
  GROUP BY fb.flag_id
),
news_window AS (
  SELECT
    fb.flag_id,
    COUNT(n.id)                                       AS news_count_24h,
    MAX(n.significance)                               AS news_significance_max_24h,
    SUM(CASE WHEN n.impact = 'bullish' THEN 1 ELSE 0 END) AS news_bullish_24h,
    SUM(CASE WHEN n.impact = 'bearish' THEN 1 ELSE 0 END) AS news_bearish_24h,
    SUM(CASE WHEN n.impact = 'neutral' THEN 1 ELSE 0 END) AS news_neutral_24h
  FROM flag_base fb
  LEFT JOIN public.ct_news_analyses n
    ON n.instrument = fb.instrument
   AND n.news_timestamp >= fb.fire_ts - INTERVAL '24 hours'
   AND n.news_timestamp <= fb.fire_ts
  GROUP BY fb.flag_id
),
nearest_earnings AS (
  SELECT
    fb.flag_id,
    MIN(ABS((e.event_date - fb.fire_date_et)))        AS days_from_nearest_earnings
  FROM flag_base fb
  LEFT JOIN public.ct_events e
    ON e.event_type = 'earnings'
   AND e.ticker = fb.instrument
   AND e.event_date BETWEEN fb.fire_date_et - INTERVAL '90 days'
                        AND fb.fire_date_et + INTERVAL '90 days'
  GROUP BY fb.flag_id
),
nearest_fomc AS (
  SELECT
    fb.flag_id,
    MIN(ABS((e.event_date - fb.fire_date_et)))        AS days_from_nearest_fomc
  FROM flag_base fb
  LEFT JOIN public.ct_events e
    ON e.event_type = 'econ'
   AND (e.title ILIKE '%FOMC%'
     OR e.title ILIKE '%Federal Reserve interest-rate%'
     OR e.title ILIKE '%rate decision%'
     OR e.title ILIKE '%FOMC minutes%')
   AND e.event_date BETWEEN fb.fire_date_et - INTERVAL '180 days'
                        AND fb.fire_date_et + INTERVAL '180 days'
  GROUP BY fb.flag_id
),
oi_ctx AS (
  SELECT DISTINCT ON (fb.flag_id)
    fb.flag_id,
    o.oi               AS oi_at_fire,
    o.oi_delta_1d      AS oi_delta_1d,
    o.oi_delta_5d      AS oi_delta_5d,
    o.volume_today     AS volume_at_fire,
    o.snap_date        AS oi_snap_date
  FROM flag_base fb
  LEFT JOIN public.ct_oi_snapshots o
    ON o.option_symbol = fb.option_symbol
   AND o.snap_date <= fb.fire_date_et
  ORDER BY fb.flag_id, o.snap_date DESC NULLS LAST, o.captured_at DESC NULLS LAST
)
SELECT
  fb.flag_id,
  fb.specialist_ticker,
  fb.instrument,
  fb.option_symbol,
  fb.strike,
  fb.expiry,
  fb.side,
  fb.direction,
  fb.score,
  fb.detector_id,
  fb.source,
  fb.status,
  fb.confirmed_t1,
  fb.horizon_hours,
  fb.entry_price,
  fb.target_price,
  fb.invalidation_price,
  fb.tags,
  fb.fire_ts,
  fb.fire_date_et,
  fb.fire_time_et,
  fb.dow_et,
  fb.hour_et,
  fb.minutes_from_open_et,
  fb.day_of_week,
  fb.time_of_day_bucket,
  fb.dte_days,
  fb.dte_bucket,
  fb.legacy_regime_at_fire,
  fb.pulse_net_premium_at_fire,
  fb.pulse_slope_5min_at_fire,

  -- Specialist v2 multi-axis grades.
  ga.premium_axis_outcome,
  ga.premium_alpha_pct,
  ga.underlying_outcome_4h,
  ga.underlying_move_4h_pct,
  ga.underlying_outcome_1d,
  ga.underlying_move_1d_pct,
  ga.underlying_outcome_3d,
  ga.underlying_move_3d_pct,
  ga.blended_verdict,
  ga.regime_at_fire                AS grade_regime_at_fire,
  ga.regime_confidence_at_fire     AS grade_regime_confidence_at_fire,
  ga.graded_at,

  -- Legacy single-axis grades (ct_flag_grades, written by ct-flag-grader for ALL sources).
  fg.outcome                       AS legacy_grade_outcome,
  fg.price_change_pct              AS legacy_grade_price_change_pct,
  fg.spy_change_pct                AS legacy_grade_spy_change_pct,
  fg.alpha_pct                     AS legacy_grade_alpha_pct,
  fg.graded_at                     AS legacy_graded_at,

  -- Unified verdict: v2 first (multi-axis precision), then legacy.
  -- 'invalidated' is its own bucket (NOT win/loss/partial); excluded from hit-rate.
  COALESCE(
    ga.blended_verdict,
    CASE fg.outcome
      WHEN 'invalidated_early' THEN 'invalidated'
      WHEN 'win'     THEN 'win'
      WHEN 'loss'    THEN 'loss'
      WHEN 'partial' THEN 'partial'
      ELSE NULL
    END
  )                                AS unified_verdict,

  -- Provenance — which grader produced unified_verdict.
  CASE
    WHEN ga.blended_verdict IS NOT NULL THEN 'specialist_v2_multi_axis'
    WHEN fg.outcome         IS NOT NULL THEN 'legacy_single_axis'
    ELSE 'ungraded'
  END                              AS grade_source,

  -- Per-axis availability so slicing knows what data is real per row.
  jsonb_build_object(
    'premium',           ga.premium_axis_outcome IS NOT NULL,
    'underlying_4h',     ga.underlying_outcome_4h IS NOT NULL,
    'underlying_1d',     ga.underlying_outcome_1d IS NOT NULL,
    'underlying_3d',     ga.underlying_outcome_3d IS NOT NULL,
    'underlying_legacy', fg.outcome IS NOT NULL
  )                                AS verdict_axes_available,

  -- Most recent specialist read at-or-before fire (per ticker).
  sr.id                            AS last_read_id,
  sr.updated_at                    AS last_read_at,
  sr.direction_lean                AS last_read_lean,
  sr.conviction                    AS last_read_conviction,
  sr.flagged                       AS last_read_flagged,
  LEFT(COALESCE(sr.read_text, ''), 200) AS last_read_excerpt,

  -- Pulse v2 regime (5-min bucket).
  COALESCE(rc_t.classification, rc_m.classification, fb.legacy_regime_at_fire) AS regime,
  rc_t.classification              AS regime_v2_ticker,
  rc_t.confidence                  AS regime_v2_ticker_confidence,
  rc_m.classification              AS regime_v2_market,
  rc_m.confidence                  AS regime_v2_market_confidence,

  -- Trigger context.
  tc.trigger_premium_total,
  tc.trigger_ask_side_perc_avg,
  tc.trigger_scored_flow_score_max,
  tc.trigger_iv_rank_max,
  tc.trigger_classifications,
  CASE
    WHEN tc.trigger_ask_side_perc_avg IS NULL THEN NULL
    WHEN tc.trigger_ask_side_perc_avg >= 60 THEN 'ask_aggressive'
    WHEN tc.trigger_ask_side_perc_avg <= 40 THEN 'bid_aggressive'
    ELSE 'mixed'
  END                              AS aggressor,
  CASE
    WHEN tc.trigger_premium_total IS NULL                THEN 'unknown'
    WHEN tc.trigger_premium_total <  50000               THEN 'small_lt_50k'
    WHEN tc.trigger_premium_total < 250000               THEN 'medium_50k_250k'
    WHEN tc.trigger_premium_total < 1000000              THEN 'large_250k_1m'
    ELSE 'whale_gt_1m'
  END                              AS premium_bucket,

  -- News + calendar + OI.
  COALESCE(nw.news_count_24h, 0)   AS news_count_24h,
  nw.news_significance_max_24h,
  COALESCE(nw.news_bullish_24h, 0) AS news_bullish_24h,
  COALESCE(nw.news_bearish_24h, 0) AS news_bearish_24h,
  COALESCE(nw.news_neutral_24h, 0) AS news_neutral_24h,
  ne.days_from_nearest_earnings,
  nf.days_from_nearest_fomc,
  oc.oi_at_fire,
  oc.oi_delta_1d,
  oc.oi_delta_5d,
  oc.volume_at_fire,
  oc.oi_snap_date,

  -- Flag-level embedding (sparse).
  emb.embedding                    AS flag_embedding,
  emb.metadata                     AS flag_embedding_metadata
FROM flag_with_buckets fb
LEFT JOIN public.ct_specialist_grade_axes ga ON ga.flag_id = fb.flag_id
LEFT JOIN public.ct_flag_grades            fg ON fg.flag_id = fb.flag_id
LEFT JOIN LATERAL (
  SELECT id, updated_at, direction_lean, conviction, read_text, flagged
  FROM public.ct_specialist_reads
  WHERE ticker = fb.instrument
    AND updated_at <= fb.fire_ts
  ORDER BY updated_at DESC
  LIMIT 1
) sr ON TRUE
LEFT JOIN public.ct_regime_classifications rc_t
  ON rc_t.ticker = fb.instrument
 AND rc_t.bucket_ts = fb.bucket_ts_5m
LEFT JOIN public.ct_regime_classifications rc_m
  ON rc_m.ticker IS NULL
 AND rc_m.bucket_ts = fb.bucket_ts_5m
LEFT JOIN trigger_ctx       tc ON tc.flag_id = fb.flag_id
LEFT JOIN news_window       nw ON nw.flag_id = fb.flag_id
LEFT JOIN nearest_earnings  ne ON ne.flag_id = fb.flag_id
LEFT JOIN nearest_fomc      nf ON nf.flag_id = fb.flag_id
LEFT JOIN oi_ctx            oc ON oc.flag_id = fb.flag_id
LEFT JOIN public.ct_embeddings emb
  ON emb.item_type = 'flag' AND emb.item_id::text = fb.flag_id::text;

CREATE UNIQUE INDEX ct_flag_analysis_corpus_pk
  ON public.ct_flag_analysis_corpus (flag_id);

CREATE INDEX ct_flag_analysis_corpus_instrument_idx       ON public.ct_flag_analysis_corpus (instrument);
CREATE INDEX ct_flag_analysis_corpus_time_of_day_idx       ON public.ct_flag_analysis_corpus (time_of_day_bucket);
CREATE INDEX ct_flag_analysis_corpus_regime_idx            ON public.ct_flag_analysis_corpus (regime);
CREATE INDEX ct_flag_analysis_corpus_dte_bucket_idx        ON public.ct_flag_analysis_corpus (dte_bucket);
CREATE INDEX ct_flag_analysis_corpus_premium_bucket_idx    ON public.ct_flag_analysis_corpus (premium_bucket);
CREATE INDEX ct_flag_analysis_corpus_unified_verdict_idx   ON public.ct_flag_analysis_corpus (unified_verdict);
CREATE INDEX ct_flag_analysis_corpus_grade_source_idx      ON public.ct_flag_analysis_corpus (grade_source);
CREATE INDEX ct_flag_analysis_corpus_blended_verdict_idx   ON public.ct_flag_analysis_corpus (blended_verdict);
CREATE INDEX ct_flag_analysis_corpus_fire_ts_desc_idx      ON public.ct_flag_analysis_corpus (fire_ts DESC);
CREATE INDEX ct_flag_analysis_corpus_detector_idx          ON public.ct_flag_analysis_corpus (detector_id);
CREATE INDEX ct_flag_analysis_corpus_side_idx              ON public.ct_flag_analysis_corpus (side);
CREATE INDEX ct_flag_analysis_corpus_aggressor_idx         ON public.ct_flag_analysis_corpus (aggressor);
CREATE INDEX ct_flag_analysis_corpus_dow_idx               ON public.ct_flag_analysis_corpus (day_of_week);

-- ============================================================================
-- corpus_baseline — uses unified_verdict; reports invalidated separately.
-- ============================================================================
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
unified_stats AS (
  SELECT
    SUM(CASE WHEN unified_verdict = 'win'     THEN 1 ELSE 0 END) AS u_wins,
    SUM(CASE WHEN unified_verdict = 'loss'    THEN 1 ELSE 0 END) AS u_losses,
    SUM(CASE WHEN unified_verdict = 'partial' THEN 1 ELSE 0 END) AS u_partials,
    SUM(CASE WHEN unified_verdict = 'pending' THEN 1 ELSE 0 END) AS u_pending,
    SUM(CASE WHEN unified_verdict = 'invalidated' THEN 1 ELSE 0 END) AS u_invalidated,
    SUM(CASE WHEN unified_verdict IS NULL     THEN 1 ELSE 0 END) AS u_ungraded
  FROM win
),
v2_axis_stats AS (
  -- Specialist v2 multi-axis breakdown (only on rows with grade_source='specialist_v2_multi_axis').
  SELECT 'blended'         AS axis, blended_verdict          AS verdict, count(*) n FROM win WHERE grade_source = 'specialist_v2_multi_axis' GROUP BY 1,2
  UNION ALL
  SELECT 'premium',           premium_axis_outcome,        count(*) FROM win WHERE grade_source = 'specialist_v2_multi_axis' GROUP BY 1,2
  UNION ALL
  SELECT 'underlying_4h',     underlying_outcome_4h,       count(*) FROM win WHERE grade_source = 'specialist_v2_multi_axis' GROUP BY 1,2
  UNION ALL
  SELECT 'underlying_1d',     underlying_outcome_1d,       count(*) FROM win WHERE grade_source = 'specialist_v2_multi_axis' GROUP BY 1,2
  UNION ALL
  SELECT 'underlying_3d',     underlying_outcome_3d,       count(*) FROM win WHERE grade_source = 'specialist_v2_multi_axis' GROUP BY 1,2
),
v2_axis_rolled AS (
  SELECT
    axis,
    SUM(CASE WHEN verdict = 'win'     THEN n ELSE 0 END) AS wins,
    SUM(CASE WHEN verdict = 'loss'    THEN n ELSE 0 END) AS losses,
    SUM(CASE WHEN verdict = 'partial' THEN n ELSE 0 END) AS partials,
    SUM(CASE WHEN verdict = 'pending' THEN n ELSE 0 END) AS pending,
    SUM(CASE WHEN verdict IS NULL     THEN n ELSE 0 END) AS ungraded
  FROM v2_axis_stats
  GROUP BY axis
),
v2_axis_jsonb AS (
  SELECT jsonb_object_agg(
    axis,
    jsonb_build_object(
      'wins',      wins, 'losses',   losses,
      'partials',  partials, 'pending', pending,
      'ungraded',  ungraded,
      'settled_n', wins + losses + partials,
      'hit_rate_strict',
        CASE WHEN (wins + losses + partials) > 0
             THEN ROUND(wins::numeric / (wins + losses + partials), 4) ELSE NULL END,
      'hit_rate_weighted',
        CASE WHEN (wins + losses + partials) > 0
             THEN ROUND((wins + 0.5 * partials)::numeric / (wins + losses + partials), 4) ELSE NULL END
    )
  ) AS axes
  FROM v2_axis_rolled
),
by_grade_source AS (
  SELECT jsonb_agg(jsonb_build_object('grade_source', grade_source, 'n', n) ORDER BY n DESC) AS rows
  FROM (SELECT grade_source, count(*) n FROM win GROUP BY 1) s
),
hr_per_source AS (
  SELECT jsonb_object_agg(
    grade_source,
    jsonb_build_object(
      'wins', wins, 'losses', losses, 'partials', partials,
      'invalidated', invalidated, 'pending', pending,
      'settled_n', wins + losses + partials,
      'hit_rate_weighted',
        CASE WHEN (wins + losses + partials) > 0
             THEN ROUND((wins + 0.5 * partials)::numeric / (wins + losses + partials), 4)
             ELSE NULL END,
      'hit_rate_strict',
        CASE WHEN (wins + losses + partials) > 0
             THEN ROUND(wins::numeric / (wins + losses + partials), 4)
             ELSE NULL END
    )
  ) AS sources
  FROM (
    SELECT
      grade_source,
      SUM(CASE WHEN unified_verdict = 'win'         THEN 1 ELSE 0 END) wins,
      SUM(CASE WHEN unified_verdict = 'loss'        THEN 1 ELSE 0 END) losses,
      SUM(CASE WHEN unified_verdict = 'partial'     THEN 1 ELSE 0 END) partials,
      SUM(CASE WHEN unified_verdict = 'invalidated' THEN 1 ELSE 0 END) invalidated,
      SUM(CASE WHEN unified_verdict = 'pending'     THEN 1 ELSE 0 END) pending
    FROM win
    WHERE grade_source IN ('specialist_v2_multi_axis','legacy_single_axis')
    GROUP BY 1
  ) s
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
)
SELECT jsonb_build_object(
  'window_days',          p_window_days,
  'window_start',         now() - make_interval(days => p_window_days),
  'window_end',           now(),
  'total_flags',          (SELECT count(*) FROM win),
  'unified_verdict',      jsonb_build_object(
    'wins',        (SELECT u_wins FROM unified_stats),
    'losses',      (SELECT u_losses FROM unified_stats),
    'partials',    (SELECT u_partials FROM unified_stats),
    'pending',     (SELECT u_pending FROM unified_stats),
    'invalidated', (SELECT u_invalidated FROM unified_stats),
    'ungraded',    (SELECT u_ungraded FROM unified_stats),
    'settled_n',   (SELECT u_wins + u_losses + u_partials FROM unified_stats),
    'hit_rate_strict',
      (SELECT CASE WHEN (u_wins + u_losses + u_partials) > 0
                   THEN ROUND(u_wins::numeric / (u_wins + u_losses + u_partials), 4)
                   ELSE NULL END FROM unified_stats),
    'hit_rate_weighted',
      (SELECT CASE WHEN (u_wins + u_losses + u_partials) > 0
                   THEN ROUND((u_wins + 0.5 * u_partials)::numeric / (u_wins + u_losses + u_partials), 4)
                   ELSE NULL END FROM unified_stats)
  ),
  'specialist_v2_axes',   (SELECT axes FROM v2_axis_jsonb),
  'by_grade_source',      (SELECT rows FROM by_grade_source),
  'hit_rate_per_grade_source', (SELECT sources FROM hr_per_source),
  'by_ticker',            (SELECT rows FROM by_ticker),
  'by_detector',          (SELECT rows FROM by_detector),
  'by_regime',            (SELECT rows FROM by_regime),
  'by_dte_bucket',        (SELECT rows FROM by_dte),
  'by_premium_bucket',    (SELECT rows FROM by_premium)
);
$$;

REVOKE ALL ON FUNCTION public.corpus_baseline(int) FROM public;
GRANT EXECUTE ON FUNCTION public.corpus_baseline(int) TO service_role, anon, authenticated;

-- ============================================================================
-- slice_by — uses unified_verdict; invalidated excluded from hit-rate.
-- Returns invalidated_n + ungraded_n as separate context columns.
-- DROP first because the return-row shape changed (added invalidated_n, ungraded_n).
-- ============================================================================
DROP FUNCTION IF EXISTS public.slice_by(text, jsonb, int, int);

CREATE FUNCTION public.slice_by(
  p_dimension    text,
  p_filters      jsonb DEFAULT '{}'::jsonb,
  p_window_days  int   DEFAULT 30,
  p_min_n        int   DEFAULT 10
)
RETURNS TABLE (
  dimension_value          text,
  n                        bigint,
  settled_n                bigint,
  invalidated_n            bigint,
  ungraded_n               bigint,
  hit_rate_unified         numeric,
  hit_rate_v2_blended      numeric,
  hit_rate_v2_premium      numeric,
  hit_rate_v2_4h           numeric,
  hit_rate_v2_1d           numeric,
  hit_rate_v2_3d           numeric,
  baseline_delta_unified   numeric,
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
    'day_of_week','unified_verdict','blended_verdict','grade_source',
    'underlying_outcome_4h','underlying_outcome_1d','underlying_outcome_3d',
    'premium_axis_outcome','legacy_grade_outcome'
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

  IF p_filters IS NOT NULL AND p_filters <> '{}'::jsonb THEN
    FOR k, v IN SELECT * FROM jsonb_each_text(p_filters)
    LOOP
      IF NOT (k = ANY (allowed_cols)) THEN
        RAISE EXCEPTION 'filter column % not in whitelist', k;
      END IF;
      filter_clause := filter_clause || format(' AND %I = %L', k, v);
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
        AVG(CASE WHEN unified_verdict = 'win'     THEN 1.0
                 WHEN unified_verdict = 'partial' THEN 0.5
                 WHEN unified_verdict = 'loss'    THEN 0.0 END) AS hr_unified
      FROM win
    ),
    g AS (
      SELECT
        COALESCE((%I)::text, '<null>') AS dv,
        count(*) AS n,
        count(*) FILTER (WHERE unified_verdict IN ('win','loss','partial')) AS settled_n,
        count(*) FILTER (WHERE unified_verdict = 'invalidated')              AS invalidated_n,
        count(*) FILTER (WHERE unified_verdict IS NULL)                      AS ungraded_n,
        AVG(CASE WHEN unified_verdict = 'win'     THEN 1.0
                 WHEN unified_verdict = 'partial' THEN 0.5
                 WHEN unified_verdict = 'loss'    THEN 0.0 END) AS hr_unified,
        AVG(CASE WHEN blended_verdict = 'win' THEN 1.0
                 WHEN blended_verdict = 'partial' THEN 0.5
                 WHEN blended_verdict = 'loss' THEN 0.0 END) AS hr_v2_blended,
        AVG(CASE WHEN premium_axis_outcome = 'win' THEN 1.0
                 WHEN premium_axis_outcome = 'partial' THEN 0.5
                 WHEN premium_axis_outcome = 'loss' THEN 0.0 END) AS hr_v2_premium,
        AVG(CASE WHEN underlying_outcome_4h = 'win' THEN 1.0
                 WHEN underlying_outcome_4h = 'partial' THEN 0.5
                 WHEN underlying_outcome_4h = 'loss' THEN 0.0 END) AS hr_v2_4h,
        AVG(CASE WHEN underlying_outcome_1d = 'win' THEN 1.0
                 WHEN underlying_outcome_1d = 'partial' THEN 0.5
                 WHEN underlying_outcome_1d = 'loss' THEN 0.0 END) AS hr_v2_1d,
        AVG(CASE WHEN underlying_outcome_3d = 'win' THEN 1.0
                 WHEN underlying_outcome_3d = 'partial' THEN 0.5
                 WHEN underlying_outcome_3d = 'loss' THEN 0.0 END) AS hr_v2_3d
      FROM win
      GROUP BY 1
    )
    SELECT
      g.dv AS dimension_value,
      g.n,
      g.settled_n,
      g.invalidated_n,
      g.ungraded_n,
      ROUND(g.hr_unified,    4),
      ROUND(g.hr_v2_blended, 4),
      ROUND(g.hr_v2_premium, 4),
      ROUND(g.hr_v2_4h,      4),
      ROUND(g.hr_v2_1d,      4),
      ROUND(g.hr_v2_3d,      4),
      ROUND(g.hr_unified - b.hr_unified, 4),
      jsonb_build_object('baseline_unified', ROUND(b.hr_unified, 4))
    FROM g, baseline b
    WHERE g.settled_n >= %s
    ORDER BY g.n DESC
  $SQL$, p_window_days, filter_clause, p_dimension, p_min_n);

  RETURN QUERY EXECUTE q;
END;
$$;

REVOKE ALL ON FUNCTION public.slice_by(text, jsonb, int, int) FROM public;
GRANT EXECUTE ON FUNCTION public.slice_by(text, jsonb, int, int) TO service_role, anon, authenticated;

-- ============================================================================
-- find_anomalies — scans on unified_verdict; invalidated excluded.
-- DROP first because the return-row shape changed (added invalidated_n, removed
-- per-axis hit_rate_4h/1d/3d which are noisy now that legacy single-axis dominates).
-- ============================================================================
DROP FUNCTION IF EXISTS public.find_anomalies(int, numeric, int);

CREATE FUNCTION public.find_anomalies(
  p_min_n               int     DEFAULT 20,
  p_deviation_threshold numeric DEFAULT 0.15,
  p_window_days         int     DEFAULT 30
)
RETURNS TABLE (
  dimension_name           text,
  dimension_value          text,
  n                        bigint,
  settled_n                bigint,
  invalidated_n            bigint,
  hit_rate_unified         numeric,
  baseline_unified         numeric,
  baseline_delta           numeric,
  abs_baseline_delta       numeric,
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
    'regime','day_of_week','detector_id','grade_source'
  ];
  d text;
  baseline_unified_v numeric;
BEGIN
  SELECT AVG(CASE WHEN unified_verdict = 'win'     THEN 1.0
                  WHEN unified_verdict = 'partial' THEN 0.5
                  WHEN unified_verdict = 'loss'    THEN 0.0 END)
  INTO baseline_unified_v
  FROM public.ct_flag_analysis_corpus
  WHERE fire_ts >= now() - make_interval(days => p_window_days);

  CREATE TEMP TABLE _anomalies (
    dimension_name      text,
    dimension_value     text,
    n                   bigint,
    settled_n           bigint,
    invalidated_n       bigint,
    hit_rate_unified    numeric
  ) ON COMMIT DROP;

  FOREACH d IN ARRAY dims LOOP
    EXECUTE format($SQL$
      INSERT INTO _anomalies (dimension_name, dimension_value, n, settled_n, invalidated_n, hit_rate_unified)
      SELECT
        %L,
        COALESCE((%I)::text, '<null>'),
        count(*),
        count(*) FILTER (WHERE unified_verdict IN ('win','loss','partial')),
        count(*) FILTER (WHERE unified_verdict = 'invalidated'),
        AVG(CASE WHEN unified_verdict = 'win'     THEN 1.0
                 WHEN unified_verdict = 'partial' THEN 0.5
                 WHEN unified_verdict = 'loss'    THEN 0.0 END)
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
    a.invalidated_n,
    ROUND(a.hit_rate_unified, 4)                                  AS hit_rate_unified,
    ROUND(baseline_unified_v, 4)                                  AS baseline_unified,
    ROUND(a.hit_rate_unified - baseline_unified_v, 4)             AS baseline_delta,
    ROUND(ABS(a.hit_rate_unified - baseline_unified_v), 4)        AS abs_baseline_delta,
    jsonb_build_object(
      'window_days',          p_window_days,
      'min_n_threshold',      p_min_n,
      'deviation_threshold',  p_deviation_threshold
    )
  FROM _anomalies a
  WHERE a.settled_n >= p_min_n
    AND ABS(a.hit_rate_unified - baseline_unified_v) >= p_deviation_threshold
  ORDER BY ABS(a.hit_rate_unified - baseline_unified_v) DESC
  LIMIT 20;
END;
$$;

REVOKE ALL ON FUNCTION public.find_anomalies(int, numeric, int) FROM public;
GRANT EXECUTE ON FUNCTION public.find_anomalies(int, numeric, int) TO service_role, anon, authenticated;

-- Initial populate (non-concurrent because the new MV is empty).
SELECT public.refresh_flag_analysis_corpus(false);
