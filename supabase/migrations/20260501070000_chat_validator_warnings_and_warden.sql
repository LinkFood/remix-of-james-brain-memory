-- =============================================================================
-- 20260501070000_chat_validator_warnings_and_warden.sql
--
-- Data-fabrication hallucination class kill — Phase 2.
--
-- 2026-04-30 night: synthesis layer killed *temporal* hallucinations
-- (preamble.temporalAnchor + preamble.whatJustHappened + temporalValidator
-- + eventCoherenceValidator). 2026-05-01: chat answered "biggest premium
-- trade today?" with a fabricated CDNS $4.5M line. CDNS not in watchlist,
-- 0 rows in ct_flow_alerts, 0 mcp_calls. Pure data hallucination.
--
-- The new validator (_shared/tickerCoherenceValidator.ts) catches this class
-- post-output. This migration:
--   1. Adds JSONB column ct_chat_tokens.validator_warnings.
--   2. Seeds a Warden invariant that counts chat rows with non-empty
--      validator_warnings in the last 24h. Severity: critical.
-- =============================================================================
SET search_path = public, extensions;

-- ----------------------------------------------------------------------------
-- 1) Persist validator warnings on the chat row Claude wrote.
-- ----------------------------------------------------------------------------
ALTER TABLE public.ct_chat_tokens
  ADD COLUMN IF NOT EXISTS validator_warnings JSONB;

COMMENT ON COLUMN public.ct_chat_tokens.validator_warnings IS
  'Array of ValidatorWarning objects from the post-output validator chain. NULL or [] means clean. tickerCoherenceValidator flags off-universe ticker mentions (data fabrication). Future validators (factuality, regulatory) append here.';

CREATE INDEX IF NOT EXISTS idx_ct_chat_tokens_warnings_created
  ON public.ct_chat_tokens (created_at DESC)
  WHERE validator_warnings IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 2) Warden invariant — count chat rows with warnings in last 24h.
--    expected_max=0; severity=critical because data fabrication is a
--    structural integrity break, not a hygiene issue.
-- ----------------------------------------------------------------------------
INSERT INTO public.ct_invariants
  (name, category, description, query_sql,
   expected_min, expected_max, severity, runbook_path, enabled)
VALUES (
  'chat_off_universe_mentions_24h',
  'synthesis',
  'ct-chat responses must not mention tickers outside the 10-ticker watchlist + macro symbols + supplied-context tickers. Off-universe mentions = Claude fabricating data. tickerCoherenceValidator flags these on every chat response and persists to ct_chat_tokens.validator_warnings. Threshold 0: any flagged response is a hallucination event.',
  $sql$
    SELECT
      count(*)::numeric                                AS metric_value,
      'chat rows with off-universe mentions in last 24h' AS message
    FROM ct_chat_tokens
    WHERE created_at > now() - interval '24 hours'
      AND validator_warnings IS NOT NULL
      AND jsonb_typeof(validator_warnings) = 'array'
      AND jsonb_array_length(validator_warnings) > 0
  $sql$,
  0,
  0,
  'critical',
  'docs/runbooks/hallucination_class.md',
  true
)
ON CONFLICT (name) DO UPDATE
SET
  category      = EXCLUDED.category,
  description   = EXCLUDED.description,
  query_sql     = EXCLUDED.query_sql,
  expected_min  = EXCLUDED.expected_min,
  expected_max  = EXCLUDED.expected_max,
  severity      = EXCLUDED.severity,
  runbook_path  = EXCLUDED.runbook_path,
  enabled       = EXCLUDED.enabled,
  updated_at    = now();
