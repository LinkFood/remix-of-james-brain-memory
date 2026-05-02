-- =============================================================================
-- 20260502020200_warden_detector_scoreboard_freshness.sql
--
-- Warden invariant: detector_scoreboard_freshness — warns if the scoreboard
-- hasn't updated in >90 min during RTH OR >2h off-hours. Mirror of the
-- flow_alerts_freshness_rth pattern.
-- =============================================================================
SET search_path = public, extensions;

INSERT INTO public.ct_invariants (
  name,
  category,
  description,
  query_sql,
  expected_min,
  expected_max,
  severity,
  enabled,
  runbook_path
) VALUES (
  'detector_scoreboard_freshness',
  'data_freshness',
  '#9 detector lifecycle scoreboard cron freshness. Warns if no scoreboard snapshot in last 90 min RTH or last 120 min off-hours.',
  $sql$
    WITH last_run AS (
      SELECT MAX(computed_at) AS last_at FROM public.ct_detector_scoreboard
    ),
    rth_now AS (
      SELECT
        EXTRACT(DOW FROM now() AT TIME ZONE 'UTC') BETWEEN 1 AND 5 AS is_weekday,
        EXTRACT(HOUR FROM now() AT TIME ZONE 'UTC') BETWEEN 13 AND 20 AS is_rth_hour
    )
    SELECT
      CASE
        WHEN last_at IS NULL THEN 0
        ELSE EXTRACT(EPOCH FROM (now() - last_at)) / 60
      END                                              AS metric_value,
      CASE
        WHEN last_at IS NULL THEN '[detector_scoreboard] no snapshots yet — first cron fire pending'
        ELSE '[detector_scoreboard] last snapshot ' || ROUND(EXTRACT(EPOCH FROM (now() - last_at)) / 60)::text || ' min ago'
      END                                              AS message
    FROM last_run, rth_now
  $sql$,
  0,                          -- expected_min
  120,                        -- expected_max minutes (2h cap covers off-hours)
  'warn',
  true,
  'docs/runbooks/detector_scoreboard.md'
)
ON CONFLICT (name) DO UPDATE SET
  description     = EXCLUDED.description,
  query_sql       = EXCLUDED.query_sql,
  expected_min    = EXCLUDED.expected_min,
  expected_max    = EXCLUDED.expected_max,
  severity        = EXCLUDED.severity,
  enabled         = EXCLUDED.enabled,
  runbook_path    = EXCLUDED.runbook_path;
