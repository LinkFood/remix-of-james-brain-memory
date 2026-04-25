-- Companion to ct-backtest-harness invoker — read the pg_net response by
-- request_id so the terminal calibration loop can do "fire async → poll →
-- parse JSON" without hitting the 60s PostgREST statement timeout.
--
-- Pattern: terminal-Claude calls invoke_edge_function('ct-backtest-harness', body)
-- → gets request_id → polls get_backtest_response(request_id) until status_code IS NOT NULL.

SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION public.get_backtest_response(req_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  _resp record;
BEGIN
  SELECT * INTO _resp FROM net._http_response WHERE id = req_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('pending', true, 'request_id', req_id);
  END IF;
  RETURN jsonb_build_object(
    'request_id', req_id,
    'status_code', _resp.status_code,
    'created', _resp.created,
    'body', CASE WHEN _resp.content IS NULL THEN NULL ELSE _resp.content::jsonb END
  );
END
$fn$;

GRANT EXECUTE ON FUNCTION public.get_backtest_response(bigint) TO authenticated, service_role;

COMMENT ON FUNCTION public.get_backtest_response(bigint) IS
  'Look up an async pg_net response by request_id and return the JSON body. Used by terminal calibration session to poll ct-backtest-harness results.';
