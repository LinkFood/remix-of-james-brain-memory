-- ============================================================================
-- Class-kill: parallel-drainer duplicate-work race on embedding backlogs.
--
-- Surfaced 2026-05-09 12:24Z by session-A's manual drain to populate Phase 4
-- semantic recall on hot corpus tonight. Fired 10 parallel `invoke_edge_function`
-- calls to ct-embed-tape-commentary; only ~100 unique rows drained — the other
-- ~900 Voyage calls re-embedded the same top-100 set because all 10 callers'
-- SELECTs ran near-simultaneously, each grabbed `WHERE embedding IS NULL ORDER
-- BY created_at DESC LIMIT 100`, returned the same row set, all 10 raced to
-- UPDATE.
--
-- Class: any concurrent caller of either drainer (manual ad-hoc + cron tick;
-- multiple operators pasting drains; future autoscaled drainers) hits this.
--
-- Fix: replace the JS-side `.from(...).select(...).is('embedding', null)`
-- claim with an RPC that does the SELECT + UPDATE atomically inside one
-- statement using FOR UPDATE SKIP LOCKED. Each caller gets a unique slice of
-- the un-embedded set; concurrent callers skip rows already claimed.
--
-- Sentinel marker: claimed rows get `embedding` set to a zero-vector
-- placeholder. `embedding IS NULL` filters in subsequent claim calls + match
-- RPCs naturally exclude them. Successful drainer processing overwrites the
-- sentinel with the real Voyage embedding + rich_text in a follow-up UPDATE.
--
-- Recovery: a row stuck at sentinel (drainer crashed mid-embed) is detectable
-- as `embedding IS NOT NULL AND rich_text IS NULL`. The reset RPC unblocks
-- such rows. See the runbook for the manual recovery sequence.
--
-- LOC class-kill, not patch: any future drainer following this pattern
-- inherits the safety. Code-only fix; no behavior change to producers,
-- consumers, or warden invariants.
-- ============================================================================
SET search_path = public, extensions;

-- ----------------------------------------------------------------------------
-- 1. claim_unembedded_breaking_news
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_unembedded_breaking_news(p_batch_size int)
RETURNS TABLE (
  id                uuid,
  ingested_at       timestamptz,
  source            text,
  headline          text,
  summary           text,
  severity          int,
  sentiment         text,
  category          text,
  tickers_affected  text[],
  macro_wide        boolean
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
  WITH claimed AS (
    SELECT n.id
    FROM public.ct_breaking_news n
    WHERE n.embedding IS NULL
    ORDER BY n.ingested_at DESC
    LIMIT GREATEST(p_batch_size, 1)
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.ct_breaking_news u
  SET embedding = (('[' || repeat('0,', 511) || '0]')::extensions.vector(512))
  FROM claimed c
  WHERE u.id = c.id
  RETURNING u.id, u.ingested_at, u.source, u.headline, u.summary, u.severity,
            u.sentiment, u.category, u.tickers_affected, u.macro_wide;
$fn$;

GRANT EXECUTE ON FUNCTION public.claim_unembedded_breaking_news(int)
  TO service_role;

COMMENT ON FUNCTION public.claim_unembedded_breaking_news IS
  'Atomic claim of un-embedded ct_breaking_news rows for the drainer. Uses FOR UPDATE SKIP LOCKED to ensure concurrent callers get disjoint slices. Sets a zero-vector sentinel so subsequent claims skip these rows; the drainer overwrites with the real embedding + rich_text on success. Stuck rows (drainer crash) detectable as embedding IS NOT NULL AND rich_text IS NULL — recoverable via reset_stale_embed_claims.';

-- ----------------------------------------------------------------------------
-- 2. claim_unembedded_tape_commentary
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_unembedded_tape_commentary(p_batch_size int)
RETURNS TABLE (
  id            bigint,
  created_at    timestamptz,
  session_date  date,
  commentary    text,
  market_tide   text,
  vix_level     numeric,
  flow_ids      bigint[],
  flag_ids      uuid[]
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
  WITH claimed AS (
    SELECT t.id
    FROM public.ct_tape_commentary t
    WHERE t.embedding IS NULL
    ORDER BY t.created_at DESC
    LIMIT GREATEST(p_batch_size, 1)
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.ct_tape_commentary u
  SET embedding = (('[' || repeat('0,', 511) || '0]')::extensions.vector(512))
  FROM claimed c
  WHERE u.id = c.id
  RETURNING u.id, u.created_at, u.session_date, u.commentary, u.market_tide,
            u.vix_level, u.flow_ids, u.flag_ids;
$fn$;

GRANT EXECUTE ON FUNCTION public.claim_unembedded_tape_commentary(int)
  TO service_role;

COMMENT ON FUNCTION public.claim_unembedded_tape_commentary IS
  'Atomic claim of un-embedded ct_tape_commentary rows for the drainer. Mirrors claim_unembedded_breaking_news. Sets a zero-vector sentinel so subsequent claims skip these rows; the drainer overwrites with the real embedding + rich_text on success.';

-- ----------------------------------------------------------------------------
-- 3. Recovery — reset stuck sentinel claims
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reset_stale_embed_claims(
  p_table             text,
  p_max_age_minutes   int DEFAULT 5
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  reset_count int := 0;
BEGIN
  IF p_table = 'ct_breaking_news' THEN
    UPDATE public.ct_breaking_news
    SET embedding = NULL
    WHERE embedding IS NOT NULL
      AND rich_text IS NULL
      AND ingested_at < now() - (p_max_age_minutes::text || ' minutes')::interval;
    GET DIAGNOSTICS reset_count = ROW_COUNT;

  ELSIF p_table = 'ct_tape_commentary' THEN
    UPDATE public.ct_tape_commentary
    SET embedding = NULL
    WHERE embedding IS NOT NULL
      AND rich_text IS NULL
      AND created_at < now() - (p_max_age_minutes::text || ' minutes')::interval;
    GET DIAGNOSTICS reset_count = ROW_COUNT;

  ELSE
    RAISE EXCEPTION 'reset_stale_embed_claims: unknown p_table %', p_table;
  END IF;

  RETURN reset_count;
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.reset_stale_embed_claims(text, int)
  TO service_role;

COMMENT ON FUNCTION public.reset_stale_embed_claims IS
  'Recovers rows stuck at sentinel-zero-vector claim (drainer crashed mid-embed). p_table must be ''ct_breaking_news'' or ''ct_tape_commentary''. Default p_max_age_minutes=5. Returns rows-reset count. Manual fire only — designed for runbook recovery, not crons.';
