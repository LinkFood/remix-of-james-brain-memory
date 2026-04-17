-- Mid-session book re-open cron + trigger RPC
-- Fires at 14:30 UTC (10:30 AM ET) weekdays — 60 min post-open.
-- If book is empty because morning gap-cancelled, Claude gets a fresh
-- commit with current tape. Otherwise no-op.
SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION public.trigger_ct_claude_trade_reopen()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER
AS $fn$ SELECT public._ct_post('ct-claude-trade-reopen'); $fn$;

GRANT EXECUTE ON FUNCTION public.trigger_ct_claude_trade_reopen() TO authenticated, service_role;

SELECT cron.schedule(
  'ct-claude-trade-reopen',
  '30 14 * * 1-5',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-claude-trade-reopen',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $cron$
);
