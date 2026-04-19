-- ============================================================================
-- 20260422000014_ct_weekly_review.sql
--
-- Phase 2 Wave J — Weekly CIO Opus Review.
--
-- The CIO tier of the model hierarchy (Co-Trader Thesis, Tenet 8) was missing.
-- Haiku runs per-heartbeat, Sonnet runs daily PM (brief + proposer), and pure
-- logic runs execution. Once a week the deepest model steps back, reviews the
-- whole week, and writes:
--   - refinements/creations on ct_principles
--   - deprecations/creations on ct_biases
--   - Elo overrides on ct_hypotheses
--   - a next-week tilt row on ct_weekly_reviews
--   - drift flags if something looks off in the meta-system
--
-- One ct_weekly_reviews row per run. Monday's ct-hypothesis-proposer and
-- ct-daily-brief read the latest non-null row and incorporate focus_tickers /
-- avoid_tickers / tactical_notes into their context (additive — no removals).
--
-- Cadence: Sunday 22:00 UTC (6pm ET). Enough of the week is closed to review;
-- early enough to seed Monday's opens.
--
-- Cost: Opus ~$15/MTok in / $75/MTok out. Cap ~150k input + ~3k output ≈ $2.48.
-- Hard guardrail in the edge function stops at $10/run.
-- ============================================================================

SET search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- ct_weekly_reviews — one row per CIO run
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ct_weekly_reviews (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  week_ending_date              date NOT NULL,                -- session_date of the Friday just closed
  macro_regime                  text,                         -- 'risk-off' | 'risk-on' | 'chop' | 'pre-fed' | etc.
  focus_tickers                 text[] NOT NULL DEFAULT ARRAY[]::text[],
  avoid_tickers                 text[] NOT NULL DEFAULT ARRAY[]::text[],
  tactical_notes                text,                         -- quoted into Monday's daily brief
  principles_refined_count      int NOT NULL DEFAULT 0,
  principles_created_count      int NOT NULL DEFAULT 0,
  biases_affected_count         int NOT NULL DEFAULT 0,
  hypothesis_elo_adjustments    jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{ hypothesis_id, old_elo, new_elo, reason }]
  drift_flags                   jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{ component, severity, description }]
  cost_usd                      numeric(10, 6),
  tokens_in                     int,
  tokens_out                    int,
  generated_at                  timestamptz NOT NULL DEFAULT now(),
  model_used                    text NOT NULL DEFAULT 'claude-opus-4-7',
  raw_analysis                  text                          -- Opus's raw reasoning / freeform text block
);

CREATE INDEX IF NOT EXISTS idx_ct_weekly_reviews_week
  ON public.ct_weekly_reviews (week_ending_date DESC);
CREATE INDEX IF NOT EXISTS idx_ct_weekly_reviews_generated
  ON public.ct_weekly_reviews (generated_at DESC);

COMMENT ON TABLE  public.ct_weekly_reviews IS
  'Weekly CIO-tier Opus meta-analysis output. One row per Sunday run. Downstream consumed by Monday ct-hypothesis-proposer and ct-daily-brief.';
COMMENT ON COLUMN public.ct_weekly_reviews.focus_tickers IS
  'Tickers the CIO says to lean into next week. Feeds proposer preferences.';
COMMENT ON COLUMN public.ct_weekly_reviews.avoid_tickers IS
  'Tickers the CIO says to avoid next week. Feeds generator filter set.';
COMMENT ON COLUMN public.ct_weekly_reviews.tactical_notes IS
  'Free-form paragraph quoted into Monday''s daily brief context.';

-- RLS — same pattern as ct_principles / ct_daily_briefs
ALTER TABLE public.ct_weekly_reviews ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ct_weekly_reviews_authread ON public.ct_weekly_reviews;
CREATE POLICY ct_weekly_reviews_authread
  ON public.ct_weekly_reviews FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS ct_weekly_reviews_svcall ON public.ct_weekly_reviews;
CREATE POLICY ct_weekly_reviews_svcall
  ON public.ct_weekly_reviews FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- last_weekly_review — helper RPC so downstream Claude functions don't have
-- to duplicate the "latest non-null" query.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.last_weekly_review()
RETURNS TABLE (
  id                            uuid,
  week_ending_date              date,
  macro_regime                  text,
  focus_tickers                 text[],
  avoid_tickers                 text[],
  tactical_notes                text,
  principles_refined_count      int,
  principles_created_count      int,
  biases_affected_count         int,
  hypothesis_elo_adjustments    jsonb,
  drift_flags                   jsonb,
  cost_usd                      numeric,
  generated_at                  timestamptz,
  model_used                    text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
  SELECT
    id, week_ending_date, macro_regime,
    focus_tickers, avoid_tickers, tactical_notes,
    principles_refined_count, principles_created_count, biases_affected_count,
    hypothesis_elo_adjustments, drift_flags,
    cost_usd, generated_at, model_used
  FROM public.ct_weekly_reviews
  ORDER BY generated_at DESC
  LIMIT 1;
$fn$;

GRANT EXECUTE ON FUNCTION public.last_weekly_review() TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Manual-trigger RPC — mirrors every other ct-* cron.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trigger_ct_claude_cio_review()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$ SELECT public._ct_post('ct-claude-cio-review'); $fn$;

GRANT EXECUTE ON FUNCTION public.trigger_ct_claude_cio_review()
  TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Cron — Sunday 22:00 UTC (6pm ET).
--
-- $cron$ outer + no nested $$ (Vault lookup is a plain SELECT, not DO).
-- ---------------------------------------------------------------------------

-- Unschedule any prior version (idempotent redeploy).
DO $$
DECLARE
  j record;
BEGIN
  FOR j IN SELECT jobname FROM cron.job WHERE jobname = 'ct-claude-cio-review'
  LOOP
    PERFORM cron.unschedule(j.jobname);
  END LOOP;
END $$;

SELECT cron.schedule(
  'ct-claude-cio-review',
  '0 22 * * 0',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-claude-cio-review',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := jsonb_build_object('triggered_by', 'scheduled')
    );
  $cron$
);
