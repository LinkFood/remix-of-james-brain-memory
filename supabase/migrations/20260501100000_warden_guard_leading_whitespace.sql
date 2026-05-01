-- =============================================================================
-- 20260501100000_warden_guard_leading_whitespace.sql
--
-- Tighten run_invariant_query's whitespace handling. The earlier fix
-- (20260501061000) did `lower(btrim(p_sql))` THEN collapsed `\s+` to single
-- space — wrong order. SQL written with a leading newline + indent (the
-- $sql$/$q$ heredoc style used throughout the seed migrations) ends up as
-- " select ..." with a stray leading space after the regex pass, and the
-- guard's `LIKE 'select %'` check rejects it.
--
-- Caught tonight by:
--   chat_off_universe_mentions_24h         (status=error, 2 consecutive)
--   specialist_reads_per_ticker_today_rth  (status=error, 1 consecutive)
--   specialist_memory_table_dead           (status=error, 1 consecutive)
--
-- Fix: collapse whitespace FIRST, then btrim. One change, no need to touch
-- any seeded query_sql rows. Class kill for any future invariant — heredoc-
-- style multi-line queries now Just Work regardless of leading indentation.
-- =============================================================================
SET search_path = public, extensions;

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
  -- Collapse ALL whitespace runs (newlines, tabs, multiple spaces) to a
  -- single space FIRST, then strip outer whitespace, then lowercase. The
  -- order matters: regexp_replace first means a leading "\n   select ..."
  -- becomes " select ...", btrim strips the lone leading space, lower
  -- normalizes the case for the LIKE check.
  v_normalized := lower(btrim(regexp_replace(p_sql, '\s+', ' ', 'g')));

  -- SELECT-only guard. Allow either `SELECT ...` or a CTE `WITH ... SELECT ...`.
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

REVOKE ALL ON FUNCTION public.run_invariant_query(text) FROM PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION public.run_invariant_query(text) TO service_role;
