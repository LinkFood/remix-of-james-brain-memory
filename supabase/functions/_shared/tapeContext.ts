/**
 * tapeContext — the tape-narrative organ.
 *
 * Source: `ct_tape_commentary` (one paragraph per row, written by ct-tape-reader
 * every 10min RTH + on conviction-flag interrupts). The tape reader is the
 * system's running narration of the live tape; this helper surfaces that
 * narrative back into other consumers' context (eod-summary, eod-report,
 * specialists, chat).
 *
 * Returns the latest commentary plus a few prior rows for continuity — the
 * tape-reader has no cross-session memory of its own (per the
 * project_co_trader_tape_reader_continuity note), so consumers downstream
 * stitch continuity by reading the prior bullets themselves.
 *
 * Implements the full `ContextHelper<T>` contract per `contextHelper.ts`:
 * never throws, defensive empty on error, telemetry meta populated.
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
// Output types
// ---------------------------------------------------------------------------

export interface TapeCommentaryEntry {
  id: number;
  created_at: string;
  session_date: string;
  trigger_kind: 'scheduled' | 'flag_interrupt' | 'manual';
  commentary: string;
  vix_level: number | null;
  market_tide: 'bullish' | 'bearish' | 'flat' | null;
  window_start: string | null;
  window_end: string | null;
  flag_ids: string[];
}

export interface TapeContextResult {
  /** Most recent commentary, or null if the table is empty. */
  latest: TapeCommentaryEntry | null;
  /** Older rows preceding `latest`, newest-first. Empty array if none. */
  prior: TapeCommentaryEntry[];
  generated_at: string;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const HELPER_NAME = 'tape';
const HELPER_VERSION = 'v1';
const DEFAULT_LATEST = 1;
const DEFAULT_PRIOR = 3;
/** Hard ceiling on `prior` rows so a runaway opts.cap can't drag huge payloads. */
const MAX_PRIOR = 20;

interface TapeRow {
  id: number;
  created_at: string;
  session_date: string;
  trigger_kind: string;
  commentary: string;
  vix_level: number | null;
  market_tide: string | null;
  window_start: string | null;
  window_end: string | null;
  flag_ids: string[] | null;
}

function toEntry(row: TapeRow): TapeCommentaryEntry {
  return {
    id: row.id,
    created_at: row.created_at,
    session_date: row.session_date,
    trigger_kind:
      row.trigger_kind === 'scheduled' ||
      row.trigger_kind === 'flag_interrupt' ||
      row.trigger_kind === 'manual'
        ? row.trigger_kind
        : 'scheduled',
    commentary: row.commentary,
    vix_level: row.vix_level == null ? null : Number(row.vix_level),
    market_tide:
      row.market_tide === 'bullish' ||
      row.market_tide === 'bearish' ||
      row.market_tide === 'flat'
        ? row.market_tide
        : null,
    window_start: row.window_start,
    window_end: row.window_end,
    flag_ids: Array.isArray(row.flag_ids) ? row.flag_ids : [],
  };
}

function buildOrganMetadata(asOf: string, status: OrganStatus): OrganMetadata {
  return {
    as_of: asOf,
    source: '_shared/tapeContext.ts / ct_tape_commentary',
    window: 'latest + N prior commentary rows, ordered by created_at DESC',
    status,
  };
}

function emptyResult(
  startedAt: number,
  warning?: string,
  status: OrganStatus = 'no_signal_detected',
): HelperResult<TapeContextResult> {
  const asOf = new Date().toISOString();
  return {
    data: {
      latest: null,
      prior: [],
      generated_at: asOf,
    },
    meta: {
      helperName: HELPER_NAME,
      helperVersion: HELPER_VERSION,
      fetchedAt: asOf,
      rowCount: 0,
      cacheHit: false,
      latencyMs: Date.now() - startedAt,
      truncated: false,
      ...(warning ? { warning } : {}),
    },
    organMetadata: buildOrganMetadata(asOf, status),
  };
}

// ---------------------------------------------------------------------------
// Convenience function — caller-friendly wrapper around helper.fetch
// ---------------------------------------------------------------------------

