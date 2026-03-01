/**
 * useBrainEntities — Queries brain_entities + entity_mentions for the Brain Inspector.
 */

import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';

export interface BrainEntity {
  id: string;
  name: string;
  entity_type: string;
  mention_count: number;
  first_seen: string;
  last_seen: string;
}

export interface EntityMention {
  id: string;
  entity_id: string;
  entry_id: string | null;
  reflection_id: string | null;
  context_snippet: string | null;
  created_at: string;
}

export function useBrainEntities(userId: string) {
  const [entities, setEntities] = useState<BrainEntity[]>([]);
  const [mentions, setMentions] = useState<EntityMention[]>([]);
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const fetchEntities = useCallback(async () => {
    if (!userId) return;
    setIsLoading(true);
    try {
      const { data } = await (supabase
        .from('brain_entities' as any)
        .select('id, name, entity_type, mention_count, first_seen, last_seen')
        .eq('user_id', userId)
        .order('mention_count', { ascending: false })
        .limit(100) as any);
      if (data) setEntities(data as unknown as BrainEntity[]);
    } catch (err) {
      console.warn('[useBrainEntities] fetch failed:', err);
    } finally {
      setIsLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    fetchEntities();
  }, [fetchEntities]);

  const fetchMentions = useCallback(async (entityId: string) => {
    setSelectedEntityId(entityId);
    try {
      const { data } = await (supabase
        .from('entity_mentions' as any)
        .select('id, entity_id, entry_id, reflection_id, context_snippet, created_at')
        .eq('entity_id', entityId)
        .order('created_at', { ascending: false })
        .limit(50) as any);
      if (data) setMentions(data as unknown as EntityMention[]);
    } catch (err) {
      console.warn('[useBrainEntities] mentions fetch failed:', err);
    }
  }, []);

  return { entities, mentions, selectedEntityId, fetchMentions, isLoading, refetch: fetchEntities };
}
