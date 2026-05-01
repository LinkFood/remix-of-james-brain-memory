/**
 * specialistContext — brain organ exposing latest per-ticker specialist reads.
 *
 * Source: `ct_specialist_reads` (per-wakeup running commentary written by the
 * 10 per-ticker specialists every cycle, flag or no flag).
 *
 * Phase 1 of the Synthesis Layer (see `docs/SYNTHESIS_LAYER_ARCHITECTURE.md`
 * § 5a and `_shared/contextHelper.ts`). Specialists currently fire and write;
 * nobody reads their output back into context. This helper closes the loop.
 *
 * Read-only. Never throws. Defensive empty `data` on any error.
 *
 * @see flowHeatmapContext.ts — reference implementation
 * @see contextHelper.ts — the contract this implements
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import type {
  ContextHelper,
  HelperDescription,
  HelperFetchContext,
  HelperOpts,
  HelperResult,
} from './contextHelper.ts';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type DirectionLean = 'bullish' | 'bearish' | 'neutral' | 'mixed';

export interface SpecialistRead {
  ticker: string;
  read_text: string;
  direction_lean: DirectionLean | null;
  conviction: number | null; // 0-100
  flagged: boolean;
  flag_id: string | null;
  updated_at: string; // ISO 8601
}

export interface SpecialistContextResult {
  per_ticker: SpecialistRead[];
  generated_at: string;
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

const HELPER_NAME = 'specialist';
const HELPER_VERSION = 'v1';
const DEFAULT_CAP = 10; // 1 latest per Mag7+QQQ+SPY+IWM watchlist ticker

interface SpecialistRow {
  ticker: string;
  read_text: string | null;
  direction_lean: DirectionLean | null;
  conviction: number | null;
  flagged: boolean | null;
  flag_id: string | null;
  updated_at: string;
}

function emptyResult(reason: string, latencyMs: number): HelperResult<SpecialistContextResult> {
  return {
    data: {
      per_ticker: [],
      generated_at: new Date().toISOString(),
    },
    meta: {
      helperName: HELPER_NAME,
      helperVersion: HELPER_VERSION,
      fetchedAt: new Date().toISOString(),
      rowCount: 0,
      cacheHit: false,
      latencyMs,
      truncated: false,
      warning: reason,
    },
  };
}

async function fetchSpecialistContext(
  ctx: HelperFetchContext,
  opts: HelperOpts,
): Promise<HelperResult<SpecialistContextResult>> {
  const start = Date.now();
  const cap = Math.max(1, opts.cap ?? DEFAULT_CAP);

  // Resolve target tickers — single focus or full watchlist
  const tickers = opts.tickerFocus
    ? [opts.tickerFocus.toUpperCase()]
    : ctx.watchlist.map((t) => t.toUpperCase());

  if (tickers.length === 0) {
    return emptyResult('empty_watchlist', Date.now() - start);
  }

  try {
    // Pull recent reads for tickers, then dedupe in JS to keep latest per ticker.
    // We over-pull (3x cap) to maximize ticker coverage in the time window.
    const overPull = Math.min(tickers.length * 3, 200);
    const { data, error } = await ctx.supabase
      .from('ct_specialist_reads')
      .select('ticker, read_text, direction_lean, conviction, flagged, flag_id, updated_at')
      .in('ticker', tickers)
      .order('updated_at', { ascending: false })
      .limit(overPull);

    if (error) return emptyResult(`db_error:${error.message}`, Date.now() - start);
    if (!Array.isArray(data) || data.length === 0) {
      return emptyResult('no_rows', Date.now() - start);
    }

    // Keep latest row per ticker (rows are already ordered DESC by updated_at)
    const latestByTicker = new Map<string, SpecialistRead>();
    for (const row of data as SpecialistRow[]) {
      if (latestByTicker.has(row.ticker)) continue;
      if (!row.read_text) continue; // skip null reads defensively
      latestByTicker.set(row.ticker, {
        ticker: row.ticker,
        read_text: row.read_text,
        direction_lean: row.direction_lean,
        conviction: row.conviction,
        flagged: row.flagged ?? false,
        flag_id: row.flag_id,
        updated_at: row.updated_at,
      });
    }

    const all = Array.from(latestByTicker.values()).sort(
      (a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at),
    );
    const truncated = all.length > cap;
    const per_ticker = all.slice(0, cap);

    return {
      data: {
        per_ticker,
        generated_at: new Date().toISOString(),
      },
      meta: {
        helperName: HELPER_NAME,
        helperVersion: HELPER_VERSION,
        fetchedAt: new Date().toISOString(),
        rowCount: per_ticker.length,
        cacheHit: false,
        latencyMs: Date.now() - start,
        truncated,
      },
    };
  } catch (e) {
    return emptyResult(
      `exception:${e instanceof Error ? e.message : String(e)}`,
      Date.now() - start,
    );
  }
}

// ---------------------------------------------------------------------------
// Default export — ContextHelper instance
// ---------------------------------------------------------------------------

const specialistContextHelper: ContextHelper<SpecialistContextResult> = {
  name: HELPER_NAME,
  version: HELPER_VERSION,
  defaultCap: DEFAULT_CAP,
  isExpensive: false,
  minRefreshSeconds: 60, // specialists run on minute cadence
  dependencies: [],
  // audienceFilter intentionally omitted — all audiences see specialist reads

  fetch: fetchSpecialistContext,

  describe(): HelperDescription {
    return {
      name: HELPER_NAME,
      version: HELPER_VERSION,
      defaultCap: DEFAULT_CAP,
      expensive: false,
      minRefreshSeconds: 60,
      dependencies: [],
      outputShape:
        'Per-ticker latest specialist read: read_text (2-3 sentence prose), direction_lean (bullish/bearish/neutral/mixed), conviction (0-100), flagged + flag_id, updated_at. One row per watchlist ticker (latest by updated_at).',
      exampleResult: {
        per_ticker: [
          {
            ticker: 'NVDA',
            read_text:
              'Heavy ask-side accumulation in 0DTE 130-strike calls in the last 30 minutes; tape lifting alongside repeated $50k+ prints.',
            direction_lean: 'bullish',
            conviction: 78,
            flagged: false,
            flag_id: null,
            updated_at: '2026-04-30T19:42:11Z',
          },
        ],
        generated_at: '2026-04-30T19:45:00Z',
      } satisfies SpecialistContextResult,
    };
  },
};

export default specialistContextHelper;

// ---------------------------------------------------------------------------
// Named convenience export — backward-compat thin wrapper
// ---------------------------------------------------------------------------

export interface GetSpecialistContextOpts extends HelperOpts {
  watchlist?: readonly string[];
  audience?: HelperFetchContext['audience'];
  sessionDate?: string;
  consumerName?: string;
}

/**
 * Convenience function. Wraps `specialistContextHelper.fetch()` so callers
 * that don't yet route through the orchestrator can invoke directly.
 */
export async function getSpecialistContext(
  supabase: SupabaseClient,
  opts: GetSpecialistContextOpts = {},
): Promise<SpecialistContextResult> {
  const ctx: HelperFetchContext = {
    supabase,
    audience: opts.audience ?? 'cotrader',
    sessionDate: opts.sessionDate ?? new Date().toISOString().slice(0, 10),
    watchlist: opts.watchlist ?? [],
    consumerName: opts.consumerName ?? 'unknown',
  };
  const result = await specialistContextHelper.fetch(ctx, opts);
  return result.data;
}
