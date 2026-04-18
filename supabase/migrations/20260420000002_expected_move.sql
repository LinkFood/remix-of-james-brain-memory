-- 20260420000002_expected_move.sql
--
-- Adds `expected_move` jsonb to ct_flags and ct_alerts. Shape (all numeric):
--   {
--     "low_pct":        number,   -- signed, percent of underlying
--     "high_pct":       number,   -- signed, percent of underlying
--     "confidence_pct": number,   -- 50-90, how confident in the RANGE
--     "horizon_hrs":    number    -- matches existing `horizon` (1/4/6/18)
--   }
--
-- This is the MAGNITUDE band Claude would put money on, in addition to the
-- existing `direction` + `conviction` fields. Enables Kelly sizing, R:R
-- calibration, and magnitude-realized vs claimed "band accuracy" as a
-- first-class edge metric.
--
-- Additive / nullable: old rows keep working, no backfill. Validation is
-- done in edge-function code (permissive — log and continue on malformed).
--
-- Indexes are partial-on-existence (b-tree on a jsonb expression) so queries
-- filtering "rows with an expected_move" stay fast without a full scan.
SET search_path = public, extensions;

ALTER TABLE ct_flags
  ADD COLUMN IF NOT EXISTS expected_move jsonb;

ALTER TABLE ct_alerts
  ADD COLUMN IF NOT EXISTS expected_move jsonb;

-- Existence indexes — "rows that declare a magnitude band."
-- Partial indexes keep them tiny (only indexes the non-null subset).
CREATE INDEX IF NOT EXISTS ct_flags_expected_move_present
  ON ct_flags ((expected_move IS NOT NULL))
  WHERE expected_move IS NOT NULL;

CREATE INDEX IF NOT EXISTS ct_alerts_expected_move_present
  ON ct_alerts ((expected_move IS NOT NULL))
  WHERE expected_move IS NOT NULL;

-- GIN indexes for key-existence queries (e.g. jsonb ? 'confidence_pct',
-- jsonb @> '{"confidence_pct": 70}'). Jsonb ops class so @>/?/?&/?| all work.
CREATE INDEX IF NOT EXISTS ct_flags_expected_move_gin
  ON ct_flags USING gin (expected_move jsonb_path_ops)
  WHERE expected_move IS NOT NULL;

CREATE INDEX IF NOT EXISTS ct_alerts_expected_move_gin
  ON ct_alerts USING gin (expected_move jsonb_path_ops)
  WHERE expected_move IS NOT NULL;

COMMENT ON COLUMN ct_flags.expected_move IS
  'Magnitude band {low_pct, high_pct, confidence_pct (50-90), horizon_hrs}. Written by ct-watcher from Claude v1.3 prompt. Nullable — old rows & invalid payloads stay null.';
COMMENT ON COLUMN ct_alerts.expected_move IS
  'Magnitude band {low_pct, high_pct, confidence_pct (50-90), horizon_hrs}. Written by ct-watcher from Claude v1.3 prompt. Nullable — old rows & invalid payloads stay null.';
