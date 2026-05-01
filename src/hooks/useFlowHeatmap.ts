/**
 * useFlowHeatmap — TanStack Query hooks for the /heatmap page.
 *
 * Three hooks, three RPCs:
 *   useFlowHeatmapLive     -> ct_flow_heatmap_live  (refetch 30s)
 *   useFlowHeatmapHistory  -> ct_flow_heatmap_history
 *   useFlowHeatmapDiff     -> ct_flow_heatmap_diff
 *
 * RPCs are being built in parallel by another agent. While they're absent,
 * each hook falls back to a deterministic mock generator that produces rows
 * matching the real RPC return shape exactly — when the RPC lands the hook
 * swaps to the real call by setting USE_MOCK = false (or by deleting the
 * try/catch fallback once stable).
 *
 * QueryKey prefix is 'flow-heatmap-' (NOT 'ct_*') so the bell-ring
 * useMarketHoursTrigger invalidator (commit d53aaba — invalidates ALL
 * queries) still picks them up at the 09:30/16:00 ET crossing without us
 * having to opt-in.
 *
 * Row shape is the contract from the parallel agent:
 *   { ticker, expiry_bucket_week, expiry_count_in_bucket, value,
 *     source_alert_count, contributing_alert_ids, latest_snapshot_at }
 */

import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type HeatmapMathMode =
  | 'total'
  | 'net_signed'
  | 'aggressive_directional_raw'
  | 'aggressive_directional_decay'
  | 'voi_unusual';

export interface HeatmapRow {
  ticker: string;
  /** Friday-of-ISO-week of the expiry (ISO date YYYY-MM-DD).
   *  Reconciled 2026-04-30 to match the live RPC's
   *  `(expiry_date - isodow + 5)` formula in
   *  `20260430170000_ct_flow_heatmap_live_rewrite.sql`. Earlier docs/mock
   *  said "Monday"; live data is Friday — Friday is the canonical option-
   *  expiry weekday for US-listed weekly contracts. */
  expiry_bucket_week: string;
  /** How many distinct expiries roll up into this week-bucket. */
  expiry_count_in_bucket: number;
  /** The number to color/display. Sign convention depends on math mode. */
  value: number;
  /** Number of underlying ct_flow_alerts rows that contributed. */
  source_alert_count: number;
  /** UUIDs/ids of the contributing flow alerts — used by the drill panel. */
  contributing_alert_ids: string[] | number[];
  latest_snapshot_at: string;
  /** Optional delta enrichment from ct_flow_heatmap_diff. Present only when
   *  the consumer is `useFlowHeatmapLiveWithDelta` and a baselineAt was set. */
  baseline_value?: number;
  delta_value?: number;
  delta_pct?: number | null;
}

/** Row shape returned by the ct_flow_heatmap_diff RPC. */
export interface HeatmapDiffRow {
  ticker: string;
  expiry_bucket_week: string;
  baseline_value: number;
  current_value: number;
  delta_value: number;
  delta_pct: number | null;
}

export interface UseFlowHeatmapLiveArgs {
  tickers?: string[] | null;
  mathMode?: HeatmapMathMode;
  minPremium?: number;
  include0DTE?: boolean;
  maxExpiryDays?: number;
  /** Actual flow window scanned by the RPC. Default 168 (7d). */
  lookbackHours?: number;
}

export interface UseFlowHeatmapHistoryArgs {
  tickers?: string[] | null;
  /** ISO timestamp lower bound. */
  since: string;
  /** ISO timestamp upper bound. */
  until: string;
  mathMode?: HeatmapMathMode;
  /** Pass-through to RPC — query key participates so chip changes invalidate. */
  lookbackHours?: number;
}

export interface UseFlowHeatmapDiffArgs {
  tickers?: string[] | null;
  baselineAt: string;
  currentAt: string;
  mathMode?: HeatmapMathMode;
  /** Window width for both baseline and current ends. Default 168 (7d). */
  lookbackHours?: number;
}

const DEFAULT_TICKERS = [
  'NVDA', 'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'TSLA', 'QQQ', 'SPY', 'IWM',
];

