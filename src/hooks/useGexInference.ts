/**
 * useGexInference — feeds <GexSnapshotCard /> on /alpha (and /heatmap PR-B
 * once that ships). Single source of truth: invokes `ct-gex-inference` edge
 * function which wraps the `gex_inference` brain organ kernel
 * (`_shared/gexInferenceContext.ts`).
 *
 * Tenet 24 honored — the strike-ladder math lives once in the organ, every
 * UI consumer pulls from this hook so /alpha and /heatmap can never drift.
 *
 * Refetch cadence: 60s during RTH, paused outside (mirrors useGexRadar).
 * `ct_gex_timeseries` ingester writes ~every 5 min; 60s frontend cadence
 * picks up new snapshots within one tick comfortably without thrash.
 */

import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

const DEFAULT_WATCHLIST = [
  'NVDA', 'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'TSLA',
  'QQQ', 'SPY', 'IWM',
];

export type DealerNetDirection = 'positive_gamma' | 'negative_gamma' | 'flat';
export type PriceVsFlip = 'above' | 'below' | 'at';
export type ConsensusDirection =
  | 'broad_positive_gamma'
  | 'broad_negative_gamma'
  | 'mixed'
  | 'no_signal';
export type OrganStatus =
  | 'populated'
  | 'data_missing'
  | 'no_signal_detected'
  | 'pending_analysis'
  | 'error';

export interface PinAttractor {
  strike: number;
  magnitude: number;
  signed_net_gex: number;
}

export interface GexInferencePerTicker {
  ticker: string;
  snapshot_at: string;
  underlying_price: number | null;
  gamma_flip_strike: number | null;
  call_wall_strike: number | null;
  put_floor_strike: number | null;
  dealer_net_direction: DealerNetDirection;
  dealer_net_total: number;
  price_vs_flip: PriceVsFlip | null;
  pin_attractor_strikes: PinAttractor[];
  atm_strike_count: number;
}

export interface GexInferenceWatchlistAggregate {
  consensus_direction: ConsensusDirection;
  tickers_above_flip: number;
  tickers_below_flip: number;
  tickers_at_flip: number;
  tickers_no_flip: number;
  median_price_vs_flip_pct: number | null;
}

export interface GexInferenceResponse {
  per_ticker: GexInferencePerTicker[];
  watchlist: GexInferenceWatchlistAggregate;
  generated_at: string;
  organ_status: OrganStatus;
  warning?: string;
}

function isMarketHoursET(date: Date = new Date()): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const get = (k: string) => parts.find((p) => p.type === k)?.value ?? '';
  const weekday = get('weekday');
  if (weekday === 'Sat' || weekday === 'Sun') return false;

  const hour = Number(get('hour'));
  const minute = Number(get('minute'));
  const minutesOfDay = hour * 60 + minute;
  const OPEN = 9 * 60 + 30;
  const CLOSE = 16 * 60;
  return minutesOfDay >= OPEN && minutesOfDay < CLOSE;
}

export function useGexInference(tickers: string[] = DEFAULT_WATCHLIST) {
  const key = ['gex-inference', ...tickers];

  return useQuery<GexInferenceResponse>({
    queryKey: key,
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('ct-gex-inference', {
        body: { tickers },
      });
      if (error) throw error;
      return data as GexInferenceResponse;
    },
    staleTime: 45_000,
    refetchInterval: () => (isMarketHoursET() ? 60_000 : false),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: 1,
  });
}

export const ALPHA_GEX_WATCHLIST = DEFAULT_WATCHLIST;
