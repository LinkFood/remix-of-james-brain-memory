-- Class-kill follow-on #2 for the 5/7 service-role-key gateway-rewrite
-- incident. After fixing inline cron commands (fa0eaab) and the
-- _ct_post / _ct_post_with_body helpers (9ca5af5), warden still showed
-- regime_state_freshness_rth + detector_scoreboard_freshness stale —
-- those crons use yet a third helper, public.invoke_edge_function,
-- which had the same bug (Authorization-only headers, no apikey).
--
-- This is the JAC-side helper used by:
--   - ct-regime-capture-rth + ct-regime-capture-offhours (via
--     trigger_ct_regime_capture)
--   - ct-detector-scorer-rth (via its own wrapper)
--   - calendar-reminder-check, jac-research-agent inter-fn calls
--   - (any cron calling invoke_edge_function)
--
-- Same fix shape as 20260507160000 — add apikey header to the headers
-- jsonb. Single migration covers the entire invoke_edge_function-using
-- class.

SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION public.invoke_edge_function(
  function_name text,
  body jsonb DEFAULT '{}'::jsonb
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  project_url text;
  svc_key text;
  request_id bigint;
BEGIN
  SELECT decrypted_secret INTO project_url
  FROM vault.decrypted_secrets
  WHERE name = 'project_url'
  LIMIT 1;

  SELECT decrypted_secret INTO svc_key
  FROM vault.decrypted_secrets
  WHERE name = 'service_role_key'
  LIMIT 1;

  IF project_url IS NULL OR svc_key IS NULL THEN
    RAISE EXCEPTION 'invoke_edge_function: vault missing project_url or service_role_key';
  END IF;

  SELECT net.http_post(
    url := project_url || '/functions/v1/' || function_name,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || svc_key,
      'apikey',        svc_key,
      'Content-Type',  'application/json'
    ),
    body := body
  ) INTO request_id;

  RETURN request_id;
END;
$$;

COMMENT ON FUNCTION public.invoke_edge_function(text, jsonb) IS
  'Vault-powered cron→edge-function HTTP wrapper (JAC-side). apikey header required (Supabase gateway rewrites Authorization to ES256 JWT post-key-migration; isServiceRoleRequest checks apikey). Sister helper to _ct_post / _ct_post_with_body.';
