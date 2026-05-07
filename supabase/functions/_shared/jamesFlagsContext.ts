/**
 * jamesFlagsContext — James's hand-labeled signals organ.
 *
 * Source: `public.ct_flags WHERE source = 'james_star'` — the unified flag
 * table after migration `20260427000010_unify_flags.sql` consolidated the
 * legacy `ct_james_flags` table into the `ct_flags` row keyed by `source`.
 * The legacy table was dropped in a follow-up; this helper reads only from
 * the unified source.
 *
 * Audience-gated to `['cotrader', 'analyst']` ONLY. Per architecture D3, the
 * `paper_claude` research-layer audience is firewalled from James's manual
 * stars to preserve the post-2026-04-25 isolation contract on the generational
 * paper-trading experiment. cotrader is the operational amplifier that gets
 * to see them; analyst is terminal-Claude analysis with full breadth.
 *
 * Field mapping inside the helper preserves the spec's typed output shape so
 * downstream consumers don't have to know about the unified schema:
 *   row.thesis      → output.note
 *   row.direction   → output.direction_view
 *   row.created_at  → output.flagged_at
 *
 * Implements the full `ContextHelper<T>` contract per `contextHelper.ts`:
 * never throws, defensive empty on error, telemetry meta populated.
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import type {
  AudienceMode,
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

export type DirectionView = 'bullish' | 'bearish' | 'neutral';

/**
 * One James-flag row in the helper's output shape. Field names match the
 * audit spec (note / direction_view / flagged_at) — internal mapping in
 * `toEntry()` translates from `ct_flags` columns.
 */
export interface JamesFlagEntry {
  id: string;
  ticker: string;
  option_symbol: string | null;
  direction_view: DirectionView;
  /** Mapped from `ct_flags.thesis`. May be null when James starred without a note. */
  note: string | null;
  /** Mapped from `ct_flags.created_at`. ISO 8601 UTC. */
  flagged_at: string;
  status: string | null;
  horizon_ts: string | null;
}

export interface JamesFlagsResult {
  /** All flags for the requested ticker(s), newest first, capped per ticker. */
  per_ticker: Array<{ ticker: string; flags: JamesFlagEntry[] }>;
  generated_at: string;
  lookback_hours: number;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const HELPER_NAME = 'james_flags';
const HELPER_VERSION = 'v1';
const DEFAULT_CAP = 5;
const DEFAULT_LOOKBACK_HOURS = 24;
const MAX_CAP = 50;
const AUDIENCE_FILTER: readonly AudienceMode[] = ['cotrader', 'analyst'];

interface CtFlagsRow {
  id: string;
  instrument: string | null;
  option_symbol: string | null;
  direction: string | null;
  thesis: string | null;
  created_at: string;
  status: string | null;
  horizon_ts: string | null;
}

function normalizeDirection(raw: string | null): DirectionView {
  if (raw === 'bullish' || raw === 'bearish' || raw === 'neutral') return raw;
  return 'neutral';
}

function toEntry(row: CtFlagsRow): JamesFlagEntry {
  return {
    id: row.id,
    ticker: row.instrument ?? '',
    option_symbol: row.option_symbol,
    direction_view: normalizeDirection(row.direction),
    note: row.thesis,
    flagged_at: row.created_at,
    status: row.status,
    horizon_ts: row.horizon_ts,
  };
}

function buildOrganMetadata(
  asOf: string,
  lookbackHours: number,
  status: OrganStatus,
): OrganMetadata {
  return {
    as_of: asOf,
    source: "_shared/jamesFlagsContext.ts / ct_flags WHERE source='james_star'",
    window: `trailing ${lookbackHours}h, per-ticker capped`,
    status,
  };
}

function emptyResult(
  startedAt: number,
  lookbackHours: number,
  warning?: string,
  status: OrganStatus = 'no_signal_detected',
): HelperResult<JamesFlagsResult> {
  const nowIso = new Date().toISOString();
  return {
    data: {
      per_ticker: [],
      generated_at: nowIso,
      lookback_hours: lookbackHours,
    },
    meta: {
      helperName: HELPER_NAME,
      helperVersion: HELPER_VERSION,
      fetchedAt: nowIso,
      rowCount: 0,
      cacheHit: false,
      latencyMs: Date.now() - startedAt,
      truncated: false,
      ...(warning ? { warning } : {}),
    },
    organMetadata: buildOrganMetadata(nowIso, lookbackHours, status),
  };
}

// ---------------------------------------------------------------------------
// Convenience function — caller-friendly wrapper around helper.fetch
// ---------------------------------------------------------------------------

/**
 * Convenience wrapper. Most callers want this rather than the full helper
 * instance. Mirrors the `getTapeContext` ergonomics.
 *
 * `opts.tickerFocus` collapses to a single instrument; otherwise the helper
 * uses `ctxWatchlist` (passed via the second arg from helper.fetch). When
 * called directly without context, pass `tickers` via the third arg.
 *
 * Defensive on every error path — never throws.
 */
export async function getJamesFlagsContext(
  supabase: SupabaseClient,
  opts: HelperOpts = {},
  tickers: readonly string[] = [],
): Promise<HelperResult<JamesFlagsResult>> {
  const startedAt = Date.now();
  const requestedCap = typeof opts.cap === 'number' ? opts.cap : DEFAULT_CAP;
  const cap = Math.max(1, Math.min(MAX_CAP, requestedCap));
  const lookbackHours =
    typeof opts.lookbackHours === 'number'
      ? Math.max(1, opts.lookbackHours)
      : DEFAULT_LOOKBACK_HOURS;

  const focus = typeof opts.tickerFocus === 'string' ? opts.tickerFocus : null;
  const targetTickers = focus
    ? [focus]
    : Array.from(tickers).filter((t): t is string => typeof t === 'string' && t.length > 0);

  if (targetTickers.length === 0) {
    return emptyResult(startedAt, lookbackHours, 'no_target_tickers');
  }

  const sinceIso = new Date(Date.now() - lookbackHours * 3600 * 1000).toISOString();

  try {
    const { data, error } = await supabase
      .from('ct_flags')
      .select('id, instrument, option_symbol, direction, thesis, created_at, status, horizon_ts')
      .eq('source', 'james_star')
      .in('instrument', targetTickers)
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: false })
      // Pull enough headroom to cap-per-ticker after grouping. Watchlist size
      // is bounded (≤10 in practice), cap ≤ MAX_CAP, so 10 * 50 = 500 ceiling
      // is comfortably under PostgREST's 1000-row response cap.
      .limit(targetTickers.length * cap);

