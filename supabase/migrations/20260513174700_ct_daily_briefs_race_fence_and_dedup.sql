-- 20260513174700 — ct_daily_briefs race-fence + historical chain reconciliation
--
-- Class kill: simultaneous scheduled-vs-breaking_news fires within ~1s produce
-- two rows with (session_date, brief_version=1), supersedes_id=null. /morning-brief
-- renders two "Morning Brief" cards with identical timestamps. Five empirical
-- instances on prod: 2026-05-13, 2026-05-12, 2026-05-05, 2026-04-30, 2026-04-29.
--
-- Three structural fixes in this migration:
--   1. Historical cleanup — per session_date, order rows by created_at ASC and
--      re-number brief_version monotonically from 1, repointing supersedes_id
--      down the chain. Promoted rows with triggered_by!='scheduled' and
--      urgency='normal' bump to urgency='high'.
--   2. UNIQUE (session_date, brief_version) — DB-layer guard against future
--      duplicates. Idempotent — UNIQUE INDEX IF NOT EXISTS pattern.
--   3. pg_advisory_xact_lock_text(text) helper + ct_insert_daily_brief_locked
--      wrapper RPC that holds the lock across find-prior-max + INSERT in one
--      transaction. supabase-js sends individual statements as separate
--      transactions; the lock must live inside the RPC to be useful.
--
-- The writer (ct-daily-brief/index.ts) is patched in this same ship to call
-- the wrapper RPC instead of the bare INSERT. The wrapper also closes the
-- scheduled-skips-findPrior hole: every triggered_by path now reads prior max
-- under the lock, regardless of whether triggered_by is breaking_news / regime_shift
-- (the old code only called findPrior for those).

-- ----------------------------------------------------------------------------
-- Step 1: Historical chain reconciliation
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_date date;
  v_row record;
  v_prev_id uuid;
  v_new_version int;
BEGIN
  -- Only touch session_dates that have a duplicate-v1 condition. Sessions with
  -- a single v1 + clean v2/v3/... chain stay unchanged.
  FOR v_date IN
    SELECT session_date
    FROM ct_daily_briefs
    GROUP BY session_date
    HAVING count(*) FILTER (WHERE brief_version = 1) > 1
    ORDER BY session_date
  LOOP
    v_prev_id := NULL;
    v_new_version := 0;
    FOR v_row IN
      SELECT id, brief_version, triggered_by, urgency, created_at
      FROM ct_daily_briefs
      WHERE session_date = v_date
      ORDER BY created_at ASC, brief_version ASC, id ASC
    LOOP
      v_new_version := v_new_version + 1;
      UPDATE ct_daily_briefs
      SET brief_version = v_new_version,
          supersedes_id = v_prev_id,
          urgency = CASE
            WHEN v_new_version > 1
              AND v_row.urgency = 'normal'
              AND v_row.triggered_by <> 'scheduled'
            THEN 'high'
            ELSE v_row.urgency
          END
      WHERE id = v_row.id;
      v_prev_id := v_row.id;
    END LOOP;
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- Step 2: UNIQUE guard on (session_date, brief_version)
-- ----------------------------------------------------------------------------
-- Idempotent — uses a UNIQUE INDEX (not constraint) so re-applying the
-- migration is a no-op even after the index exists. Functionally equivalent.
CREATE UNIQUE INDEX IF NOT EXISTS ct_daily_briefs_session_version_unique
  ON ct_daily_briefs (session_date, brief_version);

-- ----------------------------------------------------------------------------
-- Step 3: Advisory lock helper + wrapper RPC
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pg_advisory_xact_lock_text(p_key text)
RETURNS void
LANGUAGE sql
AS $$
  SELECT pg_advisory_xact_lock(hashtext(p_key))
$$;

GRANT EXECUTE ON FUNCTION public.pg_advisory_xact_lock_text(text) TO service_role;

-- Wrapper RPC: computes brief_version + supersedes_id under transaction-scoped
-- lock, then INSERTs. Caller passes the full payload as jsonb. Returns the
-- inserted row's key fields. Caller does NOT pre-compute brief_version or
-- supersedes_id — the RPC owns that decision so the lock can fence it.
--
-- The session_date and triggered_by are passed as scalar args so they're
-- typechecked + indexable in the lock-key derivation; the rest of the payload
-- is the row body.
CREATE OR REPLACE FUNCTION public.ct_insert_daily_brief_locked(
  p_session_date date,
  p_triggered_by text,
  p_urgency text,
  p_supersedes_id_hint uuid,
  p_payload jsonb
)
RETURNS TABLE (
  id uuid,
  brief_version int,
  urgency text,
  session_date date,
  triggered_by text,
  supersedes_id uuid
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_brief_version int := 1;
  v_supersedes_id uuid := p_supersedes_id_hint;
  v_inserted_id uuid;
  v_prior_id uuid;
  v_prior_version int;
BEGIN
  -- Lock the session_date partition. Released on transaction end (RPC return).
  PERFORM pg_advisory_xact_lock(hashtext(p_session_date::text));

  -- Always check for prior — closes the scheduled-skips-findPrior hole.
  SELECT cd.id, cd.brief_version
    INTO v_prior_id, v_prior_version
  FROM ct_daily_briefs cd
  WHERE cd.session_date = p_session_date
  ORDER BY cd.brief_version DESC
  LIMIT 1;

  IF v_prior_version IS NOT NULL THEN
    v_brief_version := v_prior_version + 1;
    -- If caller didn't pass a hint, point at the immediate predecessor.
    IF v_supersedes_id IS NULL THEN
      v_supersedes_id := v_prior_id;
    END IF;
  END IF;

  INSERT INTO ct_daily_briefs (
    session_date,
    brief_version,
    triggered_by,
    supersedes_id,
    urgency,
    macro_narrative,
    macro_regime,
    breaking_events,
    overnight_action,
    recent_prints,
    per_ticker,
    convergent_view,
    high_conviction_ideas,
    watchlist_focus,
    skip_today,
    generated_by_model,
    ttl_hours,
    expires_at
  ) VALUES (
    p_session_date,
    v_brief_version,
    p_triggered_by,
    v_supersedes_id,
    p_urgency,
    p_payload->>'macro_narrative',
    p_payload->>'macro_regime',
    COALESCE(p_payload->'breaking_events', '[]'::jsonb),
    p_payload->>'overnight_action',
    COALESCE(p_payload->'recent_prints', '[]'::jsonb),
    COALESCE(p_payload->'per_ticker', '[]'::jsonb),
    p_payload->>'convergent_view',
    COALESCE(p_payload->'high_conviction_ideas', '[]'::jsonb),
    COALESCE((SELECT array_agg(value::text) FROM jsonb_array_elements_text(p_payload->'watchlist_focus')), ARRAY[]::text[]),
    COALESCE((SELECT array_agg(value::text) FROM jsonb_array_elements_text(p_payload->'skip_today')), ARRAY[]::text[]),
    COALESCE(p_payload->>'generated_by_model', 'sonnet'),
    COALESCE((p_payload->>'ttl_hours')::int, 8),
    (p_payload->>'expires_at')::timestamptz
  )
  RETURNING ct_daily_briefs.id INTO v_inserted_id;

  RETURN QUERY
    SELECT cd.id, cd.brief_version, cd.urgency, cd.session_date, cd.triggered_by, cd.supersedes_id
    FROM ct_daily_briefs cd
    WHERE cd.id = v_inserted_id;
END $$;

GRANT EXECUTE ON FUNCTION public.ct_insert_daily_brief_locked(date, text, text, uuid, jsonb) TO service_role;
