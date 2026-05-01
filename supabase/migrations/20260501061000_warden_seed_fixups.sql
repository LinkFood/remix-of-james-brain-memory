-- =============================================================================
-- 20260501061000_warden_seed_fixups.sql
--
-- Two structural fixes uncovered by the very-first warden run:
--
--   (A) run_invariant_query()'s SELECT-only guard was too narrow:
--       lower(btrim(p_sql)) returns 'select\n       case when ...' (newline
--       after SELECT for indented multi-line queries), and the guard's
--       LIKE 'select %' pattern only matches a single space. Five of the
--       seeded invariants fell into this trap. Fix: collapse leading
--       whitespace to a single space before the prefix check, and switch
--       the regex to `\m(select|with)\M` style — matches keyword + any
--       whitespace.
--
--   (B) Two seeded queries referenced non-existent columns:
--       ct_mcp_calls.caller       → actually `source` + `created_at`
--       ct_specialist_reads.created_at → actually `updated_at`
--
-- Both issues are exactly what the Warden was built to catch — so the build
-- self-tested correctly. Recording the fixes here as a structural follow-up
-- (not a band-aid: the guard improvement applies to all future invariants).
-- =============================================================================
SET search_path = public, extensions;

-- ----------------------------------------------------------------------------
-- (A) Wider SELECT-only guard. Same security envelope; better whitespace
--     handling. CREATE OR REPLACE keeps the GRANT/REVOKE intact.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.run_invariant_query(p_sql text)
RETURNS TABLE (
  metric_value numeric,
  message      text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '15s'
AS $$
DECLARE
  v_normalized text;
BEGIN
  -- Normalize: lowercase, strip outer whitespace, collapse internal whitespace
  -- runs to single spaces so the prefix check works on multi-line queries.
  v_normalized := regexp_replace(lower(btrim(p_sql)), '\s+', ' ', 'g');

  -- SELECT-only guard. Allow either `SELECT ...` or a CTE `WITH ... SELECT ...`
  IF NOT (v_normalized LIKE 'select %' OR v_normalized LIKE 'with %') THEN
    RAISE EXCEPTION 'invariant queries must start with SELECT or WITH (got: %)', left(v_normalized, 30);
  END IF;
  -- Single statement only (no mid-query semicolon followed by content).
  IF v_normalized LIKE '%;%' AND position(';' IN v_normalized) < length(v_normalized) THEN
    RAISE EXCEPTION 'invariant queries must be a single statement (no mid-query semicolon)';
  END IF;
  -- Forbid DML/DDL keywords as whole words.
  IF v_normalized ~* '\m(insert|update|delete|truncate|drop|create|alter|grant|revoke|copy|do|call)\M' THEN
    RAISE EXCEPTION 'invariant queries must be read-only (forbidden keyword detected)';
  END IF;

  RETURN QUERY EXECUTE p_sql;
END;
$$;

-- Re-apply privilege grants — CREATE OR REPLACE keeps existing grants but
-- be defensive in case PostgreSQL ever drops them on signature change.
REVOKE ALL ON FUNCTION public.run_invariant_query(text) FROM PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION public.run_invariant_query(text) TO service_role;

-- ----------------------------------------------------------------------------
-- (B) Seed-row column-name fixes.
-- ----------------------------------------------------------------------------

-- ct_chat_no_uw_mcp — actual columns: source (text), created_at (timestamptz)
UPDATE public.ct_invariants
SET query_sql = $q$SELECT count(*)::numeric AS metric_value,
                          'mcp_calls in ct-chat last 24h' AS message
                   FROM ct_mcp_calls
                   WHERE source = 'ct-chat'
                     AND created_at > now() - interval '24 hours'$q$
WHERE name = 'ct_chat_no_uw_mcp';

-- specialist_reads_today — ct_specialist_reads has updated_at, not created_at
UPDATE public.ct_invariants
SET query_sql = $q$WITH wl AS (
       SELECT jsonb_array_elements_text((value)::jsonb) AS ticker
       FROM ct_config WHERE key='watcher.watchlist'
     ),
     reads AS (
       SELECT DISTINCT ticker FROM ct_specialist_reads
       WHERE updated_at >= (now() AT TIME ZONE 'America/New_York')::date
     )
     SELECT
       CASE WHEN extract(hour from now() AT TIME ZONE 'UTC') < 14 THEN 8
            ELSE count(*)
       END::numeric AS metric_value,
       'watchlist tickers with reads today' AS message
     FROM reads, wl
     WHERE reads.ticker = wl.ticker$q$
WHERE name = 'specialist_reads_today';
