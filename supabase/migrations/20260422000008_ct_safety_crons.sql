-- =============================================================================
-- 20260422000008_ct_safety_crons.sql
--
-- Wave E: safety layer. Cron schedules + manual-trigger RPCs for the two
-- autonomous guardrail functions shipped this wave:
--
--   ct-claude-circuit-breaker — */5 13-20 * * 1-5 (every 5 min during RTH)
--     Evaluates three halt conditions (session_loss, hallucination_rate,
--     concurrent_cascade), writes ct_claude_circuit_breakers rows when tripped,
--     and logs a ct_claude_decisions entry so Claude "knew" it was halted.
--     Auto-clears prior-session open breakers at the top of each run.
--
--   ct-claude-health-monitor — */10 * * * * (every 10 min including off-hours)
--     Checks time since last ct_claude_decisions row. Status: off_hours, alive,
--     stale, dead. RTH + stale|dead trips 'heartbeat_stale' breaker.
--     Off-hours runs still insert a heartbeat row for diagnostic continuity.
--
-- Both schedules use the Vault-powered Authorization pattern via the existing
-- _ct_post helper (same as Wave C crons).
-- =============================================================================

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- Manual-trigger RPCs — /crons UI "Run now" target.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trigger_ct_claude_circuit_breaker()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions
AS $fn$ SELECT public._ct_post('ct-claude-circuit-breaker'); $fn$;
GRANT EXECUTE ON FUNCTION public.trigger_ct_claude_circuit_breaker() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.trigger_ct_claude_health_monitor()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions
AS $fn$ SELECT public._ct_post('ct-claude-health-monitor'); $fn$;
GRANT EXECUTE ON FUNCTION public.trigger_ct_claude_health_monitor() TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- pg_cron schedules. Standard Vault+net.http_post pattern with $cron$/$body$
-- nesting. Never $$ inside $$.
-- -----------------------------------------------------------------------------

-- Unschedule any prior versions of these jobs (idempotent redeploy).
DO $$
DECLARE
  j record;
BEGIN
  FOR j IN SELECT jobname FROM cron.job
           WHERE jobname IN (
             'ct-claude-circuit-breaker',
             'ct-claude-health-monitor'
           )
  LOOP
    PERFORM cron.unschedule(j.jobname);
  END LOOP;
END $$;

-- Circuit breaker: every 5 min, 13-20 UTC, weekdays. Matches trade-idea-generator.
SELECT cron.schedule(
  'ct-claude-circuit-breaker',
  '*/5 13-20 * * 1-5',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-claude-circuit-breaker',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $cron$
);

-- Health monitor: every 10 min, 24/7 (off-hours status is intentionally tracked).
SELECT cron.schedule(
  'ct-claude-health-monitor',
  '*/10 * * * *',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-claude-health-monitor',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $cron$
);
