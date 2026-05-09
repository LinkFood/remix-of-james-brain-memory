-- ============================================================================
-- Phase 6 (audit-driven loop, fusion ground-truth Section E #3):
-- get_regime_transitions RPC.
--
-- Audit finding: /pulse shows current regime + sparkline. Regime
-- TRANSITIONS (when/why a ticker flipped from trending to chop, or from
-- bullish to bearish, with the trigger annotation) are completely invisible.
-- ct_regime_history.rationale (jsonb) carries the trigger context per row;
-- it just needs surfacing.
--
-- This RPC uses LAG window function to detect classification changes per
-- (ticker, bucket_ts) sequence, returning rows where current classification
-- differs from prior. Caller filters by ticker + lookback hours.
--
-- Returns the FULL row of the transition-landing bucket so the surface
-- can render: when, prior→next, confidence, momentum/breadth/trajectory
-- snapshot at flip time, rationale (trigger).
-- ============================================================================
SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION public.get_regime_transitions(
  p_lookback_hours int   DEFAULT 72,
  p_tickers        text[] DEFAULT NULL,           -- NULL = all (incl. market-wide); array filter
  p_limit          int   DEFAULT 50,
  p_include_market_wide boolean DEFAULT true       -- if true, include rows where ticker IS NULL
)
RETURNS TABLE (
  id              bigint,
  ticker          text,                  -- NULL = market-wide
  bucket_ts       timestamptz,
  prior_classification text,
  classification  text,
  confidence      numeric,
  momentum        numeric,
  breadth         numeric,
  trajectory      text,
  duration_minutes int,
  rationale       jsonb,
  rich_text       text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
  WITH windowed AS (
    SELECT
      h.id,
      h.ticker,
      h.bucket_ts,
      h.classification,
      h.confidence,
      h.momentum,
      h.breadth,
      h.trajectory,
      h.duration_minutes,
      h.rationale,
      h.rich_text,
      LAG(h.classification) OVER (PARTITION BY COALESCE(h.ticker, '__MKT__') ORDER BY h.bucket_ts) AS prior_classification
    FROM public.ct_regime_history h
    WHERE h.bucket_ts >= now() - (p_lookback_hours * interval '1 hour')
      AND (
        (p_tickers IS NULL AND (p_include_market_wide OR h.ticker IS NOT NULL))
        OR (p_tickers IS NOT NULL AND h.ticker = ANY(p_tickers))
        OR (p_include_market_wide AND p_tickers IS NOT NULL AND h.ticker IS NULL)
      )
  )
  SELECT
    id, ticker, bucket_ts, prior_classification, classification,
    confidence, momentum, breadth, trajectory, duration_minutes,
    rationale, rich_text
  FROM windowed
  WHERE prior_classification IS NOT NULL
    AND prior_classification IS DISTINCT FROM classification
  ORDER BY bucket_ts DESC
  LIMIT p_limit;
$fn$;

GRANT EXECUTE ON FUNCTION public.get_regime_transitions(int, text[], int, boolean)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.get_regime_transitions IS
  'Returns ct_regime_history rows where classification flipped vs the prior bucket for the same (ticker OR market-wide). Used by /alpha RegimeFlipJournal component (Phase 6) to surface the trigger annotations + flip timing that have been silently logged but never rendered.';
