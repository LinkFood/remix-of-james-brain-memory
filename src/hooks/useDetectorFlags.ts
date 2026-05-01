/**
 * useDetectorFlags — frontend mirror of the `detectorContext` brain organ.
 *
 * Source: `ct_flags` joined with `ct_detectors` (PostgREST embed). Returns
 * recent detector flags filtered by ticker (or full watchlist), default last
 * 24h, top N by recency. Mirrors the shape of `getDetectorContext` so any
 * Phase 5 enrichment built against this hook stays semantically identical
 * to the brain organ Claude consumers see.
 *
 * Phase 5 of the Synthesis Layer (see `docs/SYNTHESIS_LAYER_ARCHITECTURE.md`
 * § 5a). One TanStack Query, 30s refetch, queryKey starts with
 * `'detector-flags-'` (NOT `ct_*`) so the bell-ring useMarketHoursTrigger
 * invalidator picks it up cleanly at the 09:30/16:00 ET crossing.
 *
 * Filtering by `expiryBucketWeek` is supported client-side via the helper
 * `filterFlagsByExpiryBucket()` so cell-level enrichment in
 * FlowHeatmapGrid can scope flags to (ticker × expiry-week) without a
 * second RPC roundtrip — the score_breakdown JSON typically carries the
 * triggering option_symbol or expiry, which we inspect to match.
 *
 * Defensive on every error path. retry:false so a missing column / table
 * doesn't hammer 4xx (per CLAUDE.md gotcha).
 */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type FlagDirection = 'bullish' | 'bearish' | 'neutral';

export interface DetectorFlagRow {
  flag_id: string;
  detector_id: string | null;
  detector_name: string | null;
  detector_status: string | null;
  source: string | null;
  ticker: string;
  option_symbol: string | null;
  direction: FlagDirection;
  score: number;
  tags: string[];
  thesis: string | null;
  pulse_regime_at_fire: string | null;
  pulse_net_premium_at_fire: number | null;
  pulse_slope_5min_at_fire: number | null;
  score_breakdown: Record<string, unknown> | null;
  created_at: string;
}

export interface UseDetectorFlagsArgs {
  /** Single ticker focus. Pass null/undefined to fetch the full watchlist. */
  ticker?: string | null;
  /** Watchlist override when `ticker` is null. Defaults to the canonical 10. */
  watchlist?: string[];
  /** Hours back from now. Default 24. */
  lookbackHours?: number;
  /** Max rows returned. Default 50. */
  limit?: number;
  /** Filter to flags whose source matches one of these (e.g. ['detector_alarm']).
   *  Pass null/undefined to skip the filter. */
  sources?: string[] | null;
}

const DEFAULT_WATCHLIST = [
  'NVDA', 'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'TSLA', 'QQQ', 'SPY', 'IWM',
];
const DEFAULT_LOOKBACK_HOURS = 24;
const DEFAULT_LIMIT = 50;

interface RawFlagRow {
  id: string;
  detector_id: string | null;
  source: string | null;
  instrument: string | null;
  option_symbol: string | null;
  direction: string | null;
  score: number | null;
  tags: string[] | null;
  thesis: string | null;
  pulse_regime_at_fire: string | null;
  pulse_net_premium_at_fire: number | null;
  pulse_slope_5min_at_fire: number | null;
  score_breakdown: Record<string, unknown> | null;
  created_at: string;
  ct_detectors:
    | { id: string; name: string | null; status: string | null }
    | { id: string; name: string | null; status: string | null }[]
    | null;
}

function normalizeDirection(raw: string | null): FlagDirection {
  if (raw === 'bullish' || raw === 'bearish' || raw === 'neutral') return raw;
  return 'neutral';
}

function normalizeDetector(raw: RawFlagRow['ct_detectors']): { id: string; name: string | null; status: string | null } | null {
  if (!raw) return null;
  if (Array.isArray(raw)) return raw[0] ?? null;
  return raw;
}

