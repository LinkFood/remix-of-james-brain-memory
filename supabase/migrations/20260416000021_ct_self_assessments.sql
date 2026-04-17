-- ============================================================================
-- Co-Trader Self-Scoring: live self_assessment + retrospective self-regrade
-- ============================================================================
-- LIVE: every observation/flag/alert carries Claude's self-rating (confidence,
--       reasoning_quality, key_evidence, kill_conditions, what_could_go_wrong)
--       inline as it's written.
-- RETRO: 2-24hr later, Claude (Sonnet) re-reads his own row with full context
--        (subsequent flow, price action since, grader verdict) and writes a
--        self-critique row in ct_self_regrades.
--
-- The referee is the intelligence. Calibration = stated confidence matches
-- graded outcome. Self-regrade = the meta-referee grading the referee.
-- ============================================================================

SET search_path = public, extensions;

-- ----------------------------------------------------------------------------
-- 1. Inline self_assessment on the three event tables (nullable, pre-existing
--    rows stay null — no backfill, they predate the prompt change).
-- ----------------------------------------------------------------------------
ALTER TABLE ct_observations ADD COLUMN IF NOT EXISTS self_assessment jsonb;
ALTER TABLE ct_flags        ADD COLUMN IF NOT EXISTS self_assessment jsonb;
ALTER TABLE ct_alerts       ADD COLUMN IF NOT EXISTS self_assessment jsonb;

COMMENT ON COLUMN ct_observations.self_assessment IS
  'Inline Claude self-rating emitted at write time. Shape: {confidence: 1-5, reasoning_quality: 1-5, key_evidence, kill_conditions, what_could_go_wrong}. Nullable for pre-v21 rows.';
COMMENT ON COLUMN ct_flags.self_assessment IS
  'Inline Claude self-rating emitted at write time. See ct_observations.self_assessment.';
COMMENT ON COLUMN ct_alerts.self_assessment IS
  'Inline Claude self-rating emitted at write time. See ct_observations.self_assessment.';

-- ----------------------------------------------------------------------------
-- 2. ct_self_regrades — retrospective self-critique (one row per subject).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ct_self_regrades (
  id                             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type                   text NOT NULL CHECK (subject_type IN ('observation','flag','alert')),
  subject_id                     uuid NOT NULL,

  -- Snapshot of the live self-assessment (for drift comparison)
  original_confidence            int,
  original_reasoning_quality     int,

  -- Claude's retrospective rating with more context
  retrospective_confidence       int CHECK (retrospective_confidence BETWEEN 1 AND 5),
  retrospective_reasoning_quality int CHECK (retrospective_reasoning_quality BETWEEN 1 AND 5),

  -- The critique itself
  what_i_got_right               text,
  what_i_got_wrong               text,
  how_id_rewrite                 text,

  -- Pulled from ct_grades at regrade time (if the subject was gradable + graded)
  grader_verdict                 text,

  prompt_version                 text NOT NULL DEFAULT 'v1',
  regraded_at                    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (subject_type, subject_id)
);

CREATE INDEX IF NOT EXISTS ct_self_regrades_subject_idx
  ON ct_self_regrades (subject_type, subject_id);

CREATE INDEX IF NOT EXISTS ct_self_regrades_regraded_at_idx
  ON ct_self_regrades (regraded_at DESC);

-- ----------------------------------------------------------------------------
-- 3. RLS — same trust model as the rest of ct_*: authenticated read, service
--    role writes. Single-user.
-- ----------------------------------------------------------------------------
ALTER TABLE ct_self_regrades ENABLE ROW LEVEL SECURITY;

CREATE POLICY ct_self_regrades_authenticated_read
  ON ct_self_regrades FOR SELECT TO authenticated USING (true);

CREATE POLICY ct_self_regrades_service_role_all
  ON ct_self_regrades FOR ALL TO service_role USING (true) WITH CHECK (true);
