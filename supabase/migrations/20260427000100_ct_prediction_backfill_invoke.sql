-- ct-prediction-backfill invoke RPC — sync-style invoker so a one-shot
-- backfill loop can drive the function from terminal/Claude without
-- depending on the rotated CLI service_role key.
--
-- Same shape as trigger_ct_backtest_harness (commit 90 of 2026-04-27).
-- One-shot — no cron schedule. Drop after the calibration baseline lands
-- (or keep around for any future re-baselining).
--
-- Auth: SECURITY DEFINER + Vault for service_role_key.

SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION public.trigger_ct_prediction_backfill(
  body jsonb DEFAULT '{}'::jsonb,
  wait_seconds integer DEFAULT 140
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
    url     := _project_url || '/functions/v1/ct-prediction-backfill',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || _service_key
    ),
    body    := body
  ) INTO _request_id;

  -- Poll up to wait_seconds (default 140 to comfortably cover the 150s wall).
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

GRANT EXECUTE ON FUNCTION public.trigger_ct_prediction_backfill(jsonb, integer) TO authenticated, service_role;

COMMENT ON FUNCTION public.trigger_ct_prediction_backfill(jsonb, integer) IS
  'Synchronously invoke ct-prediction-backfill and return the stats JSON. Polls net._http_response every 2s up to wait_seconds (default 140). One-shot: drives the post-05792c0 stale-prediction repair across ct_contract_tracks and ct_print_tracks.';
