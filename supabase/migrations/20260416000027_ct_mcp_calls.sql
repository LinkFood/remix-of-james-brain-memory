-- ============================================================================
-- ct_mcp_calls — log of every MCP tool call Claude makes during any chat /
-- verify / other invocation. Pairs tool_use with tool_result so you can
-- see exactly what was queried and what came back.
-- ============================================================================
SET search_path = public, extensions;

CREATE TABLE IF NOT EXISTS ct_mcp_calls (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source       text NOT NULL,                   -- 'chat' | 'mcp-verify' | 'watcher' | etc
  server_name  text,                             -- e.g. 'unusual-whales'
  tool_name    text,                             -- specific tool Claude called
  tool_use_id  text,
  input        jsonb,                            -- params Claude sent
  result       jsonb,                            -- truncated result (first ~8KB)
  is_error     boolean NOT NULL DEFAULT false,
  duration_ms  int,
  related_to   uuid,                             -- optional — chat message id, etc.
  user_id      uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ct_mcp_calls_created ON ct_mcp_calls (created_at DESC);
CREATE INDEX IF NOT EXISTS ct_mcp_calls_source ON ct_mcp_calls (source, created_at DESC);
CREATE INDEX IF NOT EXISTS ct_mcp_calls_tool ON ct_mcp_calls (tool_name, created_at DESC);

ALTER TABLE ct_mcp_calls ENABLE ROW LEVEL SECURITY;
CREATE POLICY ct_mcp_calls_authread ON ct_mcp_calls FOR SELECT TO authenticated USING (true);
CREATE POLICY ct_mcp_calls_svcall ON ct_mcp_calls FOR ALL TO service_role USING (true) WITH CHECK (true);
