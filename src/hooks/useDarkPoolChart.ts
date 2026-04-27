/**
 * useDarkPoolChart — today's ct_dark_pool_prints grouped by ticker for the
 * DarkPoolChart 3x4 grid. Additive to useDarkPoolPrints (which powers the tape).
 *
 * Direct Supabase read — no edge function. Pulls all prints since session open
 * for the effective session date (today if live, otherwise the latest completed
 * session — see useEffectiveSessionDate). Bucketed by ticker in a single
 * round-trip via an `in` filter.
 *
 * 30s refresh (matches the rest of the command-station charts).
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useEffectiveSessionDate } from './useEffectiveSessionDate';

export const DARK_POOL_CHART_TICKERS = [
  'SPY', 'QQQ', 'IWM',
  'AAPL', 'MSFT', 'GOOGL',
  'AMZN', 'META', 'NVDA',
  'TSLA',
] as const;

export type DarkPoolChartTicker = (typeof DARK_POOL_CHART_TICKERS)[number];

export interface DarkPoolPrintLite {
  id: string;
  ticker: string;
  size: number;
  price: number;
  notional_value: number;
  executed_at: string | null;
}

export interface DarkPoolChartGroup {
  ticker: DarkPoolChartTicker;
  prints: DarkPoolPrintLite[];
}

export interface DarkPoolChartData {
  groups: DarkPoolChartGroup[];
  sessionStartISO: string;
  sessionDateET: string;
  isLive: boolean;
}

export function useDarkPoolChart() {
  const { data: session } = useEffectiveSessionDate();
  const startISO = session?.sessionStartISO ?? null;
  const endISO = session?.sessionEndISO ?? null;

  return useQuery<DarkPoolChartData>({
    queryKey: ['ct_dark_pool_chart', startISO, endISO],
    enabled: !!startISO && !!endISO,
    refetchInterval: 30_000,
    queryFn: async () => {
      // PostgREST hard-caps every response at 1000 rows regardless of
      // .limit() — confirmed empirically 2026-04-27 (even Range:0-9999
      // returned 999 of 50k+). Per-ticker fan-out via Promise.all stays
      // under cap and matches the fix pattern from useMacroSparklines.
      // On a normal trading day, ct_dark_pool_prints sees thousands of
      // rows during RTH; the previous .in() + .limit(10_000) silently
      // dropped everything past row 999.
      const results = await Promise.all(
        DARK_POOL_CHART_TICKERS.map(async (t) => {
          const { data, error } = await supabase
            .from('ct_dark_pool_prints')
            .select('id, ticker, size, price, notional_value, executed_at')
            .eq('ticker', t)
            .gte('executed_at', startISO!)
            .lt('executed_at', endISO!)
            .order('executed_at', { ascending: true });
          if (error) throw error;
          return (data ?? []) as DarkPoolPrintLite[];
        }),
      );

      const byTicker = new Map<string, DarkPoolPrintLite[]>();
      for (const t of DARK_POOL_CHART_TICKERS) byTicker.set(t, []);
      for (const arr of results) {
        for (const r of arr) {
          const bucket = byTicker.get(r.ticker);
          if (bucket) bucket.push(r);
        }
      }

      const groups: DarkPoolChartGroup[] = DARK_POOL_CHART_TICKERS.map(ticker => ({
        ticker,
        prints: byTicker.get(ticker) ?? [],
      }));

      return {
        groups,
        sessionStartISO: startISO!,
        sessionDateET: session!.sessionDateET,
        isLive: session!.isLive,
      };
    },
  });
}
