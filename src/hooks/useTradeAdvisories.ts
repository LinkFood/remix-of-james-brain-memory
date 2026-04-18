/**
 * useTradeAdvisories — read + ack hooks for ct_trade_advisories.
 *
 * Two hooks:
 *   - useTradeAdvisoriesForTrade(tradeId): all advisories for a single
 *     trade, newest first. Used by the Trade Journal advisories section.
 *   - useTopUnackedAdvisories(limit): highest-urgency unacked advisories
 *     across all trades. Used by the CommandStation TradeAdvisoriesStrip.
 *
 * The ack mutation flips acknowledged_by_james=true. The DB trigger
 * (ct_trade_advisories_ack_only_guard) stamps acknowledged_at server-side,
 * so we only need to send the boolean — but we still optimistically
 * update both fields in cache for instant UI feedback.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';

export type AdvisoryType =
  | 'hold'
  | 'tighten_stop'
  | 'trail'
  | 'cut'
  | 'scale_out'
  | 'flip_consider';

export interface CtTradeAdvisoryRow {
  id: string;
  trade_id: string;
  created_at: string;
  advisory_type: AdvisoryType;
  urgency: number;
  reasoning: string;
  current_unrealized_pct: number | null;
  claude_read_context: Record<string, unknown> | null;
  acknowledged_by_james: boolean;
  acknowledged_at: string | null;
}

/** Pretty verb for UI pills. */
export function advisoryTypeLabel(t: AdvisoryType): string {
  switch (t) {
    case 'hold':          return 'hold';
    case 'tighten_stop':  return 'tighten stop';
    case 'trail':         return 'trail';
    case 'cut':           return 'cut';
    case 'scale_out':     return 'scale out';
    case 'flip_consider': return 'flip?';
  }
}

/** Urgency → tailwind bg/text classes for the pill. */
export function urgencyClasses(urgency: number): string {
  if (urgency >= 5) return 'bg-red-500/20 text-red-300 border-red-500/40';
  if (urgency >= 4) return 'bg-orange-500/20 text-orange-300 border-orange-500/40';
  if (urgency >= 3) return 'bg-amber-500/15 text-amber-300 border-amber-500/40';
  if (urgency >= 2) return 'bg-blue-500/10 text-blue-300 border-blue-500/30';
  return 'bg-muted/20 text-muted-foreground border-border';
}

export function useTradeAdvisoriesForTrade(tradeId: string | null | undefined) {
  return useQuery<CtTradeAdvisoryRow[]>({
    queryKey: ['ct_trade_advisories', 'trade', tradeId],
    enabled: !!tradeId,
    refetchInterval: 30_000,
    queryFn: async () => {
      if (!tradeId) return [];
      const { data, error } = await supabase
        .from('ct_trade_advisories')
        .select('*')
        .eq('trade_id', tradeId)
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data ?? []) as CtTradeAdvisoryRow[];
    },
  });
}

export function useTopUnackedAdvisories(limit = 5) {
  return useQuery<CtTradeAdvisoryRow[]>({
    queryKey: ['ct_trade_advisories', 'top_unacked', limit],
    refetchInterval: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('ct_trade_advisories')
        .select('*')
        .eq('acknowledged_by_james', false)
        .order('urgency', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return (data ?? []) as CtTradeAdvisoryRow[];
    },
  });
}

export function useAckAdvisory() {
  const qc = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (advisoryId: string) => {
      const nowIso = new Date().toISOString();
      const { error } = await supabase
        .from('ct_trade_advisories')
        .update({ acknowledged_by_james: true, acknowledged_at: nowIso })
        .eq('id', advisoryId);
      if (error) throw error;
      return { id: advisoryId, acknowledged_at: nowIso };
    },
    onMutate: async (advisoryId) => {
      // Optimistic: flip ack=true in every cached advisories list.
      const nowIso = new Date().toISOString();
      const snapshot: Array<{ key: readonly unknown[]; data: CtTradeAdvisoryRow[] | undefined }> = [];
      const caches = qc.getQueriesData<CtTradeAdvisoryRow[]>({ queryKey: ['ct_trade_advisories'] });
      for (const [key, data] of caches) {
        snapshot.push({ key, data });
        if (!data) continue;
        qc.setQueryData<CtTradeAdvisoryRow[]>(
          key,
          data.map(r => r.id === advisoryId
            ? { ...r, acknowledged_by_james: true, acknowledged_at: nowIso }
            : r),
        );
      }
      return { snapshot };
    },
    onError: (err, _id, ctx) => {
      // Roll back
      if (ctx?.snapshot) {
        for (const s of ctx.snapshot) qc.setQueryData(s.key, s.data);
      }
      const msg = err instanceof Error ? err.message : String(err);
      toast({ title: 'Ack failed', description: msg, variant: 'destructive' });
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['ct_trade_advisories'] });
    },
  });
}
