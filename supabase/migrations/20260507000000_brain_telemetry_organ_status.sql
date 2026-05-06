-- Bundle Phase 2 enabling migration. Adds organ_status surface to
-- ct_brain_telemetry so the warden can see HelperResult.organMetadata.status
-- per row. Pre-flight for the per-organ metadata-completeness invariant
-- (deferred until organ #3 ships — single bundled migration writes the 10
-- invariants in one pass).
--
-- Producers populate result.organMetadata?.status (OrganStatus enum).
-- claudeReadSurface.ts telemetry path mirrors that into this column.

ALTER TABLE public.ct_brain_telemetry
  ADD COLUMN IF NOT EXISTS organ_status TEXT NULL;

COMMENT ON COLUMN public.ct_brain_telemetry.organ_status IS
  'Mirror of HelperResult.organMetadata.status (OrganStatus enum). Populated '
  'by buildClaudeContext telemetry write per Phase 2 organ producer updates. '
  'Null on rows older than 2026-05-07 or when organ has not yet been migrated '
  'to populate organMetadata. Read by future per-organ metadata-completeness '
  'warden invariants (queued for organ #3 ship).';
