-- =============================================================================
-- 20260502040800_warden_invariant_query_fixes.sql
--
-- Fix two warden invariant queries that tripped the run_invariant_query
-- validator on first warden fire after tonight's v2 builds:
--
-- 1) cron_zero_row_upsert_silent_failure_class — used ' ; ' as the failure-
--    list separator inside string_agg, which the validator's mid-query
--    semicolon check (position(';' IN v_trimmed) < length(v_trimmed)) flags.
--    Change separator to ' / '.
--
-- 2) specialist_scoreboard_v2_freshness — message string contained the word
--    'update', which the validator's \m(insert|update|delete|...)\M regex
--    catches as a standalone word inside a string literal. Change to
--    'refresh' which carries the same operator meaning.
-- =============================================================================
SET search_path = public, extensions;

UPDATE public.ct_invariants
SET query_sql = $sql$
    WITH failures AS (
      SELECT * FROM public.check_growth_cron_silent_failures()
    )
    SELECT
      COUNT(*)::numeric AS metric_value,
      CASE
        WHEN COUNT(*) = 0 THEN 'all growth-crons producing rows on cadence'
        ELSE string_agg(message, ' / ' ORDER BY cron_jobname)
      END AS message
    FROM failures
  $sql$
WHERE name = 'cron_zero_row_upsert_silent_failure_class';

UPDATE public.ct_invariants
SET query_sql = $sql$
    SELECT
      CASE
        WHEN MAX(last_updated) IS NULL THEN 0
        ELSE EXTRACT(EPOCH FROM (now() - MAX(last_updated))) / 3600
      END::numeric AS metric_value,
      CASE
        WHEN MAX(last_updated) IS NULL THEN '[scoreboard_v2] no rows yet — first cron fire pending'
        ELSE '[scoreboard_v2] last refresh ' || ROUND(EXTRACT(EPOCH FROM (now() - MAX(last_updated))) / 3600, 1)::text || ' h ago'
      END AS message
    FROM public.ct_specialist_scoreboard_v2
  $sql$
WHERE name = 'specialist_scoreboard_v2_freshness';
