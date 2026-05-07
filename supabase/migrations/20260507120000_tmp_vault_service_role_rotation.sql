-- Temporary RPC for service_role_key vault rotation (5/7 incident).
-- Vault was migrated to sb_secret_v2 format but the function's auto-injected
-- Deno env still expects the legacy JWT — caused all isServiceRoleRequest-
-- gated functions to 401 today (jac-morning-brief 10:00 UTC, ct-daily-brief
-- 11:00 UTC, agent_tasks pipeline silent post-03:00 UTC).
--
-- This RPC accepts the canonical JWT as a parameter (NEVER stored here),
-- writes it to vault.secrets, returns format+length for verification.
--
-- Drop migration follows immediately — this is single-use only.

CREATE OR REPLACE FUNCTION public._tmp_rotate_vault_service_role_key(new_value text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, vault, extensions
AS $fn$
DECLARE
  result jsonb;
BEGIN
  UPDATE vault.secrets SET secret = new_value WHERE name = 'service_role_key';
  SELECT jsonb_build_object(
    'name', name,
    'length', length(decrypted_secret),
    'format', CASE
      WHEN decrypted_secret LIKE 'eyJhbGci%' THEN 'JWT'
      WHEN decrypted_secret LIKE 'sb_secret_%' THEN 'sb_secret_v2'
      ELSE 'unknown'
    END,
    'sha256', encode(digest(decrypted_secret, 'sha256'), 'hex')
  )
  INTO result
  FROM vault.decrypted_secrets
  WHERE name = 'service_role_key';
  RETURN result;
END
$fn$;

GRANT EXECUTE ON FUNCTION public._tmp_rotate_vault_service_role_key(text) TO service_role;
