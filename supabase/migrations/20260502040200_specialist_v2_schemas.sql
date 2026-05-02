-- =============================================================================
-- 20260502040200_specialist_v2_schemas.sql
--
-- Specialist Scoreboard v2 — multi-axis grading (premium + underlying 4h/1d/3d)
-- with regime-conditional buckets, prompt-version lifecycle, and conviction
-- calibration. Additive on top of v1 (ct_specialist_scoreboard) — v1 stays
-- live (parallel-run discipline).
--
-- Architecture (per docs/decisions/2026-05-02-specialist-scoreboard-v2-design.md):
--
--   ct_specialist_grade_axes         — per-flag multi-axis grade. Premium axis
--                                       from ct_contract_tracks; underlying
--                                       axes from ct_price_bars (4h/1d/3d).
--   ct_specialist_scoreboard_v2      — rolling stats per
--                                       (specialist_ticker × regime × window).
--   ct_specialist_prompt_lifecycle   — per (specialist_ticker, prompt_version)
--                                       lifecycle state with K=4 stability.
--   ct_specialist_conviction_calibration — cross-specialist conviction-bucket
--                                       hit rates; per-specialist when N≥30.
--
-- Producer: postgres RPC ct_specialist_score_v2() (no embeddings — pure
-- aggregation). Lifecycle driver: edge function
-- ct-specialist-prompt-lifecycle-v2 (mirrors detector lifecycle K=4 gate).
-- =============================================================================
SET search_path = public, extensions;

-- ----------------------------------------------------------------------------
-- 1. ct_specialist_grade_axes — per-flag multi-axis grade
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ct_specialist_grade_axes (
  flag_id                  uuid PRIMARY KEY REFERENCES public.ct_flags(id) ON DELETE CASCADE,

  -- Premium axis (option price P&L from ct_contract_tracks)
  premium_axis_outcome     text CHECK (premium_axis_outcome IN ('win','loss','partial','pending') OR premium_axis_outcome IS NULL),
  premium_alpha_pct        numeric,                  -- peak_contract_pct or current snapshot vs entry

  -- Underlying axis at 4h post-fire
  underlying_outcome_4h    text CHECK (underlying_outcome_4h IN ('win','loss','partial','pending') OR underlying_outcome_4h IS NULL),
  underlying_move_4h_pct   numeric,                  -- (close_4h - close_at_fire) / close_at_fire

  -- Underlying axis at 1d post-fire (next session close)
  underlying_outcome_1d    text CHECK (underlying_outcome_1d IN ('win','loss','partial','pending') OR underlying_outcome_1d IS NULL),
  underlying_move_1d_pct   numeric,

  -- Underlying axis at 3d post-fire
  underlying_outcome_3d    text CHECK (underlying_outcome_3d IN ('win','loss','partial','pending') OR underlying_outcome_3d IS NULL),
  underlying_move_3d_pct   numeric,

  -- Blended verdict — combines axes; rules in RPC docs
  blended_verdict          text CHECK (blended_verdict IN ('strong_win','win','partial','loss','strong_loss','pending') OR blended_verdict IS NULL),

  -- Regime at fire-time (joined from ct_regime_classifications via bucket_ts)
  regime_at_fire           text,
  regime_confidence_at_fire numeric,

  graded_at                timestamptz NOT NULL DEFAULT now(),
  grade_version            integer NOT NULL DEFAULT 1   -- bump if grading rules change
);

CREATE INDEX IF NOT EXISTS ct_specialist_grade_axes_graded_at
  ON public.ct_specialist_grade_axes (graded_at DESC);
CREATE INDEX IF NOT EXISTS ct_specialist_grade_axes_blended
  ON public.ct_specialist_grade_axes (blended_verdict);

ALTER TABLE public.ct_specialist_grade_axes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ct_grade_axes_read ON public.ct_specialist_grade_axes;
CREATE POLICY ct_grade_axes_read ON public.ct_specialist_grade_axes
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS ct_grade_axes_svc ON public.ct_specialist_grade_axes;
CREATE POLICY ct_grade_axes_svc ON public.ct_specialist_grade_axes
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.ct_specialist_grade_axes IS
  'Specialist v2 per-flag multi-axis grade. Premium axis from ct_contract_tracks; underlying axes from ct_price_bars (1m bars closed at-or-after fire+4h/1d/3d). Regime joined at fire-time from ct_regime_classifications.';

