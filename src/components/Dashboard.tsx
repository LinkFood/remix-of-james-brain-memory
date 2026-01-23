/**
 * Dashboard — Your Brain at a Glance
 * 
 * GOAL: See what matters without organizing anything.
 * 
 * Important stuff floats up. Lists are actionable. Recent is visible.
 * User never built this view. AI did. That's the magic.
 * 
 * Keep it clean. Keep it fast. Keep it alive (realtime).
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { RefreshCw, Clock, List, Code, Lightbulb, TrendingUp } from "lucide-react";
import { toast } from "sonner";
import { Entry } from "./EntryCard";
import DumpInput, { DumpInputHandle } from "./DumpInput";
import { parseListItems } from "@/lib/parseListItems";
import { RealtimePostgresChangesPayload } from "@supabase/supabase-js";
import { StatsGrid, EmptyState, EntrySection } from "./dashboard";

// Extended Entry type for pending entries
interface PendingEntry extends Entry {
  _pending?: boolean;
}

interface DashboardProps {
  userId: string;
  onViewEntry: (entry: Entry) => void;
  dumpInputRef?: React.RefObject<DumpInputHandle>;
}

interface DashboardStats {
  total: number;
  today: number;
  important: number;
  byType: Record<string, number>;
}

const Dashboard = ({ userId, onViewEntry, dumpInputRef }: DashboardProps) => {
  const [entries, setEntries] = useState<PendingEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [stats, setStats] = useState<DashboardStats>({
    total: 0,
    today: 0,
    important: 0,
    byType: {},
  });
  const internalDumpRef = useRef<DumpInputHandle>(null);
  const dumpRef = dumpInputRef || internalDumpRef;
  const PAGE_SIZE = 50;

  // Collapsible sections
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    today: true,
    important: true,
    lists: true,
    code: false,
    ideas: false,
    recent: false,
  });

  const toggleSection = (section: string) => {
    setExpandedSections((prev) => ({
      ...prev,
      [section]: !prev[section],
    }));
  };

  const fetchEntries = useCallback(async (cursor?: string) => {
    try {
      let query = supabase
        .from("entries")
        .select("*")
        .eq("user_id", userId)
        .eq("archived", false)
        .order("created_at", { ascending: false })
        .limit(PAGE_SIZE);

      if (cursor) {
        query = query.lt("created_at", cursor);
      }

      const { data, error } = await query;

      if (error) throw error;

      // Transform Supabase data to Entry type with proper list_items parsing
      const entriesData: PendingEntry[] = (data || []).map((item) => ({
        ...item,
        tags: item.tags || [],
        extracted_data: (item.extracted_data as Record<string, unknown>) || {},
        list_items: parseListItems(item.list_items),
      }));

      setHasMore(entriesData.length === PAGE_SIZE);

      if (cursor) {
        // Appending more entries
        setEntries((prev) => [...prev, ...entriesData]);
      } else {
        // Initial load
        setEntries(entriesData);

        // Calculate stats (only on initial load)
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

        const stats: DashboardStats = {
          total: entriesData.length,
          today: entriesData.filter((e) => new Date(e.created_at) >= todayStart).length,
          important: entriesData.filter((e) => (e.importance_score ?? 0) >= 7).length,
          byType: entriesData.reduce((acc, e) => {
            acc[e.content_type] = (acc[e.content_type] || 0) + 1;
            return acc;
          }, {} as Record<string, number>),
        };
        setStats(stats);
      }
    } catch (error: any) {
      console.error("Failed to fetch entries:", error);
      toast.error("Failed to load entries");
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [userId]);

  const loadMore = async () => {
    if (loadingMore || !hasMore || entries.length === 0) return;
    setLoadingMore(true);
    const lastEntry = entries[entries.length - 1];
    await fetchEntries(lastEntry.created_at);
  };

  useEffect(() => {
    fetchEntries();
  }, [fetchEntries]);

  // Realtime subscription for live updates
  useEffect(() => {
    const channel = supabase
      .channel('entries-realtime')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'entries',
          filter: `user_id=eq.${userId}`,
        },
        (payload: RealtimePostgresChangesPayload<Entry>) => {
          if (payload.eventType === 'INSERT') {
            const newEntry = payload.new as Entry;
            setEntries((prev) => {
              if (prev.some((e) => e.id === newEntry.id)) return prev;
              return [{
                ...newEntry,
                tags: newEntry.tags || [],
                extracted_data: (newEntry.extracted_data as Record<string, unknown>) || {},
                list_items: parseListItems(newEntry.list_items),
              }, ...prev];
            });
          } else if (payload.eventType === 'UPDATE') {
            const updated = payload.new as Entry;
            setEntries((prev) =>
              prev.map((e) =>
                e.id === updated.id
                  ? {
                      ...updated,
                      tags: updated.tags || [],
                      extracted_data: (updated.extracted_data as Record<string, unknown>) || {},
                      list_items: parseListItems(updated.list_items),
                    }
                  : e
              )
            );
          } else if (payload.eventType === 'DELETE') {
            const deleted = payload.old as Entry;
            setEntries((prev) => prev.filter((e) => e.id !== deleted.id));
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId]);

  // Optimistic update handlers
  const handleOptimisticEntry = (pendingEntry: PendingEntry): string => {
    setEntries((prev) => [pendingEntry, ...prev]);
    return pendingEntry.id;
  };

  const handleOptimisticComplete = (tempId: string, realEntry: Entry) => {
    setEntries((prev) =>
      prev.map((e) =>
        e.id === tempId
          ? { ...realEntry, tags: realEntry.tags || [], list_items: parseListItems(realEntry.list_items), _pending: false }
          : e
      )
    );
    setStats((prev) => ({
      ...prev,
      total: prev.total + 1,
      today: prev.today + 1,
      important: (realEntry.importance_score ?? 0) >= 7 ? prev.important + 1 : prev.important,
      byType: {
        ...prev.byType,
        [realEntry.content_type]: (prev.byType[realEntry.content_type] || 0) + 1,
      },
    }));
  };

  const handleOptimisticFail = (tempId: string) => {
    setEntries((prev) => prev.filter((e) => e.id !== tempId));
  };

  const handleSaveSuccess = (entry: Entry) => {
    setEntries((prev) => {
      if (prev.some((e) => e.id === entry.id)) return prev;
      return [entry, ...prev];
    });
    setStats((prev) => ({
      ...prev,
      total: prev.total + 1,
      today: prev.today + 1,
      important: (entry.importance_score ?? 0) >= 7 ? prev.important + 1 : prev.important,
      byType: {
        ...prev.byType,
        [entry.content_type]: (prev.byType[entry.content_type] || 0) + 1,
      },
    }));
  };

  const handleToggleListItem = async (entryId: string, itemIndex: number, checked: boolean) => {
    try {
      const entry = entries.find((e) => e.id === entryId);
      if (!entry) return;

      const updatedItems = [...entry.list_items];
      updatedItems[itemIndex] = { ...updatedItems[itemIndex], checked };

      const { error } = await supabase
        .from("entries")
        .update({ list_items: updatedItems })
        .eq("id", entryId);

      if (error) throw error;

      setEntries((prev) =>
        prev.map((e) =>
          e.id === entryId ? { ...e, list_items: updatedItems } : e
        )
      );
    } catch (error) {
      console.error("Failed to update list item:", error);
      toast.error("Failed to update item");
    }
  };

  const handleStar = async (entryId: string, starred: boolean) => {
    try {
      const { error } = await supabase
        .from("entries")
        .update({ starred })
        .eq("id", entryId);

      if (error) throw error;

      setEntries((prev) =>
        prev.map((e) => (e.id === entryId ? { ...e, starred } : e))
      );
      toast.success(starred ? "Starred" : "Unstarred");
    } catch (error) {
      toast.error("Failed to update");
    }
  };

  const handleArchive = async (entryId: string) => {
    try {
      const { error } = await supabase
        .from("entries")
        .update({ archived: true })
        .eq("id", entryId);

      if (error) throw error;

      setEntries((prev) => prev.filter((e) => e.id !== entryId));
      toast.success("Archived");
    } catch (error) {
      toast.error("Failed to archive");
    }
  };

  const handleDelete = async (entryId: string) => {
    try {
      const { error } = await supabase
        .from("entries")
        .delete()
        .eq("id", entryId);

      if (error) throw error;

      setEntries((prev) => prev.filter((e) => e.id !== entryId));
      setStats((prev) => ({ ...prev, total: Math.max(0, prev.total - 1) }));
      toast.success("Deleted");
    } catch (error) {
      toast.error("Failed to delete");
    }
  };

  const handleTryExample = (text: string) => {
    if (dumpRef.current) {
      dumpRef.current.setValue(text);
      dumpRef.current.focus();
    }
  };

  const handleLoadSampleData = async () => {
    try {
      const { error } = await supabase.functions.invoke('insert-sample-data', {
        body: { user_id: userId },
      });
      if (error) throw error;
      toast.success("Sample data loaded!");
      fetchEntries();
    } catch (err: any) {
      console.error("Failed to load sample data:", err);
      toast.error("Failed to load sample data");
    }
  };

  // Computed lists
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const todayEntries = entries.filter((e) => new Date(e.created_at) >= todayStart);
  const importantEntries = entries.filter((e) => (e.importance_score ?? 0) >= 7);
  const listEntries = entries.filter((e) => e.content_type === "list");
  const codeEntries = entries.filter((e) => e.content_type === "code");
  const ideaEntries = entries.filter((e) => e.content_type === "idea");
  const starredCount = entries.filter((e) => e.starred).length;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Dump Input - Sticky on mobile */}
      <div className="sticky top-0 z-10 -mx-4 px-4 py-2 bg-background/95 backdrop-blur-sm md:static md:mx-0 md:px-0 md:py-0 md:bg-transparent md:backdrop-blur-none">
        <DumpInput
          ref={dumpRef}
          userId={userId}
          onOptimisticEntry={handleOptimisticEntry}
          onOptimisticComplete={handleOptimisticComplete}
          onOptimisticFail={handleOptimisticFail}
          onSaveSuccess={handleSaveSuccess}
        />
      </div>

      {/* Quick Stats */}
      <StatsGrid stats={stats} starredCount={starredCount} />

      {/* Sections */}
      <div className="space-y-4">
        {/* Today Section */}
        {todayEntries.length > 0 && (
          <EntrySection
            title="Today"
            icon={<Clock className="w-4 h-4 text-blue-500" />}
            entries={todayEntries}
            section="today"
            expanded={expandedSections.today}
            onToggle={toggleSection}
            color="bg-blue-500/10"
            compact
            onToggleListItem={handleToggleListItem}
            onStar={handleStar}
            onArchive={handleArchive}
            onDelete={handleDelete}
            onViewEntry={onViewEntry}
          />
        )}

        {/* Important Section */}
        {importantEntries.length > 0 && (
          <EntrySection
            title="Important"
            icon={<TrendingUp className="w-4 h-4 text-orange-500" />}
            entries={importantEntries}
            section="important"
            expanded={expandedSections.important}
            onToggle={toggleSection}
            color="bg-orange-500/10"
            compact
            onToggleListItem={handleToggleListItem}
            onStar={handleStar}
            onArchive={handleArchive}
            onDelete={handleDelete}
            onViewEntry={onViewEntry}
          />
        )}

        {/* Lists Section */}
        {listEntries.length > 0 && (
          <EntrySection
            title="Lists"
            icon={<List className="w-4 h-4 text-blue-500" />}
            entries={listEntries}
            section="lists"
            expanded={expandedSections.lists}
            onToggle={toggleSection}
            color="bg-blue-500/10"
            onToggleListItem={handleToggleListItem}
            onStar={handleStar}
            onArchive={handleArchive}
            onDelete={handleDelete}
            onViewEntry={onViewEntry}
          />
        )}

        {/* Code Section */}
        {codeEntries.length > 0 && (
          <EntrySection
            title="Code Snippets"
            icon={<Code className="w-4 h-4 text-purple-500" />}
            entries={codeEntries}
            section="code"
            expanded={expandedSections.code}
            onToggle={toggleSection}
            color="bg-purple-500/10"
            compact
            onStar={handleStar}
            onArchive={handleArchive}
            onDelete={handleDelete}
            onViewEntry={onViewEntry}
          />
        )}

        {/* Ideas Section */}
        {ideaEntries.length > 0 && (
          <EntrySection
            title="Ideas"
            icon={<Lightbulb className="w-4 h-4 text-yellow-500" />}
            entries={ideaEntries}
            section="ideas"
            expanded={expandedSections.ideas}
            onToggle={toggleSection}
            color="bg-yellow-500/10"
            compact
            onStar={handleStar}
            onArchive={handleArchive}
            onDelete={handleDelete}
            onViewEntry={onViewEntry}
          />
        )}

        {/* Recent Timeline */}
        <EntrySection
          title="Recent"
          icon={<Clock className="w-4 h-4 text-muted-foreground" />}
          entries={entries}
          section="recent"
          expanded={expandedSections.recent}
          onToggle={toggleSection}
          limit={20}
          compact
          showContent={false}
          showLoadMore
          loadingMore={loadingMore}
          hasMore={hasMore}
          onLoadMore={loadMore}
          onStar={handleStar}
          onArchive={handleArchive}
          onDelete={handleDelete}
          onViewEntry={onViewEntry}
        />
      </div>

      {/* Empty State */}
      {entries.length === 0 && (
        <EmptyState 
          onTryExample={handleTryExample}
          onLoadSampleData={handleLoadSampleData}
        />
      )}
    </div>
  );
};

export default Dashboard;
