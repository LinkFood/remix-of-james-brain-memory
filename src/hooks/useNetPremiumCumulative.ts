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
  'NVDA', 'AAPL', 'MSFT', 'META', 'GOOGL', 'AMZN', 'TSLA',
  'GLD', 'USO',
];

/**
 * True if the NY clock is inside the regular session right now.
 * Uses `en-US` Intl formatter with America/New_York tz so DST is handled
 * without a dateutil dep.
 */
function isMarketHoursET(now: Date = new Date()): boolean {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  const parts = fmt.formatToParts(now);
  const weekday = parts.find(p => p.type === 'weekday')?.value ?? '';
  const hour = Number(parts.find(p => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find(p => p.type === 'minute')?.value ?? '0');
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  const mins = hour * 60 + minute;
  // 09:30 = 570, 16:00 = 960
  return mins >= 570 && mins < 960;
}

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
