/**
 * usePrinciples — Queries jac_principles for the Brain Inspector.
 */

import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';

export interface JacPrinciple {
  id: string;
  principle: string;
  confidence: number;
  times_applied: number;
  source_reflection_ids: string[] | null;
  created_at: string;
  last_validated: string;
}

export function usePrinciples(userId: string) {
  const [principles, setPrinciples] = useState<JacPrinciple[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchPrinciples = useCallback(async () => {
    if (!userId) return;
    setIsLoading(true);
    try {
      const { data } = await (supabase
        .from('jac_principles' as any)
        .select('id, principle, confidence, times_applied, source_reflection_ids, created_at, last_validated')
        .eq('user_id', userId)
        .order('confidence', { ascending: false })
        .limit(50) as any);
      if (data) setPrinciples(data as unknown as JacPrinciple[]);
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
