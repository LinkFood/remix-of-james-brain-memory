-- ============================================================================
-- Phase 7a — Specialist substrate (write-time embedding on ct_specialist_reads)
--
-- Pre-baked Phase B per docs/audit/2026-05-09-phase-7-specialist-substrate-phase-a.md.
-- Window-safety: additive substrate ship. No consumer change. specialistRecallContext
-- continues reading chronological recall unchanged. Phase 7b (semantic swap)
-- explicitly gated on captain go post-D2.2 verdict.
--
-- Mirrors Phase 1 (PR #86 / ct_tape_commentary) substrate template — single
-- producer (specialistRunner.writeSpecialistRead), so write-time embed in the
-- producer + cron-drainer backstop (Migration B). Phase 2's cron-only pattern
-- was a two-producer pivot; Phase 7 doesn't have that asymmetry.
--
-- ct_specialist_memory has the dead writer (cascade #43 codification —
-- atlas Phase A finding 2026-05-09 evening surfaced a possible status drift
-- but the target HERE is ct_specialist_reads regardless: it's the live track-
-- record substrate the recall organ reads).
-- ============================================================================
SET search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- 1. Add embedding + rich_text columns
-- ---------------------------------------------------------------------------
ALTER TABLE public.ct_specialist_reads
  ADD COLUMN IF NOT EXISTS embedding extensions.vector(512),
  ADD COLUMN IF NOT EXISTS rich_text text;

COMMENT ON COLUMN public.ct_specialist_reads.embedding IS
  'Voyage 3-lite 512-dim embedding of rich_text. Semantic-recall substrate for the per-ticker Specialist Learning Arc on /alpha (Phase 7c) and the optional semantic swap of UNFLAGGED recall in specialistRecallContext (Phase 7b).';
COMMENT ON COLUMN public.ct_specialist_reads.rich_text IS
  'What got embedded. Cluster axis: ticker + lean + conviction band + flagged + session date. Setup-shape clusters, not just prose.';

-- ---------------------------------------------------------------------------
-- 2. HNSW COSINE index — partial on embedding IS NOT NULL
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ct_specialist_reads_embedding_hnsw
  ON public.ct_specialist_reads
  USING hnsw (embedding extensions.vector_cosine_ops)
  WHERE embedding IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. match RPC — two-level query (inner orders by HNSW distance for index use,
--    outer applies threshold + final LIMIT). Mirrors the tape_commentary +
--    regime_analogs precedent.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.match_ct_specialist_reads_by_similarity(
  query_embedding   extensions.vector(512),
  match_threshold   numeric DEFAULT 0.5,
  match_count       int     DEFAULT 5,
  exclude_after_ts  timestamptz DEFAULT NULL,    -- skip current run's own row
  ticker_filter     text    DEFAULT NULL,        -- per-specialist narrow; NULL = any
  min_conviction    int     DEFAULT NULL,        -- NULL = any conviction; int = conv >= N
  flagged_filter    boolean DEFAULT NULL         -- NULL=any, true=flagged-only, false=unflagged-only
)
RETURNS TABLE (
  id             bigint,
  ticker         text,
  updated_at     timestamptz,
  direction_lean text,
  conviction     int,
  flagged        boolean,
  flag_id        uuid,
  read_text      text,
  rich_text      text,
  similarity     numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
  SELECT id, ticker, updated_at, direction_lean, conviction, flagged, flag_id,
         read_text, rich_text, similarity
  FROM (
    SELECT
      r.id, r.ticker, r.updated_at, r.direction_lean, r.conviction, r.flagged,
      r.flag_id, r.read_text, r.rich_text,
      1 - (r.embedding <=> query_embedding) AS similarity
    FROM public.ct_specialist_reads r
    WHERE r.embedding IS NOT NULL
      AND (exclude_after_ts IS NULL OR r.updated_at < exclude_after_ts)
      AND (ticker_filter   IS NULL OR r.ticker = ticker_filter)
      AND (min_conviction  IS NULL OR r.conviction >= min_conviction)
      AND (flagged_filter  IS NULL OR r.flagged = flagged_filter)
    ORDER BY r.embedding <=> query_embedding
    LIMIT GREATEST(match_count * 3, 12)
  ) ranked
  WHERE similarity >= match_threshold
  ORDER BY similarity DESC
  LIMIT match_count;
$fn$;

GRANT EXECUTE ON FUNCTION public.match_ct_specialist_reads_by_similarity(
  extensions.vector(512), numeric, int, timestamptz, text, int, boolean
) TO authenticated, service_role;

COMMENT ON FUNCTION public.match_ct_specialist_reads_by_similarity IS
  'Cosine-similarity search over ct_specialist_reads.embedding. Returns N most-similar prior reads to the supplied query embedding, with optional ticker / conviction / flagged narrowing. Used by Specialist Learning Arc on /alpha (Phase 7c) and the optional semantic swap of UNFLAGGED recall in specialistRecallContext (Phase 7b — gated). exclude_after_ts skips the current runs own row to prevent self-match.';

-- ---------------------------------------------------------------------------
-- 4. Warden invariant — write-time gate failure detector
--    10 tickers x ~6/hr cadence ~= 60 rows/hr. Phase 1 (tape_commentary) was
--    a single writer with expected_max=2; this is 10. Allow ~16% transient
--    drift before alert. Drainer is the 5-min backstop.
-- ---------------------------------------------------------------------------
INSERT INTO public.ct_invariants (
  name, category, description, query_sql,
  expected_min, expected_max, severity, runbook_path
) VALUES (
  'specialist_reads_embedding_backlog_1h',
  'embedding_gate',
  'Count of ct_specialist_reads rows in the last 1 hour with NULL embedding. Catches write-time embedding gate failures (Voyage outage, code regression). Expected 0 - 10 (10 tickers x ~6/hr cadence; allows in-flight + transient retry; drainer cron is the backstop).',
  'SELECT count(*)::numeric AS metric_value, ''rows ''||count(*)||'' un-embedded in last 1h'' AS message FROM public.ct_specialist_reads WHERE updated_at >= now() - interval ''1 hour'' AND embedding IS NULL',
  0,
  10,
  'warn',
  'docs/runbooks/embedding_gate.md'
)
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description,
  query_sql = EXCLUDED.query_sql,
  expected_min = EXCLUDED.expected_min,
  expected_max = EXCLUDED.expected_max,
  severity = EXCLUDED.severity,
  runbook_path = EXCLUDED.runbook_path,
  updated_at = now();