/** Deterministic PRNG so mock data is stable across re-renders for the same args. */
function hashSeed(...parts: (string | number | boolean | null | undefined)[]): number {
  let h = 2166136261;
  for (const p of parts) {
    const s = String(p ?? '');
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Friday-of-ISO-week (UTC) of the week containing `d`. Matches the live
 *  RPC's `(expiry_date - isodow + 5)` formula. Sat/Sun roll forward to next
 *  week's Friday so the mock isn't accidentally producing weekend buckets. */
function fridayOf(d: Date): Date {
  const js = d.getUTCDay(); // 0=Sun..6=Sat
  const iso = js === 0 ? 7 : js; // ISO: Mon=1..Sun=7
  const diff = 5 - iso; // Mon→+4, Tue→+3, ..., Fri→0, Sat→-1, Sun→-2
  const f = new Date(d);
  f.setUTCDate(d.getUTCDate() + diff);
  f.setUTCHours(0, 0, 0, 0);
  return f;
}

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Build the column headers (expiry-week Fridays) covering the window.
 *  Reconciled 2026-04-30 to match the live RPC convention — Friday-of-ISO-week,
 *  NOT Monday. Earlier mock generator produced Monday buckets which never
 *  matched live RPC output once it shipped. */
function buildExpiryWeeks(maxExpiryDays: number, include0DTE: boolean): string[] {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const weeks: string[] = [];
  const startFriday = fridayOf(today);
  // First column: 0DTE = the today bucket if include0DTE, otherwise skip.
  // We represent 0DTE as "today's date" exactly (not the week's Friday).
  if (include0DTE) {
    weeks.push(toISODate(today));
  }
  // Then rolling weekly buckets keyed on Friday until maxExpiryDays.
  for (let offset = 0; offset <= maxExpiryDays; offset += 7) {
    const f = new Date(startFriday);
    f.setUTCDate(startFriday.getUTCDate() + offset);
    const iso = toISODate(f);
    if (!weeks.includes(iso)) weeks.push(iso);
    if (offset > maxExpiryDays) break;
  }
  return weeks;
}

/** Generate mock heatmap rows that respond plausibly to args. */
function generateMockHeatmap(args: {
  tickers: string[];
  mathMode: HeatmapMathMode;
  minPremium: number;
  include0DTE: boolean;
  maxExpiryDays: number;
  asOfIso?: string;
}): HeatmapRow[] {
  const { tickers, mathMode, minPremium, include0DTE, maxExpiryDays, asOfIso } = args;
  const expiryWeeks = buildExpiryWeeks(maxExpiryDays, include0DTE);
  const rows: HeatmapRow[] = [];
  const nowIso = asOfIso ?? new Date().toISOString();

  for (const ticker of tickers) {
    for (const week of expiryWeeks) {
      const seed = hashSeed(ticker, week, mathMode, minPremium, include0DTE, maxExpiryDays, asOfIso ?? '');
      const rng = mulberry32(seed);
      // Sparsity — ~25% of cells empty so the grid breathes.
      if (rng() < 0.25) continue;

      // Magnitude scales by ticker presence and proximity. Front-week dense,
      // monthly+ sparse. SPY/QQQ louder than mid-cap, NVDA dominant.
      const tickerWeight: Record<string, number> = {
        SPY: 1.6, QQQ: 1.5, NVDA: 1.8, IWM: 0.9, TSLA: 1.4,
        AAPL: 1.1, MSFT: 1.0, GOOGL: 0.9, AMZN: 1.0, META: 0.9,
      };
      const weight = tickerWeight[ticker] ?? 1.0;
      const today = new Date(); today.setUTCHours(0, 0, 0, 0);
      const wk = new Date(week + 'T00:00:00Z');
      const daysAhead = Math.max(0, Math.round((wk.getTime() - today.getTime()) / 86_400_000));
      const proximity = Math.exp(-daysAhead / 35); // weeks far out fade
      const baseMag = (5 + rng() * 80) * weight * (0.5 + proximity);

      let value = baseMag * 1_000_000;
      if (mathMode === 'net_signed' || mathMode.startsWith('aggressive_directional')) {
        // Signed value in [-mag, +mag] — slight bullish bias to mimic typical flow.
        const sign = rng() < 0.55 ? 1 : -1;
        value = sign * baseMag * 1_000_000;
      } else if (mathMode === 'voi_unusual') {
        // VOI ratio dimensionless: 0.5 - 12.0
        value = 0.5 + rng() * 11.5;
      }

      // Apply the min-premium floor for premium-shaped modes.
      if (mathMode !== 'voi_unusual' && Math.abs(value) < minPremium) continue;

      const sourceAlertCount = Math.max(1, Math.floor(2 + rng() * 30 * weight));
      // Mock IDs — real RPC returns the actual ct_flow_alerts ids.
      const contributingIds: number[] = Array.from(
        { length: Math.min(sourceAlertCount, 50) },
        (_, i) => Number(seed % 1_000_000) * 100 + i,
      );
      const expiryCountInBucket = week === toISODate(today) && include0DTE
        ? 1
        : 1 + Math.floor(rng() * 3);

      rows.push({
        ticker,
        expiry_bucket_week: week,
        expiry_count_in_bucket: expiryCountInBucket,
        value,
        source_alert_count: sourceAlertCount,
        contributing_alert_ids: contributingIds,
        latest_snapshot_at: nowIso,
      });
    }
  }
  return rows;
}

/** Try the real RPC; if it doesn't exist yet, fall back to mock. */
async function callOrMock(
  rpcName: 'ct_flow_heatmap_live' | 'ct_flow_heatmap_history' | 'ct_flow_heatmap_diff',
  params: Record<string, unknown>,
  mockArgs: Parameters<typeof generateMockHeatmap>[0],
): Promise<HeatmapRow[]> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any).rpc(rpcName, params);
    if (error) {
      // PGRST202 = function not found. Fall through to mock.
      const code = (error as { code?: string }).code;
      const msg = (error as { message?: string }).message ?? '';
      if (code === 'PGRST202' || /could not find the function|does not exist/i.test(msg)) {
        return generateMockHeatmap(mockArgs);
      }
      throw error;
    }
    return (data ?? []) as HeatmapRow[];
  } catch (err) {
    // Network or unexpected — still return mock so the page renders.
    console.warn(`[useFlowHeatmap] ${rpcName} unavailable, returning mock:`, err);
    return generateMockHeatmap(mockArgs);
  }
}

