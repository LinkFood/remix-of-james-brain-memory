/**
 * useSearch - Centralized search hook with debouncing
 * 
 * Provides consistent search behavior across GlobalSearch and AssistantChat.
 * Supports both semantic (vector) and keyword search modes.
 * 
 * @module hooks/useSearch
 * 
 * @example
 * ```tsx
 * const {
 *   query,
 *   setQuery,
 *   results,
 *   loading,
 *   search,
 *   useSemanticSearch,
 *   setUseSemanticSearch,
 * } = useSearch({ userId: user.id, autoSearch: true });
 * 
 * // Automatic search (debounced) - just update query
 * setQuery(userInput);
 * 
 * // Manual search - bypass debounce
 * await search();
 * ```
 * 
 * Features:
 * - 300ms debounce (configurable) for auto-search mode
 * - Toggle between semantic and keyword search
 * - Minimum query length validation
 * - Toast notifications for search feedback
 * - Invokes `search-memory` edge function
 */

import { useState, useCallback, useEffect } from "react";
import { useDebouncedCallback } from "use-debounce";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

/**
 * Search result item returned from the search-memory edge function
 */
export interface SearchResult {
  id: string;
  title: string | null;
  content: string;
  content_type: string;
  content_subtype?: string | null;
  tags: string[];
  importance_score: number | null;
  created_at: string;
  /** Similarity score (0-1) when using semantic search */
  similarity?: number;
  starred?: boolean;
  list_items?: unknown[];
  extracted_data?: Record<string, unknown>;
}

/**
 * Configuration options for the search hook
 */
interface UseSearchOptions {
  /** The authenticated user's ID */
  userId: string;
  /** Debounce delay in milliseconds (default: 300) */
  debounceMs?: number;
  /** Maximum results to return (default: 50) */
  limit?: number;
  /** Enable automatic search on query change (default: false) */
  autoSearch?: boolean;
  /** Minimum characters before search triggers (default: 2) */
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
