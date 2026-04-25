-- ct-backtest-harness invoke RPC — sync-style invoker so terminal-Claude can
-- POST a body and read the scorecard JSON back in one call.
--
-- Pattern: net.http_post (async) → poll net._http_response on the request_id
-- with a bounded wait. Wrapping it as an RPC means the caller doesn't have to
-- know about pg_net internals or write its own polling loop.
--
-- Auth: SECURITY DEFINER + Vault for the service_role_key (CLI JWT can drift
-- from the runtime env var per the service_role_key_rotation memory).

SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION public.trigger_ct_backtest_harness(
  body jsonb DEFAULT '{}'::jsonb,
  wait_seconds integer DEFAULT 90
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  _project_url text;
  _service_key text;
  _request_id  bigint;
  _waited      integer := 0;
  _resp        record;
BEGIN
  SELECT decrypted_secret INTO _project_url FROM vault.decrypted_secrets WHERE name = 'project_url';
  SELECT decrypted_secret INTO _service_key FROM vault.decrypted_secrets WHERE name = 'service_role_key';

  IF _project_url IS NULL OR _service_key IS NULL THEN
    RETURN jsonb_build_object('error', 'Vault missing project_url or service_role_key');
  END IF;

  SELECT net.http_post(
    url     := _project_url || '/functions/v1/ct-backtest-harness',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || _service_key
    ),
    body    := body
  ) INTO _request_id;

  -- Poll _http_response. Function timeout on the harness side is 150s; we
  -- bound our wait at wait_seconds (default 90) so a stuck request fails fast.
  WHILE _waited < wait_seconds LOOP
    SELECT * INTO _resp FROM net._http_response WHERE id = _request_id;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'request_id', _request_id,
        'status_code', _resp.status_code,
        'elapsed_seconds', _waited,
        'body', _resp.content::jsonb
      );
    END IF;
    PERFORM pg_sleep(2);
    _waited := _waited + 2;
  END LOOP;

  RETURN jsonb_build_object(
    'request_id', _request_id,
    'error', 'timeout',
    'waited_seconds', _waited
  );
END
$fn$;

GRANT EXECUTE ON FUNCTION public.trigger_ct_backtest_harness(jsonb, integer) TO authenticated, service_role;

COMMENT ON FUNCTION public.trigger_ct_backtest_harness(jsonb, integer) IS
  'Synchronously invoke ct-backtest-harness and return its scorecard JSON. Polls net._http_response every 2s up to wait_seconds (default 90).';