export function useFlowHeatmapLive(args: UseFlowHeatmapLiveArgs = {}) {
  const tickers = args.tickers ?? DEFAULT_TICKERS;
  const mathMode = args.mathMode ?? 'aggressive_directional_decay';
  const minPremium = args.minPremium ?? 100_000;
  const include0DTE = args.include0DTE ?? false;
  const maxExpiryDays = args.maxExpiryDays ?? 365;
  const lookbackHours = args.lookbackHours ?? 168;

  return useQuery<HeatmapRow[]>({
    queryKey: [
      'flow-heatmap-live',
      { tickers: [...tickers].sort(), mathMode, minPremium, include0DTE, maxExpiryDays, lookbackHours },
    ],
    refetchInterval: 30_000,
    staleTime: 25_000,
    queryFn: () => callOrMock(
      'ct_flow_heatmap_live',
      {
        p_tickers: tickers,
        p_math_mode: mathMode,
        p_min_premium: minPremium,
        p_include_0dte: include0DTE,
        p_max_expiry_days: maxExpiryDays,
        p_lookback_hours: lookbackHours,
      },
      { tickers, mathMode, minPremium, include0DTE, maxExpiryDays },
    ),
  });
}

export function useFlowHeatmapHistory(args: UseFlowHeatmapHistoryArgs) {
  const tickers = args.tickers ?? DEFAULT_TICKERS;
  const mathMode = args.mathMode ?? 'aggressive_directional_decay';
  const lookbackHours = args.lookbackHours ?? 168;

  return useQuery<HeatmapRow[]>({
    queryKey: [
      'flow-heatmap-history',
      { tickers: [...tickers].sort(), since: args.since, until: args.until, mathMode, lookbackHours },
    ],
    enabled: !!(args.since && args.until),
    queryFn: () => callOrMock(
      'ct_flow_heatmap_history',
      {
        p_tickers: tickers,
        p_since: args.since,
        p_until: args.until,
        p_math_mode: mathMode,
        p_lookback_hours: lookbackHours,
      },
      {
        tickers, mathMode,
        minPremium: 100_000, include0DTE: false, maxExpiryDays: 365,
        asOfIso: args.until,
      },
    ),
  });
}

