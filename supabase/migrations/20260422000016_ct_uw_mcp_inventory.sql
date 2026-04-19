-- =============================================================================
-- 20260422000015_ct_uw_mcp_inventory.sql
--
-- UW MCP tool + prompt inventory — Phase 2 Wave L.1 verified-artifact store.
--
-- CO-TRADER THESIS tenet 12: "Duplicate nothing UW maintains." Before migrating
-- the hand-rolled wrappers (uwClient.ts + UW_ENDPOINT_REGISTRY) to the UW MCP
-- server, we verify ground truth: what does UW's MCP ACTUALLY advertise today?
-- Tenet 2 says "structural prevention, not detection after the fact" — so we
-- store the live inventory and detect drift at discovery time, not at call-site
-- failure time.
--
-- Two tables, one purpose: freeze what UW publishes so Wave L.2 (ingester
-- migration) has a real whitelist to map against. Also lets drift alerts fire
-- the minute UW renames/removes a tool.
--
-- Populated by the ct-uw-mcp-scout edge function, scheduled daily 04:00 UTC
-- (before health-check at 05:00 UTC → before RTH). Scout upserts on (name) PK,
-- bumps last_seen_at, and flips `active` to false for rows that disappeared
-- from the current advertise-list.
-- =============================================================================

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- ct_uw_mcp_tools — one row per tool UW advertises.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ct_uw_mcp_tools (
  name            text PRIMARY KEY,
  description     text,
  input_schema    jsonb,
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ct_uw_mcp_tools_active
  ON ct_uw_mcp_tools (active, last_seen_at DESC);

ALTER TABLE ct_uw_mcp_tools ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ct_uw_mcp_tools' AND policyname = 'ct_uw_mcp_tools_read') THEN
    EXECUTE 'CREATE POLICY ct_uw_mcp_tools_read ON ct_uw_mcp_tools FOR SELECT TO authenticated USING (true)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ct_uw_mcp_tools' AND policyname = 'ct_uw_mcp_tools_svc') THEN
    EXECUTE 'CREATE POLICY ct_uw_mcp_tools_svc ON ct_uw_mcp_tools FOR ALL TO service_role USING (true) WITH CHECK (true)';
  END IF;
END $$;

COMMENT ON TABLE  ct_uw_mcp_tools IS
  'Inventory of tools advertised by the UW MCP server (https://api.unusualwhales.com/api/mcp). Populated by ct-uw-mcp-scout daily at 04:00 UTC. active=false means scout did not see this tool on the most recent run (drift → deprecation).';
COMMENT ON COLUMN ct_uw_mcp_tools.input_schema IS
  'JSON Schema for the tool arguments, as advertised by the server. Stored verbatim — do not rewrite.';
COMMENT ON COLUMN ct_uw_mcp_tools.active IS
  'Flipped to false when a scout run does not see the tool. Use for deprecation alerts: active=false means either renamed, removed, or UW outage.';

-- -----------------------------------------------------------------------------
-- ct_uw_mcp_prompts — one row per prompt template UW advertises.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ct_uw_mcp_prompts (
  name            text PRIMARY KEY,
  description     text,
  arguments       jsonb,
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ct_uw_mcp_prompts_active
  ON ct_uw_mcp_prompts (active, last_seen_at DESC);

ALTER TABLE ct_uw_mcp_prompts ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ct_uw_mcp_prompts' AND policyname = 'ct_uw_mcp_prompts_read') THEN
    EXECUTE 'CREATE POLICY ct_uw_mcp_prompts_read ON ct_uw_mcp_prompts FOR SELECT TO authenticated USING (true)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ct_uw_mcp_prompts' AND policyname = 'ct_uw_mcp_prompts_svc') THEN
    EXECUTE 'CREATE POLICY ct_uw_mcp_prompts_svc ON ct_uw_mcp_prompts FOR ALL TO service_role USING (true) WITH CHECK (true)';
  END IF;
END $$;

COMMENT ON TABLE  ct_uw_mcp_prompts IS
  'Inventory of prompt templates advertised by the UW MCP server. Same drift-detection contract as ct_uw_mcp_tools.';

-- -----------------------------------------------------------------------------
-- Keep updated_at honest.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ct_uw_mcp_tools_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS trg_ct_uw_mcp_tools_touch ON ct_uw_mcp_tools;
CREATE TRIGGER trg_ct_uw_mcp_tools_touch
  BEFORE UPDATE ON ct_uw_mcp_tools
  FOR EACH ROW EXECUTE FUNCTION public.ct_uw_mcp_tools_touch_updated_at();

CREATE OR REPLACE FUNCTION public.ct_uw_mcp_prompts_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS trg_ct_uw_mcp_prompts_touch ON ct_uw_mcp_prompts;
CREATE TRIGGER trg_ct_uw_mcp_prompts_touch
  BEFORE UPDATE ON ct_uw_mcp_prompts
  FOR EACH ROW EXECUTE FUNCTION public.ct_uw_mcp_prompts_touch_updated_at();

-- -----------------------------------------------------------------------------
-- Manual-trigger RPC — invoke the scout from psql/REST without waiting for cron.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trigger_ct_uw_mcp_scout()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$ SELECT public._ct_post('ct-uw-mcp-scout'); $fn$;

GRANT EXECUTE ON FUNCTION public.trigger_ct_uw_mcp_scout() TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Cron — daily 04:00 UTC. 1h ahead of the REST-path health-check at 05:00 UTC.
-- Gives us the fresh MCP inventory before the health-check fires, so Wave L.2
-- migrations can reference either table in one morning run.
-- -----------------------------------------------------------------------------
SELECT cron.schedule(
  'ct-uw-mcp-scout',
  '0 4 * * *',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-uw-mcp-scout',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $cron$
);
