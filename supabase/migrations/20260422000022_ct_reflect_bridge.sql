-- =============================================================================
-- 20260422000022_ct_reflect_bridge.sql
--
-- One-way bridge: ct_claude_decisions (last 24h, high-signal) -> one Haiku
-- synthesis -> jac_reflections row (task_type='co_trader_reflection'). Closes
-- the learning-loop gap where JAC's distill-principles is deaf to what
-- Claude-the-trader is learning.
--
-- Isolation preserved (Tenet 6): OUT-only. Co-Trader functions do NOT read
-- jac_reflections. This cron writes, nothing reads back.
--
-- Components:
--   1) trigger_ct_reflect_to_jac()  — manual-trigger RPC (Vault-powered,
--                                     avoids service_role key rotation issues)
--   2) pg_cron schedule 'ct-reflect-to-jac' — daily 22:30 UTC
-- =============================================================================

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- Manual-trigger RPC.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trigger_ct_reflect_to_jac()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions
AS $fn$ SELECT public._ct_post('ct-reflect-to-jac'); $fn$;
GRANT EXECUTE ON FUNCTION public.trigger_ct_reflect_to_jac() TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- pg_cron schedule. Daily 22:30 UTC — after EOD recap, before dream. Standard
-- Vault+net.http_post pattern with $cron$/$body$ nesting (never $$ inside $$).
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-reflect-to-jac') THEN
    PERFORM cron.unschedule('ct-reflect-to-jac');
  END IF;
END $$;

SELECT cron.schedule(
  'ct-reflect-to-jac',
  '30 22 * * *',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-reflect-to-jac',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $cron$
);
