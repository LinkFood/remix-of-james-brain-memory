import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import EntryCard, { Entry } from "@/components/EntryCard";
import SectionHeader from "./SectionHeader";

interface EntrySectionProps {
  title: string;
  icon: React.ReactNode;
  entries: Entry[];
  section: string;
  expanded: boolean;
  onToggle: (section: string) => void;
  color?: string;
  limit?: number;
  compact?: boolean;
  showContent?: boolean;
  showLoadMore?: boolean;
  loadingMore?: boolean;
  hasMore?: boolean;
  highlightedEntryId?: string | null;
  /** Multiple highlighted entry IDs (from Jac dashboard transformation) */
  jacHighlightIds?: string[];
  isSelecting?: boolean;
  selectedIds?: Set<string>;
  onLoadMore?: () => void;
  onToggleSelect?: (entryId: string) => void;
  onToggleListItem?: (entryId: string, itemIndex: number, checked: boolean) => void;
  onStar?: (entryId: string, starred: boolean) => void;
  onArchive?: (entryId: string) => void;
  onDelete?: (entryId: string) => void;
  onViewEntry?: (entry: Entry) => void;
}

const EntrySection = ({
  title,
  icon,
  entries,
  section,
  expanded,
  onToggle,
  color,
  limit = 5,
  compact = false,
  showContent = true,
  showLoadMore = false,
  loadingMore = false,
  hasMore = false,
  highlightedEntryId,
  jacHighlightIds = [],
  isSelecting = false,
  selectedIds,
  onLoadMore,
  onToggleSelect,
  onToggleListItem,
  onStar,
  onArchive,
  onDelete,
  onViewEntry,
}: EntrySectionProps) => {
  const displayEntries = entries.slice(0, limit);
  const hasMoreEntries = entries.length > limit;

  return (
    <Card>
      <SectionHeader
        title={title}
        icon={icon}
        count={entries.length}
        section={section}
        expanded={expanded}
        onToggle={onToggle}
        color={color}
      />
      {expanded && (
        <div className="px-3 pb-3 space-y-2">
          {displayEntries.map((entry) => (
            <EntryCard
              key={entry.id}
              entry={entry}
              compact={compact}
              showContent={showContent}
              highlighted={entry.id === highlightedEntryId || jacHighlightIds.includes(entry.id)}
              isSelecting={isSelecting}
              isSelected={selectedIds?.has(entry.id) ?? false}
              onToggleSelect={() => onToggleSelect?.(entry.id)}
              onToggleListItem={onToggleListItem}
              onStar={onStar}
              onArchive={onArchive}
              onDelete={onDelete}
              onClick={onViewEntry}
            />
          ))}
          {hasMoreEntries && !showLoadMore && (
            <Button variant="ghost" className="w-full text-sm">
              See all {entries.length} entries
            </Button>
          )}
          {showLoadMore && hasMore && (
            <Button
              variant="ghost"
              onClick={onLoadMore}
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
  );
};

export default EntrySection;