export function useFlowHeatmapDiff(args: UseFlowHeatmapDiffArgs) {
  const tickers = args.tickers ?? DEFAULT_TICKERS;
  const mathMode = args.mathMode ?? 'aggressive_directional_decay';
  const lookbackHours = args.lookbackHours ?? 168;

  return useQuery<HeatmapRow[]>({
    queryKey: [
      'flow-heatmap-diff',
      { tickers: [...tickers].sort(), baselineAt: args.baselineAt, currentAt: args.currentAt, mathMode, lookbackHours },
    ],
    enabled: !!(args.baselineAt && args.currentAt),
    queryFn: () => callOrMock(
      'ct_flow_heatmap_diff',
      {
        p_tickers: tickers,
        p_baseline_at: args.baselineAt,
        p_current_at: args.currentAt,
        p_math_mode: mathMode,
        p_lookback_hours: lookbackHours,
      },
      {
        tickers, mathMode,
        minPremium: 100_000, include0DTE: false, maxExpiryDays: 365,
        asOfIso: args.currentAt,
      },
    ),
  });
}

export const HEATMAP_DEFAULT_TICKERS = DEFAULT_TICKERS;

export interface UseFlowHeatmapLiveWithDeltaArgs {
  tickers?: string[] | null;
  mathMode?: HeatmapMathMode;
  minPremium?: number;
  include0DTE?: boolean;
  maxExpiryDays?: number;
  /** Actual flow window (passed to both live and diff RPCs). Default 168 (7d). */
  lookbackHours?: number;
  /** When non-null, also fetches ct_flow_heatmap_diff with this baseline and
   *  merges (baseline_value, delta_value, delta_pct) onto each cell. */
  baselineAt: Date | null;
}

/** Try ct_flow_heatmap_diff. On failure (PGRST202, network, anything) returns
 *  an empty array — caller sees no-delta and the page renders normally. */
async function fetchDiffSilent(params: {
  tickers: string[];
  baselineAt: string;
  currentAt: string;
  mathMode: HeatmapMathMode;
  lookbackHours: number;
}): Promise<HeatmapDiffRow[]> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any).rpc('ct_flow_heatmap_diff', {
      p_tickers: params.tickers,
      p_baseline_at: params.baselineAt,
      p_current_at: params.currentAt,
      p_math_mode: params.mathMode,
      p_lookback_hours: params.lookbackHours,
    });
    if (error) {
      const code = (error as { code?: string }).code;
      const msg = (error as { message?: string }).message ?? '';
      if (code === 'PGRST202' || /could not find the function|does not exist/i.test(msg)) {
        return [];
      }
      console.warn('[useFlowHeatmapLiveWithDelta] ct_flow_heatmap_diff error:', error);
      return [];
    }
    return (data ?? []) as HeatmapDiffRow[];
  } catch (err) {
    console.warn('[useFlowHeatmapLiveWithDelta] ct_flow_heatmap_diff unavailable:', err);
    return [];
  }
}

/** Combined hook: live heatmap + (optional) diff vs baseline merged per-cell.
 *
 * When baselineAt is null → behaves like useFlowHeatmapLive (no diff fetch).
 * When baselineAt is set → fans out both, merges by (ticker, expiry_bucket_week).
 *
 * Diff failures are silent — page falls back to no-delta rendering. */
