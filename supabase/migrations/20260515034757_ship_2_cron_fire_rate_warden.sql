-- Ship 2 — class-kill payload: cron-fire-rate-within-empirical-band warden.
--
-- Companion to 20260515034756 (4 cron tightenings). Tenet 15: catches
-- re-drift if a future cron retune overshoots in either direction.
--
-- Mechanism: ct_brain_telemetry rows carry consumer_name on every invocation.
-- For each consumer in a "watched cron" list (configurable in ct_config),
-- count fires per 1h rolling window during RTH and compare to an expected
-- band (min/max per consumer). Out-of-band fires WARN.
--
-- EXISTS-guard pattern (sibling to d3_capture_freshness_weeknights 5/14):
-- dormant until ct_config has at least one watched-cron band registered,
-- then auto-engages. Drift threshold tunable per-consumer.
--
-- Seeded bands for the four tightenings just shipped, computed from the new
-- schedules:
--   ct-signature-watcher-offhours: */15 during 13h/day weekdays = 4/h × 13h
--     × 5d/wk → ~260 fires/wk; per-1h expectation = 4 (offhours range only)
--   ct-slack-push-flag, ct-sweep-cluster, ct-signature-watcher-rth: every
--     min RTH = 60/h during 13-19 UTC weekdays. During RTH expectation = 60.
--
-- Invariant fires if observed fire-count drifts > drift_pct_max from expected
-- (default 0.30 = ±30%). Forward, any cron retune that overshoots gets caught.
--
-- Warden parser semicolon-blind in literals; no `;` inside query_sql.

SET search_path = public, extensions;

-- 1) ct_config seeds for drift threshold + watched consumers list.
INSERT INTO public.ct_config (key, value, description, category, min_value, max_value, default_value)
VALUES (
  'warden_cron_fire_rate_drift_pct_max',
  to_jsonb(0.30),
  'Max acceptable per-1h fire-count drift from expected band before cron_fire_rate_within_empirical_band warden warns. Default 0.30 = ±30%. Per-consumer expectations live in ct_config under cron_fire_expected_per_1h_rth.<consumer_name>.',
  'warden',
  0,
  1,
  to_jsonb(0.30)
)
ON CONFLICT (key) DO NOTHING;

-- Seed per-consumer expected fire-counts (per 1h RTH window). Each value is the
-- count of cron invocations expected per hour while in the active phase
-- (offhours-cadence for offhours consumer, RTH-cadence for the rest).
INSERT INTO public.ct_config (key, value, description, category, default_value)
VALUES
  ('cron_fire_expected_per_1h_rth.ct-signature-watcher', to_jsonb(60), 'expected RTH per-1h fires (post-Ship-2 every-minute schedule 13-19 UTC)', 'warden', to_jsonb(60)),
  ('cron_fire_expected_per_1h_rth.ct-slack-push-flag', to_jsonb(60), 'expected RTH per-1h fires (post-Ship-2 every-minute schedule 13-19 UTC)', 'warden', to_jsonb(60)),
  ('cron_fire_expected_per_1h_rth.ct-sweep-cluster', to_jsonb(60), 'expected RTH per-1h fires (post-Ship-2 every-minute schedule 13-19 UTC)', 'warden', to_jsonb(60))
ON CONFLICT (key) DO NOTHING;

