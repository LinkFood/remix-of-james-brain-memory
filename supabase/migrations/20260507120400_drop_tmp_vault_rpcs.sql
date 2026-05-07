-- Drop temp single-use SECURITY DEFINER helpers from the 5/7 vault rotation
-- attempt. Investigation continuing in Dashboard; these aren't needed and
-- shouldn't linger as privileged footguns.

DROP FUNCTION IF EXISTS public._tmp_rotate_vault_service_role_key(text);
DROP FUNCTION IF EXISTS public._tmp_fire_brief(text);
DROP FUNCTION IF EXISTS public._tmp_check_http_response(bigint[]);
