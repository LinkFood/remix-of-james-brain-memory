-- Temp RPC to manually fire a brief edge function via the cron's own
-- vault-key path. Used to backfill the 5/7 morning brief + daily brief
-- that 401'd before the vault rotation.

CREATE OR REPLACE FUNCTION public._tmp_fire_brief(fn_name text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, vault, extensions, net
AS $fn$
DECLARE
  url_base text;
  key      text;
  req_id   bigint;
BEGIN
  SELECT decrypted_secret INTO url_base FROM vault.decrypted_secrets WHERE name = 'project_url';
  SELECT decrypted_secret INTO key FROM vault.decrypted_secrets WHERE name = 'service_role_key';
  SELECT net.http_post(
    url := url_base || '/functions/v1/' || fn_name,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || key
    ),
    body := '{}'::jsonb
  ) INTO req_id;
  RETURN jsonb_build_object('request_id', req_id, 'fn', fn_name);
END
$fn$;

ALTER FUNCTION public._tmp_fire_brief(text) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public._tmp_fire_brief(text) TO service_role;
