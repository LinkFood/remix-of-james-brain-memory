/**
 * usePrinciples — Queries jac_principles.
 *
 * Table is written by the weekly distiller (distill-principles, Sunday 3
 * AM UTC). Each row is a compound lesson distilled from multiple
 * jac_reflections. The watcher / morning-brief READ this table on every
 * tick (see _shared/memoryRecall.ts) — retiring a principle here stops
 * Claude from weighing it on the next call.
 *
 * Default (backwards-compatible) query excludes retired rows and orders
 * by confidence desc, limit 50. BrainInspector + PrincipleTickerWidget
 * continue to use this shape.
 *
 * usePrinciplesFull (below) is the richer query the Principles page
 * uses: includes acknowledged, category, severity, retired_at and
 * returns the full active set unbounded.
 */

import { useState, useEffect, useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface JacPrinciple {
  id: string;
  principle: string;
  confidence: number;
  times_applied: number;
  source_reflection_ids: string[] | null;
  created_at: string;
  last_validated: string;
  category: string | null;
  severity: number | null;
  acknowledged: boolean | null;
  retired_at: string | null;
}

const PRINCIPLES_QUERY_KEY = ['jac_principles'] as const;

/**
 * Legacy hook — keeps the existing BrainInspector /
 * PrincipleTickerWidget contract (principles, isLoading, refetch).
 * Excludes retired principles.
 */
export function usePrinciples(userId: string) {
  const [principles, setPrinciples] = useState<JacPrinciple[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchPrinciples = useCallback(async () => {
    if (!userId) return;
    setIsLoading(true);
    try {
      const { data } = await (supabase
        .from('jac_principles' as never)
        .select('id, principle, confidence, times_applied, source_reflection_ids, created_at, last_validated, category, severity, acknowledged, retired_at')
        .eq('user_id', userId)
        .is('retired_at', null)
        .order('confidence', { ascending: false })
        .limit(50) as unknown as Promise<{ data: JacPrinciple[] | null }>);
      if (data) setPrinciples(data);
    } catch (err) {
      console.warn('[usePrinciples] fetch failed:', err);
    } finally {
      setIsLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    fetchPrinciples();
  }, [fetchPrinciples]);

  return { principles, isLoading, refetch: fetchPrinciples };
}

/**
 * usePrinciplesFull — React Query version for the Principles page.
 * 5-minute refresh. Returns the full active (non-retired) set, ordered
 * severity desc then confidence desc.
 */
export function usePrinciplesFull(userId: string) {
  return useQuery<JacPrinciple[]>({
    queryKey: [...PRINCIPLES_QUERY_KEY, 'active', userId],
    enabled: Boolean(userId),
    refetchInterval: 5 * 60 * 1000,
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<JacPrinciple[]> => {
      const { data, error } = await supabase
        .from('jac_principles' as never)
        .select('id, principle, confidence, times_applied, source_reflection_ids, created_at, last_validated, category, severity, acknowledged, retired_at')
        .eq('user_id', userId)
        .is('retired_at', null)
        .order('severity', { ascending: false, nullsFirst: false })
        .order('confidence', { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as JacPrinciple[];
    },
  });
}

/**
 * useAcknowledgePrinciple — Toggle acknowledged flag. James clicks the
 * checkbox once he's read and agrees. Watcher doesn't care about this
 * field; it's UI-only for now.
 */
export function useAcknowledgePrinciple() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, value }: { id: string; value: boolean }) => {
      const { error } = await supabase
        .from('jac_principles' as never)
        .update({ acknowledged: value } as never)
        .eq('id', id);
      if (error) throw error;
      return id;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: PRINCIPLES_QUERY_KEY });
    },
  });
}

/**
 * useRetirePrinciple — James's veto. Sets retired_at=now() so the
 * memory-recall layer stops surfacing it. Soft-delete; row stays for
 * history.
 */
export function useRetirePrinciple() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from('jac_principles' as never)
        .update({ retired_at: new Date().toISOString() } as never)
        .eq('id', id);
      if (error) throw error;
      return id;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: PRINCIPLES_QUERY_KEY });
    },
  });
}
