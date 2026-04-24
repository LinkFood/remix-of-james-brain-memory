-- ============================================================================
-- Co-Trader v2 — Phase 2: trigger_ct_specialist_nvda() RPC
-- ============================================================================
-- Manual-trigger RPC for the NVDA specialist. Mirrors trigger_ct_watcher
-- pattern: Vault-signed net.http_post, returns the pg_net request_id.
--
-- Poll net._http_response with the returned id to see the function's body.
-- ============================================================================

SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION public.trigger_ct_specialist_nvda(p_reason TEXT DEFAULT 'manual')
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
    url     := _project_url || '/functions/v1/ct-specialist-nvda',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || _service_key
    ),
    body    := jsonb_build_object('reason', COALESCE(p_reason, 'manual'))
  ) INTO _request_id;

  RETURN jsonb_build_object('request_id', _request_id, 'fired_at', now(), 'reason', p_reason);
END
$fn$;

GRANT EXECUTE ON FUNCTION public.trigger_ct_specialist_nvda(TEXT) TO authenticated, service_role;
