-- ct_pre_bell_predictions — 9:25 ET weekday Claude writes 3 committed calls
-- for the session: SPY direction at 10am, one ticker that'll print unusual
-- flow, one sector that'll lag. Locked. Graded at 10am/11am/close.
-- This is the "gauntlet" — forced commitment under pressure, the cleanest
-- calibration signal since there's no hindsight narration possible.
SET search_path = public, extensions;

CREATE TABLE IF NOT EXISTS ct_pre_bell_predictions (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_date           date NOT NULL,
  prediction_slot        text NOT NULL,               -- 'spy_10am' | 'unusual_flow' | 'lagging_sector'
  prediction             jsonb NOT NULL,              -- slot-specific schema (see below)
  rationale              text NOT NULL,               -- short reasoning — graded independently for reasoning quality
  confidence             int NOT NULL CHECK (confidence BETWEEN 1 AND 5),
  committed_at           timestamptz NOT NULL DEFAULT now(),
  graded_at              timestamptz,
  verdict                text,                        -- 'right' | 'wrong' | 'partial' | 'ambiguous'
  actual_outcome         jsonb,                       -- what actually happened
  calibration_delta      numeric,                     -- confidence − correctness (−4..+4)
  prompt_version         text DEFAULT 'v1'
);

-- One row per slot per session
CREATE UNIQUE INDEX IF NOT EXISTS ct_pre_bell_uniq ON ct_pre_bell_predictions (session_date, prediction_slot);
CREATE INDEX IF NOT EXISTS ct_pre_bell_session ON ct_pre_bell_predictions (session_date DESC);
CREATE INDEX IF NOT EXISTS ct_pre_bell_ungraded ON ct_pre_bell_predictions (verdict) WHERE verdict IS NULL;

ALTER TABLE ct_pre_bell_predictions ENABLE ROW LEVEL SECURITY;
CREATE POLICY ct_pre_bell_authread ON ct_pre_bell_predictions FOR SELECT TO authenticated USING (true);
CREATE POLICY ct_pre_bell_svcall ON ct_pre_bell_predictions FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Trigger RPCs for cron (generator + grader)
CREATE OR REPLACE FUNCTION public.trigger_ct_pre_bell_gauntlet()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER
AS $fn$ SELECT public._ct_post('ct-pre-bell-gauntlet'); $fn$;

CREATE OR REPLACE FUNCTION public.trigger_ct_pre_bell_grader()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER
AS $fn$ SELECT public._ct_post('ct-pre-bell-grader'); $fn$;

GRANT EXECUTE ON FUNCTION public.trigger_ct_pre_bell_gauntlet() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.trigger_ct_pre_bell_grader() TO authenticated, service_role;

-- Cron schedules:
--   25 13 * * 1-5  = 9:25 AM ET weekdays (EDT) — fire gauntlet
--   5,35 14-20 * * 1-5  = every 30min during market hours — grade any due
SELECT cron.schedule(
  'ct-pre-bell-gauntlet',
  '25 13 * * 1-5',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-pre-bell-gauntlet',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $cron$
);

SELECT cron.schedule(
  'ct-pre-bell-grader',
  '5,35 14-20 * * 1-5',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-pre-bell-grader',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $cron$
);