-- ----------------------------------------------------------------------------
-- 2. ct_specialist_scoreboard_v2 — rolling stats per (specialist × regime × window)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ct_specialist_scoreboard_v2 (
  specialist_ticker            text NOT NULL,
  regime                       text NOT NULL,                -- 'all' for unconditional + each ct_regime_config classification
  window_label                 text NOT NULL CHECK (window_label IN ('7d','30d','lifetime')),

  -- Hit rates per axis
  hit_rate_premium             numeric,
  hit_rate_underlying_4h       numeric,
  hit_rate_underlying_1d       numeric,
  hit_rate_underlying_3d       numeric,
  hit_rate_blended             numeric,

  -- Counts
  n_total                      integer NOT NULL DEFAULT 0,
  n_graded                     integer NOT NULL DEFAULT 0,
  n_partial                    integer NOT NULL DEFAULT 0,

  -- Streaks
  read_streak_signed           integer NOT NULL DEFAULT 0,   -- direction_lean consistency from ct_specialist_reads
  graded_streak_signed         integer NOT NULL DEFAULT 0,   -- blended_verdict W/L streak

  -- Drift slope = linreg of rolling 7d hit_rate over last 30d, percentage points / week
  drift_slope_7d               numeric,

  last_updated                 timestamptz NOT NULL DEFAULT now(),
  computed_at                  timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (specialist_ticker, regime, window_label)
);

CREATE INDEX IF NOT EXISTS ct_specialist_scoreboard_v2_computed
  ON public.ct_specialist_scoreboard_v2 (computed_at DESC);
CREATE INDEX IF NOT EXISTS ct_specialist_scoreboard_v2_specialist_window
  ON public.ct_specialist_scoreboard_v2 (specialist_ticker, window_label);

ALTER TABLE public.ct_specialist_scoreboard_v2 ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ct_scb_v2_read ON public.ct_specialist_scoreboard_v2;
CREATE POLICY ct_scb_v2_read ON public.ct_specialist_scoreboard_v2
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS ct_scb_v2_svc ON public.ct_specialist_scoreboard_v2;
CREATE POLICY ct_scb_v2_svc ON public.ct_specialist_scoreboard_v2
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.ct_specialist_scoreboard_v2 IS
  'Specialist v2 rolling stats per (specialist × regime × window). regime="all" stores unconditional; specific regime values mirror ct_regime_config.classification_name. Drift slope is rolling-7d hit rate over 30d, percentage-points per week.';

-- ----------------------------------------------------------------------------
-- 3. ct_specialist_prompt_lifecycle — per (specialist, prompt_version)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ct_specialist_prompt_lifecycle (
  specialist_ticker            text NOT NULL,
  prompt_version               text NOT NULL,
  status                       text NOT NULL DEFAULT 'shadow'
                                  CHECK (status IN ('shadow','trial','live','decay','retired')),
  proposed_status              text
                                  CHECK (proposed_status IN ('shadow','trial','live','decay','retired')
                                         OR proposed_status IS NULL),
  consecutive_stable_runs      integer NOT NULL DEFAULT 0,
  status_changed_at            timestamptz NOT NULL DEFAULT now(),
  hit_rate_at_status_change    numeric,
  hit_rate_current             numeric,
  last_run_at                  timestamptz NOT NULL DEFAULT now(),
  last_flip_at                 timestamptz,
  last_flip_from               text,
  last_flip_to                 text,
  PRIMARY KEY (specialist_ticker, prompt_version)
);

CREATE INDEX IF NOT EXISTS ct_specialist_lifecycle_status
  ON public.ct_specialist_prompt_lifecycle (status, last_run_at DESC);
CREATE INDEX IF NOT EXISTS ct_specialist_lifecycle_proposed
  ON public.ct_specialist_prompt_lifecycle (proposed_status, consecutive_stable_runs DESC);

ALTER TABLE public.ct_specialist_prompt_lifecycle ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ct_prompt_lc_read ON public.ct_specialist_prompt_lifecycle;
CREATE POLICY ct_prompt_lc_read ON public.ct_specialist_prompt_lifecycle
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS ct_prompt_lc_svc ON public.ct_specialist_prompt_lifecycle;
CREATE POLICY ct_prompt_lc_svc ON public.ct_specialist_prompt_lifecycle
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.ct_specialist_prompt_lifecycle IS
  'Specialist v2 prompt-version lifecycle. Mirrors ct_detector_lifecycle_state pattern. Status flip requires consecutive_stable_runs ≥ K (config: specialist.lifecycle.stability_runs, default K=4).';

