-- ============================================================================
-- Co-Trader v2 — Phase 2: Fix ct_flags.source_flow_ids type mismatch
-- ============================================================================
-- Context: Phase 1a schema declared ct_flags.source_flow_ids as UUID[], but
-- ct_scored_flow.id is BIGSERIAL (bigint). Specialists pass scored-flow ids
-- to link flags back to their originating events; the type mismatch was
-- causing every flag insert to fail silently.
--
-- Fix: retype to BIGINT[]. No data in ct_flags yet (v2 table just created),
-- so no backfill needed. If rows existed, they'd need a USING clause.
-- ============================================================================

SET search_path = public, extensions;

ALTER TABLE public.ct_flags
  ALTER COLUMN source_flow_ids TYPE BIGINT[]
  USING source_flow_ids::text[]::bigint[];

COMMENT ON COLUMN public.ct_flags.source_flow_ids IS
  'BIGINT[] of ct_scored_flow.id values that triggered this flag. Type retyped from UUID[] in 20260423000035 to match ct_scored_flow.id (BIGSERIAL).';
