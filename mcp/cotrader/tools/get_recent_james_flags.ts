// get_recent_james_flags — Tier 1 v2 tool.
//
// Returns flags James has personally starred from the /tape UI within a
// rolling lookback window. Reads `ct_flags` filtered to `source='james_star'`
// (per `_shared/jamesFlagsContext.ts:174` post `20260427000010_unify_flags`).
//
// Per Phase A audit (`docs/audit/2026-05-05-cotrader-mcp-v2-tier1-phase-a.md`):
//   - Ticker column is `instrument` (NOT `ticker` — confirmed memory).
//   - Hard universe-lock on ticker arg via `assertUniverseTicker` — James's
//     stars are operational signals on the locked universe; off-universe
//     star = bug.
//   - Default lookback 24h, capped at 168h (1 week).
//   - Tool will routinely return zero rows (latest james_star is 2026-04-24).
//     That's accurate, not a bug.
//
// Read-only (SELECT). Best-effort telemetry to `ct_brain_telemetry`.

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { resolveAuth } from '../lib/auth.ts';
import { assertUniverseTicker } from '../lib/universe.ts';

const CONSUMER_NAME = 'cotrader-mcp';
const TOOL_NAME = 'tool:get_recent_james_flags';

const DEFAULT_HOURS = 24;
const MAX_HOURS = 168; // 1 week
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export interface GetRecentJamesFlagsArgs {
  hours?: number;
  ticker?: string;
  limit?: number;
}

export interface JamesFlagRow {
  id: string;
  instrument: string;
  option_symbol: string | null;
  strike: number | null;
  expiry: string | null;
  side: string | null;
  direction: string | null;
  score: number | null;
  score_breakdown: unknown;
  tags: string[] | null;
  thesis: string | null;
  invalidation: string | null;
  horizon_hours: number | null;
  horizon_ts: string | null;
  entry_price: number | null;
  status: string | null;
  source: string;
  detector_id: string | null;
  specialist_ticker: string | null;
  created_at: string;
  updated_at: string | null;
  slacked_at: string | null;
}

export interface GetRecentJamesFlagsResult {
  flags: JamesFlagRow[];
  meta: {
    consumerName: string;
    tool: string;
    appliedFilters: {
      hours: number;
      ticker: string | null;
      limit: number;
      sinceUtc: string;
    };
    rowCount: number;
    latencyMs: number;
    generatedAt: string;
    warnings: string[];
  };
}

async function emitTelemetry(
  supabase: SupabaseClient,
  args: { latencyMs: number; outputBytes: number; error?: string | null; tickerFocus: string | null },
): Promise<void> {
  try {
    await supabase.from('ct_brain_telemetry').insert({
      helper_name: TOOL_NAME,
      audience: 'cotrader',
      ticker_focus: args.tickerFocus,
      consumer_name: CONSUMER_NAME,
      latency_ms: args.latencyMs,
      output_size_bytes: args.outputBytes,
      cache_hit: false,
      error: args.error ?? null,
    });
  } catch (_e) {
    // never block
  }
}

export async function getRecentJamesFlags(
  args: GetRecentJamesFlagsArgs,
): Promise<GetRecentJamesFlagsResult> {
  const t0 = performance.now();
  const warnings: string[] = [];

  // Validate hours
  let hours = DEFAULT_HOURS;
  if (args.hours !== undefined && args.hours !== null) {
    const h = Number(args.hours);
    if (!Number.isFinite(h) || h <= 0) {
      warnings.push(`invalid_hours:${args.hours} — using default ${DEFAULT_HOURS}`);
    } else if (h > MAX_HOURS) {
      hours = MAX_HOURS;
      warnings.push(`hours_capped_at:${MAX_HOURS}`);
    } else {
      hours = Math.floor(h);
    }
  }

  // Validate limit
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

  // Hard universe-lock on ticker arg (assertUniverseTicker throws on miss).
  let tickerArg: string | null = null;
  if (args.ticker !== undefined && args.ticker !== null && String(args.ticker).trim() !== '') {
    tickerArg = assertUniverseTicker(String(args.ticker));
  }

  const sinceUtc = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const { supabaseUrl, serviceRoleKey } = await resolveAuth();
  const supabase: SupabaseClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  let q = supabase
    .from('ct_flags')
    .select(
      'id, instrument, option_symbol, strike, expiry, side, direction, score, score_breakdown, tags, thesis, invalidation, horizon_hours, horizon_ts, entry_price, status, source, detector_id, specialist_ticker, created_at, updated_at, slacked_at',
    )
    .eq('source', 'james_star')
    .gte('created_at', sinceUtc)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (tickerArg) {
    q = q.eq('instrument', tickerArg);
  }

  const { data, error } = await q;
  const latencyMs = Math.round(performance.now() - t0);

  if (error) {
    const msg = `ct_flags james_star query failed: ${error.message}`;
    void emitTelemetry(supabase, {
      latencyMs,
      outputBytes: 0,
      error: msg,
      tickerFocus: tickerArg,
    });
    throw new Error(msg);
  }

  const rows = (data ?? []) as JamesFlagRow[];
  if (rows.length === 0) {
    warnings.push(`no_james_star_flags_in_lookback:${hours}h${tickerArg ? `_for_${tickerArg}` : ''}`);
  }

  const result: GetRecentJamesFlagsResult = {
    flags: rows,
    meta: {
      consumerName: CONSUMER_NAME,
      tool: TOOL_NAME,
      appliedFilters: {
        hours,
        ticker: tickerArg,
        limit,
        sinceUtc,
      },
      rowCount: rows.length,
      latencyMs,
      generatedAt: new Date().toISOString(),
      warnings,
    },
  };

  const outputBytes = JSON.stringify(result).length;
  void emitTelemetry(supabase, {
    latencyMs,
    outputBytes,
    error: null,
    tickerFocus: tickerArg,
  });

  return result;
}
