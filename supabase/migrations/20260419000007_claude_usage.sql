-- ct_claude_usage — unified per-call Claude cost tracking across ALL ct-*
-- functions. Before this, only ct-chat wrote cost to ct_chat_tokens;
-- watcher / curiosity / morning-brief / midday-recap / eod-recap / replay /
-- news-ingester / lessons-curator all called Claude with zero observability.
-- The /health page flagged this as the v2 gap; this migration closes it.
--
-- ct_chat_tokens stays in place (backwards-compat secondary write) — this
-- table is the new source of truth for cross-function cost breakdowns.
SET search_path = public, extensions;

CREATE TABLE IF NOT EXISTS ct_claude_usage (
  id              bigserial PRIMARY KEY,
  created_at      timestamptz NOT NULL DEFAULT now(),
  session_date    date NOT NULL DEFAULT (now() AT TIME ZONE 'America/New_York')::date,
  source          text NOT NULL,         -- edge function name (ct-watcher, ct-chat, ...)
  model           text,                  -- resolved model id (claude-sonnet-4-..., claude-haiku-4-...)
  tokens_in       int,
  tokens_out      int,
  cost_usd        numeric(10, 6),
  duration_ms     int,
  mcp_calls       int DEFAULT 0,
  metadata        jsonb                  -- optional: task_id, trade_id, tick count, etc.
);

CREATE INDEX IF NOT EXISTS ct_claude_usage_session_created
  ON ct_claude_usage (session_date DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS ct_claude_usage_source_session
  ON ct_claude_usage (source, session_date DESC);

ALTER TABLE ct_claude_usage ENABLE ROW LEVEL SECURITY;
CREATE POLICY ct_claude_usage_read ON ct_claude_usage FOR SELECT TO authenticated USING (true);
CREATE POLICY ct_claude_usage_svc  ON ct_claude_usage FOR ALL    TO service_role  USING (true) WITH CHECK (true);

-- Per-source daily rollup for /health: "what did each function cost today?"
CREATE OR REPLACE VIEW ct_claude_usage_today AS
SELECT
  session_date,
  source,
  count(*)                         AS turns,
  sum(tokens_in)                   AS tokens_in,
  sum(tokens_out)                  AS tokens_out,
  round(sum(cost_usd)::numeric, 4) AS cost_usd,
  sum(mcp_calls)                   AS mcp_calls,
  avg(duration_ms)::int            AS avg_ms
FROM ct_claude_usage
GROUP BY session_date, source
ORDER BY session_date DESC, cost_usd DESC NULLS LAST;

GRANT SELECT ON ct_claude_usage_today TO authenticated;

-- One-shot backfill: copy existing ct_chat_tokens rows into ct_claude_usage
-- as source='ct-chat'. Idempotent via an anti-join on metadata->>'chat_token_id'.
-- ct_chat_tokens keeps receiving writes (we don't drop it) — this is just
-- a historical import so /health's unified view starts with real history.
INSERT INTO ct_claude_usage (
  created_at,
  session_date,
  source,
  model,
  tokens_in,
  tokens_out,
  cost_usd,
  duration_ms,
  mcp_calls,
  metadata
)
SELECT
  c.created_at,
  c.session_date,
  'ct-chat' AS source,
  c.model,
  c.tokens_in,
  c.tokens_out,
  c.cost_usd,
  c.duration_ms,
  COALESCE(c.mcp_calls, 0),
  jsonb_build_object(
    'chat_token_id', c.id,
    'backfilled', true,
    'response_chars', c.response_chars
  )
FROM ct_chat_tokens c
WHERE NOT EXISTS (
  SELECT 1 FROM ct_claude_usage u
  WHERE u.metadata ->> 'chat_token_id' = c.id::text
);
