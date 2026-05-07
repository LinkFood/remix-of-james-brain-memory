-- Handle the LIMIT 1 variant + any other end-of-SELECT trailing whitespace.
-- Also handle cases where vault key is read inline w/o LIMIT vs with LIMIT.

CREATE OR REPLACE FUNCTION public._tmp_add_apikey_to_crons_v2()
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
      E'(''Authorization'',\\s*''Bearer\\s*''\\s*\\|\\|\\s*\\(SELECT decrypted_secret FROM vault\\.decrypted_secrets WHERE name = ''service_role_key''(?:\\s+LIMIT\\s+\\d+)?\\))',
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

ALTER FUNCTION public._tmp_add_apikey_to_crons_v2() OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public._tmp_add_apikey_to_crons_v2() TO service_role;
