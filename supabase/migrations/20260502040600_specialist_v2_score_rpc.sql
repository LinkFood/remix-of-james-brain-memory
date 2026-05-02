-- =============================================================================
-- 20260502040400_specialist_v2_score_rpc.sql
--
-- Specialist Scoreboard v2 producer — multi-axis grading + rolling scoreboard
-- + conviction calibration in one RPC.
--
-- Phase 1: per-flag grading into ct_specialist_grade_axes
--   - Premium axis  : ct_contract_tracks (peak/drawdown/current vs entry)
--   - Underlying    : ct_price_bars 1m bars at +4h, +1d, +3d post-fire
--   - Regime tag    : ct_regime_classifications (5-min bucket of created_at,
--                     per-ticker first, fallback market-wide)
--   - Blended       : multi-axis combine -> strong_win/win/partial/loss/strong_loss/pending
--
-- Phase 2: ct_specialist_scoreboard_v2 aggregation
--   regime in ('all', distinct regime_at_fire values)
--   window_label in ('7d','30d','lifetime')
--
-- Phase 3: ct_specialist_conviction_calibration
--   __ALL__ row + per-specialist when N >= specialist.conviction.per_specialist_min_n.
--
-- Key correctness rule (the v1 silent-failure fix):
--   WHERE f.specialist_ticker IS NOT NULL.
--   Detector-source flags also live in ct_flags but have specialist_ticker NULL.
-- =============================================================================
SET search_path = public, extensions;

-- ----------------------------------------------------------------------------
-- Helper: trading-day skip approximation.
-- Brief calls for "1 trading day later"; we use calendar days for alpha and
-- rely on the 'pending' fallback when no bar exists yet (weekends/holidays
-- naturally yield 'pending'). Documented simplification.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ct_specialist_score_v2(p_since_days integer DEFAULT 7)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_started_at         timestamptz := now();
  v_window_start       timestamptz := now() - make_interval(days => GREATEST(p_since_days, 1));
  v_premium_threshold  numeric;       -- as fraction (config 50.0% -> 0.5)
  v_underlying_thresh  numeric;       -- as percent (config already a percent)
  v_min_per_specialist integer;
  v_graded_count       integer := 0;
  v_scoreboard_rows    integer := 0;
  v_calibration_rows   integer := 0;
  rec                  record;
  v_premium_outcome    text;
  v_premium_alpha      numeric;
  v_track_peak         numeric;
  v_track_drawdown     numeric;
  v_track_current      numeric;
  v_track_status       text;
  v_track_print_time   timestamptz;
  v_base_close         numeric;
  v_base_ts            timestamptz;
  v_h_close            numeric;
  v_h_ts               timestamptz;
  v_pct_move           numeric;
  v_dir_sign           integer;
  v_und_outcome        text;
  v_und_4h             text;
  v_und_4h_pct         numeric;
  v_und_1d             text;
  v_und_1d_pct         numeric;
  v_und_3d             text;
  v_und_3d_pct         numeric;
  v_blended            text;
  v_regime             text;
  v_regime_conf        numeric;
