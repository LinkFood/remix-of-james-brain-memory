-- ct_james_flag_grades — outcome tracking for James's manual stars.
-- Mirrors ct_flag_grades. Each star gets graded at 24h / 72h / 7d
-- checkpoints if the underlying moves enough for a clear outcome.
--
-- Also ct_score_calibration — nightly retrospective audit of the
-- scoring engine. For each score band, what fraction of predictions
-- actually played out correctly? This is how the scorer learns.
SET search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- 1. James flag grades
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ct_james_flag_grades (
  id                 bigserial PRIMARY KEY,
  james_flag_id      bigint NOT NULL REFERENCES ct_james_flags(id) ON DELETE CASCADE,
  ticker             text NOT NULL,
  option_symbol      text NOT NULL,
  horizon_hours      int NOT NULL,           -- 24, 72, 168
  graded_at          timestamptz NOT NULL DEFAULT now(),
  outcome            text NOT NULL CHECK (outcome IN ('win','partial','loss','invalidated_early','pending')),
  spot_at_flag       numeric,
  spot_at_horizon    numeric,
  price_change_pct   numeric,
  move_to_strike_pct numeric,                -- positive = toward strike (right direction)
  crossed_strike     boolean DEFAULT false,
  notes              text,
  UNIQUE (james_flag_id, horizon_hours)
);

CREATE INDEX IF NOT EXISTS idx_ct_james_flag_grades_flag ON ct_james_flag_grades (james_flag_id);
CREATE INDEX IF NOT EXISTS idx_ct_james_flag_grades_ticker ON ct_james_flag_grades (ticker, graded_at DESC);

ALTER TABLE ct_james_flag_grades ENABLE ROW LEVEL SECURITY;
CREATE POLICY ct_james_flag_grades_read ON ct_james_flag_grades FOR SELECT TO authenticated USING (true);
CREATE POLICY ct_james_flag_grades_svc  ON ct_james_flag_grades FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 2. Score calibration — retrospective scorer audit
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ct_score_calibration (
  id                  bigserial PRIMARY KEY,
  calibration_date    date NOT NULL,
  window_days         int NOT NULL,           -- lookback window used
  score_band_low      int NOT NULL,
  score_band_high     int NOT NULL,
  n_rows              int NOT NULL,
  n_right_direction   int NOT NULL,
  n_wrong_direction   int NOT NULL,
  n_flat              int NOT NULL,
  realized_win_rate   numeric,                -- n_right_direction / n_rows
  avg_move_to_strike  numeric,                -- average % move toward the strike
  avg_abs_move        numeric,                -- average absolute spot move
  computed_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (calibration_date, window_days, score_band_low)
);

CREATE INDEX IF NOT EXISTS idx_ct_score_calibration_date ON ct_score_calibration (calibration_date DESC, score_band_low);

ALTER TABLE ct_score_calibration ENABLE ROW LEVEL SECURITY;
CREATE POLICY ct_score_calibration_read ON ct_score_calibration FOR SELECT TO authenticated USING (true);
CREATE POLICY ct_score_calibration_svc  ON ct_score_calibration FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE ct_james_flag_grades IS
  'Outcome tracking for James''s manual stars. Graded at 24/72/168h horizons.';
COMMENT ON TABLE ct_score_calibration IS
  'Retrospective audit: for each score band, what fraction of predictions played out? Nightly.';
