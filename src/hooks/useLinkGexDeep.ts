/**
 * useLinkGexDeep — React Query hook feeding <LinkGexDeep /> drill-down.
 *
 * Calls ct-linkgex-deep for a single ticker and returns the complete matrix
 * payload: strike rows, king/queen/flip/walls, 5 directional scores, combo
 * verdict, totals, per-dimension verdicts, bias bar percentages.
 *
 * Rate-limit discipline (LOAD-BEARING):
 *  - 90s refetchInterval (NOT 30s like the Radar). We're at 75% of UW daily
 *    quota; the drill-down burns 2 calls per refresh and is per-ticker, not
 *    per-ladder, so it polls slower.
 *  - `enabled` prop gates the query — pass false when the drill-down is not
 *    visible (Sheet closed, route not mounted). No polling when off-screen.
 *  - refetchIntervalInBackground: false — stop polling when the tab blurs.
 *  - Outside RTH, refetchInterval returns false (no overnight polling).
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface LinkGexStrike {
  strike: number;
  isSpot: boolean;
  isKing: boolean;
  isQueen: boolean;
  isCallWall: boolean;
  isPutWall: boolean;
  netGex: number;
  cGex: number;
  pGex: number;
  cOI: number;
  pOI: number;
  cOIC: number;
  pOIC: number;
  dollarOIC: number;
  dollarNetOIC: number;
  gammaOIC: number;
  dteOIC: number;
  dteNetOIC: number;
  cVelPct: number | null;
  pVelPct: number | null;
  zeroDteGex: number;
  activityDots: 0 | 1 | 2 | 3;
}

export interface LinkGexPayload {
  ticker: string;
  spot: number | null;
  regime: 'pos' | 'neg' | null;
  cPct: number;
  pPct: number;
  king: number | null;
  queen: number | null;
  gammaFlip: number | null;
  callWall: number | null;
  putWall: number | null;
  deltaOpen: number;
  strikes: LinkGexStrike[];
  scores: {
    flow: number;
    hedge: number;
    now: number;
    calls: number;
    puts: number;
  };
  totals: {
    dollar: number;
    gamma: number;
    dte: number;
    avgCVel: number;
    avgPVel: number;
  };
  verdicts: {
    combo: string;
    comboLabel: string;
    comboColor: string;
    $flow: string;
    gamma: string;
    dte: string;
    cVel: string;
    pVel: string;
  };
  generated_at: string;
  errors: string[];
}

/**
 * True if now is within US cash equities hours (Mon-Fri 09:30-16:00 ET).
 * Matches useGexRadar's gating — don't hammer UW overnight.
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

interface UseLinkGexDeepOptions {
  ticker: string;
  maxDte?: number;
  strikeWindow?: number;
  /**
   * When false the query is paused. Pass the Sheet-open state or route-mounted
   * flag here — prevents polling while the drill-down is off-screen. Default true.
   */
  enabled?: boolean;
}

export function useLinkGexDeep({
  ticker,
  maxDte = 30,
  strikeWindow = 30,
  enabled = true,
}: UseLinkGexDeepOptions) {
  const key = ['linkgex-deep', ticker, maxDte, strikeWindow];

  return useQuery<LinkGexPayload>({
    queryKey: key,
    enabled: enabled && !!ticker,
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('ct-linkgex-deep', {
        body: { ticker, max_dte: maxDte, strike_window: strikeWindow },
      });
      if (error) throw error;
      return data as LinkGexPayload;
    },
    staleTime: 60_000,
    // 90s during RTH, paused overnight. Minimum 90s per UW rate-limit policy.
    refetchInterval: () => (isMarketHoursET() ? 90_000 : false),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: 1,
  });
}
