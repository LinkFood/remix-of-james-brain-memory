/**
 * useDteEligibility — per-ticker 0DTE expiry availability lookup.
 *
 * Backed by ct_config.ticker_dte_eligibility (jsonb keyed by ticker). See
 * supabase/migrations/20260427000050_dte_eligibility.sql.
 *
 * Used by:
 *   - /tape header — "0DTE today" pill
 *   - /edge SignatureMagnitude — daily/Fri-only badge on 0dte rows
 */

import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { supabase } from '@/integrations/supabase/client';

export interface DteEligibility {
  daily_0dte: boolean;
  weekly_friday_0dte?: boolean;
  label: string;
}

export type DteEligibilityMap = Record<string, DteEligibility>;

export function useDteEligibility() {
  return useQuery<DteEligibilityMap>({
    queryKey: ['ct_config', 'ticker_dte_eligibility'],
    // Config rarely changes — cache aggressively.
    staleTime: 10 * 60_000,
    refetchInterval: false,
    retry: false,
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase as any)
        .from('ct_config')
        .select('value')
        .eq('key', 'ticker_dte_eligibility')
        .maybeSingle();
      if (error) {
        console.warn('[useDteEligibility]', error.message);
        return {};
      }
      return ((data?.value ?? {}) as DteEligibilityMap);
    },
  });
}

/** True if ticker has 0DTE-tradable expiry on the given UTC date. */
export function ticker0DteEligibleOn(
  ticker: string,
  eligibility: DteEligibilityMap,
  date: Date,
): boolean {
  const cfg = eligibility[ticker];
  if (!cfg) return false;
  if (cfg.daily_0dte) return true;
  if (cfg.weekly_friday_0dte && date.getUTCDay() === 5) return true;
  return false;
}

/** Memoized list of tickers with 0DTE eligibility *today*. */
export function useTodaysEligibleTickers(): { tickers: string[]; map: DteEligibilityMap } {
  const { data } = useDteEligibility();
  return useMemo(() => {
    const map = data ?? {};
    const now = new Date();
    const tickers = Object.keys(map).filter((t) => ticker0DteEligibleOn(t, map, now));
    return { tickers, map };
  }, [data]);
}
