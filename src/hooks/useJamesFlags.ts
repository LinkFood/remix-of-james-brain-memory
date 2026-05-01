/**
 * useJamesFlags — frontend mirror of the `jamesFlagsContext` brain organ.
 *
 * Source: `ct_flags WHERE source = 'james_star'` (the unified flag table
 * post-2026-04-27 unification — legacy `ct_james_flags` was migrated and
 * dropped). Returns James's hand-labeled signals filtered by ticker (or
 * full watchlist), default last 24h, top N per ticker.
 *
 * Mirrors `getJamesFlagsContext` shape — field name mapping is preserved:
 *   row.thesis      → output.note
 *   row.direction   → output.direction_view
 *   row.created_at  → output.flagged_at
 *
 * Phase 5 of the Synthesis Layer (see `docs/SYNTHESIS_LAYER_ARCHITECTURE.md`
 * § 5a). queryKey starts with `'james-flags-'` (NOT `ct_*`) so the
 * bell-ring useMarketHoursTrigger invalidator picks it up cleanly at the
 * 09:30/16:00 ET crossing. Refetch every 60s — manual cadence is slow.
 *
 * Defensive on every error path. retry:false.
 */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type DirectionView = 'bullish' | 'bearish' | 'neutral';

export interface JamesFlagRow {
  id: string;
  ticker: string;
  option_symbol: string | null;
  direction_view: DirectionView;
  /** Mapped from ct_flags.thesis. May be null when James starred without note. */
  note: string | null;
  /** Mapped from ct_flags.created_at. ISO 8601. */
  flagged_at: string;
  status: string | null;
  horizon_ts: string | null;
  /** Optional strike pulled from option_symbol (parsed) for cell-marker matching. */
  strike: number | null;
  /** Optional expiry date (YYYY-MM-DD) parsed from option_symbol. */
  expiry: string | null;
}

export interface UseJamesFlagsArgs {
  /** Single ticker focus. Pass null/undefined to fetch the full watchlist. */
  ticker?: string | null;
  /** Watchlist override when `ticker` is null. Defaults to the canonical 10. */
  watchlist?: string[];
  /** Hours back from now. Default 24. */
  lookbackHours?: number;
  /** Max rows per ticker. Default 5. */
  perTicker?: number;
}

const DEFAULT_WATCHLIST = [
  'NVDA', 'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'TSLA', 'QQQ', 'SPY', 'IWM',
];
const DEFAULT_LOOKBACK_HOURS = 24;
const DEFAULT_PER_TICKER = 5;
const MAX_PER_TICKER = 50;

