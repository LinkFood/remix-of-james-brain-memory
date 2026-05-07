-- Class-kill follow-on for the 5/7 service-role-key gateway-rewrite
-- incident (commit fa0eaab). The earlier mass-fix updated 154 cron
-- commands that used inline net.http_post(...) but missed the
-- _ct_post / _ct_post_with_body helper-function path used by:
--   - All 10 ct-specialist-* crons
--   - ct-news-ingester, ct-eod-recap, ct-lessons-curator
--   - trigger_ct_oi_snapshot_with_slot, trigger_ct_daily_brief
--   - ct_fire_eod and any other crons calling these helpers
--
-- Symptom: specialists silent today (0 reads since yesterday's close)
-- because cron → _ct_post_with_body → http_post sent only Authorization;
-- gateway rewrote to ES256 JWT; function's isServiceRoleRequest checks
-- apikey first, but apikey was absent → 401 → no rows written.
--
-- Fix: add 'apikey' header alongside 'Authorization' in both helpers.
-- Single migration covers the entire helper-using class. Same shape as
-- the 5/7 inline-cron mass-fix (commit fa0eaab); just at the helper
-- layer this time.

SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION public._ct_post(_fn text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  _project_url text;
  _service_key text;
  _request_id  bigint;
BEGIN
  SELECT decrypted_secret INTO _project_url FROM vault.decrypted_secrets WHERE name = 'project_url';
  SELECT decrypted_secret INTO _service_key FROM vault.decrypted_secrets WHERE name = 'service_role_key';
  IF _project_url IS NULL OR _service_key IS NULL THEN
    RETURN jsonb_build_object('error', 'Vault missing project_url or service_role_key');
  END IF;
  SELECT net.http_post(
    url     := _project_url || '/functions/v1/' || _fn,
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || _service_key,
      'apikey',        _service_key
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000
  ) INTO _request_id;
  RETURN jsonb_build_object('request_id', _request_id, 'fired_at', now(), 'fn', _fn);
END
$fn$;

GRANT EXECUTE ON FUNCTION public._ct_post(text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public._ct_post_with_body(_fn text, _body jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  _project_url text;
  _service_key text;
  _request_id  bigint;
BEGIN
  SELECT decrypted_secret INTO _project_url FROM vault.decrypted_secrets WHERE name = 'project_url';
  SELECT decrypted_secret INTO _service_key FROM vault.decrypted_secrets WHERE name = 'service_role_key';
  IF _project_url IS NULL OR _service_key IS NULL THEN
    RETURN jsonb_build_object('error', 'Vault missing project_url or service_role_key');
  END IF;
  SELECT net.http_post(
    url     := _project_url || '/functions/v1/' || _fn,
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || _service_key,
      'apikey',        _service_key
    ),
    body    := COALESCE(_body, '{}'::jsonb),
    timeout_milliseconds := 60000
  ) INTO _request_id;
  RETURN jsonb_build_object('request_id', _request_id, 'fired_at', now(), 'fn', _fn);
END
$fn$;

GRANT EXECUTE ON FUNCTION public._ct_post_with_body(text, jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public._ct_post(text) IS
  'Vault-powered cron→edge-function HTTP wrapper. apikey header required (Supabase gateway rewrites Authorization to ES256 JWT post-key-migration; isServiceRoleRequest checks apikey). timeout_milliseconds=60000 prevents pg_net from killing mid-flight calls.';

COMMENT ON FUNCTION public._ct_post_with_body(text, jsonb) IS
  'Vault-powered cron→edge-function HTTP wrapper with JSON body. apikey header required (gateway rewrites Authorization). timeout_milliseconds=60000 prevents pg_net from killing mid-flight calls.';
