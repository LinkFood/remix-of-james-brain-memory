/**
 * useSpecialistReads — surface the per-ticker specialist's running commentary.
 *
 * Every specialist wakeup writes a `current_read` (2-3 sentences + direction_lean
 * + conviction) to `ct_specialist_reads`. This hook pulls the most recent reads
 * for a ticker so TickerSheet can show live specialist thinking between flags.
 *
 * Polls every 30s. retry:false so the UI degrades gracefully if the table
 * is not yet deployed (backend lands in parallel).
 */

import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface SpecialistRead {
  id: number;
  ticker: string;
  updated_at: string;
  direction_lean: 'bullish' | 'bearish' | 'neutral' | 'mixed';
  conviction: number;
  read_text: string;
  flagged: boolean;
  flag_id: string | null;
}

export function useSpecialistReads(ticker?: string, limit = 3) {
  const query = useQuery({
    queryKey: ['specialist-reads', ticker, limit],
    queryFn: async (): Promise<SpecialistRead[]> => {
      if (!ticker) return [];
      const { data, error } = await supabase
        .from('ct_specialist_reads' as never)
        .select('*')
        .eq('ticker', ticker)
        .order('updated_at', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return (data ?? []) as unknown as SpecialistRead[];
    },
    enabled: !!ticker,
    staleTime: 30_000,
    refetchInterval: 30_000,
    retry: false,
  });

  const reads = query.data ?? [];
  return {
    reads,
    latest: reads[0] ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}
