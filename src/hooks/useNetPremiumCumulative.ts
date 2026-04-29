/**
 * useNetPremiumCumulative — cumulative-from-the-bell call/put premium per ticker.
 *
 * Calls the ct-net-prem-cumulative edge function, which pulls per-ticker
 * `net-prem-ticks` from UW and returns running sums from the opening bell.
 *
 * Refresh policy:
 *   - 30s during NY market hours (09:30-16:00 ET, Mon-Fri)
 *   - paused off-hours (static data, no point burning UW rate limit)
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { isMarketHoursET } from '@/lib/marketHours';

export interface NetPremCumPoint {
  t: string;                       // minute ISO (UW tape_time, UTC)
  cum_call_prem: number;
  cum_put_prem: number;
  cum_net_delta: number;
  cum_call_ask_minus_bid: number;
  cum_put_ask_minus_bid: number;
}

export interface NetPremCumTicker {
  ticker: string;
  start_time: string | null;
  end_time: string | null;
  points: NetPremCumPoint[];
  error?: string;
  fallback?: boolean;
  fallback_session_date?: string | null;
}

export interface NetPremCumResponse {
  tickers: NetPremCumTicker[];
  /** True when any ticker is served from ct_net_premium_ticks (market closed). */
  fallback?: boolean;
  fallback_session_date?: string | null;
  /** Present when UW empty AND no DB snapshot available. */
  reason?: string;
}

const DEFAULT_TICKERS = [
  'SPY', 'QQQ', 'IWM',
  'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'TSLA',
];

export function useNetPremiumCumulative(tickers: string[] = DEFAULT_TICKERS) {
  const key = tickers.join(',');
  return useQuery<NetPremCumResponse>({
    queryKey: ['ct_net_prem_cumulative', key],
    // React Query reads the interval function on each tick — flips live as soon
    // as the bell rings without a reload.
    refetchInterval: () => (isMarketHoursET() ? 30_000 : false),
    refetchOnWindowFocus: true,
    staleTime: 20_000,
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('ct-net-prem-cumulative', {
        body: { tickers },
      });
      if (error) throw error;
      return (data ?? { tickers: [] }) as NetPremCumResponse;
    },
  });
}
