-- =============================================================================
-- 20260420000035_cron_failures.sql
--
-- ct_cron_failures — detected non-healthy ct-* cron jobs. Populated by the
-- ct-cron-health-check edge function every 10 minutes. UI reads the unresolved
-- rows to surface a "Cron health" section on /health and a red dot on System.
--
-- One row per (cron_name, detection pass) where the cron was not healthy. The
-- function itself dedupes Slack pushes within a 1h window on (cron_name,
-- status) via slack_pushed_at — so we still write every detection for audit,
-- but only alert James once per hour per signal.
-- =============================================================================

SET search_path = public, extensions;

CREATE TABLE IF NOT EXISTS ct_cron_failures (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  cron_name        text NOT NULL,
  status           text NOT NULL CHECK (status IN ('failed', 'stale', 'never_ran')),
  last_run_at      timestamptz,
  last_run_status  text,
  -- When ct-cron-health-check observed the anomaly. Equal to created_at on
  -- insert; kept as its own column so downstream queries can be explicit.
  detected_at      timestamptz NOT NULL DEFAULT now(),
  -- Set when the health-check function pushed a Slack bundle that referenced
  -- this row. Null = not yet pushed (dedupe kept it quiet). Dedupe rule:
  -- don't re-push same (cron_name, status) within 1h.
  slack_pushed_at  timestamptz,
  -- Operator action from the /health UI "Resolve" button. Null = still open.
  resolved_at      timestamptz
);

CREATE INDEX IF NOT EXISTS idx_ct_cron_failures_name_detected
  ON ct_cron_failures (cron_name, detected_at DESC);

-- Finding unresolved failures (UI + preflight) is the hot path.
CREATE INDEX IF NOT EXISTS idx_ct_cron_failures_unresolved
  ON ct_cron_failures (detected_at DESC)
  WHERE resolved_at IS NULL;

ALTER TABLE ct_cron_failures ENABLE ROW LEVEL SECURITY;

CREATE POLICY ct_cron_failures_read
  ON ct_cron_failures FOR SELECT TO authenticated USING (true);

CREATE POLICY ct_cron_failures_svc
  ON ct_cron_failures FOR ALL    TO service_role  USING (true) WITH CHECK (true);

COMMENT ON TABLE  ct_cron_failures IS
  'Non-healthy ct-* crons detected by ct-cron-health-check (every 10m). Rows are written for audit on every unhealthy detection; Slack pushes are deduped per (cron_name, status) within 1h via slack_pushed_at.';
COMMENT ON COLUMN ct_cron_failures.status IS
  'Classification: failed (last_run_status=failed), stale (succeeded but last_run_at > 1.33x cadence), never_ran (null last_run_at and scheduled >1h ago).';
COMMENT ON COLUMN ct_cron_failures.slack_pushed_at IS
  'Set when the bundled Slack alert went out for this detection. Null = deduped or still pending.';
COMMENT ON COLUMN ct_cron_failures.resolved_at IS
  'Operator clicked "Resolve" on /health. Clears the red dot + hides from the 6h preflight window.';

-- Manual-trigger RPC + pg_cron schedule for ct-cron-health-check.
CREATE OR REPLACE FUNCTION public.trigger_ct_cron_health_check()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions
AS $fn$ SELECT public._ct_post('ct-cron-health-check'); $fn$;
GRANT EXECUTE ON FUNCTION public.trigger_ct_cron_health_check() TO authenticated, service_role;

-- Every 10 minutes, all day every day. ct-cron-health-check is cheap (one
-- RPC + a handful of inserts) and needs to keep running outside market hours
-- so we catch weekend/overnight outages too.
SELECT cron.schedule(
  'ct-cron-health-check',
  '*/10 * * * *',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-cron-health-check',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $cron$
);
