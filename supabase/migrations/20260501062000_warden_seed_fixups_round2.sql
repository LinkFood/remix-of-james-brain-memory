-- =============================================================================
-- 20260501062000_warden_seed_fixups_round2.sql
--
-- Round 2 of seed-query column-name corrections, surfaced by the second
-- warden run after the regex/whitespace guard fix in 20260501061000.
--
--   ct_flow_alerts.created_at  → does not exist; use ingested_at.
--                                 (executed_at is NULL — UW stopped emitting
--                                  it. Memory: ct_flow_alerts_executed_at_null.)
--   ct_daily_briefs.brief_date → does not exist; use session_date.
--
-- Both are real-data column-name mismatches the warden was built to catch.
-- =============================================================================
SET search_path = public, extensions;

-- flow_alerts_freshness_rth — window the freshness check on ingested_at.
UPDATE public.ct_invariants
SET query_sql = $q$SELECT
       CASE
         WHEN extract(dow from now() AT TIME ZONE 'America/New_York') NOT IN (1,2,3,4,5) THEN 0
         WHEN (now() AT TIME ZONE 'America/New_York')::time < '09:30' THEN 0
         WHEN (now() AT TIME ZONE 'America/New_York')::time > '16:00' THEN 0
         ELSE COALESCE(EXTRACT(EPOCH FROM (now() - MAX(ingested_at)))/60, 999)
       END::numeric AS metric_value,
       'minutes since latest ct_flow_alerts row (RTH-only)' AS message
     FROM ct_flow_alerts
     WHERE ingested_at > now() - interval '1 hour'$q$
WHERE name = 'flow_alerts_freshness_rth';

-- morning_brief_freshness — ct_daily_briefs.session_date is the date column.
UPDATE public.ct_invariants
SET query_sql = $q$SELECT
       CASE
         WHEN extract(dow from now() AT TIME ZONE 'America/New_York') NOT IN (1,2,3,4,5) THEN 1
         WHEN extract(hour from now() AT TIME ZONE 'UTC') < 11 THEN 1
         WHEN MAX(session_date) >= (now() AT TIME ZONE 'America/New_York')::date THEN 1
         ELSE 0
       END::numeric AS metric_value,
       'morning brief written for today (gated weekday post-11UTC)' AS message
     FROM ct_daily_briefs$q$
WHERE name = 'morning_brief_freshness';
