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
import { RefreshCw, Clock, List, Code, Lightbulb, TrendingUp, Calendar, Brain, Archive } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Entry } from "./EntryCard";
import DumpInput, { DumpInputHandle } from "./DumpInput";
import { cn } from "@/lib/utils";
import { parseListItems } from "@/lib/parseListItems";
import { StatsGrid, EmptyState, EntrySection } from "./dashboard";
import { QuickStats } from "./dashboard/QuickStats";
import TagFilter from "./TagFilter";
import { ReminderBanner } from "./ReminderBanner";
import { useEntries, type DashboardEntry } from "@/hooks/useEntries";
import { useEntryActions } from "@/hooks/useEntryActions";
import { useRealtimeSubscription } from "@/hooks/useRealtimeSubscription";
import JacInsightCard from "@/components/JacInsightCard";
import JacProactiveInsightBanner from "@/components/JacProactiveInsightBanner";
import { useProactiveInsights } from "@/hooks/useProactiveInsights";
import type { JacDashboardState } from "@/hooks/useJacDashboard";

interface DashboardProps {
  userId: string;
  onViewEntry: (entry: Entry) => void;
  dumpInputRef?: React.RefObject<DumpInputHandle>;
  externalFilterTags?: string[];
  onClearExternalFilter?: () => void;
  highlightedEntryId?: string | null;
  isSelecting?: boolean;
  selectedIds?: Set<string>;
  onToggleSelect?: (entryId: string) => void;
  /** Jac dashboard transformation state */
  jacState?: JacDashboardState | null;
  onClearJac?: () => void;
}

