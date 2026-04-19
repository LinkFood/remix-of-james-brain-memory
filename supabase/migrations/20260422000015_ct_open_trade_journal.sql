-- =============================================================================
-- 20260422000015_ct_open_trade_journal.sql
--
-- Phase 2 Wave I: running commentary on Claude's OPEN positions.
-- Fires ct-claude-open-trade-journal every 2 min during RTH (13-20 UTC,
-- weekdays). Pairs with ct-claude-book-exit-watcher's final-entry journal
-- retrofit so every Claude trade now has a recorded arc from entry
-- through exit instead of just the endpoints.
--
-- Standard Vault + $cron$/$body$ nesting, matching the ticker-snapshot
-- and hypothesis-cron migrations. Also exposes trigger_ct_claude_open_
-- trade_journal() so /crons "Run now" fires via Vault (avoids the CLI
-- vs runtime service_role key mismatch).
-- =============================================================================

SET search_path = public, extensions;

-- Idempotent redeploy — unschedule any prior version of the job.
DO $$
DECLARE
  j record;
BEGIN
  FOR j IN SELECT jobname FROM cron.job WHERE jobname = 'ct-claude-open-trade-journal'
  LOOP
    PERFORM cron.unschedule(j.jobname);
  END LOOP;
END $$;

-- Every 2 min during US RTH (13-20 UTC covers 9:30-16:00 ET year-round).
SELECT cron.schedule(
  'ct-claude-open-trade-journal',
  '*/2 13-20 * * 1-5',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-claude-open-trade-journal',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $cron$
);

-- Manual-trigger RPC — lets /crons "Run now" work via Vault (avoids
-- CLI-vs-runtime service_role key mismatch). Mirrors the pattern from
-- 20260422000010_ct_quant_card_rpc.sql.
CREATE OR REPLACE FUNCTION public.trigger_ct_claude_open_trade_journal()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions
AS $fn$ SELECT public._ct_post('ct-claude-open-trade-journal'); $fn$;

GRANT EXECUTE ON FUNCTION public.trigger_ct_claude_open_trade_journal() TO authenticated, service_role;
