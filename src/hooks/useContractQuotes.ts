/**
 * useContractQuotes — time-series of option-contract quotes for the drill chart.
 *
 * Reads ct_contract_quotes (Phase B builds and fills via ct-contract-poller).
 * Pre-Phase-B-deploy this returns [] so the chart renders an empty-state
 * placeholder instead of crashing. Sorted ascending by ts for direct charting.
 */

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface ContractQuoteRow {
  ts: string;          // ISO
  bid: number | null;
  ask: number | null;
  mid: number | null;
  last: number | null;
  spread_pct: number | null;
  source: string;      // 'uw_flow_latest' | 'uw_intraday' | 'uw_historic_eod'
}

export function useContractQuotes(
  optionSymbol: string | null,
  sincePrintTimeISO: string | null,
): UseQueryResult<ContractQuoteRow[]> {
  return useQuery<ContractQuoteRow[]>({
    queryKey: ['ct_contract_quotes', optionSymbol, sincePrintTimeISO],
    enabled: optionSymbol !== null,
    staleTime: 15_000,
    refetchInterval: 30_000,
    retry: false,
    queryFn: async () => {
      if (!optionSymbol) return [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let q: any = (supabase.from as any)('ct_contract_quotes')
        .select('ts, bid, ask, mid, last, spread_pct, source')
        .eq('option_symbol', optionSymbol)
        .order('ts', { ascending: true })
        .limit(2000);
      if (sincePrintTimeISO) q = q.gte('ts', sincePrintTimeISO);
      const { data, error } = await q;
      if (error) {
        console.warn('[useContractQuotes]', error.message);
        return [];
      }
      return (data ?? []) as ContractQuoteRow[];
    },
  });
}