-- 2) Register the warden invariant.
-- Active only during RTH 13-19 UTC weekdays so the post-Ship-2 hour-20
-- silence doesn't trip the floor. Sibling to Ship 2's tightening intent.
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
  'cron_fire_rate_within_empirical_band',
  'data_quality',
  'Watches per-1h fire counts for Ship 2 cron-tightened consumers vs their post-Ship-2 expected per-1h fire rate (from ct_config cron_fire_expected_per_1h_rth.*). Fires warn if any watched consumer drifts more than warden_cron_fire_rate_drift_pct_max (default ±30%) from expected during RTH. EXISTS-guard: dormant until ct_brain_telemetry has rows in the last hour. RTH-gated to 13-19 UTC weekdays.',
  $w$
    WITH gate AS (
      SELECT
        EXTRACT(DOW FROM (now() AT TIME ZONE 'UTC'))::int BETWEEN 1 AND 5
          AND EXTRACT(HOUR FROM (now() AT TIME ZONE 'UTC'))::int BETWEEN 13 AND 19
          AS in_rth
    ),
    active AS (
      SELECT EXISTS(
        SELECT 1 FROM public.ct_brain_telemetry
        WHERE created_at >= now() - interval '1 hour'
      ) AS has_rows
    ),
    drift_thr AS (
      SELECT
        COALESCE((SELECT ((value)::text)::numeric FROM public.ct_config WHERE key = 'warden_cron_fire_rate_drift_pct_max'), 0.30) AS pct_max
    ),
    expected AS (
      SELECT
        substring(key from char_length('cron_fire_expected_per_1h_rth.') + 1) AS consumer,
        ((value)::text)::numeric AS expected_per_1h
      FROM public.ct_config
      WHERE key LIKE 'cron_fire_expected_per_1h_rth.%'
    ),
    observed AS (
      SELECT
        consumer_name,
        COUNT(*)::numeric AS fires_last_1h
      FROM public.ct_brain_telemetry
      WHERE created_at >= now() - interval '1 hour'
      GROUP BY consumer_name
    ),
    drift AS (
      SELECT
        expected.consumer,
        expected.expected_per_1h,
        COALESCE(observed.fires_last_1h, 0) AS fires_last_1h,
        CASE
          WHEN expected.expected_per_1h = 0 THEN 0::numeric
          ELSE ABS(COALESCE(observed.fires_last_1h, 0) - expected.expected_per_1h) / expected.expected_per_1h
        END AS rel_drift
      FROM expected
      LEFT JOIN observed ON observed.consumer_name = expected.consumer
    ),
    worst AS (
      SELECT
        MAX(rel_drift) AS max_drift,
        string_agg(consumer || $$=$$ || ROUND(rel_drift, 2)::text, $$, $$ ORDER BY rel_drift DESC) FILTER (WHERE rel_drift > 0) AS drift_summary,
        COUNT(*) AS n_watched
      FROM drift
    )
    SELECT
      CASE
        WHEN NOT gate.in_rth THEN 0::numeric
        WHEN NOT active.has_rows THEN 0::numeric
        WHEN worst.max_drift IS NULL THEN 0::numeric
        WHEN worst.max_drift > drift_thr.pct_max THEN worst.max_drift
        ELSE 0::numeric
      END AS metric_value,
      CASE
        WHEN NOT gate.in_rth
          THEN 'dormant — outside RTH window (Mon-Fri 13-19 UTC)'
        WHEN NOT active.has_rows
          THEN 'dormant — no telemetry rows in last 1h'
        WHEN worst.n_watched = 0
          THEN 'dormant — no watched consumers in ct_config'
        WHEN worst.max_drift IS NULL OR worst.max_drift <= drift_thr.pct_max
          THEN 'healthy — max rel-drift ' || COALESCE(ROUND(worst.max_drift, 2)::text, '0') || ' within ' || drift_thr.pct_max::text || ' band'
        ELSE 'DRIFT — max ' || ROUND(worst.max_drift, 2)::text || ' over band ' || drift_thr.pct_max::text || ' — ' || COALESCE(worst.drift_summary, '?')
      END AS message
    FROM gate, active, drift_thr, worst
  $w$,
  NULL,
  0,
  NULL,
  'warn',
  'docs/SYSTEM_INDEX.md'
)
ON CONFLICT (name) DO UPDATE SET
  query_sql    = EXCLUDED.query_sql,
  description  = EXCLUDED.description,
  severity     = EXCLUDED.severity,
  runbook_path = EXCLUDED.runbook_path,
  updated_at   = now();
