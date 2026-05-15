-- Add explicit net.http_post timeout to invoke_edge_function.
--
-- 2026-05-15 incident: the scheduled 21:00 UTC ct-eod-report run produced no
-- ct_eod_reports row. The pg_cron job fired and the SELECT invoke_edge_function()
-- SQL succeeded in 27ms — that's just the net.http_post enqueue. The edge
-- function then never produced output: a transient single-attempt failure,
-- most likely the cron's net.http_post hitting its default ~5s timeout during
-- a slow edge cold-start.
--
-- invoke_edge_function was fire-and-forget with NO explicit timeout_milliseconds,
-- so pg_net's short default applied. Adding an explicit 120s timeout lets a slow
-- edge cold-start complete instead of being dropped at ~5s.
--
-- Contract preserved EXACTLY — same signature (function_name text, body jsonb
-- DEFAULT '{}'::jsonb) RETURNS bigint, same Authorization + apikey + Content-Type
-- headers, same vault reads. This function is called by ~150 crons; the ONLY
-- change is the added timeout_milliseconds argument.
--
-- Sister fix family: 20260507170000 (apikey header).

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
    body := body,
    timeout_milliseconds := 120000
  ) INTO request_id;

  RETURN request_id;
END;
$$;

COMMENT ON FUNCTION public.invoke_edge_function(text, jsonb) IS
  'Vault-powered cron→edge-function HTTP wrapper (JAC-side). apikey header required (Supabase gateway rewrites Authorization to ES256 JWT post-key-migration; isServiceRoleRequest checks apikey). timeout_milliseconds=120000 so slow edge cold-starts are not dropped at the pg_net ~5s default (2026-05-15 EOD-report miss). Sister helper to _ct_post / _ct_post_with_body.';
