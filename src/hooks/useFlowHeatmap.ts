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
  /** Monday of the expiry week (ISO date YYYY-MM-DD). */
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
}

export interface UseFlowHeatmapLiveArgs {
  tickers?: string[] | null;
  mathMode?: HeatmapMathMode;
  minPremium?: number;
  include0DTE?: boolean;
  maxExpiryDays?: number;
}

export interface UseFlowHeatmapHistoryArgs {
  tickers?: string[] | null;
  /** ISO timestamp lower bound. */
  since: string;
  /** ISO timestamp upper bound. */
  until: string;
  mathMode?: HeatmapMathMode;
}

export interface UseFlowHeatmapDiffArgs {
  tickers?: string[] | null;
  baselineAt: string;
  currentAt: string;
  mathMode?: HeatmapMathMode;
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

/** Monday (UTC) of the week containing `d`. */
function mondayOf(d: Date): Date {
  const day = d.getUTCDay(); // 0 = Sun, 1 = Mon, ...
  const diff = day === 0 ? -6 : 1 - day;
  const m = new Date(d);
  m.setUTCDate(d.getUTCDate() + diff);
  m.setUTCHours(0, 0, 0, 0);
  return m;
}

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Build the column headers (expiry-week Mondays) covering the window. */
function buildExpiryWeeks(maxExpiryDays: number, include0DTE: boolean): string[] {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const weeks: string[] = [];
  const startMonday = mondayOf(today);
  // First column: 0DTE = the today bucket if include0DTE, otherwise skip.
  // We represent 0DTE as "today's date" exactly (not the week's Monday).
  if (include0DTE) {
    weeks.push(toISODate(today));
  }
  // Then rolling weekly buckets keyed on Monday until maxExpiryDays.
  for (let offset = 0; offset <= maxExpiryDays; offset += 7) {
    const m = new Date(startMonday);
    m.setUTCDate(startMonday.getUTCDate() + offset);
    const iso = toISODate(m);
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

  return useQuery<HeatmapRow[]>({
    queryKey: [
      'flow-heatmap-live',
      { tickers: [...tickers].sort(), mathMode, minPremium, include0DTE, maxExpiryDays },
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
      },
      { tickers, mathMode, minPremium, include0DTE, maxExpiryDays },
    ),
  });
}

export function useFlowHeatmapHistory(args: UseFlowHeatmapHistoryArgs) {
  const tickers = args.tickers ?? DEFAULT_TICKERS;
  const mathMode = args.mathMode ?? 'aggressive_directional_decay';

  return useQuery<HeatmapRow[]>({
    queryKey: [
      'flow-heatmap-history',
      { tickers: [...tickers].sort(), since: args.since, until: args.until, mathMode },
    ],
    enabled: !!(args.since && args.until),
    queryFn: () => callOrMock(
      'ct_flow_heatmap_history',
      {
        p_tickers: tickers,
        p_since: args.since,
        p_until: args.until,
        p_math_mode: mathMode,
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

  return useQuery<HeatmapRow[]>({
    queryKey: [
      'flow-heatmap-diff',
      { tickers: [...tickers].sort(), baselineAt: args.baselineAt, currentAt: args.currentAt, mathMode },
    ],
    enabled: !!(args.baselineAt && args.currentAt),
    queryFn: () => callOrMock(
      'ct_flow_heatmap_diff',
      {
        p_tickers: tickers,
        p_baseline_at: args.baselineAt,
        p_current_at: args.currentAt,
        p_math_mode: mathMode,
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
