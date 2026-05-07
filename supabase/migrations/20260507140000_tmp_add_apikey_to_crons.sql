-- Add 'apikey' header to all crons that invoke edge functions via the
-- vault-key Authorization pattern. Required after Supabase migrated
-- auto-injected SUPABASE_SERVICE_ROLE_KEY to sb_secret_v2 format and
-- gateway started rewriting Authorization to ES256 JWT — old crons
-- sending only Authorization no longer reach the function's auth gate
-- because the rewritten value never matches Deno env's raw sb_secret.
-- New _shared/auth.ts checks apikey header (which is passed through
-- unmodified by gateway).
--
-- Pattern: locate jsonb_build_object('Content-Type', ..., 'Authorization', ...)
-- and insert an 'apikey' entry. Idempotent: skip crons that already have apikey.

CREATE OR REPLACE FUNCTION public._tmp_add_apikey_to_crons()
RETURNS TABLE(jobid bigint, jobname text, status text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, cron, extensions
AS $fn$
DECLARE
  rec record;
  new_command text;
BEGIN
  FOR rec IN
    SELECT j.jobid, j.jobname, j.command
    FROM cron.job j
    WHERE j.command LIKE '%functions/v1/%'
      AND j.command LIKE '%service_role_key%'
      AND j.command NOT LIKE '%''apikey''%'
      AND j.active = true
  LOOP
    new_command := regexp_replace(
      rec.command,
      E'(''Authorization'',\\s*''Bearer\\s*''\\s*\\|\\|\\s*\\(SELECT decrypted_secret FROM vault\\.decrypted_secrets WHERE name = ''service_role_key''\\))',
      E'\\1,\n        ''apikey'', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = ''service_role_key'')',
      'g'
    );
    IF new_command = rec.command THEN
      jobid := rec.jobid; jobname := rec.jobname; status := 'pattern_not_matched';
      RETURN NEXT;
    ELSE
      PERFORM cron.alter_job(rec.jobid, command := new_command);
      jobid := rec.jobid; jobname := rec.jobname; status := 'updated';
      RETURN NEXT;
    END IF;
  END LOOP;
END
$fn$;

ALTER FUNCTION public._tmp_add_apikey_to_crons() OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public._tmp_add_apikey_to_crons() TO service_role;
