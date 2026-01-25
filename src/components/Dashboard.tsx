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

import { useState, useCallback, useRef, useMemo } from "react";
import { RefreshCw, Clock, List, Code, Lightbulb, TrendingUp, Calendar } from "lucide-react";
import { Entry } from "./EntryCard";
import DumpInput, { DumpInputHandle } from "./DumpInput";
import { parseListItems } from "@/lib/parseListItems";
import { StatsGrid, EmptyState, EntrySection } from "./dashboard";
import TagFilter from "./TagFilter";
import { useEntries, type DashboardEntry } from "@/hooks/useEntries";
import { useEntryActions } from "@/hooks/useEntryActions";
import { useRealtimeSubscription } from "@/hooks/useRealtimeSubscription";

interface DashboardProps {
  userId: string;
  onViewEntry: (entry: Entry) => void;
  dumpInputRef?: React.RefObject<DumpInputHandle>;
}

const Dashboard = ({ userId, onViewEntry, dumpInputRef }: DashboardProps) => {
  const internalDumpRef = useRef<DumpInputHandle>(null);
  const dumpRef = dumpInputRef || internalDumpRef;

  // Collapsible sections
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    upcoming: true,
    today: true,
    important: true,
    lists: true,
    code: false,
    ideas: false,
    recent: false,
  });

  // Tag filtering
  const [selectedTags, setSelectedTags] = useState<string[]>([]);

  const toggleSection = (section: string) => {
    setExpandedSections((prev) => ({
      ...prev,
      [section]: !prev[section],
    }));
  };

  // Use centralized entries hook
  const {
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
  } = useEntries({ userId });

  // Use entry actions hook
  const { toggleStar, toggleArchive, deleteEntry, toggleListItem } = useEntryActions({
    onEntryUpdate: updateEntry,
    onEntryRemove: removeEntry,
    onStatsUpdate: (_, action) => {
      if (action === 'delete') {
        setStats((prev) => ({ ...prev, total: Math.max(0, prev.total - 1) }));
      }
    },
  });

  // Realtime subscription for live updates
  useRealtimeSubscription({
    userId,
    onInsert: useCallback((newEntry: Entry) => {
      const processedEntry: DashboardEntry = {
        ...newEntry,
        tags: newEntry.tags || [],
        extracted_data: (newEntry.extracted_data as Record<string, unknown>) || {},
        list_items: parseListItems(newEntry.list_items),
      };
      addEntry(processedEntry);
    }, [addEntry]),
    onUpdate: useCallback((updated: Entry) => {
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
    }, [setEntries]),
    onDelete: useCallback((deleted: Entry) => {
      removeEntry(deleted.id);
    }, [removeEntry]),
  });

  // Optimistic update handlers
  const handleOptimisticEntry = (pendingEntry: Record<string, unknown>): string => {
    setEntries((prev) => [pendingEntry as unknown as DashboardEntry, ...prev]);
    return pendingEntry.id as string;
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
    removeEntry(tempId);
  };

  const handleSaveSuccess = (entry: Entry) => {
    addEntry(entry as DashboardEntry);
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

  // Wrapped handlers that include current entry data
  const handleToggleListItem = async (entryId: string, itemIndex: number, checked: boolean) => {
    const entry = entries.find((e) => e.id === entryId);
    if (!entry) return;
    await toggleListItem(entryId, entry.list_items, itemIndex, checked);
  };

  const handleStar = async (entryId: string, starred: boolean) => {
    await toggleStar(entryId, starred);
  };

  const handleArchive = async (entryId: string) => {
    await toggleArchive(entryId);
  };

  const handleDelete = async (entryId: string) => {
    await deleteEntry(entryId);
  };

  const handleTryExample = (text: string) => {
    if (dumpRef.current) {
      dumpRef.current.setValue(text);
      dumpRef.current.focus();
    }
  };

  const handleLoadSampleData = async () => {
    try {
      const { supabase } = await import("@/integrations/supabase/client");
      const { error } = await supabase.functions.invoke('insert-sample-data', {
        body: { user_id: userId },
      });
      if (error) throw error;
      const { toast } = await import("sonner");
      toast.success("Sample data loaded!");
      fetchEntries();
    } catch (err) {
      console.error("Failed to load sample data:", err);
      const { toast } = await import("sonner");
      toast.error("Failed to load sample data");
    }
  };

  // Memoized computed lists for performance
  const todayStart = useMemo(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }, []);

  const todayStr = useMemo(() => new Date().toISOString().split('T')[0], []);

  // Filter entries by selected tags
  const filteredEntries = useMemo(() => {
    if (selectedTags.length === 0) return entries;
    return entries.filter((e) =>
      selectedTags.some((tag) => (e.tags || []).includes(tag))
    );
  }, [entries, selectedTags]);

  const todayEntries = useMemo(
    () => filteredEntries.filter((e) => new Date(e.created_at) >= todayStart),
    [filteredEntries, todayStart]
  );

  const importantEntries = useMemo(
    () => filteredEntries.filter((e) => (e.importance_score ?? 0) >= 7),
    [filteredEntries]
  );

  const listEntries = useMemo(
    () => filteredEntries.filter((e) => e.content_type === "list"),
    [filteredEntries]
  );

  const codeEntries = useMemo(
    () => filteredEntries.filter((e) => e.content_type === "code"),
    [filteredEntries]
  );

  const ideaEntries = useMemo(
    () => filteredEntries.filter((e) => e.content_type === "idea"),
    [filteredEntries]
  );

  const starredCount = useMemo(
    () => entries.filter((e) => e.starred).length,
    [entries]
  );
  
  // Upcoming entries: events/reminders with future event_date
  const upcomingEntries = useMemo(() => {
    return filteredEntries
      .filter((e) => {
        const eventDate = e.event_date;
        if (!eventDate) return false;
        return eventDate >= todayStr;
      })
      .sort((a, b) => {
        const dateA = a.event_date || '';
        const dateB = b.event_date || '';
        return dateA.localeCompare(dateB);
      });
  }, [filteredEntries, todayStr]);

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

      {/* Tag Filter */}
      <TagFilter
        entries={entries}
        selectedTags={selectedTags}
        onTagsChange={setSelectedTags}
      />

      {/* Sections */}
      <div className="space-y-4">
        {/* Upcoming Section */}
        {upcomingEntries.length > 0 && (
          <EntrySection
            title="Upcoming"
            icon={<Calendar className="w-4 h-4 text-green-500" />}
            entries={upcomingEntries}
            section="upcoming"
            expanded={expandedSections.upcoming}
            onToggle={toggleSection}
            color="bg-green-500/10"
            compact
            onToggleListItem={handleToggleListItem}
            onStar={handleStar}
            onArchive={handleArchive}
            onDelete={handleDelete}
            onViewEntry={onViewEntry}
          />
        )}

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
        {entries.length > 0 && (
          <EntrySection
            title="Recent"
            icon={<RefreshCw className="w-4 h-4 text-muted-foreground" />}
            entries={entries.slice(0, 10)}
            section="recent"
            expanded={expandedSections.recent}
            onToggle={toggleSection}
            color="bg-muted"
            compact
            onToggleListItem={handleToggleListItem}
            onStar={handleStar}
            onArchive={handleArchive}
            onDelete={handleDelete}
            onViewEntry={onViewEntry}
            showLoadMore={hasMore}
            onLoadMore={loadMore}
            loadingMore={loadingMore}
          />
        )}

        {/* Empty State */}
        {entries.length === 0 && (
          <EmptyState
            onTryExample={handleTryExample}
            onLoadSampleData={handleLoadSampleData}
          />
        )}
      </div>
    </div>
  );
};

export default Dashboard;
