-- =============================================================================
-- 20260420000038_debate_scorer_cron.sql
--
-- pg_cron schedule + manual-trigger RPC for ct-debate-outcome-scorer.
--
-- Cadence: daily at 22:00 UTC (~18:00 ET, post-close). The scorer only
-- resolves debates whose horizon has fully elapsed AND which are older than
-- 24h, so running after US close gives every same-day pick a clean window.
-- =============================================================================

SET search_path = public, extensions;

-- Manual-trigger RPC — mirrors the `_ct_post` pattern used for every other
-- ct-* cron. Called from the /health UI "Run now" button (if we add one) and
-- usable in SQL for ad-hoc backfills.
CREATE OR REPLACE FUNCTION public.trigger_ct_debate_outcome_scorer()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$ SELECT public._ct_post('ct-debate-outcome-scorer'); $fn$;

GRANT EXECUTE ON FUNCTION public.trigger_ct_debate_outcome_scorer()
  TO authenticated, service_role;

-- Daily at 22:00 UTC. Edge function checks kill switch internally.
SELECT cron.schedule(
  'ct-debate-outcome-scorer',
  '0 22 * * *',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-debate-outcome-scorer',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $cron$
);
