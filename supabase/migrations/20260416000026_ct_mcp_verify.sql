-- One-shot RPC to test UW MCP integration via ct-mcp-verify function.
SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION public.trigger_ct_mcp_verify()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $fn$
DECLARE
  _project_url text;
  _service_key text;
  _response jsonb;
  _status int;
  _body text;
  _request_id bigint;
BEGIN
  SELECT decrypted_secret INTO _project_url FROM vault.decrypted_secrets WHERE name = 'project_url';
  SELECT decrypted_secret INTO _service_key FROM vault.decrypted_secrets WHERE name = 'service_role_key';

  -- Use net.http_post blocking-style — retrieve the response synchronously
  SELECT net.http_post(
    url     := _project_url || '/functions/v1/ct-mcp-verify',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || _service_key
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000
  ) INTO _request_id;

  RETURN jsonb_build_object('request_id', _request_id, 'fired_at', now(), 'note', 'query net._http_response for body');
END
$fn$;

GRANT EXECUTE ON FUNCTION public.trigger_ct_mcp_verify() TO authenticated, service_role;