const Dashboard = ({
  userId,
  onViewEntry,
  dumpInputRef,
  externalFilterTags,
  onClearExternalFilter,
  highlightedEntryId,
  isSelecting = false,
  selectedIds,
  onToggleSelect,
  jacState,
  onClearJac,
}: DashboardProps) => {
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
  
  // Show archived toggle
  const [showArchived, setShowArchived] = useState(false);
  
  // Proactive insights
  const { insight, dismiss: dismissInsight } = useProactiveInsights(userId);

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
  } = useEntries({ userId, showArchived });

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

  // Use external filter if provided, else use local filter
  const activeFilterTags = externalFilterTags?.length ? externalFilterTags : selectedTags;

  // Filter entries by active tags
  const filteredEntries = useMemo(() => {
    if (activeFilterTags.length === 0) return entries;
    return entries.filter((e) =>
      activeFilterTags.some((tag) => (e.tags || []).includes(tag))
    );
  }, [entries, activeFilterTags]);

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

  // Jac surfaced entries — when Jac answers a query and wants entries shown at top
  const jacSurfacedEntries = useMemo(() => {
    if (!jacState?.active || !jacState.surfaceEntryIds?.length) return [];
    return jacState.surfaceEntryIds
      .map((id) => entries.find((e) => e.id === id))
      .filter(Boolean) as typeof entries;
  }, [entries, jacState?.active, jacState?.surfaceEntryIds]);

  // Jac cluster map — which cluster each entry belongs to
  const jacClusterMap = useMemo(() => {
    const map = new Map<string, string>();
    if (!jacState?.active || !jacState.clusters?.length) return map;
    for (const cluster of jacState.clusters) {
      for (const id of cluster.entryIds) {
        map.set(id, cluster.label);
      }
    }
    return map;
  }, [jacState?.active, jacState?.clusters]);
  
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
      {/* JAC TAKES OVER - Front and center when active */}
      {jacState?.active && (
        <div className="space-y-4 animate-in fade-in slide-in-from-top-2 duration-300">
          {/* Jac Insight Card - THE HERO */}
          {jacState.insightCard && (
            <JacInsightCard
              insight={jacState.insightCard}
              message={jacState.message}
              loading={jacState.loading}
              onDismiss={() => onClearJac?.()}
              prominent
            />
          )}
          {jacState.loading && !jacState.insightCard && (
            <JacInsightCard
              insight={{ title: "", body: "", type: "insight" }}
              loading={true}
              onDismiss={() => onClearJac?.()}
              prominent
            />
          )}

          {/* Jac Found Section - RIGHT HERE, NOT BURIED */}
          {jacSurfacedEntries.length > 0 && (
            <EntrySection
              title="Jac Found"
              icon={<Brain className="w-4 h-4 text-sky-400" />}
              entries={jacSurfacedEntries}
              section="jac-surfaced"
              expanded={true}
              onToggle={() => {}}
              color="bg-sky-500/10"
              compact
              highlightedEntryId={highlightedEntryId}
              jacHighlightIds={jacState?.highlightEntryIds}
              jacClusterMap={jacClusterMap}
              isSelecting={isSelecting}
              selectedIds={selectedIds}
              onToggleSelect={onToggleSelect}
              onToggleListItem={handleToggleListItem}
              onStar={handleStar}
              onArchive={handleArchive}
              onDelete={handleDelete}
              onViewEntry={onViewEntry}
            />
          )}

          {/* Clear button to return to normal view */}
          <Button 
            variant="ghost" 
            onClick={onClearJac}
            className="w-full text-muted-foreground hover:text-foreground"
          >
            ← Back to normal view
          </Button>
        </div>
      )}

      {/* Proactive Jac Insight Banner - only when Jac NOT active */}
      {!jacState?.active && insight && (
        <JacProactiveInsightBanner
          message={insight.message}
          type={insight.type}
          onDismiss={dismissInsight}
          onAction={() => {
            const firstId = insight.entryIds[0];
            const entry = entries.find(e => e.id === firstId);
            if (entry) onViewEntry(entry);
            dismissInsight();
          }}
        />
      )}

      {/* Dump Input - Sticky on mobile */}
      <div className={cn(
        "sticky top-0 z-10 -mx-4 px-4 py-2 bg-background/95 backdrop-blur-sm md:static md:mx-0 md:px-0 md:py-0 md:bg-transparent md:backdrop-blur-none",
        jacState?.active && "opacity-60"
      )}>
        <DumpInput
          ref={dumpRef}
          userId={userId}
          onOptimisticEntry={handleOptimisticEntry}
          onOptimisticComplete={handleOptimisticComplete}
          onOptimisticFail={handleOptimisticFail}
          onSaveSuccess={handleSaveSuccess}
        />
      </div>

      {/* Rest of dashboard - dimmed when Jac is active */}
      <div className={cn(
        "space-y-6 transition-opacity duration-300",
        jacState?.active && "opacity-50"
      )}>
        {/* Reminder Banner */}
        <ReminderBanner userId={userId} onViewEntry={(e) => {
          const entry = entries.find(ent => ent.id === e.id);
          if (entry) onViewEntry(entry);
        }} />

        {/* Quick Stats Banner */}
        <QuickStats entries={entries} />

        {/* Stats Grid */}
        <StatsGrid stats={stats} starredCount={starredCount} />

        {/* Tag Filter & Archive Toggle */}
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <TagFilter
              entries={entries}
              selectedTags={activeFilterTags}
              onTagsChange={setSelectedTags}
            />
            {externalFilterTags && externalFilterTags.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onClearExternalFilter}
                className="text-xs text-muted-foreground"
              >
                Clear Jac filter
              </Button>
            )}
          </div>
          <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer hover:text-foreground transition-colors">
            <Checkbox
              checked={showArchived}
              onCheckedChange={(c) => setShowArchived(c as boolean)}
            />
            <Archive className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Show archived</span>
          </label>
        </div>
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
              highlightedEntryId={highlightedEntryId}
              jacHighlightIds={jacState?.highlightEntryIds}
              jacClusterMap={jacClusterMap}
              isSelecting={isSelecting}
              selectedIds={selectedIds}
              onToggleSelect={onToggleSelect}
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
            highlightedEntryId={highlightedEntryId}
            jacHighlightIds={jacState?.highlightEntryIds}
            jacClusterMap={jacClusterMap}
            isSelecting={isSelecting}
            selectedIds={selectedIds}
            onToggleSelect={onToggleSelect}
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
            highlightedEntryId={highlightedEntryId}
            jacHighlightIds={jacState?.highlightEntryIds}
            jacClusterMap={jacClusterMap}
            isSelecting={isSelecting}
            selectedIds={selectedIds}
            onToggleSelect={onToggleSelect}
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
            highlightedEntryId={highlightedEntryId}
            jacHighlightIds={jacState?.highlightEntryIds}
            jacClusterMap={jacClusterMap}
            isSelecting={isSelecting}
            selectedIds={selectedIds}
            onToggleSelect={onToggleSelect}
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
            highlightedEntryId={highlightedEntryId}
            jacHighlightIds={jacState?.highlightEntryIds}
            jacClusterMap={jacClusterMap}
            isSelecting={isSelecting}
            selectedIds={selectedIds}
            onToggleSelect={onToggleSelect}
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
            highlightedEntryId={highlightedEntryId}
            jacHighlightIds={jacState?.highlightEntryIds}
            jacClusterMap={jacClusterMap}
            isSelecting={isSelecting}
            selectedIds={selectedIds}
            onToggleSelect={onToggleSelect}
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
            highlightedEntryId={highlightedEntryId}
            jacHighlightIds={jacState?.highlightEntryIds}
            jacClusterMap={jacClusterMap}
            isSelecting={isSelecting}
            selectedIds={selectedIds}
            onToggleSelect={onToggleSelect}
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
    </div>
  );
};

export default Dashboard;
