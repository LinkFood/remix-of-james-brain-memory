-- =============================================================================
-- 20260422000012_ct_uw_health.sql
--
-- ct_uw_endpoint_health — drift detection for Unusual Whales API paths.
--
-- CO-TRADER THESIS tenet (anti-principle): "silent failure modes — every cron,
-- ingester, dependency has health signals". This table is THE health signal
-- for every wrapper in _shared/uwClient.ts. When UW renames or removes a path,
-- the next health-check run flips status and /preflight lights up.
--
-- One row per wrapper (unique wrapper_name). The ct-uw-endpoint-health-check
-- edge function upserts it daily at 05:00 UTC (pre-market). Status transitions
-- write a `stress_check` row into ct_claude_decisions for the journal, and
-- newly-broken wrappers get a ct_cron_failures row.
-- =============================================================================

SET search_path = public, extensions;

CREATE TABLE IF NOT EXISTS ct_uw_endpoint_health (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wrapper_name           text NOT NULL,
  endpoint_path          text NOT NULL,
  last_checked_at        timestamptz NOT NULL DEFAULT now(),
  last_success_at        timestamptz,
  last_error_at          timestamptz,
  last_status_code       int,
  last_error_message     text,
  consecutive_failures   int NOT NULL DEFAULT 0,
  status                 text NOT NULL DEFAULT 'ok'
                           CHECK (status IN ('ok', 'degraded', 'broken')),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ct_uw_endpoint_health_wrapper_unique UNIQUE (wrapper_name)
);

CREATE INDEX IF NOT EXISTS idx_ct_uw_endpoint_health_status
  ON ct_uw_endpoint_health (status, last_checked_at DESC)
  WHERE status <> 'ok';

CREATE INDEX IF NOT EXISTS idx_ct_uw_endpoint_health_checked
  ON ct_uw_endpoint_health (last_checked_at DESC);

ALTER TABLE ct_uw_endpoint_health ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ct_uw_endpoint_health' AND policyname = 'ct_uw_endpoint_health_read') THEN
    EXECUTE 'CREATE POLICY ct_uw_endpoint_health_read ON ct_uw_endpoint_health FOR SELECT TO authenticated USING (true)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ct_uw_endpoint_health' AND policyname = 'ct_uw_endpoint_health_svc') THEN
    EXECUTE 'CREATE POLICY ct_uw_endpoint_health_svc ON ct_uw_endpoint_health FOR ALL TO service_role USING (true) WITH CHECK (true)';
  END IF;
END $$;

COMMENT ON TABLE  ct_uw_endpoint_health IS
  'Drift detector for every wrapper in _shared/uwClient.ts. Populated by ct-uw-endpoint-health-check at 05:00 UTC daily. Broken rows trip ct_cron_failures and surface on /preflight.';
COMMENT ON COLUMN ct_uw_endpoint_health.status IS
  'ok = last probe succeeded; degraded = 1-2 consecutive failures; broken = 3+. Broken rows write to ct_cron_failures so /preflight highlights them.';
COMMENT ON COLUMN ct_uw_endpoint_health.consecutive_failures IS
  'Resets to 0 on any successful probe. Threshold for broken = 3. Keeps a single flaky probe from crying wolf.';

-- Keep updated_at honest.
CREATE OR REPLACE FUNCTION public.ct_uw_endpoint_health_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS trg_ct_uw_endpoint_health_touch ON ct_uw_endpoint_health;
CREATE TRIGGER trg_ct_uw_endpoint_health_touch
  BEFORE UPDATE ON ct_uw_endpoint_health
  FOR EACH ROW EXECUTE FUNCTION public.ct_uw_endpoint_health_touch_updated_at();

-- -----------------------------------------------------------------------------
-- Manual-trigger RPC.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trigger_ct_uw_endpoint_health_check()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$ SELECT public._ct_post('ct-uw-endpoint-health-check'); $fn$;

GRANT EXECUTE ON FUNCTION public.trigger_ct_uw_endpoint_health_check() TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Cron — daily 05:00 UTC (pre-market for US session; also catches weekend
-- path changes before Monday RTH).
-- -----------------------------------------------------------------------------
SELECT cron.schedule(
  'ct-uw-endpoint-health-check',
  '0 5 * * *',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-uw-endpoint-health-check',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $cron$
);
