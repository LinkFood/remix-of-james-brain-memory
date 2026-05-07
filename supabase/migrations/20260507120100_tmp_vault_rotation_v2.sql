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
