-- Drop all temp SECURITY DEFINER helpers from the 5/7 service-role-key
-- gateway-rewrite incident. Investigation + fix complete:
--
--   - Diagnosed: Supabase migrated auto-injected SUPABASE_SERVICE_ROLE_KEY
--     to sb_secret_v2 format; gateway now rewrites Authorization header
--     to a short-lived ES256 JWT before passing to Edge Functions.
--     `apikey` header passes through unmodified.
--   - Fixed: _shared/auth.ts isServiceRoleRequest now checks apikey
--     header (gateway-passthrough). Authorization-Bearer-rawkey
--     branch retained for hypothetical future cases but unreachable
--     under current gateway behavior.
--   - Mass-redeployed 139 functions importing _shared/auth.ts.
--   - Mass-updated 154 pg_cron commands to send 'apikey' header
--     alongside 'Authorization'.
--   - Verified: jac-morning-brief 200 + brain_reports row written;
--     ct-daily-brief telemetry shows successful buildClaudeContext.
--
-- Drop temp RPCs to remove privileged footguns.

DROP FUNCTION IF EXISTS public._tmp_rotate_vault_service_role_key(text);
DROP FUNCTION IF EXISTS public._tmp_fire_brief(text);
DROP FUNCTION IF EXISTS public._tmp_check_http_response(bigint[]);
DROP FUNCTION IF EXISTS public._tmp_add_apikey_to_crons();
DROP FUNCTION IF EXISTS public._tmp_add_apikey_to_crons_v2();
DROP FUNCTION IF EXISTS public._tmp_patch_sync_codebases();