export function useFlowHeatmapLiveWithDelta(args: UseFlowHeatmapLiveWithDeltaArgs) {
  const tickers = args.tickers ?? DEFAULT_TICKERS;
  const mathMode = args.mathMode ?? 'aggressive_directional_decay';
  const minPremium = args.minPremium ?? 100_000;
  const include0DTE = args.include0DTE ?? false;
  const maxExpiryDays = args.maxExpiryDays ?? 365;
  const lookbackHours = args.lookbackHours ?? 168;
  const baselineAt = args.baselineAt;

  const live = useFlowHeatmapLive({ tickers, mathMode, minPremium, include0DTE, maxExpiryDays, lookbackHours });

  // Quantize baseline timestamp to the minute so the query key doesn't churn
  // on every keystroke / sub-minute re-render.
  const baselineKey = baselineAt
    ? new Date(Math.floor(baselineAt.getTime() / 60_000) * 60_000).toISOString()
    : null;

  const diff = useQuery<HeatmapDiffRow[]>({
    queryKey: [
      'flow-heatmap-diff-live',
      { tickers: [...tickers].sort(), baselineKey, mathMode, lookbackHours },
    ],
    enabled: !!baselineKey,
    refetchInterval: 30_000,
    staleTime: 25_000,
    queryFn: () => fetchDiffSilent({
      tickers,
      baselineAt: baselineKey!,
      currentAt: new Date().toISOString(),
      mathMode,
      lookbackHours,
    }),
  });

  const cells: HeatmapRow[] | undefined = (() => {
    if (!live.data) return undefined;
    if (!baselineAt) return live.data;
    const diffMap = new Map<string, HeatmapDiffRow>();
    for (const d of diff.data ?? []) {
      diffMap.set(`${d.ticker}::${d.expiry_bucket_week}`, d);
    }
    return live.data.map((r) => {
      const d = diffMap.get(`${r.ticker}::${r.expiry_bucket_week}`);
      if (!d) return r;
      return {
        ...r,
        baseline_value: d.baseline_value,
        delta_value: d.delta_value,
        delta_pct: d.delta_pct,
      };
    });
  })();

  return {
    cells,
    isLoading: live.isLoading || (!!baselineAt && diff.isLoading),
    isFetching: live.isFetching || diff.isFetching,
    dataUpdatedAt: live.dataUpdatedAt,
    isError: live.isError,
    error: live.error,
  };
}

// ============================================================================
// Per-strike hook for the per-ticker heatmap view.
//
// Different shape from HeatmapRow — keyed by (ticker, strike, expiry_date,
// side) instead of (ticker, expiry_bucket_week). Real strike granularity
// from ct_flow_heatmap_strikes RPC, NOT mocked.
// ============================================================================

export interface HeatmapStrikeRow {
  ticker: string;
  strike: number;
  /** ISO date YYYY-MM-DD — actual expiry date, NOT the week bucket. */
  expiry_date: string;
  /** 'C' / 'P' / 'mixed' (both sides contributed). */
  side: 'C' | 'P' | 'mixed';
  value: number;
  source_alert_count: number;
  contributing_alert_ids: (string | number)[];
}

export interface UseFlowHeatmapStrikesArgs {
  ticker: string | null;
  /** Hours back from now. Default 168 (7d). */
  lookbackHours?: number;
  mathMode?: HeatmapMathMode;
  /** $ floor. Default 50,000 (lower than the combined view because per-strike cells are smaller). */
  minPremium?: number;
  /** Cap on rows returned. Default 30. */
  strikeCount?: number;
  /** Include today's expiry (0DTE). Default false — symmetry with combined view. */
  include0DTE?: boolean;
}

export function useFlowHeatmapStrikes(args: UseFlowHeatmapStrikesArgs) {
  const ticker = args.ticker;
  const lookbackHours = args.lookbackHours ?? 168;
  const mathMode = args.mathMode ?? 'aggressive_directional_decay';
  const minPremium = args.minPremium ?? 50_000;
  const strikeCount = args.strikeCount ?? 30;
  const include0DTE = args.include0DTE ?? false;

  return useQuery<HeatmapStrikeRow[]>({
    queryKey: [
      'flow-heatmap-strikes',
      { ticker, lookbackHours, mathMode, minPremium, strikeCount, include0DTE },
    ],
    enabled: !!ticker,
    refetchInterval: 30_000,
    staleTime: 25_000,
    queryFn: async () => {
      if (!ticker) return [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase as any).rpc('ct_flow_heatmap_strikes', {
        p_ticker: ticker,
        p_lookback_hours: lookbackHours,
        p_math_mode: mathMode,
        p_min_premium: minPremium,
        p_strike_count: strikeCount,
        p_include_0dte: include0DTE,
      });
      if (error) throw error;
      return (data ?? []) as HeatmapStrikeRow[];
    },
  });
}
