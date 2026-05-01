-- =============================================================================
-- 20260501050000_system_warden.sql
--
-- The System Warden — invariant-based self-supervision for the OS.
--
-- Why: James caught the UTC-rollover budget bug 2026-04-30 by glancing at a
-- badge. The synthesis layer + cron health catch CRASHES. They do not catch
-- silent wrongness — a view returning the wrong column, a counter that froze,
-- a row count that flatlined, a specialist that writes flags but never reads.
-- The Warden makes those failure modes structurally visible.
--
-- Architecture:
--
--   ct_invariants — manifest table. One row per check.
--     name + category + query_sql + expected_min/max/bool + severity +
--     runbook_path + enabled. New invariant = INSERT, no code change.
--     Same structural pattern as ct_detectors / ct_specialist_prompts.
--     Tenet 25 — STRUCTURE evolves, not just within structure.
--
--   ct_invariant_log — append-only history. Every Warden run writes one row
--     per invariant. Surfaces drift over time, not just current state.
--
--   ct_warden_alarm_state — one-fire-per-state-change Slack tracking. Same
--     shape as ct_tavily_alarm_state / ct_uw_alarm_state. Stops the same
--     fail from posting twice; surfaces fail→pass recoveries.
--
--   public.run_invariant_query(p_sql text) — SECURITY DEFINER helper that
--     executes a SELECT-only query with a read-only timeout, returns
--     (metric_value numeric, message text). Trust boundary: row INSERT
--     into ct_invariants. James writes the queries; SQL injection is not
--     a concern in a single-user system, but the helper still enforces
--     SELECT-only at the parser to prevent accidents.
-- =============================================================================
SET search_path = public, extensions;

-- ----------------------------------------------------------------------------
-- 1) ct_invariants — the manifest
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ct_invariants (
  name              text PRIMARY KEY,
  category          text NOT NULL,
  description       text,
  query_sql         text NOT NULL,
  expected_min      numeric,
  expected_max      numeric,
  expected_bool     boolean,
  severity          text NOT NULL DEFAULT 'warn'
                       CHECK (severity IN ('info','warn','critical')),
  runbook_path      text,
  enabled           boolean NOT NULL DEFAULT true,
  last_run_at       timestamptz,
  last_status       text CHECK (last_status IN ('pass','fail','error')),
  last_value        text,
  last_error        text,
  consecutive_fails int NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ct_invariants_enabled_category
  ON public.ct_invariants (enabled, category);
CREATE INDEX IF NOT EXISTS idx_ct_invariants_last_status
  ON public.ct_invariants (last_status, last_run_at DESC);

ALTER TABLE public.ct_invariants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ct_invariants_read ON public.ct_invariants;
CREATE POLICY ct_invariants_read ON public.ct_invariants
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS ct_invariants_svc ON public.ct_invariants;
CREATE POLICY ct_invariants_svc ON public.ct_invariants
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.ct_invariants IS
  'System Warden manifest. One row per invariant check. The Warden cron reads enabled rows and executes query_sql via run_invariant_query(). New invariant = INSERT row, no code change. Tenet 25.';

-- ----------------------------------------------------------------------------
-- 2) ct_invariant_log — append-only history
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ct_invariant_log (
  id              bigserial PRIMARY KEY,
  invariant_name  text NOT NULL,
  ran_at          timestamptz NOT NULL DEFAULT now(),
  status          text NOT NULL CHECK (status IN ('pass','fail','error')),
  value           text,
  message         text,
  severity        text,
  runbook_path    text
);

CREATE INDEX IF NOT EXISTS idx_ct_invariant_log_name_ran
  ON public.ct_invariant_log (invariant_name, ran_at DESC);
CREATE INDEX IF NOT EXISTS idx_ct_invariant_log_ran
  ON public.ct_invariant_log (ran_at DESC);
CREATE INDEX IF NOT EXISTS idx_ct_invariant_log_status_ran
  ON public.ct_invariant_log (status, ran_at DESC) WHERE status != 'pass';

ALTER TABLE public.ct_invariant_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ct_invariant_log_read ON public.ct_invariant_log;
CREATE POLICY ct_invariant_log_read ON public.ct_invariant_log
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS ct_invariant_log_svc ON public.ct_invariant_log;
CREATE POLICY ct_invariant_log_svc ON public.ct_invariant_log
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.ct_invariant_log IS
  'Append-only Warden run history. Surfaces drift across time, not just current state. The Warden writes one row per invariant per run.';

-- ----------------------------------------------------------------------------
-- 3) ct_warden_alarm_state — one-fire-per-state-change tracking
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ct_warden_alarm_state (
  invariant_name        text PRIMARY KEY,
  current_status        text NOT NULL CHECK (current_status IN ('pass','fail','error')),
  state_changed_at      timestamptz NOT NULL DEFAULT now(),
  last_slack_posted_at  timestamptz,
  consecutive_count     int NOT NULL DEFAULT 1
);

