// Shared telemetry helper for MCP tool calls. Writes one row per tool
// invocation to public.ct_mcp_tool_calls.
//
// Born from v2 Tier 1 PR #11 review (2026-05-05) — split tool-call
// telemetry out of ct_brain_telemetry (which is organ-only) so warden +
// get_brain_health organ-coverage queries stay clean.
//
// All 5 v2 tools route through here. v1's get_co_trader_context still
// writes organ-level telemetry into ct_brain_telemetry via
// claudeReadSurface.ts — that's the right surface for organ data and
// is unchanged.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';

export interface ToolTelemetryArgs {
  /** Tool name without 'tool:' prefix — the table is the namespace. */
  tool: string;
  /** Optional ticker arg (NULL for tool-wide calls like get_warden_state). */
  ticker?: string | null;
  /** JSONB snapshot of caller args. Sanitize secrets before passing. */
  params?: Record<string, unknown> | null;
  /** Wall-clock ms for the tool body. */
  durationMs: number;
  /** Response payload size in bytes. */
  outputBytes?: number | null;
  /** Non-null if the call errored or hit a soft warning. */
  error?: string | null;
}

export async function emitToolTelemetry(
  supabase: SupabaseClient,
  args: ToolTelemetryArgs,
): Promise<void> {
  try {
    await supabase.from('ct_mcp_tool_calls').insert({
      tool: args.tool,
      ticker: args.ticker ?? null,
      params: args.params ?? null,
      duration_ms: Math.max(0, Math.round(args.durationMs)),
      output_size_bytes: args.outputBytes ?? null,
      error: args.error ?? null,
    });
  } catch (_e) {
    // Telemetry never blocks. Swallow.
  }
}
