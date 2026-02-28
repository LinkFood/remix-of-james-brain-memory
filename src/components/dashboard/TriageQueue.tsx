import { useMemo } from "react";
import { AlertTriangle } from "lucide-react";
import EntrySection from "./EntrySection";
import type { Entry } from "@/components/EntryCard";
import type { DashboardEntry } from "@/hooks/useEntries";

interface TriageQueueProps {
  entries: DashboardEntry[];
  insightEntryIds: string[];
  highlightedEntryId?: string | null;
  jacHighlightIds?: string[];
  jacClusterMap?: Map<string, string>;
  isSelecting?: boolean;
  selectedIds?: Set<string>;
  onToggleSelect?: (entryId: string) => void;
  onToggleListItem?: (entryId: string, itemIndex: number, checked: boolean) => void;
  onStar?: (entryId: string, starred: boolean) => void;
  onArchive?: (entryId: string) => void;
  onDelete?: (entryId: string) => void;
  onViewEntry?: (entry: Entry) => void;
}

const TriageQueue = ({
  entries,
  insightEntryIds,
  highlightedEntryId,
  jacHighlightIds,
  jacClusterMap,
  isSelecting,
  selectedIds,
  onToggleSelect,
  onToggleListItem,
  onStar,
  onArchive,
  onDelete,
  onViewEntry,
}: TriageQueueProps) => {
  const triageEntries = useMemo(() => {
    const today = new Date().toISOString().split('T')[0];
    const twoWeeksAgo = new Date();
    twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
    const twoWeeksAgoStr = twoWeeksAgo.toISOString();
    const insightSet = new Set(insightEntryIds);
    const seen = new Set<string>();
    const result: DashboardEntry[] = [];

    const add = (entry: DashboardEntry) => {
      if (seen.has(entry.id)) return;
      seen.add(entry.id);
      result.push(entry);
    };

    // 1. Overdue: event_date < today
    for (const e of entries) {
      if (e.event_date && e.event_date < today && !e.archived) add(e);
    }

    // 2. Unchecked lists
    for (const e of entries) {
      if (e.content_type === 'list' && !e.archived) {
        const items = e.list_items;
        if (Array.isArray(items) && items.some((i: { checked?: boolean }) => !i.checked)) {
          add(e);
        }
      }
    }

    // 3. Stale important: importance >= 7 and updated_at > 14 days ago
    for (const e of entries) {
      if ((e.importance_score ?? 0) >= 7 && e.updated_at < twoWeeksAgoStr && !e.archived) {
        add(e);
      }
    }

    // 4. Insight-flagged
    for (const e of entries) {
      if (insightSet.has(e.id)) add(e);
    }

    return result;
  }, [entries, insightEntryIds]);

  if (triageEntries.length === 0) return null;

  return (
    <EntrySection
      title="Needs Attention"
      icon={<AlertTriangle className="w-4 h-4 text-red-500" />}
      entries={triageEntries}
      section="triage"
      expanded={true}
      onToggle={() => {}}
      color="bg-red-500/10"
      limit={10}
      compact
      highlightedEntryId={highlightedEntryId}
      jacHighlightIds={jacHighlightIds}
      jacClusterMap={jacClusterMap}
      isSelecting={isSelecting}
      selectedIds={selectedIds}
      onToggleSelect={onToggleSelect}
      onToggleListItem={onToggleListItem}
      onStar={onStar}
      onArchive={onArchive}
      onDelete={onDelete}
      onViewEntry={onViewEntry}
    />
  );
};

export default TriageQueue;
