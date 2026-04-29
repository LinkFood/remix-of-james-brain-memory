-- Per-symbol identity additions to ct_contract_tracks.
--
-- Why these columns exist:
--   - print_count: every PRINT of the same option_symbol used to spawn a new
--     row — QQQ260618P00600000 had 18. Collapsing to per-symbol identity means
--     re-prints become a counter increment instead of a row insert. The
--     counter preserves the "how often is this contract being repeatedly hit"
--     signal that the duplicate-row count was implicitly carrying.
--   - last_print_at: most-recent print_time across all merged prints. Lets
--     downstream consumers tell "freshly re-printed" from "stale single fire"
--     without rejoining ct_flow_alerts.
--   - first_alert_id: pointer to the alert_id of the FIRST (earliest) print
--     for this option_symbol. Backwards-compat for any consumer still keying
--     off alert_id (ct-flag-grader's option_symbol lookup is the canonical
--     consumer; first_alert_id is a fallback).
--
-- Additive only. No existing column is touched. Phase 3 collapses dups,
-- Phase 4 enforces uniqueness via partial index.
SET search_path = public, extensions;

ALTER TABLE public.ct_contract_tracks
  ADD COLUMN IF NOT EXISTS print_count    integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS last_print_at  timestamptz,
  ADD COLUMN IF NOT EXISTS first_alert_id text;

-- Backfill the new columns on existing rows so post-merge SELECTs are sane
-- even before any new prints land. last_print_at = print_time, first_alert_id
-- = alert_id (until the merge re-points the canonical row's first_alert_id at
-- the earliest alert).
UPDATE public.ct_contract_tracks
SET last_print_at  = COALESCE(last_print_at, print_time),
    first_alert_id = COALESCE(first_alert_id, alert_id)
WHERE last_print_at IS NULL OR first_alert_id IS NULL;

COMMENT ON COLUMN public.ct_contract_tracks.print_count IS
  'Number of PRINT events that have hit this option_symbol while the track was WORKING. Incremented on re-print after Phase 4 dedup; pre-Phase 4 backfill = COUNT(*) of merged dup rows.';
COMMENT ON COLUMN public.ct_contract_tracks.last_print_at IS
  'Most-recent print_time across all merged dup rows. Updated on re-print by ct_upsert_contract_track. Used by detectors to know when a contract was last hit.';
COMMENT ON COLUMN public.ct_contract_tracks.first_alert_id IS
  'alert_id of the FIRST (earliest) print for this option_symbol — pointer back to the canonical UW alert that opened this track. Backwards-compat for consumers still keying on alert_id.';
