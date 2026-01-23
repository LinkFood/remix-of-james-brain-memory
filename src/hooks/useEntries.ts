/**
 * useEntries - Centralized entries state management hook
 * 
 * Handles fetching, pagination, and CRUD operations for entries.
 */

import { useState, useCallback, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { parseListItems } from "@/lib/parseListItems";
import type { Entry } from "@/components/EntryCard";

// Extended Entry type for pending entries
export interface DashboardEntry extends Entry {
  _pending?: boolean;
}

export interface DashboardStats {
  total: number;
  today: number;
  important: number;
  byType: Record<string, number>;
}

interface UseEntriesOptions {
  userId: string;
  pageSize?: number;
}

interface UseEntriesReturn {
  entries: DashboardEntry[];
  setEntries: React.Dispatch<React.SetStateAction<DashboardEntry[]>>;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  stats: DashboardStats;
  setStats: React.Dispatch<React.SetStateAction<DashboardStats>>;
  fetchEntries: (cursor?: string) => Promise<void>;
  loadMore: () => Promise<void>;
  updateEntry: (entryId: string, updates: Partial<Entry>) => void;
  removeEntry: (entryId: string) => void;
  addEntry: (entry: DashboardEntry) => void;
}

export function useEntries({ userId, pageSize = 50 }: UseEntriesOptions): UseEntriesReturn {
  const [entries, setEntries] = useState<DashboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [stats, setStats] = useState<DashboardStats>({
    total: 0,
    today: 0,
    important: 0,
    byType: {},
  });

  const fetchEntries = useCallback(async (cursor?: string) => {
    try {
      let query = supabase
        .from("entries")
        .select("*")
        .eq("user_id", userId)
        .eq("archived", false)
        .order("created_at", { ascending: false })
        .limit(pageSize);

      if (cursor) {
        query = query.lt("created_at", cursor);
      }

      const { data, error } = await query;

      if (error) throw error;

      // Transform Supabase data to Entry type with proper list_items parsing
      const entriesData: DashboardEntry[] = (data || []).map((item) => ({
        ...item,
        tags: item.tags || [],
        extracted_data: (item.extracted_data as Record<string, unknown>) || {},
        list_items: parseListItems(item.list_items),
      }));

      setHasMore(entriesData.length === pageSize);

      if (cursor) {
        // Appending more entries
        setEntries((prev) => [...prev, ...entriesData]);
      } else {
        // Initial load
        setEntries(entriesData);

        // Calculate stats (only on initial load)
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

        const calculatedStats: DashboardStats = {
          total: entriesData.length,
          today: entriesData.filter((e) => new Date(e.created_at) >= todayStart).length,
          important: entriesData.filter((e) => (e.importance_score ?? 0) >= 7).length,
          byType: entriesData.reduce((acc, e) => {
            acc[e.content_type] = (acc[e.content_type] || 0) + 1;
            return acc;
          }, {} as Record<string, number>),
        };
        setStats(calculatedStats);
      }
    } catch (error) {
      console.error("Failed to fetch entries:", error);
      toast.error("Failed to load entries");
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [userId, pageSize]);

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore || entries.length === 0) return;
    setLoadingMore(true);
    const lastEntry = entries[entries.length - 1];
    await fetchEntries(lastEntry.created_at);
  }, [loadingMore, hasMore, entries, fetchEntries]);

  const updateEntry = useCallback((entryId: string, updates: Partial<Entry>) => {
    setEntries((prev) =>
      prev.map((e) => (e.id === entryId ? { ...e, ...updates } : e))
    );
  }, []);

  const removeEntry = useCallback((entryId: string) => {
    setEntries((prev) => prev.filter((e) => e.id !== entryId));
  }, []);

  const addEntry = useCallback((entry: DashboardEntry) => {
    setEntries((prev) => {
      if (prev.some((e) => e.id === entry.id)) return prev;
      return [entry, ...prev];
    });
  }, []);

  // Initial fetch
  useEffect(() => {
    fetchEntries();
  }, [fetchEntries]);

  return {
    entries,
    setEntries,
    loading,
    loadingMore,
    hasMore,
    stats,
    setStats,
    fetchEntries,
    loadMore,
    updateEntry,
    removeEntry,
    addEntry,
  };
}
