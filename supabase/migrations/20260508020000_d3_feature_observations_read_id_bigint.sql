-- Cascade instance #30 fix. Stream 3 D3 loader implementation surfaced
-- ct_specialist_reads.id is BIGINT, but the original migration
-- 20260508000000_d3_feature_observations.sql declared read_id as UUID
-- NOT NULL. Empty table — safe ALTER COLUMN.

ALTER TABLE public.ct_d3_feature_observations
  ALTER COLUMN read_id TYPE BIGINT USING NULL;

COMMENT ON COLUMN public.ct_d3_feature_observations.read_id IS
  'Foreign key to ct_specialist_reads.id (BIGINT). Anchor for per-wakeup '
  'feature reconstruction. Was UUID in original migration — type mismatch '
  'caught by Stream 3 dry-run, fixed 2026-05-09.';