interface RawCtFlagsRow {
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

/** Parse OCC option symbol → { strike, expiry }. Null fields if unparseable. */
function parseOcc(occ: string | null): { strike: number | null; expiry: string | null } {
  if (!occ) return { strike: null, expiry: null };
  const m = occ.match(/^[A-Z]{1,6}(\d{6})[CP](\d{8})$/);
  if (!m) return { strike: null, expiry: null };
  const yy = parseInt(m[1].slice(0, 2), 10);
  const mm = parseInt(m[1].slice(2, 4), 10);
  const dd = parseInt(m[1].slice(4, 6), 10);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return { strike: null, expiry: null };
  const year = 2000 + yy;
  const expiry = `${year}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  // OCC strike is fixed-point: 8 digits, last 3 are the fractional thousandths
  const strikeRaw = parseInt(m[2], 10);
  const strike = Number.isFinite(strikeRaw) ? strikeRaw / 1000 : null;
  return { strike, expiry };
}

function toRow(r: RawCtFlagsRow): JamesFlagRow | null {
  if (!r.instrument) return null;
  const parsed = parseOcc(r.option_symbol);
  return {
    id: r.id,
    ticker: r.instrument,
    option_symbol: r.option_symbol,
    direction_view: normalizeDirection(r.direction),
    note: r.thesis,
    flagged_at: r.created_at,
    status: r.status,
    horizon_ts: r.horizon_ts,
    strike: parsed.strike,
    expiry: parsed.expiry,
  };
}

export function useJamesFlags(args: UseJamesFlagsArgs = {}) {
  const ticker = args.ticker ?? null;
  const watchlist = args.watchlist ?? DEFAULT_WATCHLIST;
  const lookbackHours = Math.max(1, args.lookbackHours ?? DEFAULT_LOOKBACK_HOURS);
  const perTicker = Math.max(1, Math.min(MAX_PER_TICKER, args.perTicker ?? DEFAULT_PER_TICKER));

  const targetTickers = ticker ? [ticker.toUpperCase()] : watchlist.map((t) => t.toUpperCase());

  const query = useQuery<JamesFlagRow[]>({
    queryKey: [
      'james-flags',
      { tickers: [...targetTickers].sort(), lookbackHours, perTicker },
    ],
    refetchInterval: 60_000,
    staleTime: 55_000,
    retry: false,
    queryFn: async () => {
      if (targetTickers.length === 0) return [];
      const sinceIso = new Date(Date.now() - lookbackHours * 3600_000).toISOString();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sb: any = supabase;
      const { data, error } = await sb.from('ct_flags')
        .select('id, instrument, option_symbol, direction, thesis, created_at, status, horizon_ts')
        .eq('source', 'james_star')
        .in('instrument', targetTickers)
        .gte('created_at', sinceIso)
        .order('created_at', { ascending: false })
        // Pull headroom = perTicker × tickers, comfortably under the
        // PostgREST 1000-row response cap for our 10-ticker watchlist.
        .limit(targetTickers.length * perTicker);
      if (error) throw error;
      const rows = Array.isArray(data) ? (data as RawCtFlagsRow[]) : [];
      const mapped = rows.map(toRow).filter((r): r is JamesFlagRow => r !== null);

      // Per-ticker cap (already limited by query, this enforces strictly per ticker
      // even if one ticker dominates the response).
      const counts = new Map<string, number>();
      const out: JamesFlagRow[] = [];
      for (const f of mapped) {
        const k = f.ticker.toUpperCase();
        const n = counts.get(k) ?? 0;
        if (n >= perTicker) continue;
        counts.set(k, n + 1);
        out.push(f);
      }
      return out;
    },
  });

  const flags = query.data ?? [];
  const byTicker = useMemo(() => {
    const m = new Map<string, JamesFlagRow[]>();
    for (const f of flags) {
      const t = f.ticker.toUpperCase();
      if (!m.has(t)) m.set(t, []);
      m.get(t)!.push(f);
    }
    return m;
  }, [flags]);

  return {
    flags,
    byTicker,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}

// ---------------------------------------------------------------------------
// Cell-match helper (for FlowHeatmapGrid gold-dot marker)
// ---------------------------------------------------------------------------

/** ISO weekday: Mon=1..Sun=7. Friday-of-week = d - isodow + 5 (matches SQL). */
function fridayOfWeekIso(dateIso: string): string | null {
  const d = new Date(dateIso + (dateIso.includes('T') ? '' : 'T00:00:00Z'));
  if (Number.isNaN(d.getTime())) return null;
  const js = d.getUTCDay();
  const iso = js === 0 ? 7 : js;
  const diff = 5 - iso;
  const fri = new Date(d);
  fri.setUTCDate(d.getUTCDate() + diff);
  fri.setUTCHours(0, 0, 0, 0);
  return fri.toISOString().slice(0, 10);
}

/** True if the James-flag's parsed expiry rolls up to this cell's bucket-week. */
export function jamesFlagMatchesCell(
  flag: JamesFlagRow,
  ticker: string,
  cellExpiryBucketWeek: string,
): boolean {
  if (flag.ticker.toUpperCase() !== ticker.toUpperCase()) return false;
  if (!flag.expiry) {
    // Ticker-level flag — surface only when no cell expiry to match against
    // is provided. The grid always provides one, so default to no-match here
    // to avoid over-marking every cell with a single ticker-level flag.
    return false;
  }
  const fri = fridayOfWeekIso(flag.expiry);
  return !!fri && fri === cellExpiryBucketWeek;
}
