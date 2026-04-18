-- 20260420000027_alert_post_mortems.sql
--
-- Forensic post-mortems for WRONG alerts. ct-grader already labels alerts
-- right/partial/wrong — wrong alerts until now just sat there. This table
-- stores the structured autopsy: what Claude missed, which evidence axis
-- was the weak link, which bias showed up, what the lesson is, and how
-- confident we are the lesson generalizes.
--
-- One row per (alert_id, alert_kind). alert_kind discriminates between
-- ct_alerts and ct_flags since both are subject to wrong verdicts — we do
-- NOT fk alert_id to either table directly (cross-table reference), the
-- app-level logic enforces the join.
--
-- The ct-alert-post-mortem edge function writes here every 30 min.

SET search_path = public, extensions;

CREATE TABLE IF NOT EXISTS ct_alert_post_mortems (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id                 uuid NOT NULL,
  alert_kind               text NOT NULL CHECK (alert_kind IN ('alert','flag')),
  grade_id                 uuid REFERENCES ct_grades(id) ON DELETE SET NULL,
  what_missed              text NOT NULL,
  weakest_evidence_axis    text CHECK (weakest_evidence_axis IN ('A','B','C','D','E','F')),
  bias_implicated          text,
  lesson                   text NOT NULL,
  confidence_in_lesson     int  NOT NULL CHECK (confidence_in_lesson BETWEEN 1 AND 5),
  axis_misremembered       boolean NOT NULL DEFAULT false,
  tokens_used              int,
  cost_usd                 numeric,
  model                    text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (alert_id, alert_kind)
);

CREATE INDEX IF NOT EXISTS ct_alert_post_mortems_alert_idx
  ON ct_alert_post_mortems (alert_id);

CREATE INDEX IF NOT EXISTS ct_alert_post_mortems_axis_idx
  ON ct_alert_post_mortems (weakest_evidence_axis, created_at DESC)
  WHERE weakest_evidence_axis IS NOT NULL;

CREATE INDEX IF NOT EXISTS ct_alert_post_mortems_bias_idx
  ON ct_alert_post_mortems (bias_implicated, created_at DESC)
  WHERE bias_implicated IS NOT NULL AND bias_implicated <> 'none';

CREATE INDEX IF NOT EXISTS ct_alert_post_mortems_created_idx
  ON ct_alert_post_mortems (created_at DESC);

ALTER TABLE ct_alert_post_mortems ENABLE ROW LEVEL SECURITY;

CREATE POLICY ct_alert_post_mortems_authread ON ct_alert_post_mortems
  FOR SELECT TO authenticated USING (true);

CREATE POLICY ct_alert_post_mortems_svcall ON ct_alert_post_mortems
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE ct_alert_post_mortems IS
  'Forensic autopsy of each wrong ct_alert / ct_flag. One row per (alert_id, alert_kind). Feeds ct_biases confirmation counts.';

COMMENT ON COLUMN ct_alert_post_mortems.weakest_evidence_axis IS
  'Single letter A..F — which evidence axis Claude cited that turned out to be false signal.';

COMMENT ON COLUMN ct_alert_post_mortems.axis_misremembered IS
  'true when Claude cited an axis as weak that was NOT actually in the alert evidence_axes — logged as warning.';

-- Cron: every 30 min. Offset by a few minutes so we run after ct-grader's
-- 15-min cron has landed the latest wrong verdicts.
SELECT cron.schedule(
  'ct-alert-post-mortem',
  '*/30 * * * *',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-alert-post-mortem',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $cron$
);
