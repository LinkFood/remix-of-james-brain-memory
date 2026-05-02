-- =============================================================================
-- 20260502020000_ct_detector_scoreboard.sql
--
-- #9 Detector Lifecycle Phase B — scoreboard + outcome stats RPC + lifecycle
-- state. Mirror of ct_specialist_scoreboard pattern (migration
-- 20260426000060) adapted to per-detector aggregation.
--
-- Composite hit rate metric (wins + 0.5*partials)/n per
-- docs/decisions/2026-05-02-detector-lifecycle-thresholds.md. Used for
-- all promote/demote logic.
--
-- Lifecycle state (separate small table, 14 rows max) tracks the K=4
-- stability gate — proposed_status must hold for K consecutive runs
-- before an actual ct_detectors.status flip is permitted.
--
-- Per Tenet 25, all thresholds + K live in ct_config — promoting/demoting
-- a detector is rules-as-data.
-- =============================================================================
SET search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- 1. ct_detector_scoreboard — append-only snapshot per (detector_id, run)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ct_detector_scoreboard (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  detector_id        text NOT NULL REFERENCES public.ct_detectors(id) ON DELETE CASCADE,
  computed_at        timestamptz NOT NULL DEFAULT now(),
  -- Counts (over the trailing 30d window — kept as one snapshot per run)
  n_total            integer NOT NULL DEFAULT 0,
  n_graded           integer NOT NULL DEFAULT 0,
  wins               integer NOT NULL DEFAULT 0,
  losses             integer NOT NULL DEFAULT 0,
  partials           integer NOT NULL DEFAULT 0,
  invalidated_early  integer NOT NULL DEFAULT 0,
  -- Composite hit rate (wins + 0.5*partials) / n_graded
  hit_rate_7d        numeric,
  hit_rate_30d       numeric,
  sample_count_7d    integer NOT NULL DEFAULT 0,
  sample_count_30d   integer NOT NULL DEFAULT 0,
  -- Most recent W/L streak (positive=wins, negative=losses; partials neutral)
  current_streak     integer NOT NULL DEFAULT 0,
  -- Snapshot of ct_detectors.status at compute time
  current_status     text NOT NULL,
  -- Computed lifecycle proposal — what the rules say the status SHOULD be
  proposed_status    text
);

CREATE INDEX IF NOT EXISTS ct_detector_scoreboard_detector_run
  ON public.ct_detector_scoreboard (detector_id, computed_at DESC);
CREATE INDEX IF NOT EXISTS ct_detector_scoreboard_run
  ON public.ct_detector_scoreboard (computed_at DESC);

ALTER TABLE public.ct_detector_scoreboard ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ct_det_scb_read ON public.ct_detector_scoreboard;
CREATE POLICY ct_det_scb_read ON public.ct_detector_scoreboard
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS ct_det_scb_svc ON public.ct_detector_scoreboard;
CREATE POLICY ct_det_scb_svc ON public.ct_detector_scoreboard
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.ct_detector_scoreboard IS
  'Append-only snapshot per detector per cron run. Source of truth for /detectors UI + lifecycle gating. Composite hit rate = (wins + 0.5*partials)/n_graded.';

