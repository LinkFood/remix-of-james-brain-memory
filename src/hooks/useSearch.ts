/**
 * useSearch - Centralized search hook with debouncing
 * 
 * Provides consistent search behavior across GlobalSearch and other components.
 * Implements a 300ms debounce for performance optimization.
 */

import { useState, useCallback, useEffect } from "react";
import { useDebouncedCallback } from "use-debounce";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export interface SearchResult {
  id: string;
  title: string | null;
  content: string;
  content_type: string;
  content_subtype?: string | null;
  tags: string[];
  importance_score: number | null;
  created_at: string;
  similarity?: number;
  starred?: boolean;
  list_items?: unknown[];
  extracted_data?: Record<string, unknown>;
}

interface UseSearchOptions {
  userId: string;
  debounceMs?: number;
  limit?: number;
  autoSearch?: boolean;
  minQueryLength?: number;
}

interface UseSearchReturn {
  query: string;
  setQuery: (query: string) => void;
  results: SearchResult[];
  loading: boolean;
  error: string | null;
  useSemanticSearch: boolean;
  setUseSemanticSearch: (enabled: boolean) => void;
  search: () => Promise<void>;
  clearResults: () => void;
}

export function useSearch({
  userId,
  debounceMs = 300,
  limit = 50,
  autoSearch = false,
  minQueryLength = 2,
}: UseSearchOptions): UseSearchReturn {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [useSemanticSearch, setUseSemanticSearch] = useState(true);

  const performSearch = useCallback(async (searchQuery: string) => {
    if (!searchQuery.trim() || searchQuery.trim().length < minQueryLength) {
      setResults([]);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const { data, error: searchError } = await supabase.functions.invoke("search-memory", {
        body: { 
          query: searchQuery.trim(), 
          userId,
          useSemanticSearch,
          limit,
        },
      });

      if (searchError) throw searchError;
      
      setResults(data.results || []);
      
      if (data.total === 0) {
        toast.info("No results found");
      } else {
        const searchType = useSemanticSearch ? "semantic" : "keyword";
        toast.success(`Found ${data.total} entries using ${searchType} search`);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Search failed";
      setError(errorMessage);
      toast.error("Search failed");
      console.error("Search error:", err);
    } finally {
      setLoading(false);
    }
  }, [userId, useSemanticSearch, limit, minQueryLength]);

  // Debounced search for auto-search mode
  const debouncedSearch = useDebouncedCallback(
    (searchQuery: string) => {
      performSearch(searchQuery);
    },
    debounceMs
  );

  // Manual search function (bypasses debounce)
  const search = useCallback(async () => {
    await performSearch(query);
  }, [performSearch, query]);

  // Auto-search when query changes (if enabled)
  useEffect(() => {
    if (autoSearch && query.trim().length >= minQueryLength) {
      debouncedSearch(query);
    }
  }, [query, autoSearch, debouncedSearch, minQueryLength]);

  const clearResults = useCallback(() => {
    setResults([]);
    setQuery("");
    setError(null);
  }, []);

  return {
    query,
    setQuery,
    results,
    loading,
    error,
    useSemanticSearch,
    setUseSemanticSearch,
    search,
    clearResults,
  };
}
