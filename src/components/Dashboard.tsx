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
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Clock,
  Star,
  List,
  Code,
  Lightbulb,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  TrendingUp,
  Hash,
  Sparkles,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import EntryCard, { Entry } from "./EntryCard";
import DumpInput, { DumpInputHandle } from "./DumpInput";
import { parseListItems } from "@/lib/parseListItems";
import { RealtimePostgresChangesPayload } from "@supabase/supabase-js";

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
            // Check if entry already exists (from optimistic update)
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
    // Update stats
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
    // Check if entry already exists (from realtime)
    setEntries((prev) => {
      if (prev.some((e) => e.id === entry.id)) return prev;
      return [entry, ...prev];
    });
    // Update stats
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

// Empty State Component
const EmptyState = ({
  onTryExample,
  onLoadSampleData,
}: {
  onTryExample: (text: string) => void;
  onLoadSampleData: () => void;
}) => {
  const [loading, setLoading] = useState(false);

  const examples = [
    { label: "Grocery list", text: "Buy milk, eggs, bread, and butter" },
    { label: "Code snippet", text: "const add = (a, b) => a + b;" },
    { label: "App idea", text: "App idea: an alarm that only stops when you solve a puzzle" },
  ];

  return (
    <Card className="p-8 text-center">
      <div className="max-w-md mx-auto">
        <Sparkles className="w-12 h-12 mx-auto text-primary/50 mb-4" />
        <h3 className="text-lg font-medium mb-2">Your brain is empty</h3>
        <p className="text-sm text-muted-foreground mb-6">
          Start dumping anything and watch your second brain grow.
        </p>

        {/* Quick Try Examples */}
        <div className="flex flex-wrap justify-center gap-2 mb-6">
          {examples.map((ex) => (
            <Button
              key={ex.label}
              variant="outline"
              size="sm"
              onClick={() => onTryExample(ex.text)}
              className="text-xs"
            >
              Try: "{ex.label}"
            </Button>
          ))}
        </div>

        {/* Load Sample Data */}
        <Button
          variant="secondary"
          onClick={async () => {
            setLoading(true);
            await onLoadSampleData();
            setLoading(false);
          }}
          disabled={loading}
        >
          {loading ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Loading...
            </>
          ) : (
            <>
              <Sparkles className="w-4 h-4 mr-2" />
              Load Sample Data
            </>
          )}
        </Button>
      </div>
    </Card>
  );
};


  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const todayEntries = entries.filter((e) => new Date(e.created_at) >= todayStart);
  const importantEntries = entries.filter((e) => (e.importance_score ?? 0) >= 7);
  const listEntries = entries.filter((e) => e.content_type === "list");
  const codeEntries = entries.filter((e) => e.content_type === "code");
  const ideaEntries = entries.filter((e) => e.content_type === "idea");

  const SectionHeader = ({
    title,
    icon,
    count,
    section,
    color,
  }: {
    title: string;
    icon: React.ReactNode;
    count: number;
    section: string;
    color?: string;
  }) => (
    <button
      onClick={() => toggleSection(section)}
      className="flex items-center justify-between w-full p-3 hover:bg-muted/50 rounded-lg transition-colors"
    >
      <div className="flex items-center gap-2">
        <div className={cn("p-1.5 rounded-md", color || "bg-muted")}>{icon}</div>
        <span className="font-medium">{title}</span>
        <Badge variant="secondary" className="text-xs">
          {count}
        </Badge>
      </div>
      {expandedSections[section] ? (
        <ChevronDown className="w-4 h-4 text-muted-foreground" />
      ) : (
        <ChevronRight className="w-4 h-4 text-muted-foreground" />
      )}
    </button>
  );

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
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Card className="p-3">
          <div className="flex items-center gap-2">
            <Hash className="w-4 h-4 text-muted-foreground" />
            <div>
              <p className="text-2xl font-bold">{stats.total}</p>
              <p className="text-xs text-muted-foreground">Total entries</p>
            </div>
          </div>
        </Card>
        <Card className="p-3">
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-blue-500" />
            <div>
              <p className="text-2xl font-bold">{stats.today}</p>
              <p className="text-xs text-muted-foreground">Today</p>
            </div>
          </div>
        </Card>
        <Card className="p-3">
          <div className="flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-orange-500" />
            <div>
              <p className="text-2xl font-bold">{stats.important}</p>
              <p className="text-xs text-muted-foreground">Important</p>
            </div>
          </div>
        </Card>
        <Card className="p-3">
          <div className="flex items-center gap-2">
            <Star className="w-4 h-4 text-yellow-500" />
            <div>
              <p className="text-2xl font-bold">{entries.filter((e) => e.starred).length}</p>
              <p className="text-xs text-muted-foreground">Starred</p>
            </div>
          </div>
        </Card>
      </div>

      {/* Sections */}
      <div className="space-y-4">
        {/* Today Section */}
        {todayEntries.length > 0 && (
          <Card>
            <SectionHeader
              title="Today"
              icon={<Clock className="w-4 h-4 text-blue-500" />}
              count={todayEntries.length}
              section="today"
              color="bg-blue-500/10"
            />
            {expandedSections.today && (
              <div className="px-3 pb-3 space-y-2">
                {todayEntries.slice(0, 5).map((entry) => (
                  <EntryCard
                    key={entry.id}
                    entry={entry}
                    compact
                    onToggleListItem={handleToggleListItem}
                    onStar={handleStar}
                    onArchive={handleArchive}
                    onClick={onViewEntry}
                  />
                ))}
                {todayEntries.length > 5 && (
                  <Button variant="ghost" className="w-full text-sm">
                    See all {todayEntries.length} entries
                  </Button>
                )}
              </div>
            )}
          </Card>
        )}

        {/* Important Section */}
        {importantEntries.length > 0 && (
          <Card>
            <SectionHeader
              title="Important"
              icon={<TrendingUp className="w-4 h-4 text-orange-500" />}
              count={importantEntries.length}
              section="important"
              color="bg-orange-500/10"
            />
            {expandedSections.important && (
              <div className="px-3 pb-3 space-y-2">
                {importantEntries.slice(0, 5).map((entry) => (
                  <EntryCard
                    key={entry.id}
                    entry={entry}
                    compact
                    onToggleListItem={handleToggleListItem}
                    onStar={handleStar}
                    onArchive={handleArchive}
                    onClick={onViewEntry}
                  />
                ))}
              </div>
            )}
          </Card>
        )}

        {/* Lists Section */}
        {listEntries.length > 0 && (
          <Card>
            <SectionHeader
              title="Lists"
              icon={<List className="w-4 h-4 text-blue-500" />}
              count={listEntries.length}
              section="lists"
              color="bg-blue-500/10"
            />
            {expandedSections.lists && (
              <div className="px-3 pb-3 space-y-2">
                {listEntries.slice(0, 5).map((entry) => (
                  <EntryCard
                    key={entry.id}
                    entry={entry}
                    onToggleListItem={handleToggleListItem}
                    onStar={handleStar}
                    onArchive={handleArchive}
                    onClick={onViewEntry}
                  />
                ))}
              </div>
            )}
          </Card>
        )}

        {/* Code Section */}
        {codeEntries.length > 0 && (
          <Card>
            <SectionHeader
              title="Code Snippets"
              icon={<Code className="w-4 h-4 text-purple-500" />}
              count={codeEntries.length}
              section="code"
              color="bg-purple-500/10"
            />
            {expandedSections.code && (
              <div className="px-3 pb-3 space-y-2">
                {codeEntries.slice(0, 5).map((entry) => (
                  <EntryCard
                    key={entry.id}
                    entry={entry}
                    compact
                    onStar={handleStar}
                    onArchive={handleArchive}
                    onClick={onViewEntry}
                  />
                ))}
              </div>
            )}
          </Card>
        )}

        {/* Ideas Section */}
        {ideaEntries.length > 0 && (
          <Card>
            <SectionHeader
              title="Ideas"
              icon={<Lightbulb className="w-4 h-4 text-yellow-500" />}
              count={ideaEntries.length}
              section="ideas"
              color="bg-yellow-500/10"
            />
            {expandedSections.ideas && (
              <div className="px-3 pb-3 space-y-2">
                {ideaEntries.slice(0, 5).map((entry) => (
                  <EntryCard
                    key={entry.id}
                    entry={entry}
                    compact
                    onStar={handleStar}
                    onArchive={handleArchive}
                    onClick={onViewEntry}
                  />
                ))}
              </div>
            )}
          </Card>
        )}

        {/* Recent Timeline */}
        <Card>
          <SectionHeader
            title="Recent"
            icon={<Clock className="w-4 h-4 text-muted-foreground" />}
            count={entries.length}
            section="recent"
          />
          {expandedSections.recent && (
            <div className="px-3 pb-3 space-y-2">
              {entries.slice(0, 20).map((entry) => (
                <EntryCard
                  key={entry.id}
                  entry={entry}
                  compact
                  showContent={false}
                  onStar={handleStar}
                  onArchive={handleArchive}
                  onClick={onViewEntry}
                />
              ))}
              {hasMore && (
                <Button
                  variant="ghost"
                  onClick={loadMore}
                  disabled={loadingMore}
                  className="w-full text-sm"
                >
                  {loadingMore ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Loading...
                    </>
                  ) : (
                    `Load more entries`
                  )}
                </Button>
              )}
            </div>
          )}
        </Card>
      </div>

      {/* Empty State */}
      {entries.length === 0 && (
        <EmptyState 
          onTryExample={(text) => {
            if (dumpRef.current) {
              dumpRef.current.setValue(text);
              dumpRef.current.focus();
            }
          }}
          onLoadSampleData={async () => {
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
          }}
        />
      )}
    </div>
  );
};

export default Dashboard;
