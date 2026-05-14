-- D3 Path 3 companion — warden invariant `d3_capture_freshness_weeknights`.
--
-- Pairs with the autonomous cron migration (20260514120000) per the structural-
-- fix-with-warden-invariant pattern. EXISTS-guard ahead-of-producer (per
-- feedback_warden_dormant_until_active_pattern.md): returns metric_value=0
-- until first `d3_cron_*` generation_id lands, then auto-engages.
--
-- Threshold semantics: the staleness threshold is day-of-week + time-of-day
-- aware because the cron is weekday-only. Naive 25h check would false-fire
-- Monday morning when most recent capture is Friday's (72h gap).
--
--   Tue-Fri after fire time (>= 22:00 UTC): threshold 26h (1h grace after
--                                            24h between successive captures)
--   Tue-Fri before fire time (< 22:00 UTC):  threshold 26h (yesterday's
--                                            capture is ~21-23h old)
--   Mon after fire time (>= 22:00 UTC):       threshold 26h (today's capture)
--   Mon before fire time (< 22:00 UTC):       threshold 73h (last Fri capture
--                                            is ~48-72h old over the weekend)
--   Sat (any):                                threshold 26h (yesterday=Fri)
--   Sun (any):                                threshold 50h (Fri capture
--                                            is ~24-48h old)
--
-- 22:00 UTC is the gate, not 21:05 — gives the cron fire (21:05 UTC) ~55 min
-- to land before the warden expects it. The full UTC-day rebuild can take a
-- few minutes; this avoids transient false-fires immediately after fire time.
--
-- Severity warn (not critical) — captures can be back-filled manually if a
-- night is missed (Path 1 ran 5/14 to back-fill 5/8-5/13). Gap is recoverable.

INSERT INTO public.ct_invariants (
  name, category, description, query_sql,
  expected_min, expected_max, severity, runbook_path
) VALUES (
  'd3_capture_freshness_weeknights',
  'd3_experiment',
  'D3 autonomous capture freshness — fails on weeknights if most recent d3_cron_* row in ct_d3_feature_observations is past its day-of-week-aware staleness threshold. Auto-engages via EXISTS-guard after first cron fire.',
  $sql$
    WITH active AS (
      SELECT EXISTS(
        SELECT 1 FROM public.ct_d3_feature_observations
        WHERE generation_id LIKE 'd3_cron_%'
          AND wakeup_at >= now() - interval '7 days'
      ) AS is_active
    ),
    latest AS (
      SELECT MAX(wakeup_at) AS most_recent
      FROM public.ct_d3_feature_observations
      WHERE generation_id LIKE 'd3_cron_%'
    ),
    threshold AS (
      SELECT
        CASE
          WHEN EXTRACT(DOW FROM (now() AT TIME ZONE 'UTC'))::int = 0
            THEN interval '50 hours'
          WHEN EXTRACT(DOW FROM (now() AT TIME ZONE 'UTC'))::int = 6
            THEN interval '26 hours'
          WHEN EXTRACT(DOW FROM (now() AT TIME ZONE 'UTC'))::int = 1
               AND EXTRACT(HOUR FROM (now() AT TIME ZONE 'UTC'))::int < 22
            THEN interval '73 hours'
          ELSE interval '26 hours'
        END AS max_age
    )
    SELECT
      CASE
        WHEN NOT active.is_active THEN 0::numeric
        WHEN latest.most_recent IS NULL THEN 0::numeric
        WHEN (now() - latest.most_recent) > threshold.max_age THEN 1::numeric
        ELSE 0::numeric
      END AS metric_value,
      CASE
        WHEN NOT active.is_active
          THEN 'dormant — no d3_cron_* generation_id present in last 7d (autonomous capture not yet activated)'
        WHEN latest.most_recent IS NULL
          THEN 'no d3_cron_* rows in ct_d3_feature_observations yet'
        WHEN (now() - latest.most_recent) > threshold.max_age
          THEN 'STALE: most recent d3_cron_* capture at ' || latest.most_recent::text ||
               ' — age ' || (now() - latest.most_recent)::text ||
               ' exceeds dow-aware threshold ' || threshold.max_age::text
        ELSE 'fresh: most recent d3_cron_* capture at ' || latest.most_recent::text ||
             ' (age ' || (now() - latest.most_recent)::text ||
             ' within threshold ' || threshold.max_age::text || ')'
      END AS message
    FROM active, latest, threshold
  $sql$,
  0,
  0,
  'warn',
  'docs/methodology-patterns.md#manual-experiment-cadence-doesnt-survive-captain-life-cadence'
)
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description,
  query_sql = EXCLUDED.query_sql,
  expected_min = EXCLUDED.expected_min,
  expected_max = EXCLUDED.expected_max,
  severity = EXCLUDED.severity,
  runbook_path = EXCLUDED.runbook_path,
  updated_at = now();
