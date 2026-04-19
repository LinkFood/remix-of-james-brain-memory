-- =============================================================================
-- Wave N.4 — generational lifecycle crons + manual triggers + trade exit_mode.
--
-- Adds:
--   1. ct_trades.exit_mode column (N.1 added it to ct_trade_ideas; the writer
--      now propagates exit_mode into ct_trades so the exit-watcher can branch
--      per-trade).
--   2. claude_hallucination_cascade_threshold config (tunable; default 10).
--   3. trigger_ct_claude_generation_manager() and trigger_ct_claude_cash_decay()
--      manual-trigger RPCs.
--   4. pg_cron schedules:
--        ct-claude-generation-manager  '0 13-20 * * 1-5'   hourly during RTH
--        ct-claude-generation-manager  '30 22 * * 0'       weekend safety check (Sun 22:30 UTC)
--        ct-claude-cash-decay          '0 20 * * 1-5'      post-session-close weekdays
-- =============================================================================

SET search_path = public, extensions;

-- ----------------------------------------------------------------------------
-- 1) ct_trades.exit_mode — matches the ct_trade_ideas column added in
--    20260422000017_ct_generations.sql so book-writer can propagate the mode
--    into the open trade row.
-- ----------------------------------------------------------------------------
ALTER TABLE public.ct_trades
  ADD COLUMN IF NOT EXISTS exit_mode text NOT NULL DEFAULT 'stop_target_horizon'
    CHECK (exit_mode IN ('stop_target_horizon','open_until_invalidated','theta_decay','manual'));

-- ----------------------------------------------------------------------------
-- 2) Hallucination cascade threshold — tunable; default 10.
-- ----------------------------------------------------------------------------
INSERT INTO ct_config (key, value, description, category, default_value) VALUES
  ('claude_hallucination_cascade_threshold', '10'::jsonb,
   'Number of hallucination_flag=true ct_claude_decisions within a generation that triggers a cascade-fire',
   'generational', '10'::jsonb)
  ON CONFLICT (key) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 3) Manual-trigger RPCs for the two new functions.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trigger_ct_claude_generation_manager()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions
AS $fn$ SELECT public._ct_post('ct-claude-generation-manager'); $fn$;
GRANT EXECUTE ON FUNCTION public.trigger_ct_claude_generation_manager() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.trigger_ct_claude_cash_decay()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions
AS $fn$ SELECT public._ct_post('ct-claude-cash-decay'); $fn$;
GRANT EXECUTE ON FUNCTION public.trigger_ct_claude_cash_decay() TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 4) pg_cron schedules — idempotent: unschedule any prior versions first.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  j record;
BEGIN
  FOR j IN SELECT jobname FROM cron.job
           WHERE jobname IN (
             'ct-claude-generation-manager',
             'ct-claude-generation-manager-weekend',
             'ct-claude-cash-decay'
           )
  LOOP
    PERFORM cron.unschedule(j.jobname);
  END LOOP;
END $$;

-- Generation manager: hourly during RTH, weekdays.
SELECT cron.schedule(
  'ct-claude-generation-manager',
  '0 13-20 * * 1-5',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-claude-generation-manager',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $cron$
);

-- Generation manager weekend safety check: Sunday 22:30 UTC.
SELECT cron.schedule(
  'ct-claude-generation-manager-weekend',
  '30 22 * * 0',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-claude-generation-manager',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $cron$
);

-- Cash decay: daily at 20:00 UTC weekdays (post session close).
SELECT cron.schedule(
  'ct-claude-cash-decay',
  '0 20 * * 1-5',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-claude-cash-decay',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $cron$
);
