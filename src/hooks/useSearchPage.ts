/**
 * useSearchPage — Dedicated hook for the Search page.
 * Calls search-memory edge function + queries jac_reflections.
 * Merges and ranks results by relevance.
 */

import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';

export interface SearchPageResult {
  id: string;
  content: string;
  title: string | null;
  content_type: string;
  content_subtype?: string | null;
  tags: string[];
  importance_score: number | null;
  created_at: string;
  similarity?: number;
  /** 'entry' or 'reflection' */
  source: 'entry' | 'reflection';
}

export interface SearchPageFilters {
  contentType?: string;
  sourceType?: 'all' | 'entries' | 'reflections';
  startDate?: string;
  endDate?: string;
}

export interface UseSearchPageResult {
  results: SearchPageResult[];
  isSearching: boolean;
  error: string | null;
  hasSearched: boolean;
  search: (query: string, filters?: SearchPageFilters) => Promise<void>;
}

export function useSearchPage(): UseSearchPageResult {
  const [userId, setUserId] = useState<string>('');
  const [results, setResults] = useState<SearchPageResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) setUserId(session.user.id);
    });
  }, []);

  const search = useCallback(
    async (query: string, filters?: SearchPageFilters) => {
      if (!query.trim() || !userId) return;

      setIsSearching(true);
      setError(null);
      setHasSearched(true);

      try {
        const merged: SearchPageResult[] = [];

        const shouldSearchEntries =
          !filters?.sourceType || filters.sourceType === 'all' || filters.sourceType === 'entries';
        const shouldSearchReflections =
          !filters?.sourceType || filters.sourceType === 'all' || filters.sourceType === 'reflections';

        // 1. Search entries via search-memory edge function
        if (shouldSearchEntries) {
          const { data, error: fnError } = await supabase.functions.invoke('search-memory', {
            body: {
              query: query.trim(),
              useSemanticSearch: true,
              contentType: filters?.contentType || undefined,
              startDate: filters?.startDate || undefined,
              endDate: filters?.endDate || undefined,
              limit: 50,
            },
          });

          if (fnError) {
            console.error('search-memory error:', fnError);
          } else if (data?.results) {
            for (const r of data.results) {
              merged.push({
                id: r.id,
                content: r.content,
                title: r.title,
                content_type: r.content_type,
                content_subtype: r.content_subtype ?? null,
                tags: r.tags || [],
                importance_score: r.importance_score,
                created_at: r.created_at,
                similarity: r.similarity,
                source: 'entry',
              });
            }
          }
        }

        // 2. Search jac_reflections
        if (shouldSearchReflections) {
          try {
            const escapedQuery = query.trim().replace(/%/g, '\\%').replace(/_/g, '\\_');
            const { data: reflections, error: refError } = await (supabase
              .from('jac_reflections' as any)
              .select('id, task_type, summary, intent, connections, created_at')
              .eq('user_id', userId)
              .or(`summary.ilike.%${escapedQuery}%,intent.ilike.%${escapedQuery}%`)
              .order('created_at', { ascending: false })
              .limit(20) as any);

            if (!refError && reflections) {
              for (const r of reflections as any[]) {
                merged.push({
                  id: r.id,
                  content: r.summary || '',
                  title: r.intent || `${r.task_type} reflection`,
                  content_type: r.task_type || 'reflection',
                  tags: r.connections || [],
                  importance_score: null,
                  created_at: r.created_at,
                  source: 'reflection',
                });
              }
            }
          } catch (refErr) {
            // jac_reflections may not exist yet
            console.warn('Reflection search failed:', refErr);
          }
        }

        // Sort: similarity scores first (desc), then by date
        merged.sort((a, b) => {
          if (a.similarity != null && b.similarity != null) {
            return b.similarity - a.similarity;
          }
          if (a.similarity != null) return -1;
          if (b.similarity != null) return 1;
          return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
        });

        setResults(merged);
      } catch (err) {
        console.error('Search failed:', err);
        setError(err instanceof Error ? err.message : 'Search failed');
        setResults([]);
      } finally {
        setIsSearching(false);
      }
    },
    [userId]
  );

  return { results, isSearching, error, hasSearched, search };
}
