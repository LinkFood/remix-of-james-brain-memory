-- Forensic post-op corpus: wide materialized view joining flags + multi-axis grades
-- + most-recent specialist read + Pulse v2 regime + 24h news window + OI delta
-- + scored-flow trigger context + flag embedding. Read-only over existing tables.

CREATE MATERIALIZED VIEW IF NOT EXISTS public.ct_flag_analysis_corpus AS
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
    -- minutes from 09:30 ET. Negative = pre-market. >390 = after-hours.
    (
      EXTRACT(EPOCH FROM ((f.created_at AT TIME ZONE 'America/New_York')::time - TIME '09:30'))/60.0
    )::int                            AS minutes_from_open_et,
    -- DTE: expiry - fire_date_et. Null-safe for flags w/o expiry.
    CASE WHEN f.expiry IS NULL THEN NULL
         ELSE (f.expiry - (f.created_at AT TIME ZONE 'America/New_York')::date)
    END                               AS dte_days,
    -- 5-min bucket aligned to UTC for regime join.
    date_trunc('hour', f.created_at)
      + INTERVAL '5 min'
      * (EXTRACT(MINUTE FROM f.created_at)::int / 5)  AS bucket_ts_5m
  FROM public.ct_flags f
),
flag_with_buckets AS (
  SELECT
    fb.*,
    -- Time-of-day bucket (ET).
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
    -- Day-of-week label (1=Mon..5=Fri per ISODOW; PG DOW: 0=Sun..6=Sat).
    CASE dow_et
      WHEN 0 THEN 'sun' WHEN 1 THEN 'mon' WHEN 2 THEN 'tue'
      WHEN 3 THEN 'wed' WHEN 4 THEN 'thu' WHEN 5 THEN 'fri' WHEN 6 THEN 'sat'
    END                                              AS day_of_week,
    -- DTE bucket.
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
  -- Aggregate scored-flow context across source_flow_ids per flag.
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
  -- 24h pre-fire window per instrument.
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
  -- Latest OI snapshot for the flag's option_symbol on or before fire_date_et.
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

  -- Multi-axis grade outcomes.
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

  -- Most recent specialist read at-or-before fire (per ticker).
  sr.id                            AS last_read_id,
  sr.updated_at                    AS last_read_at,
  sr.direction_lean                AS last_read_lean,
  sr.conviction                    AS last_read_conviction,
  sr.flagged                       AS last_read_flagged,
  LEFT(COALESCE(sr.read_text, ''), 200) AS last_read_excerpt,

  -- Pulse v2 regime (5-min bucket): per-ticker first, fallback to market-wide.
  COALESCE(rc_t.classification, rc_m.classification, fb.legacy_regime_at_fire) AS regime,
  rc_t.classification              AS regime_v2_ticker,
  rc_t.confidence                  AS regime_v2_ticker_confidence,
  rc_m.classification              AS regime_v2_market,
  rc_m.confidence                  AS regime_v2_market_confidence,

  -- Trigger context from scored_flow.
  tc.trigger_premium_total,
  tc.trigger_ask_side_perc_avg,
  tc.trigger_scored_flow_score_max,
  tc.trigger_iv_rank_max,
  tc.trigger_classifications,
  -- Aggressor bucket from ask_side_perc.
  CASE
    WHEN tc.trigger_ask_side_perc_avg IS NULL THEN NULL
    WHEN tc.trigger_ask_side_perc_avg >= 60 THEN 'ask_aggressive'
    WHEN tc.trigger_ask_side_perc_avg <= 40 THEN 'bid_aggressive'
    ELSE 'mixed'
  END                              AS aggressor,
  -- Premium bucket.
  CASE
    WHEN tc.trigger_premium_total IS NULL                THEN 'unknown'
    WHEN tc.trigger_premium_total <  50000               THEN 'small_lt_50k'
    WHEN tc.trigger_premium_total < 250000               THEN 'medium_50k_250k'
    WHEN tc.trigger_premium_total < 1000000              THEN 'large_250k_1m'
    ELSE 'whale_gt_1m'
  END                              AS premium_bucket,

  -- News window.
  COALESCE(nw.news_count_24h, 0)   AS news_count_24h,
  nw.news_significance_max_24h,
  COALESCE(nw.news_bullish_24h, 0) AS news_bullish_24h,
  COALESCE(nw.news_bearish_24h, 0) AS news_bearish_24h,
  COALESCE(nw.news_neutral_24h, 0) AS news_neutral_24h,

  -- Calendar context.
  ne.days_from_nearest_earnings,
  nf.days_from_nearest_fomc,

  -- OI context.
  oc.oi_at_fire,
  oc.oi_delta_1d,
  oc.oi_delta_5d,
  oc.volume_at_fire,
  oc.oi_snap_date,

  -- Flag-level embedding (sparse: only ~52 flags had this captured pre-corpus).
  emb.embedding                    AS flag_embedding,
  emb.metadata                     AS flag_embedding_metadata
FROM flag_with_buckets fb
LEFT JOIN public.ct_specialist_grade_axes ga ON ga.flag_id = fb.flag_id
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

-- Required for REFRESH MATERIALIZED VIEW CONCURRENTLY.
CREATE UNIQUE INDEX IF NOT EXISTS ct_flag_analysis_corpus_pk
  ON public.ct_flag_analysis_corpus (flag_id);

CREATE INDEX IF NOT EXISTS ct_flag_analysis_corpus_instrument_idx
  ON public.ct_flag_analysis_corpus (instrument);
CREATE INDEX IF NOT EXISTS ct_flag_analysis_corpus_time_of_day_idx
  ON public.ct_flag_analysis_corpus (time_of_day_bucket);
CREATE INDEX IF NOT EXISTS ct_flag_analysis_corpus_regime_idx
  ON public.ct_flag_analysis_corpus (regime);
CREATE INDEX IF NOT EXISTS ct_flag_analysis_corpus_dte_bucket_idx
  ON public.ct_flag_analysis_corpus (dte_bucket);
CREATE INDEX IF NOT EXISTS ct_flag_analysis_corpus_premium_bucket_idx
  ON public.ct_flag_analysis_corpus (premium_bucket);
CREATE INDEX IF NOT EXISTS ct_flag_analysis_corpus_blended_verdict_idx
  ON public.ct_flag_analysis_corpus (blended_verdict);
CREATE INDEX IF NOT EXISTS ct_flag_analysis_corpus_fire_ts_desc_idx
  ON public.ct_flag_analysis_corpus (fire_ts DESC);
CREATE INDEX IF NOT EXISTS ct_flag_analysis_corpus_detector_idx
  ON public.ct_flag_analysis_corpus (detector_id);
CREATE INDEX IF NOT EXISTS ct_flag_analysis_corpus_side_idx
  ON public.ct_flag_analysis_corpus (side);
CREATE INDEX IF NOT EXISTS ct_flag_analysis_corpus_aggressor_idx
  ON public.ct_flag_analysis_corpus (aggressor);
CREATE INDEX IF NOT EXISTS ct_flag_analysis_corpus_dow_idx
  ON public.ct_flag_analysis_corpus (day_of_week);

-- Refresh entry-point. CONCURRENT requires the unique index above + a populated MV;
-- first refresh is non-concurrent in case the MV was created empty.
CREATE OR REPLACE FUNCTION public.refresh_flag_analysis_corpus(p_concurrently boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  t0 timestamptz := clock_timestamp();
  row_count bigint;
BEGIN
  IF p_concurrently THEN
    REFRESH MATERIALIZED VIEW CONCURRENTLY public.ct_flag_analysis_corpus;
  ELSE
    REFRESH MATERIALIZED VIEW public.ct_flag_analysis_corpus;
  END IF;
  SELECT count(*) INTO row_count FROM public.ct_flag_analysis_corpus;
  RETURN jsonb_build_object(
    'ok', true,
    'rows', row_count,
    'concurrent', p_concurrently,
    'duration_ms', EXTRACT(EPOCH FROM (clock_timestamp() - t0)) * 1000
  );
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_flag_analysis_corpus(boolean) FROM public;
GRANT EXECUTE ON FUNCTION public.refresh_flag_analysis_corpus(boolean) TO service_role, anon, authenticated;

-- Initial populate (non-concurrent so an empty MV becomes seeded).
SELECT public.refresh_flag_analysis_corpus(false);

-- Nightly refresh at 04:00 UTC (after grader runs at 03:00 UTC). Use Vault-keyed
-- service-role pattern via pg_cron's own SQL execution; cron runs in the same DB.
SELECT cron.schedule(
  'ct-flag-analysis-corpus-refresh-nightly',
  '0 4 * * *',
  $cron$ SELECT public.refresh_flag_analysis_corpus(true); $cron$
);
