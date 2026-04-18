-- ct_chat cross-facet memory tracking
--
-- When ct-chat detects a "reach outside our corpus" question (historical
-- precedent, regime analogs, "years ago"...), it queries Duck Countdown's
-- hunt_knowledge brain (7M+ entries, same Supabase, same 512-dim space).
-- This column records how many BRIDGE-type narrative hits were actually
-- injected into the Claude context on that turn, so we can:
--
--   - See cross-facet usage alongside existing token/cost per turn,
--   - Correlate cost with cross-facet queries (embedding + RPC aren't free),
--   - Watch for prompt stuffing (hits should correlate with *intent* not volume).
--
-- DCD schema is NOT touched. hunt_knowledge stays read-only from Co-Trader's
-- point of view — cross_facet is an OS-level query pattern, not a new table.
SET search_path = public, extensions;

ALTER TABLE ct_chat_tokens
  ADD COLUMN IF NOT EXISTS cross_facet_hits int NOT NULL DEFAULT 0;

COMMENT ON COLUMN ct_chat_tokens.cross_facet_hits IS
  'Number of DCD hunt_knowledge BRIDGE hits injected into this chat turn. 0 means cross-facet was not triggered or returned nothing.';

-- Update the daily rollup view to include cross-facet totals. DROP first
-- because CREATE OR REPLACE VIEW can't change the column count.
DROP VIEW IF EXISTS ct_chat_tokens_today;
CREATE VIEW ct_chat_tokens_today AS
SELECT
  session_date,
  count(*)                              AS turns,
  sum(tokens_in)                        AS tokens_in,
  sum(tokens_out)                       AS tokens_out,
  round(sum(cost_usd)::numeric, 4)      AS cost_usd,
  sum(mcp_calls)                        AS mcp_calls,
  sum(cross_facet_hits)                 AS cross_facet_hits,
  count(*) FILTER (WHERE cross_facet_hits > 0) AS cross_facet_turns,
  avg(duration_ms)::int                 AS avg_ms
FROM ct_chat_tokens
GROUP BY session_date
ORDER BY session_date DESC;

GRANT SELECT ON ct_chat_tokens_today TO authenticated;

RESET search_path;
