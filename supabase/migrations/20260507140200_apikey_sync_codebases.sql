-- Edge case: sync-all-codebases cron uses a DECLARE'd svc_key variable
-- instead of inline vault SELECT. Hand-patched.

CREATE OR REPLACE FUNCTION public._tmp_patch_sync_codebases()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, cron, extensions
AS $fn$
DECLARE
  jid bigint;
  cmd text;
  new_cmd text;
BEGIN
  SELECT jobid, command INTO jid, cmd FROM cron.job WHERE jobname = 'sync-all-codebases';
  IF jid IS NULL THEN
    RETURN jsonb_build_object('error', 'sync-all-codebases cron not found');
  END IF;
  new_cmd := replace(
    cmd,
    E'''Authorization'', ''Bearer '' || svc_key,\n          ''Content-Type'', ''application/json''',
    E'''Authorization'', ''Bearer '' || svc_key,\n          ''apikey'', svc_key,\n          ''Content-Type'', ''application/json'''
  );
  IF new_cmd = cmd THEN
    RETURN jsonb_build_object('error', 'pattern not found', 'jobid', jid);
  END IF;
  PERFORM cron.alter_job(jid, command := new_cmd);
  RETURN jsonb_build_object('updated', true, 'jobid', jid);
END
$fn$;

ALTER FUNCTION public._tmp_patch_sync_codebases() OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public._tmp_patch_sync_codebases() TO service_role;
