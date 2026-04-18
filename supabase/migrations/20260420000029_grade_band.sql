-- 20260420000029_grade_band.sql
--
-- Wave 17 band-accuracy scoring on ct_grades.
--
-- Adds MAGNITUDE calibration to the referee. Direction is already graded
-- (right/partial/wrong/ambiguous). This layer answers: "did the actual move %
-- fall inside [low_pct, high_pct]?" and "how overconfident was the claim?"
--
-- Only populated for flags/alerts that had `expected_move` set at write time
-- (v1.3+ rows). Pre-v1.3 grades leave these columns null — we do NOT
-- retroactively grade historical rows that had no band.
--
-- The calibration_delta is SIGNED like the existing ct_grades.calibration_delta:
--   positive = overconfident (claimed high confidence, didn't hit band)
--   negative = underconfident (claimed low confidence, hit band anyway)
--   zero     = perfectly calibrated for that single call
-- Formula: claimed_confidence_pct - (band_hit ? 100 : 0)
--
-- Feeds useRiskMetrics.bandAccuracy and the new BandCalibrationPanel.
SET search_path = public, extensions;

ALTER TABLE ct_grades
  ADD COLUMN IF NOT EXISTS band_hit boolean,
  ADD COLUMN IF NOT EXISTS band_low_pct numeric,
  ADD COLUMN IF NOT EXISTS band_high_pct numeric,
  ADD COLUMN IF NOT EXISTS band_confidence_pct numeric,
  ADD COLUMN IF NOT EXISTS band_calibration_delta numeric;

-- Partial index — the common read pattern is "how many banded grades
-- hit vs missed in the last N days". Partial on band_hit IS NOT NULL
-- keeps it tiny (only v1.3+ rows).
CREATE INDEX IF NOT EXISTS ct_grades_band_hit_graded_at_idx
  ON ct_grades (band_hit, graded_at DESC)
  WHERE band_hit IS NOT NULL;

COMMENT ON COLUMN ct_grades.band_hit IS
  'True if actual_return_pct fell within [band_low_pct, band_high_pct] at horizon close. Null for pre-v1.3 grades that had no expected_move claim.';
COMMENT ON COLUMN ct_grades.band_low_pct IS
  'Snapshot of expected_move.low_pct at grade time. Frozen — source row could be edited later.';
COMMENT ON COLUMN ct_grades.band_high_pct IS
  'Snapshot of expected_move.high_pct at grade time.';
COMMENT ON COLUMN ct_grades.band_confidence_pct IS
  'Snapshot of expected_move.confidence_pct at grade time (50-90 range per watcher validation).';
COMMENT ON COLUMN ct_grades.band_calibration_delta IS
  'Signed: claimed_confidence_pct - (band_hit ? 100 : 0). Positive = overconfident in band, negative = underconfident. Aggregates into BandCalibrationPanel histogram.';
