/**
 * useGexRadar — React Query hook feeding <GexRadar /> in the command station.
 *
 * Calls the `ct-gex-radar` edge function with a ticker list; returns the
 * per-ticker strike tables (king, queen, flip, walls, velocity-tagged rows,
 * Δ OPEN, regime). 30-second refetch during US market hours, paused after
 * close so we don't burn UW quota overnight.
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface GexRadarStrike {
  strike: number;
  netGex: number;
  cGex: number;
  pGex: number;
  cOI: number;
  pOI: number;
  cOIC: number;
  pOIC: number;
  velocity_pct: number | null;
  dominant_side: 'C' | 'P' | null;
  show_velocity: boolean;
}

export type GexComboVerdict =
  | 'URGENT'
  | 'A+ BULLISH'
  | 'A+ BEARISH'
  | 'SQUEEZE SETUP'
  | 'BATTLEGROUND'
  | 'LEAN BULLISH'
  | 'LEAN BEARISH'
  | 'NEUTRAL';

export interface GexRadarVerdicts {
  combo: GexComboVerdict;
  comboLabel: string;
  comboColor: string;
  $flow: number;
  hedge: number;
  now: number;
  cVel: number;
  pVel: number;
}

export interface GexRadarScores {
  flow: number;
  hedge: number;
  now: number;
  calls: number;
  puts: number;
}

export interface GexRadarTicker {
  ticker: string;
  spot: number | null;
  strikes: GexRadarStrike[];
  king: number | null;
  queen: number | null;
  gammaFlip: number | null;
  callWall: number | null;
  putWall: number | null;
  deltaOpen: number;
  regime: 'pos' | 'neg' | null;
  verdicts: GexRadarVerdicts | null;
  scores: GexRadarScores | null;
  errors: string[];
}

export interface GexRadarResponse {
  tickers: GexRadarTicker[];
  generated_at: string;
}

const DEFAULT_TICKERS = ['SPY', 'QQQ', 'IWM'];

/**
 * Returns true if the current time is within US cash equities hours
 * (Mon-Fri, 09:30-16:00 America/New_York). Drives refetch cadence so
 * we don't hammer UW overnight.
 */
function isMarketHoursET(date: Date = new Date()): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const get = (k: string) => parts.find(p => p.type === k)?.value ?? '';
  const weekday = get('weekday');
  if (weekday === 'Sat' || weekday === 'Sun') return false;

  const hour = Number(get('hour'));
  const minute = Number(get('minute'));
  const minutesOfDay = hour * 60 + minute;
  const OPEN = 9 * 60 + 30;
  const CLOSE = 16 * 60;
  return minutesOfDay >= OPEN && minutesOfDay < CLOSE;
}

export function useGexRadar(tickers: string[] = DEFAULT_TICKERS, windowSize = 30) {
  const key = ['gex-radar', ...tickers, windowSize];

  return useQuery<GexRadarResponse>({
    queryKey: key,
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('ct-gex-radar', {
        body: { tickers, window: windowSize },
      });
      if (error) throw error;
      return data as GexRadarResponse;
    },
    staleTime: 20_000,
    // Dynamic: 30s during RTH, paused (false) outside. React Query accepts a fn.
    refetchInterval: () => (isMarketHoursET() ? 30_000 : false),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: 1,
  });
}
