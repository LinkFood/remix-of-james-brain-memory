-- ============================================================================
-- Co-Trader v2 — ct_flags.slacked_at + Slack gating config
-- ============================================================================
-- Phase 4a: Slack push for flags.
--
-- Adds a `slacked_at` column + partial index so `ct-slack-push-flag` can poll
-- efficiently for the next batch of unpushed flags. Adds two gating configs
-- for same-day vs multi-day treatment (per v2 scope: "T+1 OI confirmation —
-- two tracks"). Reuses existing `score.slack_threshold` (80) for the score
-- gate — no duplicate threshold keys.
-- ============================================================================

SET search_path = public, extensions;

-- ----------------------------------------------------------------------------
-- 1. slacked_at column + partial index
-- ----------------------------------------------------------------------------
ALTER TABLE public.ct_flags
  ADD COLUMN IF NOT EXISTS slacked_at TIMESTAMPTZ;

COMMENT ON COLUMN public.ct_flags.slacked_at IS
  'Set by ct-slack-push-flag when the flag has been pushed. NULL = eligible for next push sweep.';

-- Partial index: cron polls for slacked_at IS NULL every minute; this keeps
-- the scan O(unsent rows) regardless of table growth.
CREATE INDEX IF NOT EXISTS idx_ct_flags_unslacked
  ON public.ct_flags (created_at DESC)
  WHERE slacked_at IS NULL;

-- ----------------------------------------------------------------------------
-- 2. Slack gating config (same-day vs multi-day)
-- ----------------------------------------------------------------------------
-- `score.slack_threshold` already exists (seeded at 80 in 20260423000026).
-- Only the new gating keys are added here. Values are JSONB — ct_config norm.
INSERT INTO public.ct_config (key, value, description, category, default_value) VALUES
  ('slack.flag_require_confirmation',  'false'::jsonb, 'v2: require T+1 OI confirmation (status=conviction) for multi-day flags before Slack', 'slack', 'false'::jsonb),
  ('slack.flag_same_day_horizon_hours','24'::jsonb,    'Flags with horizon_hours <= this are same-day; longer horizons gated by flag_require_confirmation', 'slack', '24'::jsonb)
ON CONFLICT (key) DO NOTHING;
