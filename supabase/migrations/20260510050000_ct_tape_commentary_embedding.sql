-- ============================================================================
-- Phase 1 (audit-driven, 2026-05-09 fusion ground-truth doc Section B gap #2):
-- Embed ct_tape_commentary at write-time so semantic recall over historical
-- tape reads becomes possible.
--
-- Closes the JAC OS embedding-gate gap on the load-bearing narrative table
-- ct-tape-reader writes every 10 min RTH (~50-80 rows/day). Without this,
-- the iter #2 hint at src/components/alpha/ClaudesRead.tsx:154 ("5 most-
-- similar past reads + their NextClose outcomes") is impossible.
--
-- Pattern follows the regime/session embedding precedent:
--   - inline `embedding extensions.vector(512)` column on the source table
--   - `rich_text` column carrying what got embedded (regime/tide context +
--     commentary text — so similar setups cluster, not just similar prose)
--   - HNSW COSINE index
--   - match_* RPC with two-level query (inner orders by HNSW distance for
--     index use, outer applies threshold and final LIMIT)
--   - warden invariant catching write-time gate failures
--
-- Producer change: ct-tape-reader is updated in this same ship to compute
-- rich_text + voyageEmbed + UPDATE the row after the initial INSERT
-- (fire-and-forget; never blocks the response).
--
-- Backfill: handled by ct-embed-tape-commentary backlog cron (next migration).
-- ============================================================================
SET search_path = public, extensions;

-- 1. Add embedding + rich_text columns
ALTER TABLE public.ct_tape_commentary
  ADD COLUMN IF NOT EXISTS embedding extensions.vector(512),
  ADD COLUMN IF NOT EXISTS rich_text text;

COMMENT ON COLUMN public.ct_tape_commentary.embedding IS
  'Voyage 3-lite 512-dim embedding of rich_text. Semantic-recall substrate for /alpha ClaudesRead "5 most-similar past reads" surface.';
COMMENT ON COLUMN public.ct_tape_commentary.rich_text IS
  'What got embedded: "TAPE_COMMENTARY | tide:X vix:Y flags:N flow:M | session:DATE\n<commentary>". Cluster axis is regime/state, not just prose.';

-- 2. HNSW COSINE index
CREATE INDEX IF NOT EXISTS ct_tape_commentary_embedding_hnsw
  ON public.ct_tape_commentary
  USING hnsw (embedding extensions.vector_cosine_ops)
  WHERE embedding IS NOT NULL;

-- 3. match RPC — mirrors search_ct_regime_analogs (20260502040400) two-level
--    query pattern: inner orders by HNSW distance for index use, outer
--    applies threshold and final LIMIT.
CREATE OR REPLACE FUNCTION public.match_ct_tape_commentary_by_similarity(
  query_embedding   extensions.vector(512),
  match_threshold   numeric DEFAULT 0.5,
  match_count       int     DEFAULT 5,
  exclude_after_ts  timestamptz DEFAULT NULL,  -- skip current run's own row
  session_date_filter date DEFAULT NULL         -- NULL = any session; date = restrict
)
RETURNS TABLE (
  id              bigint,
  created_at      timestamptz,
  session_date    date,
  trigger_kind    text,
  commentary      text,
  rich_text       text,
  market_tide     text,
  vix_level       numeric,
  flow_ids        bigint[],
  flag_ids        uuid[],
  similarity      numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
  SELECT
    id,
    created_at,
    session_date,
    trigger_kind,
    commentary,
    rich_text,
    market_tide,
    vix_level,
    flow_ids,
    flag_ids,
    similarity
  FROM (
    SELECT
      t.id,
      t.created_at,
      t.session_date,
      t.trigger_kind,
      t.commentary,
      t.rich_text,
      t.market_tide,
      t.vix_level,
      t.flow_ids,
      t.flag_ids,
      1 - (t.embedding <=> query_embedding) AS similarity
    FROM public.ct_tape_commentary t
    WHERE t.embedding IS NOT NULL
      AND (exclude_after_ts IS NULL OR t.created_at < exclude_after_ts)
      AND (session_date_filter IS NULL OR t.session_date = session_date_filter)
    ORDER BY t.embedding <=> query_embedding
    LIMIT GREATEST(match_count * 3, 12)
  ) ranked
  WHERE similarity >= match_threshold
  ORDER BY similarity DESC
  LIMIT match_count;
$fn$;

GRANT EXECUTE ON FUNCTION public.match_ct_tape_commentary_by_similarity(
  extensions.vector(512), numeric, int, timestamptz, date
) TO authenticated, service_role;

COMMENT ON FUNCTION public.match_ct_tape_commentary_by_similarity IS
  'Cosine-similarity search over ct_tape_commentary.embedding. Returns 5 most-similar prior reads to the supplied query embedding. Used by /alpha ClaudesRead semantic-recall surface (Phase 4) and by tapeContext brain organ (future). exclude_after_ts skips the current runs own row to prevent self-match.';

-- 4. Warden invariant — write-time gate failure detector
--    EXISTS-guards via 1-hour window so it stays dormant until ct-tape-reader
--    deploys and starts producing un-embedded freshly-written rows
--    (per feedback_warden_dormant_until_active_pattern.md).
--    Catches scenarios: Voyage outage, embed code path broken, write-time
--    wiring regression in ct-tape-reader.
INSERT INTO public.ct_invariants (
  name, category, description, query_sql,
  expected_min, expected_max, severity, runbook_path
) VALUES (
  'tape_commentary_embedding_backlog_1h',
  'embedding_gate',
  'Count of ct_tape_commentary rows in the last 1 hour with NULL embedding. Catches write-time embedding gate failures (Voyage outage, code regression). Expected 0 - 2 (allows in-flight + transient retry).',
  'SELECT count(*)::numeric AS metric_value, ''rows ''||count(*)||'' un-embedded in last 1h'' AS message FROM public.ct_tape_commentary WHERE created_at >= now() - interval ''1 hour'' AND embedding IS NULL',
  0,
  2,
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
