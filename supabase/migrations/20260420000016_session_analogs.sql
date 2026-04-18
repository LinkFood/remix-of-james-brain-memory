-- ============================================================================
-- Session Analogs — "find past sessions most similar to today's tape"
--
-- Core idea: condense each trading day into a single text summary + feature
-- JSONB, embed it with Voyage 512-dim, and semantic-search against it. One
-- row per session_date, so the table is tiny and the IVFFlat index stays
-- blazingly fast.
--
-- Used by: ct-session-analog edge function (build + search modes) and the
-- HistoricalAnalogsCard on CommandStation.
--
-- Cost: 1 Voyage call / day (nightly cron) + 1 Voyage call on search. That's
-- it. Zero new UW calls — all inputs come from existing ct_heartbeats /
-- ct_iv_rank_daily / ct_news_analyses.
-- ============================================================================
SET search_path = public, extensions;

-- ============================================================================
-- ct_session_embeddings — one row per session_date, per `through_utc` snapshot
-- UNIQUE is on (session_date, through_utc) so we can embed multiple snapshots
-- per day if we ever want intraday analogs (e.g. open + midday + close).
-- ============================================================================
CREATE TABLE IF NOT EXISTS ct_session_embeddings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_date      date        NOT NULL,
  through_utc       timestamptz NOT NULL,   -- e.g. 17:00 UTC = midday, 21:00 UTC = close
  state_summary     text        NOT NULL,   -- human-readable narrative for embedding
  state_features    jsonb       NOT NULL DEFAULT '{}',  -- structured features (for filter + display)
  embedding         extensions.vector(512) NOT NULL,
  eod_return_pct    numeric,                -- SPY close return; NULL until EOD materialized
  eod_summary       text,                   -- 1-line outcome ("closed -0.4%, failed to hold call wall")
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_date, through_utc)
);

-- ============================================================================
-- Indexes — IVFFlat for vector search (copy the pattern from ct_embeddings;
-- lists=100 is right for small-corpus single-user use; rebuild when we hit
-- ~10K session embeddings, which at 1/day is ~27 years out).
-- ============================================================================
CREATE INDEX IF NOT EXISTS ct_session_embeddings_ivfflat
  ON ct_session_embeddings
  USING ivfflat (embedding extensions.vector_cosine_ops)
  WITH (lists = 100);

CREATE INDEX IF NOT EXISTS ct_session_embeddings_date_idx
  ON ct_session_embeddings (session_date DESC);

CREATE INDEX IF NOT EXISTS ct_session_embeddings_through_idx
  ON ct_session_embeddings (through_utc DESC);

-- ============================================================================
-- RLS — same model as ct_embeddings: authenticated read, service role write.
-- ============================================================================
ALTER TABLE ct_session_embeddings ENABLE ROW LEVEL SECURITY;

CREATE POLICY ct_session_embeddings_authenticated_read
  ON ct_session_embeddings FOR SELECT TO authenticated USING (true);

CREATE POLICY ct_session_embeddings_service_role_all
  ON ct_session_embeddings FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- ============================================================================
-- search_ct_session_analogs — vector RPC. Excludes the query session itself.
--
-- Inner-query orders by distance for IVFFlat, threshold in outer query.
-- (Pattern from DCD hunt_knowledge — IVFFlat requires ORDER BY in the same
-- query level that the index is tuned for.)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.search_ct_session_analogs(
  query_embedding   extensions.vector(512),
  match_threshold   numeric,
  match_count       int,
  exclude_date      date DEFAULT NULL
)
RETURNS TABLE (
  id              uuid,
  session_date    date,
  through_utc     timestamptz,
  state_summary   text,
  state_features  jsonb,
  eod_return_pct  numeric,
  eod_summary     text,
  similarity      numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
  SELECT
    id,
    session_date,
    through_utc,
    state_summary,
    state_features,
    eod_return_pct,
    eod_summary,
    similarity
  FROM (
    SELECT
      e.id,
      e.session_date,
      e.through_utc,
      e.state_summary,
      e.state_features,
      e.eod_return_pct,
      e.eod_summary,
      1 - (e.embedding <=> query_embedding) AS similarity
    FROM ct_session_embeddings e
    WHERE (exclude_date IS NULL OR e.session_date <> exclude_date)
    ORDER BY e.embedding <=> query_embedding
    LIMIT GREATEST(match_count * 2, 10)
  ) ranked
  WHERE similarity >= match_threshold
  ORDER BY similarity DESC
  LIMIT match_count;
$fn$;

GRANT EXECUTE ON FUNCTION public.search_ct_session_analogs(extensions.vector(512), numeric, int, date)
  TO authenticated, service_role;

-- ============================================================================
-- trigger_ct_session_analog — RPC helper for "run now" / cron, matches the
-- `_ct_post` pattern used everywhere else in Co-Trader. Body is empty — the
-- function defaults to `{ mode: 'build', session_date: today }` when called
-- without a body.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.trigger_ct_session_analog()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$ SELECT public._ct_post('ct-session-analog'); $fn$;

GRANT EXECUTE ON FUNCTION public.trigger_ct_session_analog() TO authenticated, service_role;
