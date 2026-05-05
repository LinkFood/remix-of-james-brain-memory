// get_observed_patterns — Tier 1 v2 tool.
//
// Reads the forensic platform's catalog of statistically-confirmed patterns
// over Co-Trader flag history (`ct_observed_patterns`).
//
// Per Phase A audit (`docs/audit/2026-05-05-cotrader-mcp-v2-tier1-phase-a.md`):
//   - `pattern_signature` is JSONB with GIN index. Ticker filter uses JSON
//     containment via `pattern_signature->>'instrument' = TICKER`.
//   - Status enum in production: `validated | observed | deprecated`. Default
//     filter is `validated|observed` (drops 6/11 dominant `deprecated` rows).
//   - Soft universe-lock on ticker arg: off-watchlist returns empty without
//     throwing (pattern signatures sometimes carry detector_id or time-of-day
//     instead of ticker, so an ad-hoc symbol probe is legitimate).
//
// Read-only (SELECT). Best-effort telemetry to `ct_mcp_tool_calls` with
// `tool='get_observed_patterns'`, `consumer_name='cotrader-mcp'`. Per
// PR #11 review (2026-05-05) — separated from ct_brain_telemetry so
// organ-coverage queries against the brain telemetry stay clean.

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { resolveAuth } from '../lib/auth.ts';
import { isUniverseTicker, UNIVERSE } from '../lib/universe.ts';
import { emitToolTelemetry } from '../lib/tool_telemetry.ts';

const CONSUMER_NAME = 'cotrader-mcp';
const TOOL_NAME = 'get_observed_patterns';

const VALID_STATUSES = new Set(['validated', 'observed', 'deprecated']);
const DEFAULT_STATUS_FILTER: readonly string[] = ['validated', 'observed'];
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 50;

export interface GetObservedPatternsArgs {
  ticker?: string;
  status?: string | string[];
  min_n?: number;
  limit?: number;
}

export interface ObservedPatternRow {
  id: number;
  pattern_signature: Record<string, unknown>;
  description: string | null;
  n_observed: number | null;
  hit_rate_blended: number | null;
  hit_rate_per_axis: Record<string, unknown> | null;
  baseline_delta: number | null;
  regime_conditional: boolean | null;
  recommended_action: string | null;
  status: string;
  captured_at: string;
  last_validated_at: string | null;
  captured_by: string | null;
  notes: string | null;
}

export interface GetObservedPatternsResult {
  patterns: ObservedPatternRow[];
  meta: {
    consumerName: string;
    tool: string;
    appliedFilters: {
      ticker: string | null;
      tickerInUniverse: boolean | null;
      status: string[];
      minN: number | null;
      limit: number;
    };
    rowCount: number;
    latencyMs: number;
    generatedAt: string;
    warnings: string[];
  };
}

function resolveStatusFilter(status: GetObservedPatternsArgs['status']): {
  values: string[];
  warnings: string[];
} {
  const warnings: string[] = [];
  if (status === undefined || status === null) {
    return { values: [...DEFAULT_STATUS_FILTER], warnings };
  }
  const raw = Array.isArray(status) ? status : String(status).split(',');
  const cleaned: string[] = [];
  for (const s of raw) {
    const v = String(s).trim().toLowerCase();
    if (!v) continue;
    if (!VALID_STATUSES.has(v)) {
      warnings.push(`unknown_status:${v} (valid: validated|observed|deprecated)`);
      continue;
    }
    if (!cleaned.includes(v)) cleaned.push(v);
  }
  if (cleaned.length === 0) {
    warnings.push('no_valid_status_provided_using_default');
    return { values: [...DEFAULT_STATUS_FILTER], warnings };
  }
  return { values: cleaned, warnings };
}

export async function getObservedPatterns(
  args: GetObservedPatternsArgs,
): Promise<GetObservedPatternsResult> {
  const t0 = performance.now();
  const warnings: string[] = [];

  // Validate + normalize args
  let tickerArg: string | null = null;
  let tickerInUniverse: boolean | null = null;
  if (args.ticker !== undefined && args.ticker !== null && String(args.ticker).trim() !== '') {
    const t = String(args.ticker).trim().toUpperCase();
    tickerArg = t;
    tickerInUniverse = isUniverseTicker(t);
    if (!tickerInUniverse) {
      warnings.push(
        `ticker_off_watchlist:${t} (universe: ${UNIVERSE.join(', ')}) — pattern_signature filter applied anyway, may return empty`,
      );
    }
  }

  const { values: statusValues, warnings: statusWarn } = resolveStatusFilter(args.status);
  warnings.push(...statusWarn);

  let minN: number | null = null;
  if (args.min_n !== undefined && args.min_n !== null) {
    const n = Number(args.min_n);
    if (!Number.isFinite(n) || n < 0) {
      warnings.push(`invalid_min_n:${args.min_n} — ignored`);
    } else {
      minN = Math.floor(n);
    }
  }

  let limit = DEFAULT_LIMIT;
  if (args.limit !== undefined && args.limit !== null) {
    const l = Number(args.limit);
    if (!Number.isFinite(l) || l <= 0) {
      warnings.push(`invalid_limit:${args.limit} — using default ${DEFAULT_LIMIT}`);
    } else {
      limit = Math.min(Math.floor(l), MAX_LIMIT);
      if (l > MAX_LIMIT) warnings.push(`limit_capped_at:${MAX_LIMIT}`);
    }
  }

  const { supabaseUrl, serviceRoleKey } = await resolveAuth();
  const supabase: SupabaseClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  // Build query
  let q = supabase
    .from('ct_observed_patterns')
    .select(
      'id, pattern_signature, description, n_observed, hit_rate_blended, hit_rate_per_axis, baseline_delta, regime_conditional, recommended_action, status, captured_at, last_validated_at, captured_by, notes',
    )
    .in('status', statusValues)
    .order('last_validated_at', { ascending: false, nullsFirst: false })
    .order('captured_at', { ascending: false })
    .limit(limit);

  if (tickerArg) {
    // GIN-index-friendly containment on the JSONB column.
    q = q.contains('pattern_signature', { instrument: tickerArg });
  }
  if (minN !== null) {
    q = q.gte('n_observed', minN);
  }

  const { data, error } = await q;
  const latencyMs = Math.round(performance.now() - t0);

  if (error) {
    const msg = `ct_observed_patterns query failed: ${error.message}`;
    void emitToolTelemetry(supabase, {
      tool: TOOL_NAME,
      ticker: tickerArg,
      params: { ticker: tickerArg, status: statusValues, min_n: minN, limit },
      durationMs: latencyMs,
      outputBytes: 0,
      error: msg,
    });
    throw new Error(msg);
  }

  const rows = (data ?? []) as ObservedPatternRow[];
  const result: GetObservedPatternsResult = {
    patterns: rows,
    meta: {
      consumerName: CONSUMER_NAME,
      tool: TOOL_NAME,
      appliedFilters: {
        ticker: tickerArg,
        tickerInUniverse,
        status: statusValues,
        minN,
        limit,
      },
      rowCount: rows.length,
      latencyMs,
      generatedAt: new Date().toISOString(),
      warnings,
    },
  };

  const outputBytes = JSON.stringify(result).length;
  void emitToolTelemetry(supabase, {
    tool: TOOL_NAME,
    ticker: tickerArg,
    params: { ticker: tickerArg, status: statusValues, min_n: minN, limit },
    durationMs: latencyMs,
    outputBytes,
  });

  return result;
}
