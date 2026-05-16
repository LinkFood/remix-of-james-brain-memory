-- Ship 1 — ct-flag-grader head-of-line starvation class-kill.
--
-- Phase A finding (2026-05-16): ct-flag-grader Job A selects the candidate
-- pool with .in('status',['active','conviction']).lte('horizon_ts',now)
-- .order('horizon_ts',asc).limit(200). The pool is 12,761 overdue flags.
-- Three of four skip paths (!option_symbol, !contract_track,
-- price_unavailable) `continue` WITHOUT transitioning ct_flags.status —
-- so an un-gradeable flag stays status='active' forever, re-occupying the
-- oldest-200 ASC slots every run. The grader cursor frontier is
-- empirically pinned at horizon_ts ~2026-05-01 (newest graded flag
-- horizon = 2026-05-01T19:10). All 80 overdue specialist flags sit behind
-- this wall, ungraded — which is the C1 acceptance blocker.
--
-- Re-emergence of Tenet 15's 3x DESC-sort starvation class one layer
-- deeper: skip-without-status-transition is the immortality mechanism.
--
-- Class-kill: a terminal 'ungradeable' status. When the grader hits a
-- structural skip path it transitions the flag to 'ungradeable' (+ a
-- diagnostic reason), so the flag leaves the candidate pool permanently
-- and the pool drains. The market_closed skip path is NOT terminal — it
-- is transient and self-heals on the next RTH run — so it keeps using
-- 'active' and is intentionally untouched here.
--
-- Authoring per docs/runbooks/ct_invariants_sql_authoring.md (Path C):
-- single SELECT per query_sql, no inline comments, no mid-query
-- semicolons (including in string literals — cascade #41), $inv$-quoted.

SET search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- 1. Extend ct_flags.status to allow the terminal 'ungradeable' value.
--    The original CHECK is an inline column constraint from
--    20260423000026_v2_specialist_schema.sql:55-56. Drop it by
--    introspection so we are robust to its auto-generated name.
-- ---------------------------------------------------------------------------
DO $body$
DECLARE c text;
BEGIN
  FOR c IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public'
      AND rel.relname = 'ct_flags'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%status%'
  LOOP
    EXECUTE 'ALTER TABLE public.ct_flags DROP CONSTRAINT ' || quote_ident(c);
  END LOOP;
END $body$;

ALTER TABLE public.ct_flags
  ADD CONSTRAINT ct_flags_status_check
  CHECK (status IN ('active','conviction','graded','invalidated','ungradeable'));

-- ---------------------------------------------------------------------------
-- 2. Diagnostic reason column — why a flag could not be graded.
--    Values: no_option_symbol | no_contract_track | price_unavailable.
-- ---------------------------------------------------------------------------
ALTER TABLE public.ct_flags
  ADD COLUMN IF NOT EXISTS ungradeable_reason text;

-- ---------------------------------------------------------------------------
-- 3. Warden invariant — grader_oldest_overdue_flag_age.
--    Pair-shipped per defense-net discipline: structurally a flag can no
--    longer be stuck forever, but the warden catches regression (a new
--    skip path, a cron stall, a backlog the limit-200 cannot drain).
--    Metric = age in hours of the oldest overdue active/conviction flag.
--    Threshold 72h clears a 3-day weekend (underlying-axis specialist /
--    james flags legitimately defer grading over market-closed windows).
--    Under healthy weekday operation this sits minutes-to-hours.
-- ---------------------------------------------------------------------------
INSERT INTO public.ct_invariants
  (name, category, description, query_sql, expected_min, expected_max, expected_bool, severity, runbook_path, enabled)
VALUES (
  'grader_oldest_overdue_flag_age',
  'cron_health',
  'ct-flag-grader candidate-pool health — age in hours of the oldest active/conviction flag whose horizon_ts has passed. Catches grader head-of-line starvation (Ship 1 class-kill regression guard). Threshold 72h clears a 3-day weekend deferral of underlying-axis grading.',
  $inv$WITH oldest AS (SELECT MIN(horizon_ts) AS oldest_horizon FROM public.ct_flags WHERE status IN ('active','conviction') AND horizon_ts <= now()) SELECT CASE WHEN oldest_horizon IS NULL THEN 0 ELSE EXTRACT(EPOCH FROM (now() - oldest_horizon)) / 3600 END::numeric AS metric_value, CASE WHEN oldest_horizon IS NULL THEN 'grader candidate pool empty — no overdue flags' ELSE 'grader oldest overdue flag horizon ' || ROUND(EXTRACT(EPOCH FROM (now() - oldest_horizon)) / 3600)::text || 'h past now (threshold 72h)' END AS message FROM oldest$inv$,
  NULL, 72, NULL, 'warn',
  'docs/methodology-patterns.md#grader-hol-starvation-re-emergence-at-deeper-layer', true
)
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description, query_sql = EXCLUDED.query_sql,
  expected_max = EXCLUDED.expected_max, severity = EXCLUDED.severity,
  enabled = EXCLUDED.enabled, runbook_path = EXCLUDED.runbook_path;
