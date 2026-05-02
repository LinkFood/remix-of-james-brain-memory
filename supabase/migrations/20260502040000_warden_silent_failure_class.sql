-- =============================================================================
-- 20260502040000_warden_silent_failure_class.sql
--
-- Pre-flight for tonight's Pulse v2 + Specialist Scoreboard v2 builds.
--
-- Adds the cron_zero_row_upsert_silent_failure_class warden invariant — the
-- structural fix for the class of bug that bit specialist scoreboard v1
-- earlier tonight: edge function reports HTTP 200, cron logs success, but
-- the upsert atomically rolled back on a NOT NULL constraint violation and
-- zero rows landed in the target table. See docs/runbooks/silent_failures.md
-- for the canonical case.
--
-- Design (Tenet 25):
--   - ct_growth_crons is the manifest. One row per growth-cron.
--   - Adding a new growth-cron = INSERT row, no code change.
--   - check_growth_cron_silent_failures() iterates the manifest dynamically
--     and reports per-row failures.
--   - One warden invariant aggregates failures into a single metric.
-- =============================================================================
SET search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- 1. ct_growth_crons — manifest of crons that must write rows on cadence
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ct_growth_crons (
  cron_jobname             text PRIMARY KEY,
  target_table             text NOT NULL,
  freshness_column         text NOT NULL,
  scope                    text NOT NULL DEFAULT 'always'
                              CHECK (scope IN ('always','rth','daily','weekday')),
  expected_window_minutes  integer NOT NULL,
  description              text,
  enabled                  boolean NOT NULL DEFAULT true,
  created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ct_growth_crons_enabled
  ON public.ct_growth_crons (enabled, scope);

ALTER TABLE public.ct_growth_crons ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ct_growth_crons_read ON public.ct_growth_crons;
CREATE POLICY ct_growth_crons_read ON public.ct_growth_crons
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS ct_growth_crons_svc ON public.ct_growth_crons;
CREATE POLICY ct_growth_crons_svc ON public.ct_growth_crons
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.ct_growth_crons IS
  'Manifest of crons that must produce rows on cadence. Used by the warden silent-failure invariant. New growth-cron = INSERT row.';

-- ---------------------------------------------------------------------------
-- 2. check_growth_cron_silent_failures() — dynamic per-row check
--
-- Returns one row per FAILING growth-cron. A failure = no row landed in
-- target_table within (expected_window_minutes + 5min grace) since now(),
-- evaluated only when the cron's scope says it should currently be running.
--
-- Empty result = all clear. The warden invariant counts rows; expected_max=0
-- means any failure trips the alarm.
--
-- SECURITY DEFINER because freshness_column is an identifier, target_table
-- is an identifier — they're injected via format()/quote_ident(). Trust
-- boundary: row INSERT into ct_growth_crons. Single-user system; James
-- writes the rows.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.check_growth_cron_silent_failures()
RETURNS TABLE (
  cron_jobname           text,
  target_table           text,
  last_seen_minutes_ago  numeric,
  expected_window_minutes integer,
  scope                  text,
  message                text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  rec        public.ct_growth_crons%ROWTYPE;
  last_at    timestamptz;
  age_min    numeric;
  utc_dow    int;
  utc_hour   int;
  in_window  boolean;
BEGIN
  utc_dow  := EXTRACT(DOW  FROM now() AT TIME ZONE 'UTC')::int;  -- 0=Sun..6=Sat
  utc_hour := EXTRACT(HOUR FROM now() AT TIME ZONE 'UTC')::int;

  FOR rec IN
    SELECT * FROM public.ct_growth_crons WHERE enabled = true
  LOOP
    -- Scope gating — skip checks outside the cron's expected operating window.
    in_window := CASE rec.scope
      WHEN 'always'  THEN true
      WHEN 'rth'     THEN (utc_dow BETWEEN 1 AND 5) AND (utc_hour BETWEEN 13 AND 20)
      WHEN 'weekday' THEN (utc_dow BETWEEN 1 AND 5)
      WHEN 'daily'   THEN true  -- daily crons checked all day; grace handles intra-day
      ELSE false
    END;

    IF NOT in_window THEN
      CONTINUE;
    END IF;

    -- Dynamic max(freshness_column) lookup on target_table.
    EXECUTE format(
      'SELECT MAX(%I) FROM %s',
      rec.freshness_column,
      rec.target_table
    ) INTO last_at;

    IF last_at IS NULL THEN
      cron_jobname            := rec.cron_jobname;
      target_table            := rec.target_table;
      last_seen_minutes_ago   := NULL;
      expected_window_minutes := rec.expected_window_minutes;
      scope                   := rec.scope;
      message                 := format('[%s] no rows in %s yet — cron may have never fired',
                                  rec.cron_jobname, rec.target_table);
      RETURN NEXT;
      CONTINUE;
    END IF;

    age_min := EXTRACT(EPOCH FROM (now() - last_at)) / 60.0;

    -- Threshold = expected_window + 5min grace (clock skew, cron jitter).
    IF age_min > (rec.expected_window_minutes + 5) THEN
      cron_jobname            := rec.cron_jobname;
      target_table            := rec.target_table;
      last_seen_minutes_ago   := ROUND(age_min, 1);
      expected_window_minutes := rec.expected_window_minutes;
      scope                   := rec.scope;
      message                 := format('[%s] last %s row %s min ago (expected ≤%s min)',
                                  rec.cron_jobname,
                                  rec.target_table,
                                  ROUND(age_min)::text,
                                  rec.expected_window_minutes::text);
      RETURN NEXT;
    END IF;
  END LOOP;
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.check_growth_cron_silent_failures()
  TO authenticated, service_role;

COMMENT ON FUNCTION public.check_growth_cron_silent_failures IS
  'Iterates ct_growth_crons; returns one row per cron whose target table has no fresh rows within the expected window. Used by warden cron_zero_row_upsert_silent_failure_class.';

-- ---------------------------------------------------------------------------
-- 3. Seed initial growth-cron inventory.
--    v2 builds (regime-capture, specialist-score-v2) add their own rows in
--    their respective schema migrations.
-- ---------------------------------------------------------------------------
INSERT INTO public.ct_growth_crons
  (cron_jobname, target_table, freshness_column, scope, expected_window_minutes, description)
VALUES
  ('ct-detector-scoreboard-update-rth',     'public.ct_detector_scoreboard',  'computed_at',  'rth',     45,
    'Detector scoreboard nightly snapshot — RTH cadence */30 min'),
  ('ct-detector-scoreboard-update-offhours','public.ct_detector_scoreboard',  'computed_at',  'weekday', 90,
    'Detector scoreboard nightly snapshot — off-hours hourly cadence'),
  ('ct-specialist-scoreboard-update',       'public.ct_specialist_scoreboard','computed_at',  'daily',   1500,
    'Specialist scoreboard v1 — nightly 23:00 UTC. THIS IS THE CRON THAT FAILED SILENTLY ON 2026-05-02 (NULL specialist_name overflow → atomic upsert rollback). See docs/runbooks/silent_failures.md.'),
  ('ct-flow-pulse-capture',                 'public.ct_flow_pulse_ticks',     'tick_time',    'rth',     15,
    'Flow Pulse capture — RTH every 5 min'),
  ('ct-flow-ingester-perticker-rth',        'public.ct_flow_alerts',          'ingested_at',  'rth',     20,
    'Per-ticker UW flow ingester — RTH cadence'),
  ('ct-system-warden',                      'public.ct_invariant_log',        'ran_at',       'always',  60,
    'System Warden — every 30 min, all day. Self-check: warden silence here means warden itself is dead.')
ON CONFLICT (cron_jobname) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4. The warden invariant — aggregates failures into a single metric.
-- ---------------------------------------------------------------------------
INSERT INTO public.ct_invariants
  (name, category, description, query_sql, expected_min, expected_max, severity, enabled, runbook_path)
VALUES (
  'cron_zero_row_upsert_silent_failure_class',
  'silent_failure',
  'Class-level invariant: any growth-cron whose target table is not growing at the expected cadence. Catches the silent-success-zero-row-write class (HTTP 200 + atomic rollback + cron logs success). Canonical case: specialist scoreboard v1, 2026-05-02.',
  $sql$
    WITH failures AS (
      SELECT * FROM public.check_growth_cron_silent_failures()
    )
    SELECT
      COUNT(*)::numeric AS metric_value,
      CASE
        WHEN COUNT(*) = 0 THEN 'all growth-crons producing rows on cadence'
        ELSE string_agg(message, ' ; ' ORDER BY cron_jobname)
      END AS message
    FROM failures
  $sql$,
  0,
  0,
  'warn',
  true,
  'docs/runbooks/silent_failures.md'
)
ON CONFLICT (name) DO UPDATE SET
  description     = EXCLUDED.description,
  query_sql       = EXCLUDED.query_sql,
  expected_min    = EXCLUDED.expected_min,
  expected_max    = EXCLUDED.expected_max,
  severity        = EXCLUDED.severity,
  enabled         = EXCLUDED.enabled,
  runbook_path    = EXCLUDED.runbook_path;
