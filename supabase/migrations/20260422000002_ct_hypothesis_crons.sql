-- =============================================================================
-- 20260422000002_ct_hypothesis_crons.sql
--
-- pg_cron schedules + AFTER INSERT trigger on ct_grades + manual-trigger RPCs
-- for the four hypothesis-engine edge functions shipped in Wave 1b.
--
-- Schedules:
--   ct-hypothesis-health-check : every 15 min during 13-20 UTC Mon-Fri (RTH)
--   ct-hypothesis-reaper        : daily 06:00 UTC (02:00 ET — after overnight)
--   ct-hypothesis-proposer      : weekdays 11:00 UTC (07:00 ET — pre-bell)
--
-- Trigger:
--   ct_grades AFTER INSERT -> if NEW.hypothesis_id IS NOT NULL ->
--     _ct_post_with_body('ct-hypothesis-confidence-update', {grade_id: NEW.id})
--
-- Naming convention mirrors the existing ct-* cron family: trigger_ct_* SQL
-- RPCs so the /crons UI "Run now" button can fire each function ad-hoc using
-- the Vault-powered Authorization pattern (avoids the CLI-vs-runtime
-- service_role key mismatch).
-- =============================================================================

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- Variant of _ct_post that accepts a jsonb body. We do NOT modify the original
-- _ct_post(_fn text) helper since every other cron depends on its zero-arg
-- signature; instead we add a sibling with _body.
-- -----------------------------------------------------------------------------
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
    body    := COALESCE(_body, '{}'::jsonb)
  ) INTO _request_id;
  RETURN jsonb_build_object('request_id', _request_id, 'fired_at', now(), 'fn', _fn);
END
$fn$;

GRANT EXECUTE ON FUNCTION public._ct_post_with_body(text, jsonb) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Manual-trigger RPCs — one-line wrappers around _ct_post for each function.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trigger_ct_hypothesis_health_check()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions
AS $fn$ SELECT public._ct_post('ct-hypothesis-health-check'); $fn$;
GRANT EXECUTE ON FUNCTION public.trigger_ct_hypothesis_health_check() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.trigger_ct_hypothesis_reaper()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions
AS $fn$ SELECT public._ct_post('ct-hypothesis-reaper'); $fn$;
GRANT EXECUTE ON FUNCTION public.trigger_ct_hypothesis_reaper() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.trigger_ct_hypothesis_proposer()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions
AS $fn$ SELECT public._ct_post('ct-hypothesis-proposer'); $fn$;
GRANT EXECUTE ON FUNCTION public.trigger_ct_hypothesis_proposer() TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- AFTER INSERT trigger on ct_grades — fires ct-hypothesis-confidence-update
-- only when the grade is linked to a hypothesis. Fire-and-forget: the net.http
-- call returns a request_id immediately, the edge function updates the
-- hypothesis asynchronously. The trigger itself must never block the insert.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trigger_ct_grades_notify_hypothesis()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
BEGIN
  IF NEW.hypothesis_id IS NOT NULL THEN
    BEGIN
      PERFORM public._ct_post_with_body(
        'ct-hypothesis-confidence-update',
        jsonb_build_object('grade_id', NEW.id)
      );
    EXCEPTION WHEN OTHERS THEN
      -- Never fail the grade insert because the notifier hiccuped.
      RAISE WARNING 'trigger_ct_grades_notify_hypothesis failed for grade=%: %', NEW.id, SQLERRM;
    END;
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS ct_grades_notify_hypothesis_trg ON ct_grades;
CREATE TRIGGER ct_grades_notify_hypothesis_trg
  AFTER INSERT ON ct_grades
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_ct_grades_notify_hypothesis();

-- -----------------------------------------------------------------------------
-- Cron schedules — all use the Vault pattern and $cron$/$body$ nesting
-- (matches every other ct-* cron in this repo).
-- -----------------------------------------------------------------------------

-- Health check: every 15 min, 13-20 UTC (09-16 ET), weekdays only.
SELECT cron.schedule(
  'ct-hypothesis-health-check',
  '*/15 13-20 * * 1-5',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-hypothesis-health-check',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $cron$
);

-- Reaper: daily at 06:00 UTC (02:00 ET, post-overnight).
SELECT cron.schedule(
  'ct-hypothesis-reaper',
  '0 6 * * *',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-hypothesis-reaper',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $cron$
);

-- Proposer: weekdays 11:00 UTC (07:00 ET, pre-bell).
SELECT cron.schedule(
  'ct-hypothesis-proposer',
  '0 11 * * 1-5',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-hypothesis-proposer',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $cron$
);
