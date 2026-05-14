-- Ship 2 — warden invariant `contract_poller_skip_reason_distribution`.
--
-- Surveys the past-4h skew of ct_contract_poller_log over the RTH window
-- (13-20 UTC weekdays) and fires WARN if any of:
--   - skipped_budget share > warden_poller_skipped_budget_max
--   - skipped_cap share    > warden_poller_skipped_lru_max
--   - quote_written share  < warden_poller_quote_written_min
--
-- Thresholds live in ct_config (Tenet 16) — read at query time so retunes are
-- DB edits, never code changes.
--
-- EXISTS-guard ahead-of-producer pattern (per feedback_warden_dormant_until_active_pattern.md):
-- returns metric_value=0 when no rows in last 4h, or when outside RTH window,
-- or before the very first poller_log write lands. Auto-engages once telemetry
-- starts flowing.
--
-- Parser hygiene (per feedback_warden_parser_semicolon_blind.md):
-- warden's no-mid-query-semicolon guard is string-literal-blind, so NO `;`
-- characters anywhere inside query_sql, including in message text. Using
-- em-dash and pipe separators in messages.
--
-- Severity warn — early signal, not critical. Class-kill C protection: paired
-- with the table that makes the underlying gap structurally measurable.

INSERT INTO public.ct_invariants (
  name, category, description, query_sql,
  expected_min, expected_max, severity, runbook_path
) VALUES (
  'contract_poller_skip_reason_distribution',
  'data_quality',
  'Past 4h RTH distribution of ct-contract-poller outcomes — fails when skipped_budget share, skipped_cap share, or quote_written share crosses ct_config thresholds. Auto-engages via EXISTS-guard.',
  $sql$
    WITH gate AS (
      SELECT
        EXTRACT(DOW FROM (now() AT TIME ZONE 'UTC'))::int BETWEEN 1 AND 5
          AND EXTRACT(HOUR FROM (now() AT TIME ZONE 'UTC'))::int BETWEEN 13 AND 20
          AS in_rth
    ),
    active AS (
      SELECT EXISTS(
        SELECT 1 FROM public.ct_contract_poller_log
        WHERE created_at >= now() - interval '4 hours'
      ) AS has_rows
    ),
    thresholds AS (
      SELECT
        COALESCE((SELECT (value)::text::numeric FROM public.ct_config WHERE key = 'warden_poller_skipped_budget_max'), 0.30) AS budget_max,
        COALESCE((SELECT (value)::text::numeric FROM public.ct_config WHERE key = 'warden_poller_skipped_lru_max'), 0.60)    AS lru_max,
        COALESCE((SELECT (value)::text::numeric FROM public.ct_config WHERE key = 'warden_poller_quote_written_min'), 0.05) AS write_min
    ),
    dist AS (
      SELECT
        COUNT(*)::numeric                                                                       AS total,
        COUNT(*) FILTER (WHERE sweep_reason = 'skipped_budget')::numeric                        AS n_budget,
        COUNT(*) FILTER (WHERE sweep_reason = 'skipped_cap')::numeric                           AS n_cap,
        COUNT(*) FILTER (WHERE sweep_reason = 'quote_written')::numeric                         AS n_written
      FROM public.ct_contract_poller_log
      WHERE created_at >= now() - interval '4 hours'
    ),
    calc AS (
      SELECT
        gate.in_rth,
        active.has_rows,
        thresholds.budget_max,
        thresholds.lru_max,
        thresholds.write_min,
        dist.total,
        CASE WHEN dist.total > 0 THEN dist.n_budget / dist.total ELSE 0 END AS budget_share,
        CASE WHEN dist.total > 0 THEN dist.n_cap    / dist.total ELSE 0 END AS cap_share,
        CASE WHEN dist.total > 0 THEN dist.n_written / dist.total ELSE 0 END AS written_share
      FROM gate, active, thresholds, dist
    )
    SELECT
      CASE
        WHEN NOT calc.in_rth          THEN 0::numeric
        WHEN NOT calc.has_rows        THEN 0::numeric
        WHEN calc.total = 0           THEN 0::numeric
        WHEN calc.budget_share  > calc.budget_max THEN 1::numeric
        WHEN calc.cap_share     > calc.lru_max    THEN 1::numeric
        WHEN calc.written_share < calc.write_min  THEN 1::numeric
        ELSE 0::numeric
      END AS metric_value,
      CASE
        WHEN NOT calc.in_rth
          THEN 'dormant — outside RTH window (Mon-Fri 13-20 UTC) | total_4h=' || calc.total::text
        WHEN NOT calc.has_rows
          THEN 'dormant — no ct_contract_poller_log rows in last 4h (telemetry not yet active)'
        WHEN calc.total = 0
          THEN 'dormant — zero rows in 4h window'
        WHEN calc.budget_share > calc.budget_max
          THEN 'BUDGET-STARVED | skipped_budget_share=' || round(calc.budget_share, 3)::text
            || ' exceeds threshold ' || round(calc.budget_max, 3)::text
            || ' over n=' || calc.total::text
        WHEN calc.cap_share > calc.lru_max
          THEN 'LRU-STARVED | skipped_cap_share=' || round(calc.cap_share, 3)::text
            || ' exceeds threshold ' || round(calc.lru_max, 3)::text
            || ' over n=' || calc.total::text
        WHEN calc.written_share < calc.write_min
          THEN 'WRITE-FLOOR | quote_written_share=' || round(calc.written_share, 3)::text
            || ' below threshold ' || round(calc.write_min, 3)::text
            || ' over n=' || calc.total::text
        ELSE 'healthy | n=' || calc.total::text
          || ' budget=' || round(calc.budget_share, 3)::text
          || ' cap=' || round(calc.cap_share, 3)::text
          || ' written=' || round(calc.written_share, 3)::text
      END AS message
    FROM calc
  $sql$,
  0,
  0,
  'warn',
  'docs/methodology-patterns.md#per-attempt-telemetry-makes-skip-shape-observable'
)
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description,
  query_sql = EXCLUDED.query_sql,
  expected_min = EXCLUDED.expected_min,
  expected_max = EXCLUDED.expected_max,
  severity = EXCLUDED.severity,
  runbook_path = EXCLUDED.runbook_path,
  updated_at = now();
