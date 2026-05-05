-- ct_mcp_tool_calls — telemetry separation for MCP-side tool calls.
--
-- v2 Tier 1 added 5 read-only MCP tools (get_observed_patterns,
-- get_morning_brief, get_eod_summary, get_warden_state,
-- get_recent_james_flags). Initial implementation wrote tool-call telemetry
-- into ct_brain_telemetry with helper_name='tool:<name>' — surfaced as a
-- structural concern in PR #11 review (mixed organ + tool rows
-- desensitized organ-coverage queries against ct_brain_telemetry +
-- get_brain_health).
--
-- This migration creates a dedicated table for MCP tool-call telemetry.
-- Per James: "no schema change" constraint in v2 Tier 1 brief was over-
-- scoped — the intent was protective against EXISTING-table mutation (C1
-- measurement protection), not against ADDITIVE new tables.
--
-- ct_brain_telemetry stays clean for organ telemetry (the original 11
-- helper_name values + cache_hit:fresh_<sec>s rows from v1.1's organ
-- cache).
--
-- Future: any new MCP server (jac-mcp, dcd-mcp) writes here too via the
-- same shared helper at mcp/cotrader/lib/tool_telemetry.ts (renameable
-- to mcp/_shared/ if a sibling MCP appears).

CREATE TABLE IF NOT EXISTS public.ct_mcp_tool_calls (
  id BIGSERIAL PRIMARY KEY,
  tool TEXT NOT NULL,                                -- e.g., 'get_observed_patterns'
  ticker TEXT,                                       -- optional ticker arg (NULL for tool-wide calls like get_warden_state)
  params JSONB,                                      -- snapshot of input args (status filter, limit, hours, etc.) for replay/debug
  duration_ms INT,                                   -- wall-clock ms for the tool body
  output_size_bytes INT,                             -- response payload size
  error TEXT,                                        -- non-null if call errored or hit a soft warning ('off_watchlist', 'no_results', etc.)
  consumer_name TEXT NOT NULL DEFAULT 'cotrader-mcp', -- distinguishes future jac-mcp / dcd-mcp etc.
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ct_mcp_tool_calls_tool_time
  ON public.ct_mcp_tool_calls(tool, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ct_mcp_tool_calls_recent
  ON public.ct_mcp_tool_calls(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ct_mcp_tool_calls_errors
  ON public.ct_mcp_tool_calls(created_at DESC)
  WHERE error IS NOT NULL;

COMMENT ON TABLE public.ct_mcp_tool_calls IS
  'Per-call telemetry ledger for MCP-side tools. Separate from ct_brain_telemetry (which is organ-only) so warden + dashboard organ-coverage queries stay clean. Born from v2 Tier 1 PR #11 review 2026-05-05.';

COMMENT ON COLUMN public.ct_mcp_tool_calls.tool IS
  'Tool name (e.g. get_observed_patterns, get_morning_brief). No "tool:" prefix needed since the table itself is the namespace.';

COMMENT ON COLUMN public.ct_mcp_tool_calls.params IS
  'JSONB snapshot of caller args. Useful for replay-debug + answering "which queries get run most?" without re-instrumenting.';
