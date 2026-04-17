-- ct_biases — structural patterns the self-grader surface repeatedly but
-- the tactical lessons-curator doesn't capture. Weekly meta-analysis over
-- last 30d of grades + self_regrades extracts "what am I systematically
-- wrong about." Injected into watcher system prompt so Claude sees its
-- own blindspots before every call.
--
-- Biases are META (identity-level patterns); lessons are TACTICAL (rules
-- for specific setups). They coexist.
SET search_path = public, extensions;

CREATE TABLE IF NOT EXISTS ct_biases (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern         text NOT NULL,                 -- "I overweight put flow in low-VIX tape"
  evidence        text NOT NULL,                 -- citations — grade IDs, regrade quotes, stats
  instruments     text[],                        -- nullable → universal
  severity        int NOT NULL CHECK (severity BETWEEN 1 AND 5),
  active          boolean NOT NULL DEFAULT true,
  observed_count  int DEFAULT 1,                 -- how many grades showed this pattern
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_confirmed  timestamptz NOT NULL DEFAULT now(),
  superseded_by   uuid REFERENCES ct_biases(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ct_biases_active ON ct_biases (active, severity DESC, last_confirmed DESC);
CREATE INDEX IF NOT EXISTS ct_biases_last_confirmed ON ct_biases (last_confirmed DESC);

ALTER TABLE ct_biases ENABLE ROW LEVEL SECURITY;
CREATE POLICY ct_biases_authread ON ct_biases FOR SELECT TO authenticated USING (true);
CREATE POLICY ct_biases_svcall ON ct_biases FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.trigger_ct_bias_booth()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER
AS $fn$ SELECT public._ct_post('ct-bias-booth'); $fn$;

GRANT EXECUTE ON FUNCTION public.trigger_ct_bias_booth() TO authenticated, service_role;

-- Cron: Sunday 22:00 UTC — before lessons-curator at 23:00, so biases
-- can inform the weekly lesson review.
SELECT cron.schedule(
  'ct-bias-booth',
  '0 22 * * 0',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-bias-booth',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $cron$
);