-- ----------------------------------------------------------------------------
-- 4. ct_specialist_conviction_calibration — cross-specialist + per-specialist
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ct_specialist_conviction_calibration (
  specialist_ticker            text NOT NULL,           -- '__ALL__' for cross-specialist row
  conviction_bucket            text NOT NULL CHECK (conviction_bucket IN ('0-20','20-40','40-60','60-80','80-100')),
  window_label                 text NOT NULL CHECK (window_label IN ('7d','30d','lifetime')),
  hit_rate                     numeric,
  n                            integer NOT NULL DEFAULT 0,
  last_updated                 timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (specialist_ticker, conviction_bucket, window_label)
);

CREATE INDEX IF NOT EXISTS ct_specialist_conv_cal_specialist
  ON public.ct_specialist_conviction_calibration (specialist_ticker, window_label);

ALTER TABLE public.ct_specialist_conviction_calibration ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ct_conv_cal_read ON public.ct_specialist_conviction_calibration;
CREATE POLICY ct_conv_cal_read ON public.ct_specialist_conviction_calibration
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS ct_conv_cal_svc ON public.ct_specialist_conviction_calibration;
CREATE POLICY ct_conv_cal_svc ON public.ct_specialist_conviction_calibration
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.ct_specialist_conviction_calibration IS
  'Specialist v2 conviction calibration. specialist_ticker = ''__ALL__'' for cross-specialist baseline. Per-specialist rows added when N ≥ 30 per bucket per specialist (config: specialist.conviction.per_specialist_min_n).';

-- ----------------------------------------------------------------------------
-- 5. Config defaults (Tenet 16 — every number tunable in ct_config)
-- ----------------------------------------------------------------------------
INSERT INTO public.ct_config (key, value, category, default_value, description) VALUES
  ('specialist.lifecycle.stability_runs', '4'::jsonb, 'specialist', '4'::jsonb,
   'K — consecutive stable runs of proposed_status before lifecycle flip permitted. Mirrors detector lifecycle.'),
  ('specialist.lifecycle.shadow_to_trial_hit_rate', '0.45'::jsonb, 'specialist', '0.45'::jsonb,
   'Minimum hit_rate_blended to propose trial from shadow.'),
  ('specialist.lifecycle.trial_to_live_hit_rate', '0.55'::jsonb, 'specialist', '0.55'::jsonb,
   'Minimum hit_rate_blended to propose live from trial.'),
  ('specialist.lifecycle.decay_hit_rate', '0.40'::jsonb, 'specialist', '0.40'::jsonb,
   'Below this hit_rate_blended, propose decay (one step down).'),
  ('specialist.conviction.per_specialist_min_n', '30'::jsonb, 'specialist', '30'::jsonb,
   'Minimum N per conviction bucket per specialist before per-specialist calibration row populates. Below this, only __ALL__ row exists.'),
  ('specialist.scoring.underlying_outcome_threshold_pct', '0.5'::jsonb, 'specialist', '0.5'::jsonb,
   'Move % threshold for underlying_outcome win/loss vs partial. ≥ +0.5% in direction = win; ≤ -0.5% against = loss; else partial.'),
  ('specialist.scoring.premium_outcome_threshold_pct', '50.0'::jsonb, 'specialist', '50.0'::jsonb,
   'Premium peak % threshold for premium_axis win. ≥ +50% peak = win; max_drawdown ≤ -50% with no recovery = loss; else partial.')
ON CONFLICT (key) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 6. Register specialist v2 cron as a growth-cron
-- ----------------------------------------------------------------------------
INSERT INTO public.ct_growth_crons
  (cron_jobname, target_table, freshness_column, scope, expected_window_minutes, description)
VALUES
  ('ct-specialist-score-v2-nightly', 'public.ct_specialist_scoreboard_v2', 'computed_at', 'daily', 1500,
    'Specialist v2 scoring — nightly 03:00 UTC. Multi-axis grading + scoreboard refresh.'),
  ('ct-specialist-prompt-lifecycle-v2', 'public.ct_specialist_prompt_lifecycle', 'last_run_at', 'daily', 1500,
    'Specialist v2 prompt lifecycle — nightly 04:00 UTC after scoring. K=4 gate flips.')
ON CONFLICT (cron_jobname) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 7. Warden invariants (3) per brief
-- ----------------------------------------------------------------------------

-- 7a. specialist_scoreboard_v2_freshness — max(last_updated) ≤ 26h
INSERT INTO public.ct_invariants
  (name, category, description, query_sql, expected_min, expected_max, severity, enabled, runbook_path)
