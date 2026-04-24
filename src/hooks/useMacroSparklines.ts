/**
 * useMacroSparklines — one batch query feeding 10 MacroTile sparklines.
 *
 * Pulls the last 6h of `ct_price_bars` for the watchlist, groups by ticker,
 * downsamples each series to <=60 points. Returns a Map so the banner can
 * look up each ticker's series in O(1) and pass it down to its tile.
 *
 * Why 6h and not "today only": covers pre-market and the first few minutes
 * of the cash session when today's bar count is still thin. Gives a
 * continuous-looking intraday arc even at 09:32 ET.
 */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

const TICKERS = ['SPY','QQQ','IWM','AAPL','MSFT','GOOGL','AMZN','META','NVDA','TSLA'] as const;
const LOOKBACK_HOURS = 6;
const MAX_POINTS = 60;

interface PriceBarRow {
  ticker: string;
  ts: string;
  close: number | string;
}

export interface MacroSparklinePoint {
  t: number; // ms epoch — recharts wants numeric domain
  c: number;
}

export interface MacroSparklineSeries {
  ticker: string;
  points: MacroSparklinePoint[];
  firstClose: number | null;
  lastClose: number | null;
  direction: 'up' | 'down' | 'flat';
}

interface MacroSparklinesResult {
  seriesMap: Map<string, MacroSparklineSeries>;
  isLoading: boolean;
  isError: boolean;
}

function toNum(n: number | string | null | undefined): number | null {
  if (n == null) return null;
  const v = typeof n === 'number' ? n : parseFloat(n);
  return Number.isFinite(v) ? v : null;
}

/**
 * Even-interval bucket downsampling: if we have >MAX_POINTS bars, step
 * through the array with stride = ceil(N / MAX_POINTS) and force-include
 * the last bar so the latest tick always lands on the sparkline.
 */
function downsample(points: MacroSparklinePoint[]): MacroSparklinePoint[] {
  if (points.length <= MAX_POINTS) return points;
  const stride = Math.ceil(points.length / MAX_POINTS);
  const out: MacroSparklinePoint[] = [];
  for (let i = 0; i < points.length; i += stride) out.push(points[i]);
  const last = points[points.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

function buildSeries(ticker: string, rows: PriceBarRow[]): MacroSparklineSeries {
  const sorted = rows
    .map((r) => ({ t: Date.parse(r.ts), c: toNum(r.close) }))
    .filter((p): p is MacroSparklinePoint => Number.isFinite(p.t) && p.c != null)
    .sort((a, b) => a.t - b.t);

  const down = downsample(sorted);
  const firstClose = down.length ? down[0].c : null;
  const lastClose = down.length ? down[down.length - 1].c : null;

  let direction: MacroSparklineSeries['direction'] = 'flat';
  if (firstClose != null && lastClose != null) {
    if (lastClose > firstClose) direction = 'up';
    else if (lastClose < firstClose) direction = 'down';
  }

  return { ticker, points: down, firstClose, lastClose, direction };
}

export function useMacroSparklines(): MacroSparklinesResult {
  const sinceIso = useMemo(
    () => new Date(Date.now() - LOOKBACK_HOURS * 3600_000).toISOString(),
    // Bucket by hour so the cache key is stable across rerenders within the minute.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [Math.floor(Date.now() / 3600_000)],
  );

  const { data, isLoading, isError } = useQuery<PriceBarRow[]>({
    queryKey: ['macro-sparklines', sinceIso.slice(0, 13)],
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: false,
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.from('ct_price_bars' as never) as any)
        .select('ticker,ts,close')
        .in('ticker', Array.from(TICKERS))
        .gte('ts', sinceIso)
        .order('ticker', { ascending: true })
        .order('ts', { ascending: true });
      if (error) throw error;
      return (data ?? []) as PriceBarRow[];
    },
  });

  const seriesMap = useMemo(() => {
    const byTicker = new Map<string, PriceBarRow[]>();
    for (const t of TICKERS) byTicker.set(t, []);
    for (const r of data ?? []) {
      const arr = byTicker.get(r.ticker);
      if (arr) arr.push(r);
    }
    const out = new Map<string, MacroSparklineSeries>();
    for (const [t, rows] of byTicker.entries()) {
      out.set(t, buildSeries(t, rows));
    }
    return out;
  }, [data]);

  return { seriesMap, isLoading, isError };
}
