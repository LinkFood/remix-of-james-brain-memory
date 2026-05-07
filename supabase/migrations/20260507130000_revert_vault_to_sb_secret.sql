-- Recreate temp rotation RPC + reverse migration to manually-fire helper.
-- 5/7 vault rotation incident: I rotated vault from sb_secret_v2 (matched
-- function runtime env) to JWT (didn't match), making the 401s persist.
-- tmp-env-diag function confirmed Supabase auto-injects sb_secret_v2 as
-- SUPABASE_SERVICE_ROLE_KEY in Edge Function runtime now (deprecated JWT
-- replaced). Reverting vault to match function env.

CREATE OR REPLACE FUNCTION public._tmp_rotate_vault_service_role_key(new_value text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, vault, extensions
AS $fn$
DECLARE
  result jsonb;
  sid    uuid;
BEGIN
  SELECT id INTO sid FROM vault.secrets WHERE name = 'service_role_key';
  IF sid IS NULL THEN
    RETURN jsonb_build_object('error', 'service_role_key not found in vault');
  END IF;
  PERFORM vault.update_secret(sid, new_value, 'service_role_key', NULL);
  SELECT jsonb_build_object(
    'length', length(decrypted_secret),
    'format', CASE
      WHEN decrypted_secret LIKE 'eyJhbGci%' THEN 'JWT'
      WHEN decrypted_secret LIKE 'sb_secret_%' THEN 'sb_secret_v2'
      ELSE 'unknown'
    END,
    'sha256', encode(digest(decrypted_secret, 'sha256'), 'hex')
  ) INTO result FROM vault.decrypted_secrets WHERE name = 'service_role_key';
  RETURN result;
END
$fn$;

ALTER FUNCTION public._tmp_rotate_vault_service_role_key(text) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public._tmp_rotate_vault_service_role_key(text) TO service_role;

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
  SELECT decrypted_secret INTO key      FROM vault.decrypted_secrets WHERE name = 'service_role_key';
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
