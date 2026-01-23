import { useState, useEffect, useCallback } from "react";
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
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import EntryCard, { Entry } from "./EntryCard";
import DumpInput from "./DumpInput";
import { parseListItems } from "@/lib/parseListItems";

interface DashboardProps {
  userId: string;
  onViewEntry: (entry: Entry) => void;
}

interface DashboardStats {
  total: number;
  today: number;
  important: number;
  byType: Record<string, number>;
}

const Dashboard = ({ userId, onViewEntry }: DashboardProps) => {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<DashboardStats>({
    total: 0,
    today: 0,
    important: 0,
    byType: {},
  });

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

  const fetchEntries = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from("entries")
        .select("*")
        .eq("user_id", userId)
        .eq("archived", false)
        .order("created_at", { ascending: false })
        .limit(100);

      if (error) throw error;

      // Transform Supabase data to Entry type with proper list_items parsing
      const entriesData: Entry[] = (data || []).map((item) => ({
        ...item,
        tags: item.tags || [],
        extracted_data: (item.extracted_data as Record<string, unknown>) || {},
        list_items: parseListItems(item.list_items),
      }));
      setEntries(entriesData);

      // Calculate stats
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
    } catch (error: any) {
      console.error("Failed to fetch entries:", error);
      toast.error("Failed to load entries");
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    fetchEntries();
  }, [fetchEntries]);

  const handleSaveSuccess = (entry: Entry) => {
    setEntries((prev) => [entry, ...prev]);
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

  // Filter entries by category
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
      {/* Dump Input - Always at top */}
      <DumpInput userId={userId} onSaveSuccess={handleSaveSuccess} />

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
              {entries.slice(0, 10).map((entry) => (
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
            </div>
          )}
        </Card>
      </div>

      {/* Empty State */}
      {entries.length === 0 && (
        <Card className="p-8 text-center">
          <div className="max-w-sm mx-auto">
            <Lightbulb className="w-12 h-12 mx-auto text-muted-foreground/50 mb-4" />
            <h3 className="text-lg font-medium mb-2">Your brain is empty</h3>
            <p className="text-sm text-muted-foreground mb-4">
              Start dumping anything - code, ideas, lists, links - and watch your second brain grow.
            </p>
          </div>
        </Card>
      )}
    </div>
  );
};

export default Dashboard;
