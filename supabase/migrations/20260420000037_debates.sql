-- =============================================================================
-- 20260420000037_debates.sql
--
-- ct_debates — persistence for /debate cards. Each row is one debate: the
-- topic, bull/bear steel-mans, Claude's prior lean + cited grade, bias risk,
-- and the neutral synthesis. James decides the winner by clicking one of the
-- Pick buttons (BULL / BEAR / NEITHER) — ct-debate-outcome-scorer later
-- resolves user_pick into outcome_verdict (right/wrong/pending) by measuring
-- whether the picked side's best_trade would have prevailed over horizon_hrs.
--
-- Why persist now (wave 26 was ephemeral):
--   "Which way did James go on this? Was he right? Is there a pattern?"
--   Ephemeral debates can't answer that — persistence is the prerequisite for
--   a James-vs-Claude win-rate comparison (see /debates page + Scorecard
--   cross-link).
--
-- Embedding: the TOPIC is embedded once on save (Voyage 512-dim). Semantic
-- search over past debates uses ct_debates.embedding directly — no
-- ct_embeddings sidecar row, because debates are their own searchable first-
-- class entity (same pattern as ct_session_embeddings).
-- =============================================================================

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- Table
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ct_debates (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at            timestamptz NOT NULL DEFAULT now(),

  -- Debate content (mirrors the DebateCard shape returned by ct-chat)
  topic                 text NOT NULL,
  bull_case             jsonb NOT NULL DEFAULT '{}'::jsonb,
  bear_case             jsonb NOT NULL DEFAULT '{}'::jsonb,
  your_prior_lean       text,
  recent_grade_on_this  jsonb,
  your_bias_risk        text,
  synthesis             text,
  instrument            text,   -- denormalized from bull_case / topic parse for fast filters

  -- James's call. Null until he clicks a Pick button in ChatPanel.
  user_pick             text CHECK (user_pick IS NULL OR user_pick IN ('bull','bear','neither')),
  user_pick_at          timestamptz,

  -- Outcome resolved by ct-debate-outcome-scorer. 'pending' = horizon not yet
  -- elapsed OR insufficient data even after Haiku fallback.
  outcome_verdict       text CHECK (outcome_verdict IS NULL OR outcome_verdict IN ('right','wrong','pending')),
  outcome_at            timestamptz,
  outcome_detail        jsonb,  -- optional: price move, horizon used, haiku reasoning

  -- Voyage 512-dim embedding of the TOPIC — one-shot on save, never re-embed.
  embedding             extensions.vector(512)
);

COMMENT ON TABLE  public.ct_debates IS
  'Persisted /debate cards. user_pick is James''s call (bull/bear/neither), outcome_verdict is resolved by ct-debate-outcome-scorer after horizon. Topic is embedded (512-dim) on save for semantic search.';
COMMENT ON COLUMN public.ct_debates.user_pick IS
  'James''s manual pick. Stays NULL until he clicks a Pick button — the system NEVER auto-picks a side (per build constraint).';
COMMENT ON COLUMN public.ct_debates.outcome_verdict IS
  'right=picked side prevailed over horizon, wrong=it didn''t, pending=horizon not elapsed or data insufficient even after Haiku fallback.';
COMMENT ON COLUMN public.ct_debates.embedding IS
  'Voyage voyage-3-lite embedding of topic (plus synthesis tail). Written once on save; search uses cosine distance, threshold 0.3.';

-- -----------------------------------------------------------------------------
-- Indexes
-- -----------------------------------------------------------------------------
-- Hot path: list James's debates newest-first (page + dropdown feed).
CREATE INDEX IF NOT EXISTS ct_debates_user_created_idx
  ON public.ct_debates (user_id, created_at DESC);

-- Scorer pickup: "pending outcomes where user already picked".
CREATE INDEX IF NOT EXISTS ct_debates_pending_outcome_idx
  ON public.ct_debates (created_at DESC)
  WHERE user_pick IS NOT NULL AND outcome_verdict IS NULL;

-- Filters on the /debates page.
CREATE INDEX IF NOT EXISTS ct_debates_instrument_idx
  ON public.ct_debates (instrument) WHERE instrument IS NOT NULL;

CREATE INDEX IF NOT EXISTS ct_debates_user_pick_idx
  ON public.ct_debates (user_pick) WHERE user_pick IS NOT NULL;

-- IVFFlat on topic embedding. lists=100 matches the small-corpus pattern used
-- by ct_embeddings and ct_session_embeddings. Rebuild when we cross ~10K
-- debates (years out at a few per week).
CREATE INDEX IF NOT EXISTS ct_debates_ivfflat
  ON public.ct_debates
  USING ivfflat (embedding extensions.vector_cosine_ops)
  WITH (lists = 100);

-- -----------------------------------------------------------------------------
-- RLS — per-user ownership. Service role bypasses.
-- -----------------------------------------------------------------------------
ALTER TABLE public.ct_debates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ct_debates_select_own ON public.ct_debates;
CREATE POLICY ct_debates_select_own
  ON public.ct_debates FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS ct_debates_insert_own ON public.ct_debates;
CREATE POLICY ct_debates_insert_own
  ON public.ct_debates FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS ct_debates_update_own ON public.ct_debates;
CREATE POLICY ct_debates_update_own
  ON public.ct_debates FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS ct_debates_service_all ON public.ct_debates;
CREATE POLICY ct_debates_service_all
  ON public.ct_debates FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

-- -----------------------------------------------------------------------------
-- search_ct_debates — semantic search RPC (threshold 0.3, per build spec).
-- Scoped to a single user — callers pass their uid; service role can pass
-- any uid. Pattern copied verbatim from search_ct_session_analogs (inner
-- ORDER BY for IVFFlat, threshold in outer).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.search_ct_debates(
  query_embedding   extensions.vector(512),
  query_user_id     uuid,
  match_threshold   numeric DEFAULT 0.3,
  match_count       int     DEFAULT 20
)
RETURNS TABLE (
  id                    uuid,
  created_at            timestamptz,
  topic                 text,
  instrument            text,
  your_prior_lean       text,
  user_pick             text,
  outcome_verdict       text,
  similarity            numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
  SELECT
    id, created_at, topic, instrument, your_prior_lean,
    user_pick, outcome_verdict, similarity
  FROM (
    SELECT
      d.id,
      d.created_at,
      d.topic,
      d.instrument,
      d.your_prior_lean,
      d.user_pick,
      d.outcome_verdict,
      1 - (d.embedding <=> query_embedding) AS similarity
    FROM public.ct_debates d
    WHERE d.user_id = query_user_id
      AND d.embedding IS NOT NULL
    ORDER BY d.embedding <=> query_embedding
    LIMIT GREATEST(match_count * 2, 10)
  ) ranked
  WHERE similarity >= match_threshold
  ORDER BY similarity DESC
  LIMIT match_count;
$fn$;

GRANT EXECUTE ON FUNCTION public.search_ct_debates(extensions.vector(512), uuid, numeric, int)
  TO authenticated, service_role;
