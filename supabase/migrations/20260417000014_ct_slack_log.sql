-- ct_slack_log — every push to Slack gets logged for dedupe + audit.
-- Used by ct-watcher to skip redundant pushes (same direction + same
-- trigger within 30min with no material escalation). Used by
-- ct-slack-digest to avoid duplicate digests. Used by future audit
-- to see what actually pinged James vs what stayed in the DB.
SET search_path = public, extensions;

CREATE TABLE IF NOT EXISTS ct_slack_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source          text NOT NULL,           -- 'alert' | 'flag' | 'invalidation' | 'digest'
  state           text,                    -- 'ALERT' | 'FLAG' | 'OBSERVATION' | null for digest
  instruments     text[],
  direction       text,                    -- 'bullish' | 'bearish' | 'neutral'
  alert_trigger   text,                    -- regime_shift | convergence | thesis_invalidation | etc
  conviction      int,
  convergence_cnt int,                     -- so we can detect "upgrade" pushes
  event_id        uuid,                    -- FK to the ct_alert/ct_flag row that triggered
  summary         text,                    -- message summary (first bullet)
  pushed          boolean NOT NULL DEFAULT true,   -- false = skipped by dedupe (logged anyway)
  skip_reason     text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ct_slack_log_created ON ct_slack_log (created_at DESC);
CREATE INDEX IF NOT EXISTS ct_slack_log_dedupe ON ct_slack_log (source, direction, alert_trigger, created_at DESC);

ALTER TABLE ct_slack_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY ct_slack_log_read ON ct_slack_log FOR SELECT TO authenticated USING (true);
CREATE POLICY ct_slack_log_svc  ON ct_slack_log FOR ALL    TO service_role  USING (true) WITH CHECK (true);

-- Trigger RPC + cron for ct-slack-digest
CREATE OR REPLACE FUNCTION public.trigger_ct_slack_digest()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER
AS $fn$ SELECT public._ct_post('ct-slack-digest'); $fn$;

GRANT EXECUTE ON FUNCTION public.trigger_ct_slack_digest() TO authenticated, service_role;

-- Cron: every 30 min during market hours (13:00-20:30 UTC weekdays)
SELECT cron.schedule(
  'ct-slack-digest',
  '0,30 13-20 * * 1-5',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-slack-digest',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $cron$
);
