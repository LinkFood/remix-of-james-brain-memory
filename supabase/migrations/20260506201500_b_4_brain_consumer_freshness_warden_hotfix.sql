-- =============================================================================
-- 20260506201500_b_4_brain_consumer_freshness_warden_hotfix.sql
--
-- Hotfix: B-4 invariant errored on first warden run with
-- "invariant queries must be a single statement (no mid-query semicolon)"
-- Cause: SQL inline comments inside the CTE VALUES rows contained semicolons
-- (e.g., "-- periodic; some gaps OK"). Warden's parser flagged the `;` in
-- comments as mid-query terminators.
--
-- Fix: re-issue the invariant with the same logic, semicolons in comments
-- replaced with hyphens. Re-enable.
-- =============================================================================

SET search_path = public, extensions;

UPDATE public.ct_invariants
SET query_sql = $$
WITH context AS (
  SELECT
    extract(isodow from now())::int AS utc_dow,
    extract(hour   from now())::int AS utc_hour
),
is_rth AS (
  SELECT
    (utc_dow BETWEEN 1 AND 5) AND (utc_hour BETWEEN 14 AND 19) AS rth
  FROM context
),
covered_consumers(consumer_name, threshold_hours) AS (
  VALUES
    ('ct-tape-reader',             0.5),
    ('ct-watcher',                 1.0),
    ('ct-curiosity',               2.0),
    ('ct-news-sweep',              2.0),
    ('ct-hypothesis-health-check', 1.0),
    ('ct-hypothesis-proposer',     2.0),
    ('ct-alert-post-mortem',       4.0),
    ('ct-self-grader',             4.0),
    ('ct-daily-brief',            26.0)
),
per_consumer_freshness AS (
  SELECT
    cc.consumer_name,
    cc.threshold_hours,
    MAX(t.created_at) AS last_write_at,
    EXTRACT(EPOCH FROM (now() - COALESCE(MAX(t.created_at), now() - interval '999 hours'))) / 3600.0 AS hours_since_last_write
  FROM covered_consumers cc
  LEFT JOIN public.ct_brain_telemetry t
    ON t.consumer_name = cc.consumer_name
   AND t.created_at >= now() - interval '7 days'
  GROUP BY cc.consumer_name, cc.threshold_hours
),
silent AS (
  SELECT consumer_name, hours_since_last_write, threshold_hours
  FROM per_consumer_freshness
  WHERE hours_since_last_write > threshold_hours
)
SELECT
  CASE WHEN (SELECT rth FROM is_rth)
    THEN (SELECT COUNT(*)::numeric FROM silent)
    ELSE 0::numeric
  END AS metric_value,
  CASE WHEN NOT (SELECT rth FROM is_rth) THEN 'off-RTH skip'
       WHEN (SELECT COUNT(*) FROM silent) = 0 THEN 'all RTH-frequent brain consumers fresh'
       ELSE 'silent_consumers: ' || (
         SELECT string_agg(consumer_name || '(' || ROUND(hours_since_last_write::numeric, 1) || 'h>' || threshold_hours || 'h)', ',' ORDER BY hours_since_last_write DESC)
         FROM silent
       )
  END AS message
$$,
    enabled = true,
    last_status = NULL,
    last_value = NULL,
    last_error = NULL,
    consecutive_fails = 0
WHERE name = 'brain_consumer_freshness_rth';
