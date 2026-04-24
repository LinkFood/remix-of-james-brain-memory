-- ============================================================================
-- Co-Trader v2 — ct-slack-push-flag cron (every minute)
-- ============================================================================
-- Phase 4a: poll unslacked flags (score >= slack threshold, status in
-- active|conviction) and push to Slack. Function self-guards against silent
-- no-op (missing SLACK_BOT_TOKEN or slack_channel_id) by not stamping
-- slacked_at — the next sweep retries once Slack is configured.
--
-- Cadence: every minute. Cheap (single DB read when no new flags); keeps
-- Slack latency within ~60s of flag write. Back-pressure via limit(10) per
-- sweep so a burst cannot starve later flags.
-- ============================================================================

SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION public.trigger_ct_slack_push_flag()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER
SET search_path = public, extensions
AS $fn$ SELECT public._ct_post('ct-slack-push-flag'); $fn$;

GRANT EXECUTE ON FUNCTION public.trigger_ct_slack_push_flag() TO authenticated, service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-slack-push-flag') THEN
    PERFORM cron.unschedule('ct-slack-push-flag');
  END IF;

  PERFORM cron.schedule(
    'ct-slack-push-flag',
    '* * * * *',
    $body$ SELECT public.trigger_ct_slack_push_flag(); $body$
  );
END $$;

COMMENT ON FUNCTION public.trigger_ct_slack_push_flag IS
  'V2 cron trigger for ct-slack-push-flag (every minute). Pushes eligible unslacked flags to Slack.';
