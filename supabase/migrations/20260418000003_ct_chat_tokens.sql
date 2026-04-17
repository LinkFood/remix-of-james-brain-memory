-- ct_chat_tokens — every chat turn records token usage + cost so we can
-- see what the chat is costing us over the weekend. Drops into the
-- cost-observability gap flagged by the Ask Claude audit.
SET search_path = public, extensions;

CREATE TABLE IF NOT EXISTS ct_chat_tokens (
  id              bigserial PRIMARY KEY,
  created_at      timestamptz NOT NULL DEFAULT now(),
  session_date    date NOT NULL DEFAULT (now() AT TIME ZONE 'America/New_York')::date,
  user_id         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  model           text,
  tokens_in       int,
  tokens_out      int,
  cost_usd        numeric(10, 6),
  duration_ms     int,
  mcp_calls       int DEFAULT 0,
  user_message    text,
  response_chars  int
);

CREATE INDEX IF NOT EXISTS ct_chat_tokens_session ON ct_chat_tokens (session_date DESC, created_at DESC);

ALTER TABLE ct_chat_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY ct_chat_tokens_read ON ct_chat_tokens FOR SELECT TO authenticated USING (true);
CREATE POLICY ct_chat_tokens_svc  ON ct_chat_tokens FOR ALL    TO service_role  USING (true) WITH CHECK (true);

-- Daily rollup view for a quick "what did chat cost today" query.
CREATE OR REPLACE VIEW ct_chat_tokens_today AS
SELECT
  session_date,
  count(*)                AS turns,
  sum(tokens_in)          AS tokens_in,
  sum(tokens_out)         AS tokens_out,
  round(sum(cost_usd)::numeric, 4) AS cost_usd,
  sum(mcp_calls)          AS mcp_calls,
  avg(duration_ms)::int   AS avg_ms
FROM ct_chat_tokens
GROUP BY session_date
ORDER BY session_date DESC;

GRANT SELECT ON ct_chat_tokens_today TO authenticated;
