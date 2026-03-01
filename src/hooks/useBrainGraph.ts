/**
 * useBrainGraph -- Data hook for the Brain Inspector page.
 *
 * Fetches entries and reflections, and on item select loads
 * relationships from entry_relationships for the inspector panel.
 */

import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';

// --------------- Types ---------------

export interface BrainEntry {
  id: string;
  title: string | null;
  content: string;
  content_type: string;
  tags: string[] | null;
  importance_score: number | null;
  has_embedding: boolean;
  access_count: number | null;
  last_accessed_at: string | null;
  created_at: string;
}

export interface BrainReflection {
  id: string;
  task_type: string;
  intent: string | null;
  summary: string;
  connections: string[] | null;
  created_at: string;
}

export type BrainItem =
  | (BrainEntry & { kind: 'entry' })
  | (BrainReflection & { kind: 'reflection' });

export interface EntryRelationship {
  id: string;
  source_entry_id: string;
  related_entry_id: string;
  relationship_type: string;
  similarity_score: number;
  created_at: string;
  // Resolved fields (populated after fetch)
  related_title: string | null;
  related_content_type: string | null;
}

export interface UseBrainGraphReturn {
  entries: BrainEntry[];
  reflections: BrainReflection[];
  allItems: BrainItem[];
  selectedItem: BrainItem | null;
  selectItem: (item: BrainItem | null) => void;
  relationships: EntryRelationship[];
  relationshipsLoading: boolean;
  isLoading: boolean;
  tab: 'entries' | 'reflections' | 'all';
  setTab: (tab: 'entries' | 'reflections' | 'all') => void;
}

export function useBrainGraph(userId: string): UseBrainGraphReturn {
  const [entries, setEntries] = useState<BrainEntry[]>([]);
  const [reflections, setReflections] = useState<BrainReflection[]>([]);
  const [selectedItem, setSelectedItem] = useState<BrainItem | null>(null);
  const [relationships, setRelationships] = useState<EntryRelationship[]>([]);
  const [relationshipsLoading, setRelationshipsLoading] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [tab, setTab] = useState<'entries' | 'reflections' | 'all'>('all');

  // Fetch entries and reflections
  useEffect(() => {
    if (!userId) return;

    async function fetchData() {
      setIsLoading(true);

      // Fetch entries — select needed columns only (skip embedding to save bandwidth)
      const { data: entryData } = await supabase
        .from('entries')
        .select(
          'id, title, content, content_type, tags, importance_score, access_count, last_accessed_at, created_at',
        )
        .eq('user_id', userId)
        .eq('archived', false)
        .order('created_at', { ascending: false })
        .limit(100);

      if (entryData) {
        const mapped: BrainEntry[] = (
          entryData as Array<{
            id: string;
            title: string | null;
            content: string;
            content_type: string;
            tags: string[] | null;
            importance_score: number | null;
            access_count: number | null;
            last_accessed_at: string | null;
            created_at: string;
          }>
        ).map((e) => ({
          id: e.id,
          title: e.title,
          content: e.content,
          content_type: e.content_type,
          tags: e.tags,
          importance_score: e.importance_score,
          has_embedding: true, // Assume embedded if present — dedicated check not worth fetching vector
          access_count: e.access_count,
          last_accessed_at: e.last_accessed_at,
          created_at: e.created_at,
        }));
        setEntries(mapped);
      }

      // Fetch reflections
      const { data: refData } = await (supabase
        .from('jac_reflections' as any)
        .select('id, task_type, intent, summary, connections, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(50) as any);

      if (refData) {
        setReflections(refData as unknown as BrainReflection[]);
      }

      setIsLoading(false);
    }

    fetchData();
  }, [userId]);

  // When an item is selected, fetch its relationships
  const selectItem = useCallback(
    (item: BrainItem | null) => {
      setSelectedItem(item);
      setRelationships([]);

      if (!item || item.kind !== 'entry') return;

      setRelationshipsLoading(true);

      (async () => {
        // Fetch relationships where this entry is the source
        const { data: relData } = await (supabase
          .from('entry_relationships' as any)
          .select(
            'id, source_entry_id, related_entry_id, relationship_type, similarity_score, created_at',
          )
          .eq('source_entry_id', item.id)
          .order('similarity_score', { ascending: false }) as any);

        if (relData && (relData as any[]).length > 0) {
          const typed = relData as unknown as Array<{
            id: string;
            source_entry_id: string;
            related_entry_id: string;
            relationship_type: string;
            similarity_score: number;
            created_at: string;
          }>;

          // Resolve related entry titles
          const relatedIds = typed.map((r) => r.related_entry_id);
          const { data: relatedEntries } = await supabase
            .from('entries')
            .select('id, title, content_type')
            .in('id', relatedIds);

          const titleMap = new Map<
            string,
            { title: string | null; content_type: string | null }
          >();
          if (relatedEntries) {
            for (const e of relatedEntries as Array<{
              id: string;
              title: string | null;
              content_type: string;
            }>) {
              titleMap.set(e.id, {
                title: e.title,
                content_type: e.content_type,
              });
            }
          }

          const enriched: EntryRelationship[] = typed.map((r) => ({
            ...r,
            related_title: titleMap.get(r.related_entry_id)?.title ?? null,
            related_content_type:
              titleMap.get(r.related_entry_id)?.content_type ?? null,
          }));

          setRelationships(enriched);
        }

        setRelationshipsLoading(false);
      })();
    },
    [],
  );

  // Build combined list based on tab
  const allItems: BrainItem[] = (() => {
    const entryItems: BrainItem[] = entries.map((e) => ({
      ...e,
      kind: 'entry' as const,
    }));
    const refItems: BrainItem[] = reflections.map((r) => ({
      ...r,
      kind: 'reflection' as const,
    }));

    if (tab === 'entries') return entryItems;
    if (tab === 'reflections') return refItems;
    // 'all' -- merge and sort by created_at DESC
    return [...entryItems, ...refItems].sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
  })();

  return {
    entries,
    reflections,
    allItems,
    selectedItem,
    selectItem,
    relationships,
    relationshipsLoading,
    isLoading,
    tab,
    setTab,
  };
}
