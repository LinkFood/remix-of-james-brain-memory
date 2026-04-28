-- Backfill today's null target_price + invalidation_price on ct_flags.
-- Detector functions and signature_v1 score-only fires were inserting null
-- targets which collapsed the /flags ProgressChip into a silent dash. From
-- today onward inserts carry contract-side targets (entry × 1.5, invalidation
-- entry × 0.7); this migration retrofits already-inserted rows from today.
UPDATE public.ct_flags
SET target_price = ROUND((entry_price * 1.5)::numeric, 4),
    invalidation_price = ROUND((entry_price * 0.7)::numeric, 4)
WHERE target_price IS NULL
  AND entry_price IS NOT NULL
  AND entry_price > 0
  AND created_at >= '2026-04-28T00:00:00Z'
  AND source IN ('signature_alarm', 'detector_alarm');
