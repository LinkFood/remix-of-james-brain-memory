-- Utility RPC to pull the body from a pg_net response by request_id.
-- Useful for reading the output of fire-and-forget _ct_post invocations
-- (replay, attention backfill, etc.) from the SQL editor or a REST client.
SET search_path = public, extensions, net;

CREATE OR REPLACE FUNCTION public._get_http_body(_request_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, net
AS $fn$
DECLARE
  _status int;
  _body text;
  _parsed jsonb;
BEGIN
  SELECT status_code, content INTO _status, _body
  FROM net._http_response
  WHERE id = _request_id;

  IF _status IS NULL THEN
    RETURN jsonb_build_object('pending', true, 'request_id', _request_id);
  END IF;

  BEGIN
    _parsed := _body::jsonb;
  EXCEPTION WHEN OTHERS THEN
    _parsed := jsonb_build_object('raw', _body);
  END;

  RETURN jsonb_build_object('status', _status, 'body', _parsed);
END
$fn$;

GRANT EXECUTE ON FUNCTION public._get_http_body(bigint) TO authenticated, service_role;
