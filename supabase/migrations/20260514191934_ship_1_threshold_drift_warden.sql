-- Ship 1 (v2) — warden invariant `threshold_calibration_drift_detector`.
--
-- Pairs with the grader threshold recalibration (20260514191932) + 5-bucket
-- RPC overload (20260514191933) per the structural-fix-with-warden-invariant
-- pattern. Reads the live 7-day per-bucket P75 from
-- ct_contract_threshold_distribution(p_window_days => 7) and compares it to
-- the configured grader.alarm_win_pct.* values. Fires WARN if any bucket's
-- relative drift |configured - empirical_p75| / empirical_p75 exceeds the
-- ct_config-loaded warden_threshold_drift_max_pct (default 0.20).
--
-- EXISTS-guard ahead-of-producer pattern (per
-- feedback_warden_dormant_until_active_pattern.md): returns metric_value=0
-- when there are no contract-tracks rows in the 7-day window, or no qualifying
-- grader.alarm_win_pct.* rows in ct_config. Both should be active immediately
-- on deploy (5,000+ rows in 7d window, 5 config rows freshly written by
-- companion migration) so the invariant auto-engages on next warden tick.
--
-- Drift semantics:
--   * Long-end floor handling: for buckets where empirical P75 < 0.05 (the
--     meaningful-move floor used by the companion migration), drift is computed
--     against max(P75, 0.05). Below the floor, calling the configured 5pct
--     bar "drifted" is noise — the bar is intentionally above the degenerate
--     P75 to preserve grading semantic.
--   * Buckets with n < 30 in the 7d window are skipped (not enough signal).
--
-- Parser hygiene (per feedback_warden_parser_semicolon_blind.md): no `;`
-- inside query_sql, including in message string literals. Using em-dash and
-- pipe separators in message text.
--
-- Severity warn — drift is a signal to recalibrate, not a crisis. Recommended
-- cadence is weekly Monday 12 UTC (warden ticks every 30 min regardless;
-- the invariant is cheap so we don't gate on cadence inside the query).

INSERT INTO public.ct_invariants (
  name, category, description, query_sql,
  expected_min, expected_max, severity, runbook_path
) VALUES (
  'threshold_calibration_drift_detector',
  'calibration',
  'Compares configured grader.alarm_win_pct.* values vs ct_contract_threshold_distribution(7) empirical P75. Fires WARN when max per-bucket relative drift exceeds ct_config warden_threshold_drift_max_pct (default 0.20). Auto-engages via EXISTS-guard once both ct_config and ct_contract_tracks are populated.',
  $sql$
    WITH cfg_rows AS (
      SELECT
        key,
        ((value)::text)::numeric / 100.0 AS configured_decimal
      FROM public.ct_config
      WHERE category = 'grader'
        AND key IN (
          'grader.alarm_win_pct.0dte',
          'grader.alarm_win_pct.1_3d',
          'grader.alarm_win_pct.4_14d',
          'grader.alarm_win_pct.15_45d',
          'grader.alarm_win_pct.46d_plus'
        )
    ),
    drift_max AS (
      SELECT COALESCE(
        ((value)::text)::numeric,
        0.20
      ) AS max_drift_pct
      FROM public.ct_config
      WHERE key = 'warden_threshold_drift_max_pct'
      UNION ALL
      SELECT 0.20::numeric
      WHERE NOT EXISTS (
        SELECT 1 FROM public.ct_config WHERE key = 'warden_threshold_drift_max_pct'
      )
      LIMIT 1
    ),
    active AS (
      SELECT
        (SELECT COUNT(*) FROM cfg_rows) AS n_cfg,
        EXISTS(
          SELECT 1 FROM public.ct_contract_tracks
          WHERE first_tracked_at >= now() - interval '7 days'
            AND peak_contract_pct IS NOT NULL
        ) AS has_tracks
    ),
    dist AS (
      SELECT
        dte_bucket,
        bucket_order,
        n_tracks,
        p75_peak_pct
      FROM public.ct_contract_threshold_distribution(7)
    ),
    drift AS (
      SELECT
        d.dte_bucket,
        d.bucket_order,
        d.n_tracks,
        d.p75_peak_pct AS empirical_p75,
        c.configured_decimal,
        GREATEST(d.p75_peak_pct, 0.05) AS effective_anchor,
        CASE
          WHEN d.n_tracks IS NULL OR d.n_tracks < 30 THEN NULL
          WHEN c.configured_decimal IS NULL THEN NULL
          ELSE ABS(c.configured_decimal - GREATEST(d.p75_peak_pct, 0.05))
               / NULLIF(GREATEST(d.p75_peak_pct, 0.05), 0)
        END AS rel_drift
      FROM dist d
      LEFT JOIN cfg_rows c ON c.key = 'grader.alarm_win_pct.' || d.dte_bucket
    ),
    worst AS (
      SELECT
        MAX(rel_drift) AS max_drift,
        STRING_AGG(
          dte_bucket || '=' || round(COALESCE(rel_drift, 0)::numeric, 3)::text,
          ' | '
          ORDER BY bucket_order
        ) AS per_bucket
      FROM drift
    ),
    final AS (
      SELECT
        active.n_cfg,
        active.has_tracks,
        (SELECT max_drift_pct FROM drift_max) AS max_allowed,
        worst.max_drift,
        worst.per_bucket
      FROM active, worst
    )
    SELECT
      CASE
        WHEN final.n_cfg = 0 THEN 0::numeric
        WHEN NOT final.has_tracks THEN 0::numeric
        WHEN final.max_drift IS NULL THEN 0::numeric
        WHEN final.max_drift > final.max_allowed THEN 1::numeric
        ELSE 0::numeric
      END AS metric_value,
      CASE
        WHEN final.n_cfg = 0
          THEN 'dormant — no grader.alarm_win_pct.* rows in ct_config (companion migration not yet applied)'
        WHEN NOT final.has_tracks
          THEN 'dormant — no ct_contract_tracks with peak_contract_pct in last 7d'
        WHEN final.max_drift IS NULL
          THEN 'dormant — all buckets had n<30 in 7d window'
        WHEN final.max_drift > final.max_allowed
          THEN 'DRIFT max_rel_drift=' || round(final.max_drift, 3)::text
            || ' exceeds threshold ' || round(final.max_allowed, 3)::text
            || ' per_bucket ' || final.per_bucket
        ELSE 'healthy max_rel_drift=' || round(final.max_drift, 3)::text
          || ' within threshold ' || round(final.max_allowed, 3)::text
          || ' per_bucket ' || final.per_bucket
      END AS message
    FROM final
  $sql$,
  0,
  0,
  'warn',
  'docs/methodology-patterns.md#empirical-p75-as-grader-anchor-with-meaningful-move-floor'
)
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description,
  query_sql = EXCLUDED.query_sql,
  expected_min = EXCLUDED.expected_min,
  expected_max = EXCLUDED.expected_max,
  severity = EXCLUDED.severity,
  runbook_path = EXCLUDED.runbook_path,
  updated_at = now();
