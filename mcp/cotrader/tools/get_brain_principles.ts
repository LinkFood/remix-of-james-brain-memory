// get_brain_principles — Co-Trader MCP v2 Tier 1 tool.
//
// Returns the captain's distilled principles from `jac_principles` — the
// behavior rules learned from prior session reflections, distilled by the
// `distill-principles` cron. Use when reasoning about whether a current
// setup pattern matches a previously-codified failure mode.
//
// The 5/5 server.ts comment claiming brain_principles doesn't exist is
// STALE — Phase A 2026-05-07 confirmed jac_principles is the canonical
// table (rows present, distill-principles cron writing). Adding tool now.
//
// Phase A field-mapping notes (instance #34 — producer-instrumentation-
// gates-consumer-precision):
//   principle_id           ← id (UUID)
//   text                   ← principle
//   distilled_at           ← created_at
//   confidence             ← confidence (0.0-1.0 in DB)
//   source_pattern         ← null (DB has no descriptive failure-mode
//                                  text field; source_reflection_ids is
//                                  UUID array — empirically empty across
//                                  current rows. Don't fabricate.)
// DB-extra fields surfaced (additive beyond doc spec):
//   source_reflection_ids, category, severity, acknowledged,
//   retired_at, times_applied, last_validated
//
// Filter: retired_at IS NULL (active principles only). Captain workflow
// wants currently-applicable rules; retired ones are noise.
//
// Status enum (Path C explicit-absence contract):
//   any active principles → "populated"
//   zero rows             → "no_principles_yet" with empty principles[]
//
// Read-only. Best-effort telemetry to ct_mcp_tool_calls.

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { resolveAuth } from '../lib/auth.ts';
import { emitToolTelemetry } from '../lib/tool_telemetry.ts';

const CONSUMER_NAME = 'cotrader-mcp';
const TOOL_NAME = 'get_brain_principles';
const HARD_CAP = 100;

export interface GetBrainPrinciplesArgs {
  // No params per scoping doc. include_retired added later if needed.
  _placeholder?: never;
}

interface JacPrincipleRow {
  id: string;
  principle: string;
  source_reflection_ids: string[] | null;
  confidence: number | null;
  times_applied: number | null;
  created_at: string;
  last_validated: string | null;
  category: string | null;
  severity: number | null;
  acknowledged: boolean | null;
  retired_at: string | null;
}

export interface BrainPrinciple {
  principle_id: string;
  text: string;
  source_pattern: null;
  distilled_at: string;
  confidence: number | null;
  source_reflection_ids: string[];
  category: string | null;
  severity: number | null;
  acknowledged: boolean;
  retired_at: string | null;
  times_applied: number;
  last_validated: string | null;
}

export interface BrainPrinciplesResponse {
  status: 'populated' | 'no_principles_yet';
  principles: BrainPrinciple[];
  total_count: number;
  last_distillation_at: string | null;
}

export interface GetBrainPrinciplesResult {
  brief: BrainPrinciplesResponse;
  meta: {
    consumerName: string;
    tool: string;
    rowCount: number;
    latencyMs: number;
    generatedAt: string;
    warnings: string[];
  };
}

function mapRow(row: JacPrincipleRow): BrainPrinciple {
  return {
    principle_id: row.id,
    text: row.principle,
    source_pattern: null,
    distilled_at: row.created_at,
    confidence: row.confidence,
    source_reflection_ids: Array.isArray(row.source_reflection_ids) ? row.source_reflection_ids : [],
    category: row.category,
    severity: row.severity,
    acknowledged: row.acknowledged ?? false,
    retired_at: row.retired_at,
    times_applied: row.times_applied ?? 0,
    last_validated: row.last_validated,
  };
}

function emptyResponse(): BrainPrinciplesResponse {
  return {
    status: 'no_principles_yet',
    principles: [],
    total_count: 0,
    last_distillation_at: null,
  };
}

export async function getBrainPrinciples(_args: GetBrainPrinciplesArgs = {}): Promise<GetBrainPrinciplesResult> {
  const t0 = performance.now();
  const warnings: string[] = [];

  const { supabaseUrl, serviceRoleKey } = await resolveAuth();
  const supabase: SupabaseClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  const { data, error } = await supabase
    .from('jac_principles')
    .select(
      'id, principle, source_reflection_ids, confidence, times_applied, created_at, last_validated, category, severity, acknowledged, retired_at',
    )
    .is('retired_at', null)
    .order('created_at', { ascending: false })
    .limit(HARD_CAP);

  const latencyMs = Math.round(performance.now() - t0);

  if (error) {
    const msg = `jac_principles query failed: ${error.message}`;
    void emitToolTelemetry(supabase, {
      tool: TOOL_NAME,
      params: {},
      durationMs: latencyMs,
      outputBytes: 0,
      error: msg,
    });
    throw new Error(msg);
  }

  const rows = (data ?? []) as JacPrincipleRow[];
  let response: BrainPrinciplesResponse;
  if (rows.length === 0) {
    response = emptyResponse();
    warnings.push('no_active_principles');
  } else {
    const principles = rows.map(mapRow);
    response = {
      status: 'populated',
      principles,
      total_count: principles.length,
      last_distillation_at: principles[0].distilled_at,
    };
    if (rows.length === HARD_CAP) warnings.push(`hard_cap_reached_at_${HARD_CAP}`);
  }

  const result: GetBrainPrinciplesResult = {
    brief: response,
    meta: {
      consumerName: CONSUMER_NAME,
      tool: TOOL_NAME,
      rowCount: rows.length,
      latencyMs,
      generatedAt: new Date().toISOString(),
      warnings,
    },
  };

  const outputBytes = JSON.stringify(result).length;
  void emitToolTelemetry(supabase, {
    tool: TOOL_NAME,
    params: {},
    durationMs: latencyMs,
    outputBytes,
  });

  return result;
}