ALTER TABLE public.ct_warden_alarm_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ct_warden_alarm_state_read ON public.ct_warden_alarm_state;
CREATE POLICY ct_warden_alarm_state_read ON public.ct_warden_alarm_state
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS ct_warden_alarm_state_svc ON public.ct_warden_alarm_state;
CREATE POLICY ct_warden_alarm_state_svc ON public.ct_warden_alarm_state
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ----------------------------------------------------------------------------
-- 4) run_invariant_query — SELECT-only executor with timeout
-- ----------------------------------------------------------------------------
-- Each invariant query MUST return one row with columns:
--   metric_value numeric  — the headline number for range comparison
--   message      text     — human-readable detail (optional)
-- For boolean checks, return metric_value=1 (true) or 0 (false) and set
-- expected_bool true; ranges + booleans are mutually exclusive per row.
CREATE OR REPLACE FUNCTION public.run_invariant_query(p_sql text)
RETURNS TABLE (
  metric_value numeric,
  message      text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '15s'
AS $$
DECLARE
  v_trimmed text;
BEGIN
  v_trimmed := lower(btrim(p_sql));

  -- SELECT-only guard — no DML, no DDL. Single statement only (no semicolons
  -- mid-query). Trust boundary is the INSERT into ct_invariants — this is
  -- belt-and-suspenders against accidents.
  IF NOT (v_trimmed LIKE 'select %' OR v_trimmed LIKE 'with %') THEN
    RAISE EXCEPTION 'invariant queries must start with SELECT or WITH (got: %)', left(v_trimmed, 30);
  END IF;
  IF v_trimmed LIKE '%;%' AND position(';' IN v_trimmed) < length(v_trimmed) THEN
    RAISE EXCEPTION 'invariant queries must be a single statement (no mid-query semicolon)';
  END IF;
  IF v_trimmed ~* '\m(insert|update|delete|truncate|drop|create|alter|grant|revoke|copy|do|call)\M' THEN
    RAISE EXCEPTION 'invariant queries must be read-only (forbidden keyword detected)';
  END IF;

  RETURN QUERY EXECUTE p_sql;
END;
$$;

REVOKE ALL ON FUNCTION public.run_invariant_query(text) FROM PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION public.run_invariant_query(text) TO service_role;

COMMENT ON FUNCTION public.run_invariant_query(text) IS
  'Executes a SELECT-only invariant query for the Warden. Returns (metric_value numeric, message text). Service-role only.';

-- ----------------------------------------------------------------------------
-- 5) get_warden_health(window_hours int) — Slack/UI summary RPC
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_warden_health(window_hours int DEFAULT 24)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  WITH window_start AS (
    SELECT (now() - (window_hours || ' hours')::interval) AS t0
  ),
  current_state AS (
    SELECT
      i.name,
      i.category,
      i.severity,
      i.last_status,
      i.last_value,
      i.consecutive_fails,
      i.runbook_path,
      i.last_run_at
    FROM ct_invariants i
    WHERE i.enabled = true
  ),
  totals AS (
    SELECT
      count(*)                                                 AS total_enabled,
      count(*) FILTER (WHERE last_status = 'pass')             AS passing,
      count(*) FILTER (WHERE last_status = 'fail')             AS failing,
      count(*) FILTER (WHERE last_status = 'error')            AS errored,
      count(*) FILTER (WHERE last_status IS NULL)              AS never_ran,
      count(*) FILTER (WHERE last_status = 'fail' AND severity = 'critical') AS critical_failing
    FROM current_state
  ),
  by_category AS (
    SELECT category,
           count(*) AS total,
           count(*) FILTER (WHERE last_status = 'pass')  AS passing,
           count(*) FILTER (WHERE last_status = 'fail')  AS failing,
           count(*) FILTER (WHERE last_status = 'error') AS errored
    FROM current_state
    GROUP BY category
  ),
  failures AS (
    SELECT name, category, severity, last_value, consecutive_fails, runbook_path, last_run_at
    FROM current_state
    WHERE last_status IN ('fail','error')
    ORDER BY
      CASE severity WHEN 'critical' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END,
      consecutive_fails DESC
  )
  SELECT jsonb_build_object(
    'window_hours', window_hours,
    'totals', (SELECT to_jsonb(t) FROM totals t),
    'by_category', COALESCE((SELECT jsonb_agg(to_jsonb(c)) FROM by_category c), '[]'::jsonb),
    'failures', COALESCE((SELECT jsonb_agg(to_jsonb(f)) FROM failures f), '[]'::jsonb),
    'generated_at', now()
  );
$$;

GRANT EXECUTE ON FUNCTION public.get_warden_health(int) TO authenticated, service_role;

COMMENT ON FUNCTION public.get_warden_health(int) IS
  'Warden dashboard payload. Counts passing/failing/errored invariants, breaks down by category, lists current failures with severity + runbook path.';

-- ----------------------------------------------------------------------------
-- 6) Update touch trigger
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._ct_invariants_touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ct_invariants_updated_at ON public.ct_invariants;
CREATE TRIGGER ct_invariants_updated_at
  BEFORE UPDATE ON public.ct_invariants
  FOR EACH ROW EXECUTE FUNCTION public._ct_invariants_touch_updated_at();
