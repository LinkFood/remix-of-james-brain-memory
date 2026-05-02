-- Pattern capture table for the forensic post-op platform.
-- Manual INSERT path during Phase 4. Status flow: observed -> validated -> deprecated.
-- Specialist feedback loop (Phase 5) deferred until ct_observed_patterns has
-- >=10 'validated' rows confirmed across multiple weeks.

CREATE TABLE IF NOT EXISTS public.ct_observed_patterns (
  id                  bigserial   PRIMARY KEY,
  pattern_signature   jsonb       NOT NULL,
  description         text        NOT NULL,
  n_observed          int         NOT NULL,
  hit_rate_blended    numeric     NOT NULL,
  hit_rate_per_axis   jsonb,
  baseline_delta      numeric,
  regime_conditional  boolean     NOT NULL DEFAULT false,
  recommended_action  text,
  status              text        NOT NULL DEFAULT 'observed'
                                  CHECK (status IN ('observed','validated','deprecated')),
  captured_at         timestamptz NOT NULL DEFAULT now(),
  last_validated_at   timestamptz,
  captured_by         text,
  notes               text
);

CREATE INDEX IF NOT EXISTS idx_observed_patterns_status
  ON public.ct_observed_patterns (status, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_observed_patterns_signature_gin
  ON public.ct_observed_patterns USING GIN (pattern_signature);

ALTER TABLE public.ct_observed_patterns ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ct_observed_patterns service role full"
  ON public.ct_observed_patterns
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE POLICY "ct_observed_patterns authenticated read"
  ON public.ct_observed_patterns
  FOR SELECT TO authenticated, anon
  USING (true);
