-- ============================================================================
-- search_ct_regime_analogs — vector RPC for the `regime` brain organ.
--
-- Mirrors the search_ct_session_analogs pattern (20260420000016): two-level
-- query — inner orders by HNSW distance for the index to be used, outer
-- applies the cosine-similarity threshold and final LIMIT.
--
-- Schemas live in 20260502040100_pulse_v2_schemas.sql:
--   ct_regime_history.embedded_state extensions.vector(512)
--   HNSW index ct_regime_history_embedded_hnsw on (embedded_state vector_cosine_ops)
--
-- Per regimeContext.ts, this RPC is read-only and called from the
-- buildClaudeContext orchestrator (read path). Producer (ct-regime-capture)
-- writes the embeddings; consumers only search.
-- ============================================================================
SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION public.search_ct_regime_analogs(
  query_embedding   extensions.vector(512),
  match_threshold   numeric,
  match_count       int,
  ticker_filter     text  DEFAULT NULL,    -- NULL = market-wide; '*' = any ticker
  exclude_after_ts  timestamptz DEFAULT NULL  -- exclude rows newer than this (avoid self-match on current bucket)
)
RETURNS TABLE (
  id              bigint,
  ticker          text,
  bucket_ts       timestamptz,
  classification  text,
  confidence      numeric,
  rich_text       text,
  rationale       jsonb,
  similarity      numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
  SELECT
    id,
    ticker,
    bucket_ts,
    classification,
    confidence,
    rich_text,
    rationale,
    similarity
  FROM (
    SELECT
      h.id,
      h.ticker,
      h.bucket_ts,
      h.classification,
      h.confidence,
      h.rich_text,
      h.rationale,
      1 - (h.embedded_state <=> query_embedding) AS similarity
    FROM public.ct_regime_history h
    WHERE h.embedded_state IS NOT NULL
      AND (
        ticker_filter IS NULL AND h.ticker IS NULL                  -- market-wide only
        OR ticker_filter = '*'                                       -- any ticker
        OR h.ticker = ticker_filter                                  -- specific ticker
      )
      AND (exclude_after_ts IS NULL OR h.bucket_ts < exclude_after_ts)
    ORDER BY h.embedded_state <=> query_embedding
    LIMIT GREATEST(match_count * 3, 12)
  ) ranked
  WHERE similarity >= match_threshold
  ORDER BY similarity DESC
  LIMIT match_count;
$fn$;

GRANT EXECUTE ON FUNCTION public.search_ct_regime_analogs(
  extensions.vector(512), numeric, int, text, timestamptz
) TO authenticated, service_role;

COMMENT ON FUNCTION public.search_ct_regime_analogs IS
  'Cosine-similarity search over ct_regime_history.embedded_state. Read by regimeContext brain organ. ticker_filter: NULL=market-wide row only, ''*''=any ticker, ''SPY''=that ticker. exclude_after_ts skips current-bucket self-matches.';
