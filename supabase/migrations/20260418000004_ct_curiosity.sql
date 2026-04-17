-- =============================================================================
-- 20260418000004_ct_curiosity.sql
--
-- Proactive Claude ("ct-curiosity") — the self-directed counterpart to the
-- reactive watcher. Runs every 30 min during market hours, offset 7 min from
-- the watcher (at :07 and :37) so the two don't stampede the MCP budget.
--
-- Each run asks Claude ONE question: given the last 30 min of tape state,
-- is there anything the scheduled watcher MIGHT HAVE MISSED worth a deeper
-- look? If yes, pick ONE specific investigation, pull the relevant data via
-- the UW MCP (hard budget: 2 calls max, enforced in prompt + logged), and
-- write a finding. If nothing is worth chasing, skip gracefully — that's the
-- correct behavior, not a failure.
--
-- Findings embed via Voyage + hit Slack when attention_score ≥ 60.
-- =============================================================================
SET search_path = public, extensions;

-- ----------------------------------------------------------------------------
-- ct_curiosity_findings
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ct_curiosity_findings (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  session_date          date NOT NULL DEFAULT CURRENT_DATE,
  user_id               uuid,                          -- James's profile id, nullable for safety
  question              text NOT NULL,                 -- what Claude went hunting for
  finding               text NOT NULL,                 -- what it found
  attention_score       int CHECK (attention_score BETWEEN 0 AND 100),
  mcp_calls             int NOT NULL DEFAULT 0,        -- actual UW calls made this run
  tokens_in             int NOT NULL DEFAULT 0,
  tokens_out            int NOT NULL DEFAULT 0,
  cost_usd              numeric NOT NULL DEFAULT 0,
  actionable            boolean NOT NULL DEFAULT false,
  related_instruments   text[] NOT NULL DEFAULT '{}',
  prompt_version        text NOT NULL DEFAULT 'v1'
);

CREATE INDEX IF NOT EXISTS idx_ct_curiosity_created_attention
  ON ct_curiosity_findings (created_at DESC, attention_score DESC);

CREATE INDEX IF NOT EXISTS idx_ct_curiosity_session
  ON ct_curiosity_findings (session_date DESC);

COMMENT ON TABLE ct_curiosity_findings IS
  'Proactive Claude findings. Each row = one self-directed investigation where Claude decided the tape was worth a deeper look beyond what the scheduled watcher pulled. Budget: max 2 UW MCP calls per run, Haiku only.';
COMMENT ON COLUMN ct_curiosity_findings.question IS
  'The specific investigation Claude chose to run — ticker, strike, flow pattern, DP cluster.';
COMMENT ON COLUMN ct_curiosity_findings.finding IS
  'Synthesis of what the UW data showed, with an honest "actionable or not" read.';

-- ----------------------------------------------------------------------------
-- RLS
-- ----------------------------------------------------------------------------
ALTER TABLE ct_curiosity_findings ENABLE ROW LEVEL SECURITY;

CREATE POLICY ct_curiosity_authread
  ON ct_curiosity_findings FOR SELECT TO authenticated USING (true);

CREATE POLICY ct_curiosity_svcall
  ON ct_curiosity_findings FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ----------------------------------------------------------------------------
-- Trigger RPC (mirrors the _ct_post pattern used by every ct cron)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trigger_ct_curiosity()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions
AS $fn$ SELECT public._ct_post('ct-curiosity'); $fn$;

GRANT EXECUTE ON FUNCTION public.trigger_ct_curiosity() TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Cron: 7,37 past the hour during weekday market hours (13:00-20:00 UTC =
-- 9:00 AM - 4:00 PM ET). Offset 7 min from watcher's 0,15,30,45 so the two
-- crons don't race for Anthropic + UW capacity.
-- ----------------------------------------------------------------------------
SELECT cron.schedule(
  'ct-curiosity',
  '7,37 13-20 * * 1-5',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-curiosity',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $cron$
);
