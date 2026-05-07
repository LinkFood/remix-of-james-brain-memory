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
  OrganMetadata,
  OrganStatus,
} from './contextHelper.ts';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type DirectionLean = 'bullish' | 'bearish' | 'neutral' | 'mixed';

export interface SpecialistRead {
  ticker: string;
  /** Null when ticker_status='pending_analysis' (specialist hasn't fired in window). */
  read_text: string | null;
  direction_lean: DirectionLean | null;
  conviction: number | null; // 0-100
  flagged: boolean;
  flag_id: string | null;
  /** Null when ticker_status='pending_analysis'. */
  updated_at: string | null;
  /**
   * Per-ticker semantic state (Bundle Phase 2 organ #9 ship 2026-05-07).
   * Reachable today: 'populated' (row exists in window with read_text) or
   * 'pending_analysis' (no row in window — specialist hasn't fired enough).
   * 'no_signal_detected' and 'error' kept in OrganStatus enum but unreachable
   * under current producer (specialistRunner ALWAYS writes read_text — even
   * parse-fail paths emit a sentinel string). See instance #34
   * (producer-instrumentation-gates-consumer-precision) at
   * docs/audit/2026-05-07-organ-9-specialist-phase-a.md.
   */
  ticker_status: OrganStatus;
}

export interface SpecialistContextResult {
  /**
   * One entry per watchlist ticker (or per opts.tickerFocus). Bundle Phase 2
   * 2026-05-07 changed shape from "tickers with rows only" to "all watchlist
   * tickers, some with null content fields and ticker_status='pending_analysis'".
   * Downstream consumers reading per_ticker should not assume populated-only —
   * filter by ticker_status if they need only signal-bearing entries.
   */
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

function buildOrganMetadata(asOf: string, status: OrganStatus): OrganMetadata {
  return {
    as_of: asOf,
    source: '_shared/specialistContext.ts / ct_specialist_reads (latest per ticker)',
    window: 'latest read per watchlist ticker; per-ticker enumeration includes pending tickers with null content',
    status,
  };
}

function emptyResult(
  reason: string,
  latencyMs: number,
  status: OrganStatus = 'no_signal_detected',
): HelperResult<SpecialistContextResult> {
  const asOf = new Date().toISOString();
  return {
    data: {
      per_ticker: [],
      generated_at: asOf,
    },
    meta: {
      helperName: HELPER_NAME,
      helperVersion: HELPER_VERSION,
      fetchedAt: asOf,
      rowCount: 0,
      cacheHit: false,
      latencyMs,
      truncated: false,
      warning: reason,
    },
    organMetadata: buildOrganMetadata(asOf, status),
  };
}

function pendingEntry(ticker: string): SpecialistRead {
  return {
    ticker,
    read_text: null,
    direction_lean: null,
    conviction: null,
    flagged: false,
    flag_id: null,
    updated_at: null,
    ticker_status: 'pending_analysis',
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
    return emptyResult('empty_watchlist', Date.now() - start, 'error');
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

    if (error) return emptyResult(`db_error:${error.message}`, Date.now() - start, 'error');

    // Keep latest row per ticker (rows are already ordered DESC by updated_at).
    // Bundle Phase 2 ship 2026-05-07: enumerate ALL requested tickers — emit
    // pending_analysis entries with null content for tickers without rows in
    // window. This makes per-ticker coverage explicit and lets consumers filter
    // by ticker_status instead of inferring from missing-from-array.
    const latestByTicker = new Map<string, SpecialistRead>();
    for (const row of (data ?? []) as SpecialistRow[]) {
      if (latestByTicker.has(row.ticker)) continue;
      if (!row.read_text) continue; // dead defensive — producer always writes read_text
      latestByTicker.set(row.ticker, {
        ticker: row.ticker,
        read_text: row.read_text,
        direction_lean: row.direction_lean,
        conviction: row.conviction,
        flagged: row.flagged ?? false,
        flag_id: row.flag_id,
        updated_at: row.updated_at,
        ticker_status: 'populated',
      });
    }

    // Build full enumeration: populated rows where they exist, pending_analysis
    // entries for tickers without rows in window.
    const fullEnumeration: SpecialistRead[] = tickers.map((t) => {
      const populated = latestByTicker.get(t);
      return populated ?? pendingEntry(t);
    });

    // Sort: populated rows first (newest-first by updated_at), then pending.
    const populated = fullEnumeration.filter((e) => e.ticker_status === 'populated');
    const pending = fullEnumeration.filter((e) => e.ticker_status !== 'populated');
    populated.sort((a, b) => Date.parse(b.updated_at!) - Date.parse(a.updated_at!));
    const ordered = [...populated, ...pending];

    // Cap applies to the populated subset (caller asked for top-N signal-
    // bearing); pending entries are appended for full enumeration.
    const cappedPopulated = populated.slice(0, cap);
    const truncated = populated.length > cap;
    const per_ticker = [...cappedPopulated, ...pending];

    const asOf = new Date().toISOString();
    const status: OrganStatus = populated.length > 0 ? 'populated' : 'pending_analysis';

    return {
      data: {
        per_ticker,
        generated_at: asOf,
      },
      meta: {
        helperName: HELPER_NAME,
        helperVersion: HELPER_VERSION,
        fetchedAt: asOf,
        rowCount: populated.length,
        cacheHit: false,
        latencyMs: Date.now() - start,
        truncated,
      },
      organMetadata: buildOrganMetadata(asOf, status),
    };
  } catch (e) {
    return emptyResult(
      `exception:${e instanceof Error ? e.message : String(e)}`,
      Date.now() - start,
      'error',
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
        'Per-ticker latest specialist read: read_text (2-3 sentence prose), direction_lean, conviction (0-100), flagged + flag_id, updated_at, ticker_status (OrganStatus enum). Bundle Phase 2 (2026-05-07) shape: ALL watchlist tickers enumerated — populated entries first (newest-first by updated_at), pending_analysis entries (null content) for tickers without rows in window. Consumers should filter by ticker_status if signal-bearing only.',
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
            ticker_status: 'populated',
          },
          {
            ticker: 'IWM',
            read_text: null,
            direction_lean: null,
            conviction: null,
            flagged: false,
            flag_id: null,
            updated_at: null,
            ticker_status: 'pending_analysis',
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