-- ---------------------------------------------------------------------------
-- 2. ct_detector_lifecycle_state — single row per detector, stability tracking
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ct_detector_lifecycle_state (
  detector_id            text PRIMARY KEY REFERENCES public.ct_detectors(id) ON DELETE CASCADE,
  proposed_status        text,
  proposed_streak        integer NOT NULL DEFAULT 0,
  last_run_at            timestamptz NOT NULL DEFAULT now(),
  last_flip_at           timestamptz,
  last_flip_from         text,
  last_flip_to           text,
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ct_det_lifecycle_state_run
  ON public.ct_detector_lifecycle_state (last_run_at DESC);

ALTER TABLE public.ct_detector_lifecycle_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ct_det_state_read ON public.ct_detector_lifecycle_state;
CREATE POLICY ct_det_state_read ON public.ct_detector_lifecycle_state
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS ct_det_state_svc ON public.ct_detector_lifecycle_state;
CREATE POLICY ct_det_state_svc ON public.ct_detector_lifecycle_state
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.ct_detector_lifecycle_state IS
  'Single row per detector tracking proposed_status stability. Streak must reach K (config: detector.lifecycle.stability_runs) before an actual ct_detectors.status flip.';

-- ---------------------------------------------------------------------------
-- 3. ct_detector_outcome_stats(p_since_days) — RPC for composite hit rate
--
-- Per Q1 calibration analysis (docs/decisions/2026-05-02-detector-lifecycle-thresholds.md),
-- composite metric = (wins + 0.5*partials) / n_graded. Strict win-only is
-- too punishing (only 1 detector qualifies for live); win-plus-partial is
-- too loose (everything qualifies). Composite separates portfolio cleanly:
-- 30% bottom (zerodte_put_voi), 68% top (smart_money_repeat).
--
-- Joins ct_flag_grades to ct_flags on flag_id. Detector grouping uses
-- ct_flags.detector_id. Specialist source (detector_id often NULL on
-- specialist flags) handled separately as IS NULL group.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ct_detector_outcome_stats(p_since_days integer)
RETURNS TABLE (
  detector_id        text,
  n_total            bigint,
  n_graded           bigint,
  wins               bigint,
  losses             bigint,
  partials           bigint,
  invalidated_early  bigint,
  hit_rate_composite numeric,
  current_streak     integer
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, extensions
AS $$
  WITH window_start AS (
    SELECT (now() - make_interval(days => GREATEST(p_since_days, 1)))::timestamptz AS ts
  ),
  flag_truth AS (
    SELECT
      f.id           AS flag_id,
      f.detector_id,
      f.created_at,
      g.outcome
    FROM public.ct_flags f
    LEFT JOIN public.ct_flag_grades g ON g.flag_id = f.id
    WHERE f.created_at >= (SELECT ts FROM window_start)
      AND f.detector_id IS NOT NULL
  ),
  agg AS (
    SELECT
      detector_id,
      COUNT(*)                                                      AS n_total,
      COUNT(outcome)                                                AS n_graded,
      COUNT(*) FILTER (WHERE outcome = 'win')                       AS wins,
      COUNT(*) FILTER (WHERE outcome = 'loss')                      AS losses,
      COUNT(*) FILTER (WHERE outcome = 'partial')                   AS partials,
      COUNT(*) FILTER (WHERE outcome = 'invalidated_early')         AS invalidated_early
    FROM flag_truth
    GROUP BY detector_id
  ),
  -- Streak = consecutive same-outcome at the most recent end of the window.
  -- Wins streak counts wins (+ partials as half-credit doesn't apply here —
  -- streaks are W/L specific). Losses streak counts losses.
  recent AS (
    SELECT
      detector_id,
      outcome,
      ROW_NUMBER() OVER (PARTITION BY detector_id ORDER BY created_at DESC) AS rn
    FROM flag_truth
    WHERE outcome IS NOT NULL
  ),
  streak_calc AS (
    SELECT
      r1.detector_id,
      r1.outcome AS latest_outcome,
      (SELECT COALESCE(MAX(r2.rn), 0)
         FROM recent r2
         WHERE r2.detector_id = r1.detector_id
           AND r2.rn <= (
             SELECT MIN(r3.rn)
               FROM recent r3
               WHERE r3.detector_id = r1.detector_id
                 AND r3.outcome != r1.outcome
                 AND r3.rn > 1
           )
      ) AS streak_len
    FROM recent r1
    WHERE r1.rn = 1
  )
  SELECT
    a.detector_id,
    a.n_total,
    a.n_graded,
    a.wins,
    a.losses,
    a.partials,
    a.invalidated_early,
    -- Composite hit rate = (wins + 0.5*partials) / n_graded (NULL if no grades)
    ((a.wins::numeric + 0.5 * a.partials::numeric)
       / NULLIF(a.n_graded, 0))::numeric                            AS hit_rate_composite,
    -- Streak: positive for win-streak, negative for loss-streak, 0 otherwise
    CASE
      WHEN s.latest_outcome = 'win'  THEN COALESCE(s.streak_len, 0)::int
      WHEN s.latest_outcome = 'loss' THEN -COALESCE(s.streak_len, 0)::int
      ELSE 0
    END                                                             AS current_streak
  FROM agg a
  LEFT JOIN streak_calc s USING (detector_id)
  ORDER BY a.n_graded DESC NULLS LAST;
$$;

GRANT EXECUTE ON FUNCTION public.ct_detector_outcome_stats(integer)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.ct_detector_outcome_stats(integer) IS
  'Per-detector outcome stats over trailing window. Composite hit rate = (wins + 0.5*partials)/n_graded. Used by ct-detector-scoreboard-update cron.';

-- ---------------------------------------------------------------------------
-- 4. Lifecycle thresholds — config-driven (Tenet 16, 25)
-- ---------------------------------------------------------------------------
INSERT INTO ct_config (key, value, description, category, default_value) VALUES
  ('detector.lifecycle.shadow_to_trial_n_min', '50'::jsonb,
    'Minimum n_graded over 30d for shadow → trial promotion.',
    'detector_lifecycle', '50'::jsonb),
  ('detector.lifecycle.shadow_to_trial_hr_min', '0.30'::jsonb,
    'Minimum composite hit rate over 30d for shadow → trial promotion.',
    'detector_lifecycle', '0.30'::jsonb),
  ('detector.lifecycle.trial_to_live_n_min', '150'::jsonb,
    'Minimum n_graded over 30d for trial → live promotion.',
    'detector_lifecycle', '150'::jsonb),
  ('detector.lifecycle.trial_to_live_hr_min', '0.35'::jsonb,
    'Minimum composite hit rate over 30d for trial → live promotion.',
    'detector_lifecycle', '0.35'::jsonb),
  ('detector.lifecycle.live_to_decay_hr_max', '0.20'::jsonb,
    'Composite hit rate over 14d below this → live → decay demotion.',
    'detector_lifecycle', '0.20'::jsonb),
  ('detector.lifecycle.live_to_decay_n_min', '30'::jsonb,
    'Minimum n_graded over 14d for live → decay demotion (avoid demoting on noise).',
    'detector_lifecycle', '30'::jsonb),
  ('detector.lifecycle.decay_to_retired_hr_max', '0.25'::jsonb,
    'Composite hit rate over 30d below this → decay → retired demotion.',
    'detector_lifecycle', '0.25'::jsonb),
  ('detector.lifecycle.decay_to_retired_n_min', '50'::jsonb,
    'Minimum n_graded over 30d for decay → retired demotion.',
    'detector_lifecycle', '50'::jsonb),
  ('detector.lifecycle.stability_runs', '4'::jsonb,
    'K — proposed_status must hold for K consecutive cron runs before actual ct_detectors.status flip. Default 4 ≈ 2 hours of stability at 30-min cadence.',
    'detector_lifecycle', '4'::jsonb),
  ('detector.lifecycle.slack_enabled', 'true'::jsonb,
    'Master switch for Slack notifications on detector status flips.',
    'detector_lifecycle', 'true'::jsonb)
ON CONFLICT (key) DO NOTHING;