    if (error) return emptyResult(startedAt, lookbackHours, `query_error:${error.message}`, 'error');
    if (!Array.isArray(data) || data.length === 0) {
      return emptyResult(startedAt, lookbackHours, 'no_rows');
    }

    const byTicker = new Map<string, JamesFlagEntry[]>();
    for (const row of data as CtFlagsRow[]) {
      const ticker = row.instrument;
      if (!ticker) continue;
      if (!byTicker.has(ticker)) byTicker.set(ticker, []);
      byTicker.get(ticker)!.push(toEntry(row));
    }

    let truncated = false;
    let total = 0;
    const per_ticker = Array.from(byTicker.entries()).map(([ticker, flags]) => {
      if (flags.length > cap) truncated = true;
      const capped = flags.slice(0, cap);
      total += capped.length;
      return { ticker, flags: capped };
    });

    const nowIso = new Date().toISOString();
    return {
      data: {
        per_ticker,
        generated_at: nowIso,
        lookback_hours: lookbackHours,
      },
      meta: {
        helperName: HELPER_NAME,
        helperVersion: HELPER_VERSION,
        fetchedAt: nowIso,
        rowCount: total,
        cacheHit: false,
        latencyMs: Date.now() - startedAt,
        truncated,
      },
      organMetadata: buildOrganMetadata(nowIso, lookbackHours, total > 0 ? 'populated' : 'no_signal_detected'),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown_error';
    return emptyResult(startedAt, lookbackHours, `exception:${msg}`, 'error');
  }
}

// ---------------------------------------------------------------------------
// ContextHelper instance — default export
// ---------------------------------------------------------------------------

const jamesFlagsHelper: ContextHelper<JamesFlagsResult> = {
  name: HELPER_NAME,
  version: HELPER_VERSION,
  defaultCap: DEFAULT_CAP,
  isExpensive: false,
  // James stars are written manually from /tape — slow cadence relative to
  // any cron consumer. 5min freshness is generous; orchestrator cache layer
  // can re-key as needed.
  minRefreshSeconds: 300,
  dependencies: [],
  // D3 firewall: cotrader (operational amplifier) + analyst (terminal-Claude)
  // ONLY. paper_claude is excluded — preserves the post-2026-04-25 isolation
  // contract on the generational paper-trading experiment.
  audienceFilter: AUDIENCE_FILTER,

  async fetch(
    ctx: HelperFetchContext,
    opts: HelperOpts,
  ): Promise<HelperResult<JamesFlagsResult>> {
    return await getJamesFlagsContext(ctx.supabase, opts, ctx.watchlist ?? []);
  },

  describe(): HelperDescription {
    return {
      name: HELPER_NAME,
      version: HELPER_VERSION,
      defaultCap: DEFAULT_CAP,
      expensive: false,
      minRefreshSeconds: 300,
      dependencies: [],
      audienceFilter: AUDIENCE_FILTER,
      outputShape:
        'Per-ticker recent James hand-labeled flags, newest first, default 5 ' +
        'per ticker over a 24h lookback. Each entry carries direction_view ' +
        '(bullish/bearish/neutral), note (thesis), flagged_at (created_at), ' +
        'option_symbol, status, and horizon_ts. Audience-gated to cotrader + analyst.',
      exampleResult: {
        per_ticker: [
          {
            ticker: 'TSLA',
            flags: [
              {
                id: '823ebc77-99dc-472b-b348-b5db7e6b50b5',
                ticker: 'TSLA',
                option_symbol: 'TSLA260501P00360000',
                direction_view: 'bearish',
                note: null,
                flagged_at: '2026-04-24T14:50:53.647099+00:00',
                status: 'active',
                horizon_ts: '2026-04-25T14:50:53.647099+00:00',
              },
            ],
          },
        ],
        generated_at: '2026-04-30T18:00:00.000Z',
        lookback_hours: 24,
      } satisfies JamesFlagsResult,
    };
  },
};

export default jamesFlagsHelper;
