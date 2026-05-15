-- Item 1 — Heartbeat cross-producer dedup config seed.
--
-- Bug: brain-insights cron (type=pattern/overdue/stale/etc, 10AM+8PM ET) and
-- jac-heartbeat cron (type=heartbeat, every 30 min) emit same-theme insights
-- back-to-back when both fire within ~30 min and Claude lands on similar
-- narrative loops. Today's instance:
--   2026-05-14 22:00:28 UTC brain-insights wrote pattern
--     "Narrative velocity outpacing decision velocity"
--   2026-05-14 22:30:14 UTC jac-heartbeat wrote heartbeat
--     "Narrative velocity masking decision velocity"
-- Existing jac-heartbeat dedup at supabase/functions/jac-heartbeat/index.ts:268
-- only queried `.eq('type', 'heartbeat')` — intra-producer only.
--
-- Fix shape: heartbeat now yields to recent non-heartbeat brain_insights rows
-- in a configurable window (default 30 min). Heartbeat is the interrupt
-- channel; batch producer wins when they collide. Companion code change at
-- supabase/functions/jac-heartbeat/index.ts (cross-producer yield block
-- between intra-heartbeat 6h gap check and context load).
--
-- This migration just seeds the ct_config tunable per Tenet 16.

SET search_path = public, extensions;

INSERT INTO public.ct_config (key, value, description, category, min_value, max_value, default_value)
VALUES (
  'jac_heartbeat_cross_producer_yield_ms',
  to_jsonb(1800000),
  'jac-heartbeat yields if any non-heartbeat brain_insights row was created within this many ms. Default 1800000 (30 min). Set to 0 to disable cross-producer yield.',
  'jac',
  0,
  86400000,
  to_jsonb(1800000)
)
ON CONFLICT (key) DO NOTHING;