VALUES (
  'specialist_scoreboard_v2_freshness',
  'data_freshness',
  'Specialist v2 scoreboard must refresh nightly. ≤26h staleness threshold (24h cron + 2h grace).',
  $sql$
    SELECT
      CASE
        WHEN MAX(last_updated) IS NULL THEN 0
        ELSE EXTRACT(EPOCH FROM (now() - MAX(last_updated))) / 3600
      END::numeric AS metric_value,
      CASE
        WHEN MAX(last_updated) IS NULL THEN '[scoreboard_v2] no rows yet — first cron fire pending'
        ELSE '[scoreboard_v2] last update ' || ROUND(EXTRACT(EPOCH FROM (now() - MAX(last_updated))) / 3600, 1)::text || ' h ago'
      END AS message
    FROM public.ct_specialist_scoreboard_v2
  $sql$,
  0, 26, 'warn', true, 'docs/runbooks/specialist_v2.md'
)
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description,
  query_sql = EXCLUDED.query_sql,
  expected_min = EXCLUDED.expected_min,
  expected_max = EXCLUDED.expected_max,
  severity = EXCLUDED.severity,
  enabled = EXCLUDED.enabled,
  runbook_path = EXCLUDED.runbook_path;

-- 7b. specialist_grade_axes_growing — daily row count growing on RTH days
INSERT INTO public.ct_invariants
  (name, category, description, query_sql, expected_min, severity, enabled, runbook_path)
VALUES (
  'specialist_grade_axes_growing',
  'data_freshness',
  'ct_specialist_grade_axes must add rows on RTH days. ≥10 graded flags per RTH-day window.',
  $sql$
    WITH clk AS (
      SELECT EXTRACT(DOW FROM now() AT TIME ZONE 'UTC')::int AS dow
    ),
    cnt AS (
      SELECT COUNT(*) AS c
      FROM public.ct_specialist_grade_axes
      WHERE graded_at > now() - interval '24 hours'
    )
    SELECT
      CASE
        WHEN clk.dow NOT BETWEEN 1 AND 5 THEN 999
        ELSE cnt.c
      END::numeric AS metric_value,
      '[grade_axes] ' || cnt.c::text || ' graded last 24h' AS message
    FROM clk, cnt
  $sql$,
  10, 'warn', true, 'docs/runbooks/specialist_v2.md'
)
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description,
  query_sql = EXCLUDED.query_sql,
  expected_min = EXCLUDED.expected_min,
  severity = EXCLUDED.severity,
  enabled = EXCLUDED.enabled,
  runbook_path = EXCLUDED.runbook_path;

-- 7c. specialist_lifecycle_silent_streak_check — catch silent no-op pattern
--    Triggers if any (specialist, prompt_version) is stuck in same proposed_status
--    for >7 days without flip OR explicit-hold (proposed_status NULL = pending).
INSERT INTO public.ct_invariants
  (name, category, description, query_sql, expected_min, expected_max, severity, enabled, runbook_path)
VALUES (
  'specialist_lifecycle_silent_streak_check',
  'silent_failure',
  'Catches silent no-op: lifecycle row stuck in same proposed_status >7d without flip. Mirrors v1 silent-failure class at the lifecycle layer.',
  $sql$
    SELECT
      COUNT(*)::numeric AS metric_value,
      CASE
        WHEN COUNT(*) = 0 THEN 'no stuck lifecycle rows'
        ELSE 'STUCK: ' || string_agg(specialist_ticker || ':' || prompt_version, ', ' ORDER BY specialist_ticker)
      END AS message
    FROM public.ct_specialist_prompt_lifecycle
    WHERE proposed_status IS NOT NULL
      AND status != proposed_status
      AND last_run_at < now() - interval '7 days'
      AND consecutive_stable_runs >= 4   -- K=4 reached but never flipped → silent
  $sql$,
  0, 0, 'warn', true, 'docs/runbooks/specialist_v2.md'
)
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description,
  query_sql = EXCLUDED.query_sql,
  expected_min = EXCLUDED.expected_min,
  expected_max = EXCLUDED.expected_max,
  severity = EXCLUDED.severity,
  enabled = EXCLUDED.enabled,
  runbook_path = EXCLUDED.runbook_path;

-- ----------------------------------------------------------------------------
-- 8. Seed lifecycle rows for the 20 (specialist × prompt_version) combos
--    that exist today in ct_specialist_prompts.
-- ----------------------------------------------------------------------------
INSERT INTO public.ct_specialist_prompt_lifecycle
  (specialist_ticker, prompt_version, status, last_run_at)
SELECT
  ticker,
  version::text                          AS prompt_version,
  CASE
    WHEN is_active = true  THEN 'live'   -- v2 prompts that are active
    WHEN is_active = false THEN 'retired' -- v1 prompts deprecated
    ELSE 'shadow'
  END AS status,
  now() AS last_run_at
FROM public.ct_specialist_prompts
ON CONFLICT (specialist_ticker, prompt_version) DO NOTHING;
