-- =============================================================================
-- 20260430173500_ct_fire_eod_helper.sql
--
-- One-shot helper RPC to invoke ct-eod-summary / ct-eod-report from terminal
-- using the runtime-vault service_role_key (CLI key drift since rotation
-- means edge-function HTTP auth fails when invoked from terminal directly —
-- per feedback_service_role_key_rotation.md).
--
-- This RPC only wraps net.http_post via vault; it adds no new behavior.
-- Idempotent — replace allowed.
-- =============================================================================

SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION public.ct_fire_eod(p_target text, p_body jsonb DEFAULT '{}'::jsonb)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_request_id bigint;
  v_url        text;
BEGIN
  IF p_target NOT IN ('ct-eod-summary', 'ct-eod-report') THEN
    RAISE EXCEPTION 'invalid p_target: % (allowed: ct-eod-summary, ct-eod-report)', p_target;
  END IF;

  v_url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url')
        || '/functions/v1/' || p_target;

  SELECT net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
    ),
    body := p_body
  ) INTO v_request_id;

  RETURN v_request_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.ct_fire_eod(text, jsonb) TO service_role;

COMMENT ON FUNCTION public.ct_fire_eod(text, jsonb) IS
  'One-shot helper to invoke EOD edge functions via runtime vault key. Returns pg_net request_id. Drop after manual verification.';
