-- =============================================================================
-- 20260430184000_pg_net_timeout_class_kill.sql
--
-- P0 CLASS KILL: pg_net timeout_milliseconds.
--
-- pg_net's net.http_post default timeout silently cancels mid-flight HTTP
-- calls before edge functions can finish work. The cron logs "succeeded"
-- (queue accepted) and the actual HTTP call gets killed.
--
-- We saw this bite live three times today:
--   1. flow-ingester crons producing 0 rows all morning until manual fire
--      (commit b22a3ff fixed those 3 crons individually)
--   2. ct-heatmap-snapshot — added 60s timeout at creation today
--   3. OI snapshot crons — surfaced 2026-04-30 ~14:30 ET when
--      OvernightPositioning panel showed only 6/10 watchlist tickers.
--      MSFT/GOOGL/META stuck since 4/28, AMZN since 4/24.
--
-- Originally scoped as Saturday work covering 30+ migration files. Then we
-- realized: every cron using `_ct_post` or `_ct_post_with_body` inherits
-- the bug from those two helper functions. Fix the helpers, every cron
-- gets the fix. ONE migration covers the entire class.
--
-- Direct net.http_post callers (flow-ingester, heatmap-snapshot,
-- detector-flow-stack-v1) already have explicit timeout per their own
-- migrations. Saturday's work: audit any remaining direct callers.
-- =============================================================================

SET search_path = public, extensions;

-- _ct_post — used by trigger_ct_news_ingester, trigger_ct_eod_recap,
-- trigger_ct_lessons_curator, trigger_ct_specialist-* (10), and dozens
-- of other zero-arg trigger RPCs.
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
      'Authorization', 'Bearer ' || _service_key
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000   -- CLASS KILL: 60s gives any reasonable edge function room to finish
  ) INTO _request_id;
  RETURN jsonb_build_object('request_id', _request_id, 'fired_at', now(), 'fn', _fn);
END
$fn$;

GRANT EXECUTE ON FUNCTION public._ct_post(text) TO authenticated, service_role;

-- _ct_post_with_body — used by trigger_ct_oi_snapshot_with_slot,
-- trigger_ct_daily_brief, trigger_ct_specialist-{TICKER}, trigger_ct_eod_report,
-- ct_fire_eod, and any cron passing a JSON body. Same pg_net default
-- timeout bug.
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
      'Authorization', 'Bearer ' || _service_key
    ),
    body    := COALESCE(_body, '{}'::jsonb),
    timeout_milliseconds := 60000   -- CLASS KILL: same as _ct_post
  ) INTO _request_id;
  RETURN jsonb_build_object('request_id', _request_id, 'fired_at', now(), 'fn', _fn);
END
$fn$;

GRANT EXECUTE ON FUNCTION public._ct_post_with_body(text, jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public._ct_post(text) IS
  'Vault-powered cron→edge-function HTTP wrapper. timeout_milliseconds=60000 prevents pg_net from killing mid-flight calls (class kill 2026-04-30).';

COMMENT ON FUNCTION public._ct_post_with_body(text, jsonb) IS
  'Vault-powered cron→edge-function HTTP wrapper with JSON body. timeout_milliseconds=60000 prevents pg_net from killing mid-flight calls (class kill 2026-04-30).';
