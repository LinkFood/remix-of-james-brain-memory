# Cron Health Runbook

## Symptom
- `/crons` page card shows red.
- `get_cron_status()` returns `last_run_at` older than the schedule expects, or `last_run_status = 'failed'` / `'never'`.
- Cron-health Slack alert fires on a specific cron name.
- Cron shows `last_run_status = 'succeeded'` but the target table has no new rows (the silent class).

## What's actually happening

pg_cron jobs are rows in `cron.job` keyed by `jobname`. Most schedules are simple `net.http_post(...)` calls into an edge function. The "succeeded" status is the gotcha: pg_cron only verifies that the SQL ran without throwing — it does NOT check the HTTP response. A cron firing into a 404 function will report "succeeded" forever.

Three layers can fail:
1. **SQL parse / auth** — cron body uses bad SQL or wrong vault key. `last_run_status = 'failed'`, `last_run_message` has the error.
2. **HTTP layer** — function returns 404 / 5xx / times out. pg_cron status looks fine; the rows you expected don't show up.
3. **Function logic** — function returns 200 but wrote nothing because of a guard (watchlist filter excluded everything, dedupe blocked the insert, kill-switch flag set).

Load-bearing files:
- Schedules in migrations matching `*_cron_*.sql` and `cron.schedule(...)` calls
- `get_cron_status()` RPC — joins `cron.job` + `cron.job_run_details`
- Vault keys: `vault.decrypted_secrets` with names `service_role_key`, `project_url`, `supabase_url`
- Authoritative pattern reference: `feedback_cron_health_query.md`

## Diagnostic ladder

1. **Quick scan.**
   ```sql
   SELECT * FROM get_cron_status()
   WHERE last_run_at < now() - interval '1 hour'
      OR last_run_status IN ('failed', 'never');
   ```

2. **Per-cron history (last 5 runs).**
   ```sql
   SELECT j.jobname, d.status, d.return_message, d.start_time, d.end_time
   FROM cron.job j
   JOIN cron.job_run_details d ON d.jobid = j.jobid
   WHERE j.jobname = '<jobname>'
   ORDER BY d.start_time DESC LIMIT 5;
   ```
   `return_message` carries the SQL-layer error if any.

3. **Verify function actually exists.**
   ```bash
   npx supabase functions list | grep <function-name>
   ```
   Missing or with no recent deploy → 404 trap. The `ct-session-analog` precedent: cron at `30 21 * * 1-5` fired into a non-existent function for weeks; pg_cron status reported "succeeded" the whole time.

4. **Hit the function manually.**
   Use the vault-stored service-role pattern (per `feedback_service_role_key_rotation.md` — CLI JWT may not match runtime env). One-shot DO block:
   ```sql
   DO $$
   DECLARE r record;
   BEGIN
     SELECT * INTO r FROM net.http_post(
       url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/<function-name>',
       headers := jsonb_build_object(
         'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key'),
         'Content-Type', 'application/json'
       ),
       body := '{}'::jsonb,
       timeout_milliseconds := 60000
     );
     RAISE NOTICE 'request_id: %', r.id;
   END $$;
   ```
   Then `SELECT * FROM net._http_response WHERE id = <request_id>;` for status + body.

5. **Function logs.** If the call returned 5xx, tail edge function logs for the actual stack trace.

## Common causes

- **Function 404 (not deployed).** Most common silent class. Always verify with `npx supabase functions list` after rename / new function. Per `project_co_trader_wednesday_2026_04_29_late_night_wrap.md`, this exact bug killed `ct-session-analog`.
- **Function 5xx.** Read logs. Often a missing env var, a downstream API key issue, or a DB constraint violation on insert.
- **pg_net timeout missing.** Cron body lacks `timeout_milliseconds := 60000`. pg_net default is short; functions that take 30-50s get aborted. Fix: amend the schedule.
- **Schedule mistyped.** `0 21 * * 1-5` (UTC) and `0 17 * * 1-5` (UTC) look the same at a glance; one is 5 PM ET, the other isn't. Verify the human intent in the migration comment matches the cron expression.
- **Cron disabled accidentally.** Someone ran `cron.unschedule()` or set `cron.alter_job(active := false)`. Re-enable: `SELECT cron.alter_job(jobid, active := true)`.
- **Vault key missing.** `project_url` and `supabase_url` BOTH must exist (different crons reference different names). Per `~/CLAUDE.md`. If either is null, the cron body's URL string concatenation produces a malformed URL and pg_net throws.
- **SQL `$$` nesting.** Per `~/CLAUDE.md`: pg_cron bodies must use `$cron$ ... $body$ ... $body$ $cron$`, never `$$` inside `$$`.
- **HTTP "succeeded" but no rows.** Function logic guarded everything out. Read the function's first 50 lines — watchlist filter, kill-switch check, daily-cap break — and verify the input data wasn't degenerate.

## Fix steps

For 404:
1. Deploy: `npx supabase functions deploy <name> --no-verify-jwt`
2. Verify in `functions list`.
3. Hit manually (step 4 above) to confirm 200.
4. Wait for next scheduled fire and confirm row landed.

For schedule typo:
1. Read the migration that created the cron.
2. Write a new migration with `cron.alter_job(jobid := ..., schedule := '<correct>')` or unschedule + reschedule.
3. `npx supabase db push`.

For vault / SQL errors: the `return_message` column tells you exactly what's wrong. Don't guess.

## Related

- Tables: `cron.job`, `cron.job_run_details`, `net._http_response`
- RPC: `get_cron_status()`
- Vault keys: `service_role_key`, `project_url`, `supabase_url`
- Memory: `feedback_cron_health_query.md`, `feedback_cron_response_pattern.md`, `feedback_service_role_key_rotation.md`, `pgnet_response_body_null_workaround.md`
- Migration helper: `~/CLAUDE.md` pg_cron section
- Related runbooks: `uw_pollers.md`, `data_freshness.md`