function toRow(row: RawFlagRow): DetectorFlagRow | null {
  if (!row.instrument) return null;
  const detector = normalizeDetector(row.ct_detectors);
  return {
    flag_id: row.id,
    detector_id: row.detector_id,
    detector_name: detector?.name ?? null,
    detector_status: detector?.status ?? null,
    source: row.source,
    ticker: row.instrument,
    option_symbol: row.option_symbol,
    direction: normalizeDirection(row.direction),
    score: row.score == null ? 0 : Number(row.score),
    tags: Array.isArray(row.tags) ? row.tags : [],
    thesis: row.thesis,
    pulse_regime_at_fire: row.pulse_regime_at_fire,
    pulse_net_premium_at_fire: row.pulse_net_premium_at_fire == null ? null : Number(row.pulse_net_premium_at_fire),
    pulse_slope_5min_at_fire: row.pulse_slope_5min_at_fire == null ? null : Number(row.pulse_slope_5min_at_fire),
    score_breakdown: row.score_breakdown,
    created_at: row.created_at,
  };
}

export function useDetectorFlags(args: UseDetectorFlagsArgs = {}) {
  const ticker = args.ticker ?? null;
  const watchlist = args.watchlist ?? DEFAULT_WATCHLIST;
  const lookbackHours = Math.max(1, args.lookbackHours ?? DEFAULT_LOOKBACK_HOURS);
  const limit = Math.max(1, args.limit ?? DEFAULT_LIMIT);
  const sources = args.sources ?? null;

  const targetTickers = ticker ? [ticker.toUpperCase()] : watchlist.map((t) => t.toUpperCase());

  const query = useQuery<DetectorFlagRow[]>({
    queryKey: [
      'detector-flags',
      { tickers: [...targetTickers].sort(), lookbackHours, limit, sources: sources ? [...sources].sort() : null },
    ],
    refetchInterval: 30_000,
    staleTime: 25_000,
    retry: false,
    queryFn: async () => {
      if (targetTickers.length === 0) return [];
      const sinceIso = new Date(Date.now() - lookbackHours * 3600_000).toISOString();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sb: any = supabase;
      let q = sb.from('ct_flags')
        .select(
          `id,
           detector_id,
           source,
           instrument,
           option_symbol,
           direction,
           score,
           tags,
           thesis,
           pulse_regime_at_fire,
           pulse_net_premium_at_fire,
           pulse_slope_5min_at_fire,
           score_breakdown,
           created_at,
           ct_detectors:detector_id ( id, name, status )`,
        )
        .in('instrument', targetTickers)
        .gte('created_at', sinceIso)
        .order('created_at', { ascending: false })
        .limit(limit);
      if (sources && sources.length > 0) q = q.in('source', sources);

      const { data, error } = await q;
      if (error) throw error;
      const rows = Array.isArray(data) ? (data as RawFlagRow[]) : [];
      return rows.map(toRow).filter((r): r is DetectorFlagRow => r !== null);
    },
  });

  return {
    flags: query.data ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
  };
}

// ---------------------------------------------------------------------------
// Helpers — used by FlowHeatmapGrid for cell-level enrichment
// ---------------------------------------------------------------------------

/**
 * Best-effort match of a flag to a (ticker × expiry_bucket_week) cell.
 *
 * Strategy:
 *   1. Always require ticker match (case-insensitive).
 *   2. If the flag carries `option_symbol`, parse the embedded expiry
 *      (OCC format: TICKER + YYMMDD + C/P + STRIKE), compute the
 *      Friday-of-week, and compare to `cellExpiryBucketWeek`.
 *   3. If parsing fails (no option_symbol or unparseable), inspect
 *      `score_breakdown` for a top-level `expiry` / `expiry_bucket_week`
 *      field and match if present.
 *   4. Otherwise the flag is ticker-level — match if cellExpiryBucketWeek
 *      is undefined OR `matchTickerOnly` is true.
 *
 * `cellExpiryBucketWeek` is the ISO YYYY-MM-DD Friday-of-week string used
 * by the live RPC. The helper computes Friday-of-week from any expiry date
 * to reconcile the two.
 */
