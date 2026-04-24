-- 20260424000037_invalidation_price.sql
-- ----------------------------------------------------------------------------
-- Tier 2 flag-grading work: numeric invalidation level alongside the prose
-- `invalidation` field on ct_flags.
--
-- Why both:
--   • `invalidation` (TEXT) keeps the human-readable thesis ("breaks below
--     VWAP on volume", "GOOGL closes above 348 with sustained volume").
--   • `invalidation_price` (NUMERIC) lets the grader compute INVALIDATED_EARLY
--     outcomes deterministically and lets the UI render stop-buffer state on
--     the live progress chip.
--
-- TODO(backfill): Existing flags only have prose. A one-off LLM script will
-- parse `invalidation` text → numeric price for historical rows. NOT done in
-- this migration on purpose — schema change is reversible, prose-parsing is
-- not.
-- ----------------------------------------------------------------------------

ALTER TABLE public.ct_flags
  ADD COLUMN IF NOT EXISTS invalidation_price NUMERIC NULL;

COMMENT ON COLUMN public.ct_flags.invalidation_price IS
  'Numeric stop level. NULL until specialist prompts emit it (post 20260424000037) or backfill script runs. Prose form lives in `invalidation`.';
