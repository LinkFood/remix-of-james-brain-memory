-- Ship 7 — class-kill prevention layer. Warden invariant guards against the
-- post-Ship-7 starvation class: short-DTE high-conviction tracks (the ones
-- the conviction tie-breaker is supposed to favor) silently dropping below
-- a meaningful sweep floor. Sibling to contract_poller_skip_reason_distribution
-- from Ship 2 — that watches percentages across the pool; this watches the
-- floor on the conviction tier specifically.
--
-- Shape mirrors Ship 2's invariant: WITH gate (RTH-only) + active (EXISTS
-- guard — dormant until tracks exist) + thresholds (ct_config-driven) + calc.
-- Returns metric_value 1=fail, 0=pass-or-dormant, with a structured message
-- describing the float vs threshold. No mid-string semicolons.
--
-- The metric: MEDIAN(sweep_count) over WORKING short-DTE (dte_at_print <= 7)
-- tracks created in the last 24h. Falls below floor -> Slack alarm on first
-- state change. Per cascade-#42 / instance #11 we DO NOT block on tracks
-- being absent; EXISTS-guard returns dormant (metric=0).
--
-- Threshold seed: 5 sweeps. Ship 2 telemetry shows 8d-21d already getting
-- ~16 avg_sweeps; 0d-7d should ride above 5 once the cap raise + tie-breaker
-- land. Calibrate-DOWN later if empirics warrant per warden_threshold_calibration.

-- 1) Config-driven threshold.
INSERT INTO public.ct_config (key, value, description, category, min_value, max_value, default_value)
VALUES (
  'warden_poller_short_dte_sweep_floor',
  '5'::jsonb,
  'Warden floor for median sweep_count on short-DTE (dte_at_print<=7) WORKING tracks created in last 24h. Fail invariant when median falls below this. Seeded at 5 — empirical 8d-21d sweeps avg ~16; conviction-tier tracks should ride above this once the cap raise + tie-breaker reach steady state.',
  'warden',
  0,
  100,
  '5'::jsonb
)
ON CONFLICT (key) DO NOTHING;

-- 2) Register the invariant. Manifest INSERT only — no edge fn change, per
-- Tenet 25 (adding a check is a database INSERT).
INSERT INTO public.ct_invariants (
  name,
  category,
  description,
  query_sql,
  expected_min,
  expected_max,
  expected_bool,
  severity,
  runbook_path
)
VALUES (
  'contract_poller_short_dte_sweep_floor',
  'data_quality',
  'Floor on median sweep_count for short-DTE WORKING contract tracks created in last 24h. Catches conviction-tier starvation after Ship 7 cap raise / tie-breaker. Dormant outside RTH and when no short-DTE tracks exist.',
  $w$
    WITH gate AS (
      SELECT
        EXTRACT(DOW FROM (now() AT TIME ZONE 'UTC'))::int BETWEEN 1 AND 5
          AND EXTRACT(HOUR FROM (now() AT TIME ZONE 'UTC'))::int BETWEEN 13 AND 20
          AS in_rth
    ),
    active AS (
      SELECT EXISTS(
        SELECT 1 FROM public.ct_contract_tracks
        WHERE created_at >= now() - interval '24 hours'
          AND track_status = 'WORKING'
          AND dte_at_print <= 7
      ) AS has_rows
    ),
    threshold AS (
      SELECT
        COALESCE(
          (SELECT (value)::text::numeric FROM public.ct_config WHERE key = 'warden_poller_short_dte_sweep_floor'),
          5
        ) AS floor_val
    ),
    stats AS (
      SELECT
        COUNT(*)::numeric AS n_tracks,
        COALESCE(
          percentile_cont(0.5) WITHIN GROUP (ORDER BY sweep_count),
          0
        )::numeric AS median_sweeps
      FROM public.ct_contract_tracks
      WHERE created_at >= now() - interval '24 hours'
        AND track_status = 'WORKING'
        AND dte_at_print <= 7
    ),
    calc AS (
      SELECT
        gate.in_rth,
        active.has_rows,
        threshold.floor_val,
        stats.n_tracks,
        stats.median_sweeps
      FROM gate, active, threshold, stats
    )
    SELECT
      CASE
        WHEN NOT calc.in_rth                          THEN 0::numeric
        WHEN NOT calc.has_rows                        THEN 0::numeric
        WHEN calc.n_tracks = 0                        THEN 0::numeric
        WHEN calc.median_sweeps < calc.floor_val      THEN 1::numeric
        ELSE 0::numeric
      END AS metric_value,
      CASE
        WHEN NOT calc.in_rth
          THEN 'dormant — outside RTH window (Mon-Fri 13-20 UTC)'
        WHEN NOT calc.has_rows
          THEN 'dormant — no short-DTE WORKING tracks in last 24h'
        WHEN calc.n_tracks = 0
          THEN 'dormant — n=0 over window'
        WHEN calc.median_sweeps < calc.floor_val
          THEN 'STARVATION | median_sweeps=' || round(calc.median_sweeps, 2)::text
            || ' below floor ' || calc.floor_val::text
            || ' over n=' || calc.n_tracks::text || ' short-DTE tracks (24h)'
        ELSE 'healthy | median_sweeps=' || round(calc.median_sweeps, 2)::text
          || ' floor=' || calc.floor_val::text
          || ' n=' || calc.n_tracks::text
      END AS message
    FROM calc
  $w$,
  NULL,    -- expected_min unused (boolean-shape via metric_value 0/1)
  0,       -- expected_max = 0 (1 means fail)
  NULL,
  'warn',
  'docs/SYSTEM_INDEX.md'
)
ON CONFLICT (name) DO UPDATE SET
  query_sql = EXCLUDED.query_sql,
  description = EXCLUDED.description,
  expected_min = EXCLUDED.expected_min,
  expected_max = EXCLUDED.expected_max,
  severity = EXCLUDED.severity,
  runbook_path = EXCLUDED.runbook_path;
