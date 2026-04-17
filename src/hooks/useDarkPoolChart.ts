/**
 * useDarkPoolChart — today's ct_dark_pool_prints grouped by ticker for the
 * DarkPoolChart 3x4 grid. Additive to useDarkPoolPrints (which powers the tape).
 *
 * Direct Supabase read — no edge function. Pulls all prints since session open
 * (America/New_York 04:00) for the watchlist, bucketed by ticker in a single
 * round-trip via an `in` filter.
 *
 * 30s refresh (matches the rest of the command-station charts).
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export const DARK_POOL_CHART_TICKERS = [
  'SPY', 'QQQ', 'IWM',
  'NVDA', 'AAPL', 'MSFT',
  'META', 'GOOGL', 'AMZN',
  'TSLA', 'GLD', 'USO',
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
}

/** Start of today's session in America/New_York (04:00 ET — covers pre-market DP). */
function sessionStartISO(): string {
  const now = new Date();
  const nyParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const get = (t: string) => nyParts.find(p => p.type === t)?.value ?? '00';
  // 04:00 ET ~= 08:00 or 09:00 UTC depending on DST. Build as ET wall-clock
  // then let the server compare as a UTC timestamp — we build an ISO string
  // by nudging a fresh Date through the NY offset.
  const y = get('year'), m = get('month'), d = get('day');
  // Construct "YYYY-MM-DDT04:00:00" in ET and convert to UTC.
  // Trick: create a Date from the string as if UTC, measure NY offset, shift.
  const asIfUtc = new Date(`${y}-${m}-${d}T04:00:00Z`);
  const nyNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const localNow = new Date(now.toLocaleString('en-US'));
  const offsetMs = localNow.getTime() - nyNow.getTime();
  return new Date(asIfUtc.getTime() + offsetMs).toISOString();
}

export function useDarkPoolChart() {
  const startISO = useMemo(() => sessionStartISO(), []);

  return useQuery<DarkPoolChartData>({
    queryKey: ['ct_dark_pool_chart', startISO],
    refetchInterval: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('ct_dark_pool_prints')
        .select('id, ticker, size, price, notional_value, executed_at')
        .in('ticker', DARK_POOL_CHART_TICKERS as unknown as string[])
        .gte('executed_at', startISO)
        .order('executed_at', { ascending: true })
        .limit(10_000);
      if (error) throw error;

      const rows = (data ?? []) as DarkPoolPrintLite[];
      const byTicker = new Map<string, DarkPoolPrintLite[]>();
      for (const t of DARK_POOL_CHART_TICKERS) byTicker.set(t, []);
      for (const r of rows) {
        const bucket = byTicker.get(r.ticker);
        if (bucket) bucket.push(r);
      }

      const groups: DarkPoolChartGroup[] = DARK_POOL_CHART_TICKERS.map(ticker => ({
        ticker,
        prints: byTicker.get(ticker) ?? [],
      }));

      return { groups, sessionStartISO: startISO };
    },
  });
}
