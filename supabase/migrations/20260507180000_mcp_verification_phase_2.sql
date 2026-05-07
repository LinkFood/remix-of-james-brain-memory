-- Verification layer Phase 2 — automated MCP tool correctness signal.
-- Promotes Phase 1 (commit c16e126, manual stdout) to continuously-enforced
-- via cron + warden invariant. Empirically justified by today's
-- gateway-rewrite incident + wrong-table-pointed morning_brief tool —
-- automated MCP correctness catches the next class without manual
-- eyeball testing.
--
-- Three components:
--   1. ct_mcp_test_results table (append-only, bigint PK per project
--      convention — doc spec called for UUID but ct_invariant_log uses
--      bigint serial, instance #35 watch caught the deviation)
--   2. ct-mcp-verification-runner edge function + pg_cron schedule
--   3. mcp_tool_correctness warden invariant with EXISTS-guard
--
-- Authoring per docs/runbooks/ct_invariants_sql_authoring.md (Path C runbook).

SET search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- 1. ct_mcp_test_results table
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.ct_mcp_test_results (
  id            BIGSERIAL PRIMARY KEY,
  run_id        UUID NOT NULL,
  ran_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  tool_name     TEXT NOT NULL,
  test_name     TEXT NOT NULL,
  category      INT NOT NULL CHECK (category BETWEEN 1 AND 5),
  result        TEXT NOT NULL CHECK (result IN ('PASS', 'FAIL', 'DRIFT')),
  evidence      TEXT,
  duration_ms   INT,
  diff          JSONB
);

CREATE INDEX IF NOT EXISTS idx_ct_mcp_test_results_ran_at
  ON public.ct_mcp_test_results (ran_at DESC);

CREATE INDEX IF NOT EXISTS idx_ct_mcp_test_results_run_id
  ON public.ct_mcp_test_results (run_id);

CREATE INDEX IF NOT EXISTS idx_ct_mcp_test_results_result_tool
  ON public.ct_mcp_test_results (result, tool_name)
  WHERE result IN ('FAIL', 'DRIFT');

ALTER TABLE public.ct_mcp_test_results ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ct_mcp_test_results_read ON public.ct_mcp_test_results;
CREATE POLICY ct_mcp_test_results_read ON public.ct_mcp_test_results
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS ct_mcp_test_results_svc ON public.ct_mcp_test_results;
CREATE POLICY ct_mcp_test_results_svc ON public.ct_mcp_test_results
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.ct_mcp_test_results IS
  'Append-only log of MCP tool verification runs. One row per test per run. Read by mcp_tool_correctness warden invariant. Run by ct-mcp-verification-runner edge function on */30 cadence.';

-- ---------------------------------------------------------------------------
-- 3. mcp_tool_correctness warden invariant (component 3 of 3)
-- ---------------------------------------------------------------------------
-- EXISTS-guard pattern: dormant until first row in ct_mcp_test_results,
-- then auto-engages. Counts FAIL+DRIFT in last 6 hours. Severity warn —
-- captain bridge incorrectness is bad but not data-loss class.
-- SQL authored per Path C runbook: single SELECT, no inline comments,
-- $inv$ dollar-quoted.

INSERT INTO public.ct_invariants
  (name, category, description, query_sql, expected_min, expected_max, expected_bool, severity, runbook_path, enabled)
VALUES (
  'mcp_tool_correctness',
  'mcp_health',
  'Captain-bridge MCP tool correctness signal. Counts FAIL + DRIFT results in ct_mcp_test_results over the last 6 hours, gated on the EXISTS guard so dormant until the verification runner has fired at least once. Empirically justified by the 2026-05-07 gateway-rewrite incident + the wrong-table-pointed morning_brief tool — automated MCP correctness catches the next class without manual eyeball testing.',
  $inv$WITH active AS (SELECT EXISTS(SELECT 1 FROM public.ct_mcp_test_results WHERE ran_at >= now() - interval '24 hours') AS is_active), broken AS (SELECT COUNT(*) AS n FROM public.ct_mcp_test_results WHERE result IN ('FAIL', 'DRIFT') AND ran_at >= now() - interval '6 hours') SELECT CASE WHEN active.is_active THEN broken.n::numeric ELSE 0::numeric END AS metric_value, CASE WHEN NOT active.is_active THEN 'mcp verification runner has not fired yet (dormant per EXISTS guard)' WHEN broken.n = 0 THEN 'all mcp tool tests passing in last 6h' ELSE 'MCP TOOL CORRECTNESS COMPROMISED: ' || broken.n || ' FAIL/DRIFT results in last 6h' END AS message FROM active, broken$inv$,
  NULL,
  0,
  NULL,
  'warn',
  'docs/audit/2026-05-07-mcp-verification-layer.md',
  true
)
ON CONFLICT (name) DO UPDATE SET
  description     = EXCLUDED.description,
  query_sql       = EXCLUDED.query_sql,
  expected_min    = EXCLUDED.expected_min,
  expected_max    = EXCLUDED.expected_max,
  severity        = EXCLUDED.severity,
  enabled         = EXCLUDED.enabled,
  runbook_path    = EXCLUDED.runbook_path;