/**
 * Convenience wrapper. Most callers want this rather than the full helper
 * instance. Mirrors the `getFlowHeatmapContext` ergonomics.
 *
 * `opts.cap` controls the count of *prior* rows (latest is always 1 when
 * present). Defaults to 3 prior + 1 latest.
 */
export async function getTapeContext(
  supabase: SupabaseClient,
  opts: HelperOpts = {},
): Promise<HelperResult<TapeContextResult>> {
  const startedAt = Date.now();
  const requestedPrior = typeof opts.cap === 'number' ? opts.cap : DEFAULT_PRIOR;
  const priorCap = Math.max(0, Math.min(MAX_PRIOR, requestedPrior));
  const totalNeeded = DEFAULT_LATEST + priorCap;

  try {
    const { data, error } = await supabase
      .from('ct_tape_commentary')
      .select(
        'id, created_at, session_date, trigger_kind, commentary, vix_level, market_tide, window_start, window_end, flag_ids',
      )
      .order('created_at', { ascending: false })
      .limit(totalNeeded);

    if (error) return emptyResult(startedAt, `query_error:${error.message}`, 'error');
    if (!Array.isArray(data) || data.length === 0) {
      return emptyResult(startedAt, 'no_rows');
    }

    const rows = (data as TapeRow[]).map(toEntry);
    const latest = rows[0] ?? null;
    const prior = rows.slice(1);
    const truncated = requestedPrior > MAX_PRIOR;
    const asOf = new Date().toISOString();

    return {
      data: {
        latest,
        prior,
        generated_at: asOf,
      },
      meta: {
        helperName: HELPER_NAME,
        helperVersion: HELPER_VERSION,
        fetchedAt: asOf,
        rowCount: rows.length,
        cacheHit: false,
        latencyMs: Date.now() - startedAt,
        truncated,
        ...(truncated ? { warning: 'cap_clamped_to_max_prior' } : {}),
      },
      organMetadata: buildOrganMetadata(asOf, latest ? 'populated' : 'no_signal_detected'),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown_error';
    return emptyResult(startedAt, `exception:${msg}`, 'error');
  }
}

// ---------------------------------------------------------------------------
// ContextHelper instance — default export
// ---------------------------------------------------------------------------

const tapeContextHelper: ContextHelper<TapeContextResult> = {
  name: HELPER_NAME,
  version: HELPER_VERSION,
  defaultCap: DEFAULT_PRIOR,
  isExpensive: false,
  // Tape commentary writes every 10min RTH; 5min freshness lets a single fetch
  // cover one cron interval without re-querying.
  minRefreshSeconds: 300,
  dependencies: [],
  // No audienceFilter — every audience can see the running tape narrative.

  async fetch(
    ctx: HelperFetchContext,
    opts: HelperOpts,
  ): Promise<HelperResult<TapeContextResult>> {
    return await getTapeContext(ctx.supabase, opts);
  },

  describe(): HelperDescription {
    return {
      name: HELPER_NAME,
      version: HELPER_VERSION,
      defaultCap: DEFAULT_PRIOR,
      expensive: false,
      minRefreshSeconds: 300,
      dependencies: [],
      outputShape:
        'Latest tape narrative paragraph plus N prior rows for continuity. Each row carries trigger_kind, commentary, vix_level, market_tide, window_start/end, flag_ids.',
      exampleResult: {
        latest: {
          id: 12345,
          created_at: '2026-04-30T18:30:00.000Z',
          session_date: '2026-04-30',
          trigger_kind: 'scheduled',
          commentary:
            'Tape steady through midday. NVDA call-side stack rebuilding into 2pm.',
          vix_level: 14.2,
          market_tide: 'bullish',
          window_start: '2026-04-30T18:20:00.000Z',
          window_end: '2026-04-30T18:30:00.000Z',
          flag_ids: [],
        },
        prior: [],
        generated_at: '2026-04-30T18:30:01.000Z',
      },
    };
  },
};

export default tapeContextHelper;