BEGIN
  -- Load config (fall back to brief defaults if unset).
  SELECT COALESCE((value::text)::numeric / 100.0, 0.5)
    INTO v_premium_threshold
    FROM ct_config WHERE key = 'specialist.scoring.premium_outcome_threshold_pct';
  IF v_premium_threshold IS NULL THEN v_premium_threshold := 0.5; END IF;

  SELECT COALESCE((value::text)::numeric, 0.5)
    INTO v_underlying_thresh
    FROM ct_config WHERE key = 'specialist.scoring.underlying_outcome_threshold_pct';
  IF v_underlying_thresh IS NULL THEN v_underlying_thresh := 0.5; END IF;

  SELECT COALESCE((value::text)::integer, 30)
    INTO v_min_per_specialist
    FROM ct_config WHERE key = 'specialist.conviction.per_specialist_min_n';
  IF v_min_per_specialist IS NULL THEN v_min_per_specialist := 30; END IF;

  -- =========================================================================
  -- Phase 1 — per-flag multi-axis grading.
  -- Filter: specialist-source flags only (specialist_ticker IS NOT NULL).
  -- Skip flags already graded at the current grade_version (=1).
  -- =========================================================================
  FOR rec IN
    SELECT
      f.id,
      f.specialist_ticker,
      f.instrument,
      f.option_symbol,
      f.direction,
      f.created_at
    FROM ct_flags f
    WHERE f.specialist_ticker IS NOT NULL
      AND f.option_symbol IS NOT NULL
      AND f.created_at >= v_window_start
      AND NOT EXISTS (
        SELECT 1 FROM ct_specialist_grade_axes g
         WHERE g.flag_id = f.id AND g.grade_version = 1
      )
    ORDER BY f.created_at ASC
    LIMIT 5000   -- defensive cap; nightly run shouldn't approach this
  LOOP
    BEGIN
      v_premium_outcome := NULL; v_premium_alpha := NULL;
      v_und_4h := NULL; v_und_4h_pct := NULL;
      v_und_1d := NULL; v_und_1d_pct := NULL;
      v_und_3d := NULL; v_und_3d_pct := NULL;
      v_blended := 'pending';
      v_regime := NULL; v_regime_conf := NULL;

      -- ----- Premium axis -----
      SELECT
        MAX(peak_contract_pct),
        MIN(max_drawdown_pct),
        (ARRAY_AGG(current_contract_pct ORDER BY print_time DESC NULLS LAST))[1],
        (ARRAY_AGG(track_status ORDER BY print_time DESC NULLS LAST))[1],
        MIN(print_time)
        INTO v_track_peak, v_track_drawdown, v_track_current, v_track_status, v_track_print_time
      FROM ct_contract_tracks t
      WHERE t.option_symbol = rec.option_symbol
        AND t.ticker = rec.instrument
        AND t.print_time >= rec.created_at - interval '2 hours'
        AND t.print_time <= rec.created_at + interval '2 hours';

      IF v_track_peak IS NOT NULL OR v_track_current IS NOT NULL THEN
        IF v_track_peak IS NOT NULL AND v_track_peak >= v_premium_threshold THEN
          v_premium_outcome := 'win';
          v_premium_alpha := v_track_peak;
        ELSIF v_track_drawdown IS NOT NULL
              AND v_track_drawdown <= -v_premium_threshold
              AND COALESCE(v_track_current, 0) <= 0 THEN
          v_premium_outcome := 'loss';
          v_premium_alpha := COALESCE(v_track_current, v_track_drawdown);
        ELSIF v_track_status IN ('WORKING')
              AND v_track_print_time IS NOT NULL
              AND now() - v_track_print_time < interval '4 hours' THEN
          v_premium_outcome := 'pending';
          v_premium_alpha := v_track_current;
        ELSE
          v_premium_outcome := 'partial';
          v_premium_alpha := v_track_current;
        END IF;
      END IF;

      -- ----- Underlying axes (4h / 1d / 3d) -----
      -- Base price = first 1m bar at-or-after fire time
      SELECT close, ts INTO v_base_close, v_base_ts
        FROM ct_price_bars
       WHERE ticker = rec.instrument
         AND timeframe = '1m'
         AND ts >= rec.created_at
       ORDER BY ts ASC
       LIMIT 1;

      v_dir_sign := CASE rec.direction
                      WHEN 'bullish' THEN 1
                      WHEN 'bearish' THEN -1
                      ELSE 0  -- neutral: leave outcomes NULL
                    END;

      IF v_base_close IS NOT NULL AND v_base_close > 0 AND v_dir_sign <> 0 THEN
        -- 4h horizon
        SELECT close, ts INTO v_h_close, v_h_ts
          FROM ct_price_bars
         WHERE ticker = rec.instrument
           AND timeframe = '1m'
           AND ts >= rec.created_at + interval '4 hours'
         ORDER BY ts ASC
         LIMIT 1;
        IF v_h_close IS NOT NULL THEN
          v_pct_move := ((v_h_close - v_base_close) / v_base_close) * 100;
          v_und_4h_pct := v_pct_move * v_dir_sign;
          IF v_und_4h_pct >= v_underlying_thresh THEN v_und_4h := 'win';
          ELSIF v_und_4h_pct <= -v_underlying_thresh THEN v_und_4h := 'loss';
          ELSE v_und_4h := 'partial';
          END IF;
        ELSIF rec.created_at + interval '4 hours' > now() THEN
          v_und_4h := 'pending';
        ELSE
          v_und_4h := 'pending';   -- no bar = leave pending (e.g., weekend window)
        END IF;

        -- 1d horizon (calendar day approximation; pending if no bar yet)
        SELECT close, ts INTO v_h_close, v_h_ts
          FROM ct_price_bars
         WHERE ticker = rec.instrument
           AND timeframe = '1m'
           AND ts >= rec.created_at + interval '1 day'
         ORDER BY ts ASC
         LIMIT 1;
        IF v_h_close IS NOT NULL THEN
          v_pct_move := ((v_h_close - v_base_close) / v_base_close) * 100;
          v_und_1d_pct := v_pct_move * v_dir_sign;
          IF v_und_1d_pct >= v_underlying_thresh THEN v_und_1d := 'win';
          ELSIF v_und_1d_pct <= -v_underlying_thresh THEN v_und_1d := 'loss';
          ELSE v_und_1d := 'partial';
          END IF;
        ELSE
          v_und_1d := 'pending';
        END IF;

        -- 3d horizon
        SELECT close, ts INTO v_h_close, v_h_ts
          FROM ct_price_bars
         WHERE ticker = rec.instrument
           AND timeframe = '1m'
           AND ts >= rec.created_at + interval '3 days'
         ORDER BY ts ASC
         LIMIT 1;
        IF v_h_close IS NOT NULL THEN
          v_pct_move := ((v_h_close - v_base_close) / v_base_close) * 100;
          v_und_3d_pct := v_pct_move * v_dir_sign;
          IF v_und_3d_pct >= v_underlying_thresh THEN v_und_3d := 'win';
          ELSIF v_und_3d_pct <= -v_underlying_thresh THEN v_und_3d := 'loss';
          ELSE v_und_3d := 'partial';
          END IF;
        ELSE
          v_und_3d := 'pending';
        END IF;
      END IF;

      -- ----- Blended verdict -----
      IF v_und_4h = 'pending' OR v_und_1d = 'pending' OR v_und_3d = 'pending' THEN
        v_blended := 'pending';
      ELSIF v_und_4h IS NULL AND v_und_1d IS NULL AND v_und_3d IS NULL THEN
        -- direction='neutral' OR no underlying data: fall back to premium
        IF v_premium_outcome = 'win' THEN v_blended := 'win';
        ELSIF v_premium_outcome = 'loss' THEN v_blended := 'loss';
        ELSIF v_premium_outcome = 'pending' OR v_premium_outcome IS NULL THEN v_blended := 'pending';
        ELSE v_blended := 'partial';
        END IF;
      ELSIF v_und_4h = 'win' AND v_und_1d = 'win' AND v_und_3d = 'win'
            AND v_premium_outcome = 'win' THEN
        v_blended := 'strong_win';
      ELSIF v_und_4h = 'loss' AND v_und_1d = 'loss' AND v_und_3d = 'loss'
            AND v_premium_outcome = 'loss' THEN
        v_blended := 'strong_loss';
      ELSIF v_und_1d = 'win' AND (v_premium_outcome = 'win' OR v_premium_outcome IS NULL) THEN
        v_blended := 'win';
      ELSIF v_und_1d = 'loss' AND v_premium_outcome IS DISTINCT FROM 'win' THEN
        v_blended := 'loss';
      ELSE
        v_blended := 'partial';
      END IF;

      -- ----- Regime at fire-time -----
      -- 5-min bucket of created_at.
      SELECT classification, confidence
        INTO v_regime, v_regime_conf
      FROM ct_regime_classifications rc
      WHERE rc.ticker = rec.instrument
        AND rc.bucket_ts = date_trunc('minute', rec.created_at)
                          - make_interval(mins => EXTRACT(MINUTE FROM rec.created_at)::int % 5)
      ORDER BY rc.bucket_ts DESC
      LIMIT 1;

      IF v_regime IS NULL THEN
        SELECT classification, confidence
          INTO v_regime, v_regime_conf
        FROM ct_regime_classifications rc
        WHERE rc.ticker IS NULL
          AND rc.bucket_ts = date_trunc('minute', rec.created_at)
                            - make_interval(mins => EXTRACT(MINUTE FROM rec.created_at)::int % 5)
        ORDER BY rc.bucket_ts DESC
        LIMIT 1;
      END IF;

      IF v_regime IS NULL THEN
        v_regime := 'unknown';
      END IF;

      -- ----- UPSERT grade row -----
      INSERT INTO ct_specialist_grade_axes (
        flag_id,
        premium_axis_outcome, premium_alpha_pct,
        underlying_outcome_4h, underlying_move_4h_pct,
        underlying_outcome_1d, underlying_move_1d_pct,
        underlying_outcome_3d, underlying_move_3d_pct,
        blended_verdict,
        regime_at_fire, regime_confidence_at_fire,
        graded_at, grade_version
      ) VALUES (
        rec.id,
        v_premium_outcome, v_premium_alpha,
        v_und_4h, v_und_4h_pct,
        v_und_1d, v_und_1d_pct,
        v_und_3d, v_und_3d_pct,
        v_blended,
        v_regime, v_regime_conf,
        now(), 1
      )
      ON CONFLICT (flag_id) DO UPDATE SET
        premium_axis_outcome     = EXCLUDED.premium_axis_outcome,
        premium_alpha_pct        = EXCLUDED.premium_alpha_pct,
        underlying_outcome_4h    = EXCLUDED.underlying_outcome_4h,
        underlying_move_4h_pct   = EXCLUDED.underlying_move_4h_pct,
        underlying_outcome_1d    = EXCLUDED.underlying_outcome_1d,
        underlying_move_1d_pct   = EXCLUDED.underlying_move_1d_pct,
        underlying_outcome_3d    = EXCLUDED.underlying_outcome_3d,
        underlying_move_3d_pct   = EXCLUDED.underlying_move_3d_pct,
        blended_verdict          = EXCLUDED.blended_verdict,
        regime_at_fire           = EXCLUDED.regime_at_fire,
        regime_confidence_at_fire = EXCLUDED.regime_confidence_at_fire,
        graded_at                = EXCLUDED.graded_at;

      v_graded_count := v_graded_count + 1;
    EXCEPTION WHEN OTHERS THEN
      -- defensive: per-flag failure must not abort the run
      RAISE NOTICE 'ct_specialist_score_v2: grade error flag=% err=%', rec.id, SQLERRM;
    END;
  END LOOP;

  -- =========================================================================
  -- Phase 2 — scoreboard aggregation per (specialist × regime × window).
  -- Build one big union: regime='all' over all rows + each distinct regime.
  -- =========================================================================
  WITH grades_all AS (
    SELECT
      f.specialist_ticker,
      f.direction,
      f.created_at,
      g.graded_at,
      g.regime_at_fire,
      g.blended_verdict,
      g.premium_axis_outcome,
      g.underlying_outcome_4h,
      g.underlying_outcome_1d,
      g.underlying_outcome_3d
    FROM ct_specialist_grade_axes g
    JOIN ct_flags f ON f.id = g.flag_id
    WHERE g.grade_version = 1
      AND f.specialist_ticker IS NOT NULL
  ),
  windowed AS (
    -- Replicate each row across applicable windows
    SELECT g.*, w.window_label, w.window_start FROM grades_all g CROSS JOIN (
      VALUES
        ('7d',       now() - interval '7 days'),
        ('30d',      now() - interval '30 days'),
        ('lifetime', '-infinity'::timestamptz)
    ) AS w(window_label, window_start)
    WHERE g.created_at >= w.window_start
  ),
  bucketed AS (
    -- Regime='all' AND per-regime
    SELECT specialist_ticker, window_label, 'all'::text AS regime,
           direction, created_at, graded_at, blended_verdict,
           premium_axis_outcome, underlying_outcome_4h,
           underlying_outcome_1d, underlying_outcome_3d
    FROM windowed
    UNION ALL
    SELECT specialist_ticker, window_label, COALESCE(regime_at_fire, 'unknown') AS regime,
           direction, created_at, graded_at, blended_verdict,
           premium_axis_outcome, underlying_outcome_4h,
           underlying_outcome_1d, underlying_outcome_3d
    FROM windowed
  ),
  -- Composite hit rate: (wins + 0.5*partials)/n_graded per axis
  agg AS (
    SELECT
      specialist_ticker,
      regime,
      window_label,
      COUNT(*)                                                          AS n_total,
      COUNT(*) FILTER (WHERE blended_verdict NOT IN ('pending'))        AS n_graded,
      COUNT(*) FILTER (WHERE blended_verdict = 'partial')               AS n_partial,
      -- premium
      (
        (COUNT(*) FILTER (WHERE premium_axis_outcome = 'win')::numeric
         + 0.5 * COUNT(*) FILTER (WHERE premium_axis_outcome = 'partial')::numeric)
        / NULLIF(COUNT(*) FILTER (WHERE premium_axis_outcome IN ('win','loss','partial')), 0)
      )                                                                 AS hr_premium,
      -- underlying axes
      (
        (COUNT(*) FILTER (WHERE underlying_outcome_4h = 'win')::numeric
         + 0.5 * COUNT(*) FILTER (WHERE underlying_outcome_4h = 'partial')::numeric)
        / NULLIF(COUNT(*) FILTER (WHERE underlying_outcome_4h IN ('win','loss','partial')), 0)
      )                                                                 AS hr_4h,
      (
        (COUNT(*) FILTER (WHERE underlying_outcome_1d = 'win')::numeric
         + 0.5 * COUNT(*) FILTER (WHERE underlying_outcome_1d = 'partial')::numeric)
        / NULLIF(COUNT(*) FILTER (WHERE underlying_outcome_1d IN ('win','loss','partial')), 0)
      )                                                                 AS hr_1d,
      (
        (COUNT(*) FILTER (WHERE underlying_outcome_3d = 'win')::numeric
         + 0.5 * COUNT(*) FILTER (WHERE underlying_outcome_3d = 'partial')::numeric)
        / NULLIF(COUNT(*) FILTER (WHERE underlying_outcome_3d IN ('win','loss','partial')), 0)
      )                                                                 AS hr_3d,
      -- blended
      (
        (COUNT(*) FILTER (WHERE blended_verdict IN ('win','strong_win'))::numeric
         + 0.5 * COUNT(*) FILTER (WHERE blended_verdict = 'partial')::numeric)
        / NULLIF(COUNT(*) FILTER (WHERE blended_verdict NOT IN ('pending')), 0)
      )                                                                 AS hr_blended
    FROM bucketed
    GROUP BY specialist_ticker, regime, window_label
  ),
  -- Read-streak: consecutive same-direction direction_lean from ct_specialist_reads
  -- (positive bullish, negative bearish, neutral breaks streak). Per specialist.
  reads_ranked AS (
    SELECT
      ticker AS specialist_ticker,
      direction_lean,
      ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY updated_at DESC) AS rn
    FROM ct_specialist_reads
    WHERE direction_lean IS NOT NULL
  ),
  read_streaks AS (
    SELECT
      r1.specialist_ticker,
      CASE r1.direction_lean
        WHEN 'bullish' THEN 1
        WHEN 'bearish' THEN -1
        ELSE 0
      END *
      (SELECT COALESCE(MAX(r2.rn), 0)
         FROM reads_ranked r2
         WHERE r2.specialist_ticker = r1.specialist_ticker
           AND r2.rn <= COALESCE((
             SELECT MIN(r3.rn) - 1
               FROM reads_ranked r3
               WHERE r3.specialist_ticker = r1.specialist_ticker
                 AND r3.direction_lean != r1.direction_lean
                 AND r3.rn > 1
           ), (SELECT MAX(r4.rn)
                 FROM reads_ranked r4
                 WHERE r4.specialist_ticker = r1.specialist_ticker))
      ) AS read_streak_signed
    FROM reads_ranked r1
    WHERE r1.rn = 1 AND r1.direction_lean IN ('bullish', 'bearish')
  ),
  -- Graded-streak: blended_verdict W/L on the most recent flags per specialist.
  graded_ranked AS (
    SELECT
      f.specialist_ticker,
      g.blended_verdict,
      ROW_NUMBER() OVER (PARTITION BY f.specialist_ticker ORDER BY g.graded_at DESC) AS rn
    FROM ct_specialist_grade_axes g
    JOIN ct_flags f ON f.id = g.flag_id
    WHERE g.grade_version = 1
      AND f.specialist_ticker IS NOT NULL
      AND g.blended_verdict IN ('win','strong_win','loss','strong_loss')
  ),
  graded_streaks AS (
    SELECT
      r1.specialist_ticker,
      CASE WHEN r1.blended_verdict IN ('win','strong_win') THEN 1 ELSE -1 END *
      (SELECT COALESCE(MAX(r2.rn), 0)
         FROM graded_ranked r2
         WHERE r2.specialist_ticker = r1.specialist_ticker
           AND r2.rn <= COALESCE((
             SELECT MIN(r3.rn) - 1
               FROM graded_ranked r3
               WHERE r3.specialist_ticker = r1.specialist_ticker
                 AND ((r1.blended_verdict IN ('win','strong_win')
                       AND r3.blended_verdict IN ('loss','strong_loss'))
                      OR (r1.blended_verdict IN ('loss','strong_loss')
                          AND r3.blended_verdict IN ('win','strong_win')))
                 AND r3.rn > 1
           ), (SELECT MAX(r4.rn) FROM graded_ranked r4
                WHERE r4.specialist_ticker = r1.specialist_ticker))
      ) AS graded_streak_signed
    FROM graded_ranked r1
    WHERE r1.rn = 1
  )
  INSERT INTO ct_specialist_scoreboard_v2 (
    specialist_ticker, regime, window_label,
    hit_rate_premium, hit_rate_underlying_4h, hit_rate_underlying_1d, hit_rate_underlying_3d,
    hit_rate_blended,
    n_total, n_graded, n_partial,
    read_streak_signed, graded_streak_signed,
    drift_slope_7d, last_updated, computed_at
  )
  SELECT
    a.specialist_ticker, a.regime, a.window_label,
    a.hr_premium, a.hr_4h, a.hr_1d, a.hr_3d, a.hr_blended,
    a.n_total::int, a.n_graded::int, a.n_partial::int,
    COALESCE(rs.read_streak_signed, 0)::int,
    COALESCE(gs.graded_streak_signed, 0)::int,
    NULL::numeric,        -- drift_slope_7d v1 = NULL until N>=30 + 30d coverage
    now(), now()
  FROM agg a
  LEFT JOIN read_streaks rs   ON rs.specialist_ticker = a.specialist_ticker
  LEFT JOIN graded_streaks gs ON gs.specialist_ticker = a.specialist_ticker
  ON CONFLICT (specialist_ticker, regime, window_label) DO UPDATE SET
    hit_rate_premium       = EXCLUDED.hit_rate_premium,
    hit_rate_underlying_4h = EXCLUDED.hit_rate_underlying_4h,
    hit_rate_underlying_1d = EXCLUDED.hit_rate_underlying_1d,
    hit_rate_underlying_3d = EXCLUDED.hit_rate_underlying_3d,
    hit_rate_blended       = EXCLUDED.hit_rate_blended,
    n_total                = EXCLUDED.n_total,
    n_graded               = EXCLUDED.n_graded,
    n_partial              = EXCLUDED.n_partial,
    read_streak_signed     = EXCLUDED.read_streak_signed,
    graded_streak_signed   = EXCLUDED.graded_streak_signed,
    drift_slope_7d         = EXCLUDED.drift_slope_7d,
    last_updated           = EXCLUDED.last_updated,
    computed_at            = EXCLUDED.computed_at;

  GET DIAGNOSTICS v_scoreboard_rows = ROW_COUNT;

  -- =========================================================================
  -- Phase 3 — conviction calibration.
  -- Buckets: 0-20, 20-40, 40-60, 60-80, 80-100 against ct_flags.score.
  -- Hit-rate of underlying_outcome_1d (win/loss/partial). Composite metric.
  -- __ALL__ row always emits. Per-specialist only when n >= min.
  -- =========================================================================
  WITH bucketed AS (
    SELECT
      f.specialist_ticker,
      f.created_at,
      g.underlying_outcome_1d,
      CASE
        WHEN f.score < 20  THEN '0-20'
        WHEN f.score < 40  THEN '20-40'
        WHEN f.score < 60  THEN '40-60'
        WHEN f.score < 80  THEN '60-80'
        ELSE '80-100'
      END AS conviction_bucket
    FROM ct_flags f
    JOIN ct_specialist_grade_axes g ON g.flag_id = f.id
    WHERE g.grade_version = 1
      AND f.specialist_ticker IS NOT NULL
      AND f.score IS NOT NULL
  ),
  windowed AS (
    SELECT b.*, w.window_label, w.window_start FROM bucketed b CROSS JOIN (
      VALUES
        ('7d',       now() - interval '7 days'),
        ('30d',      now() - interval '30 days'),
        ('lifetime', '-infinity'::timestamptz)
    ) AS w(window_label, window_start)
    WHERE b.created_at >= w.window_start
  ),
  -- __ALL__ row (cross-specialist baseline)
  all_rows AS (
    SELECT
      '__ALL__'::text AS specialist_ticker,
      conviction_bucket,
      window_label,
      (
        (COUNT(*) FILTER (WHERE underlying_outcome_1d = 'win')::numeric
         + 0.5 * COUNT(*) FILTER (WHERE underlying_outcome_1d = 'partial')::numeric)
        / NULLIF(COUNT(*) FILTER (WHERE underlying_outcome_1d IN ('win','loss','partial')), 0)
      ) AS hit_rate,
      COUNT(*)::int AS n
    FROM windowed
    GROUP BY conviction_bucket, window_label
  ),
  per_spec_rows AS (
    SELECT
      specialist_ticker,
      conviction_bucket,
      window_label,
      (
        (COUNT(*) FILTER (WHERE underlying_outcome_1d = 'win')::numeric
         + 0.5 * COUNT(*) FILTER (WHERE underlying_outcome_1d = 'partial')::numeric)
        / NULLIF(COUNT(*) FILTER (WHERE underlying_outcome_1d IN ('win','loss','partial')), 0)
      ) AS hit_rate,
      COUNT(*)::int AS n
    FROM windowed
    GROUP BY specialist_ticker, conviction_bucket, window_label
    HAVING COUNT(*) >= v_min_per_specialist
  ),
  combined AS (
    SELECT * FROM all_rows
    UNION ALL
    SELECT * FROM per_spec_rows
  )
  INSERT INTO ct_specialist_conviction_calibration (
    specialist_ticker, conviction_bucket, window_label, hit_rate, n, last_updated
  )
  SELECT specialist_ticker, conviction_bucket, window_label, hit_rate, n, now()
  FROM combined
  ON CONFLICT (specialist_ticker, conviction_bucket, window_label) DO UPDATE SET
    hit_rate     = EXCLUDED.hit_rate,
    n            = EXCLUDED.n,
    last_updated = EXCLUDED.last_updated;

  GET DIAGNOSTICS v_calibration_rows = ROW_COUNT;

  RETURN jsonb_build_object(
    'graded_count',     v_graded_count,
    'scoreboard_rows',  v_scoreboard_rows,
    'calibration_rows', v_calibration_rows,
    'elapsed_ms',       (EXTRACT(EPOCH FROM (now() - v_started_at)) * 1000)::int,
    'window_days',      p_since_days,
    'thresholds', jsonb_build_object(
      'premium_fraction',   v_premium_threshold,
      'underlying_pct',     v_underlying_thresh,
      'min_per_specialist', v_min_per_specialist
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.ct_specialist_score_v2(integer)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.ct_specialist_score_v2(integer) IS
  'Specialist v2 producer. Phase 1 grades new flags into ct_specialist_grade_axes (premium + underlying 4h/1d/3d + blended + regime). Phase 2 aggregates ct_specialist_scoreboard_v2 per (specialist x regime x window). Phase 3 emits ct_specialist_conviction_calibration (__ALL__ + per-specialist when N>=min). The WHERE specialist_ticker IS NOT NULL filter is the v1 silent-failure fix. Trading-day skip approximated by calendar days; rows with no bar yield pending.';

-- ----------------------------------------------------------------------------
-- Manual-trigger helper (mirror of trigger_ct_detector_scoreboard pattern).
-- Returns request_id from invoke_edge_function.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trigger_ct_specialist_score_v2()
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
  SELECT public.invoke_edge_function('ct-specialist-prompt-lifecycle-v2', '{}'::jsonb);
$fn$;

GRANT EXECUTE ON FUNCTION public.trigger_ct_specialist_score_v2() TO authenticated, service_role;

COMMENT ON FUNCTION public.trigger_ct_specialist_score_v2() IS
  'Manual-fire trigger for the specialist v2 nightly run. Invokes the lifecycle edge function which calls ct_specialist_score_v2(7) then runs the K=4 lifecycle gate.';