export interface FlagCellMatchOpts {
  ticker: string;
  cellExpiryBucketWeek?: string;
  matchTickerOnly?: boolean;
}

/** ISO weekday: Mon=1..Sun=7. Friday-of-week = d - isodow + 5 (matches SQL). */
function fridayOfWeekIso(dateIso: string): string | null {
  const d = new Date(dateIso + (dateIso.includes('T') ? '' : 'T00:00:00Z'));
  if (Number.isNaN(d.getTime())) return null;
  // JS getUTCDay: 0=Sun..6=Sat. ISO day: Mon=1..Sun=7.
  const js = d.getUTCDay();
  const iso = js === 0 ? 7 : js;
  const diff = 5 - iso; // Mon→+4, Tue→+3, ... Fri→0, Sat→-1, Sun→-2
  const fri = new Date(d);
  fri.setUTCDate(d.getUTCDate() + diff);
  fri.setUTCHours(0, 0, 0, 0);
  return fri.toISOString().slice(0, 10);
}

/** Parse OCC option symbol → expiry ISO date (YYMMDD inside). */
function parseExpiryFromOcc(occ: string): string | null {
  // OCC format: ROOT + YYMMDD + C|P + STRIKE(8 digits). Root is 1-6 chars.
  const m = occ.match(/^[A-Z]{1,6}(\d{6})[CP]\d{8}$/);
  if (!m) return null;
  const yy = parseInt(m[1].slice(0, 2), 10);
  const mm = parseInt(m[1].slice(2, 4), 10);
  const dd = parseInt(m[1].slice(4, 6), 10);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  // 2-digit year window — assume 2000-2099 for our market data
  const year = 2000 + yy;
  return `${year}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

export function flagMatchesCell(flag: DetectorFlagRow, opts: FlagCellMatchOpts): boolean {
  if (!flag.ticker || flag.ticker.toUpperCase() !== opts.ticker.toUpperCase()) return false;
  if (opts.matchTickerOnly) return true;
  if (!opts.cellExpiryBucketWeek) return true;

  // 1. Try option_symbol parse
  if (flag.option_symbol) {
    const exp = parseExpiryFromOcc(flag.option_symbol);
    if (exp) {
      const fri = fridayOfWeekIso(exp);
      if (fri && fri === opts.cellExpiryBucketWeek) return true;
      // explicit miss — option-symbol-bearing flags don't fall through
      return false;
    }
  }

  // 2. Try score_breakdown.expiry / .expiry_bucket_week
  const sb = flag.score_breakdown;
  if (sb && typeof sb === 'object') {
    const ebw = (sb as Record<string, unknown>).expiry_bucket_week;
    if (typeof ebw === 'string' && ebw === opts.cellExpiryBucketWeek) return true;
    const exp = (sb as Record<string, unknown>).expiry;
    if (typeof exp === 'string') {
      const fri = fridayOfWeekIso(exp.slice(0, 10));
      if (fri && fri === opts.cellExpiryBucketWeek) return true;
    }
  }

  // 3. No expiry signal — treat as ticker-level (cell-undecidable).
  // Default to NOT matching at the cell level so we don't over-glow every cell.
  return false;
}

/** Filter helper for cell-level rendering. Returns flags matching this cell. */
export function filterFlagsByExpiryBucket(
  flags: DetectorFlagRow[],
  ticker: string,
  cellExpiryBucketWeek: string,
): DetectorFlagRow[] {
  return flags.filter((f) => flagMatchesCell(f, { ticker, cellExpiryBucketWeek }));
}

/** Convenience hook that pre-groups flags by ticker for row-level rendering. */
export function useDetectorFlagsByTicker(args: UseDetectorFlagsArgs = {}) {
  const { flags, isLoading, isError } = useDetectorFlags(args);
  const byTicker = useMemo(() => {
    const m = new Map<string, DetectorFlagRow[]>();
    for (const f of flags) {
      const t = f.ticker.toUpperCase();
      if (!m.has(t)) m.set(t, []);
      m.get(t)!.push(f);
    }
    return m;
  }, [flags]);
  return { flags, byTicker, isLoading, isError };
}
