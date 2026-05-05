// get_warden_state — Tier 1 v2 tool.
//
// Returns the System Warden's current invariant snapshot via the existing
// `public.get_warden_health(window_hours)` RPC. Per Phase A audit
// (`docs/audit/2026-05-05-cotrader-mcp-v2-tier1-phase-a.md` §1.5, §9.5):
// the RPC server-aggregates `totals + by_category + sorted failures[]` with
// runbook_path each, in one round-trip. The dashboard is canonical against
// this RPC. We don't re-implement the join.
//
// Read-only (single SELECT via RPC). Best-effort telemetry to
// `ct_mcp_tool_calls` (separate table from organ telemetry per PR #11
// review 2026-05-05).

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { resolveAuth } from '../lib/auth.ts';
import { emitToolTelemetry } from '../lib/tool_telemetry.ts';

const CONSUMER_NAME = 'cotrader-mcp';
const TOOL_NAME = 'get_warden_state';

const DEFAULT_WINDOW_HOURS = 24;
const MIN_WINDOW_HOURS = 1;
const MAX_WINDOW_HOURS = 720; // 30 days — enough for any historical look-back

export interface GetWardenStateArgs {
  window_hours?: number;
}

export interface WardenFailure {
  name: string;
  category: string;
  severity: string;
  last_value: string | null;
  last_run_at: string | null;
  runbook_path: string | null;
  consecutive_fails: number | null;
  [key: string]: unknown; // forward-compat — RPC may evolve
}

export interface WardenHealthPayload {
  totals: Record<string, number>;
  by_category: Array<Record<string, unknown>>;
  failures: WardenFailure[];
  [key: string]: unknown;
}

export interface GetWardenStateResult {
  warden: WardenHealthPayload | null;
  meta: {
    consumerName: string;
    tool: string;
    windowHours: number;
    failureCount: number;
    latencyMs: number;
    generatedAt: string;
    warnings: string[];
  };
}

export async function getWardenState(args: GetWardenStateArgs): Promise<GetWardenStateResult> {
  const t0 = performance.now();
  const warnings: string[] = [];

  let windowHours = DEFAULT_WINDOW_HOURS;
  if (args.window_hours !== undefined && args.window_hours !== null) {
    const w = Number(args.window_hours);
    if (!Number.isFinite(w) || w < MIN_WINDOW_HOURS) {
      warnings.push(`invalid_window_hours:${args.window_hours} — using default ${DEFAULT_WINDOW_HOURS}`);
    } else if (w > MAX_WINDOW_HOURS) {
      windowHours = MAX_WINDOW_HOURS;
      warnings.push(`window_hours_capped_at:${MAX_WINDOW_HOURS}`);
    } else {
      windowHours = Math.floor(w);
    }
  }

  const { supabaseUrl, serviceRoleKey } = await resolveAuth();
  const supabase: SupabaseClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  const { data, error } = await supabase.rpc('get_warden_health', {
    window_hours: windowHours,
  });

  const latencyMs = Math.round(performance.now() - t0);

  if (error) {
    const msg = `get_warden_health RPC failed: ${error.message}`;
    void emitToolTelemetry(supabase, {
      tool: TOOL_NAME,
      params: { window_hours: windowHours },
      durationMs: latencyMs,
      outputBytes: 0,
      error: msg,
    });
    throw new Error(msg);
  }

  const payload = (data ?? null) as WardenHealthPayload | null;
  const failureCount = Array.isArray(payload?.failures) ? payload!.failures.length : 0;

  const result: GetWardenStateResult = {
    warden: payload,
    meta: {
      consumerName: CONSUMER_NAME,
      tool: TOOL_NAME,
      windowHours,
      failureCount,
      latencyMs,
      generatedAt: new Date().toISOString(),
      warnings,
    },
  };

  const outputBytes = JSON.stringify(result).length;
  void emitToolTelemetry(supabase, {
    tool: TOOL_NAME,
    params: { window_hours: windowHours },
    durationMs: latencyMs,
    outputBytes,
  });

  return result;
}
