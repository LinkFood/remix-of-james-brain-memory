-- v1.1 prompt — evidence axes diversity gate.
-- Every FLAG / ALERT must declare which axes (A..F) its evidence spans so
-- downstream code can detect echo-chamber repetitions (e.g. 14 ALERTs on
-- 2026-04-17 all citing the same B+C frame). GIN index enables fast
-- "did prior alert on same instruments cite the same axes?" lookups.

ALTER TABLE ct_alerts ADD COLUMN IF NOT EXISTS evidence_axes text[] DEFAULT '{}';
ALTER TABLE ct_flags  ADD COLUMN IF NOT EXISTS evidence_axes text[] DEFAULT '{}';

CREATE INDEX IF NOT EXISTS ct_alerts_evidence_axes_gin ON ct_alerts USING GIN (evidence_axes);
