-- ============================================================================
-- Co-Trader Watcher: pg_cron schedule + manual-trigger RPC
-- ============================================================================
-- Schedule: every 30 min during market hours weekdays (13:00-21:00 UTC).
-- Manual trigger: public.trigger_ct_watcher() — callable via REST for testing.
-- ============================================================================

SET search_path = public, extensions;

-- ----------------------------------------------------------------------------
-- RPC: manual trigger (fire-and-forget via pg_net, uses Vault for auth)
-- Returns the pg_net request_id; poll net._http_response for body if needed.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trigger_ct_watcher()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  _project_url text;
  _service_key text;
  _request_id  bigint;
BEGIN
  SELECT decrypted_secret INTO _project_url FROM vault.decrypted_secrets WHERE name = 'project_url';
  SELECT decrypted_secret INTO _service_key FROM vault.decrypted_secrets WHERE name = 'service_role_key';

  IF _project_url IS NULL OR _service_key IS NULL THEN
    RETURN jsonb_build_object('error', 'Vault missing project_url or service_role_key');
  END IF;

  SELECT net.http_post(
    url     := _project_url || '/functions/v1/ct-watcher',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || _service_key
    ),
    body    := '{}'::jsonb
  ) INTO _request_id;

  RETURN jsonb_build_object('request_id', _request_id, 'fired_at', now());
END
$fn$;

GRANT EXECUTE ON FUNCTION public.trigger_ct_watcher() TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Production schedule: every 30 min, weekdays, market hours window in UTC
-- (13:00-20:59 UTC ≈ 9:00am-3:59pm ET during EDT, with 30-min cadence).
-- Using $cron$/$body$ delimiters per the "never $$-inside-$$" gotcha.
-- ----------------------------------------------------------------------------
SELECT cron.schedule(
  'ct-watcher',
  '0,30 13-20 * * 1-5',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-watcher',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    )
  $cron$
);
