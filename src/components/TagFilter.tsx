import { useMemo, useState } from "react";
import { Tag, X, ChevronDown, ChevronUp } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Entry } from "@/components/EntryCard";

interface TagFilterProps {
  entries: Entry[];
  selectedTags: string[];
  onTagsChange: (tags: string[]) => void;
}

const COLLAPSED_TAG_COUNT = 10;

export function TagFilter({ entries, selectedTags, onTagsChange }: TagFilterProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  // Calculate tag counts from entries
  const tagCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    entries.forEach((entry) => {
      (entry.tags || []).forEach((tag) => {
        counts[tag] = (counts[tag] || 0) + 1;
      });
    });
    // Sort by count descending
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .reduce((acc, [tag, count]) => {
        acc[tag] = count;
        return acc;
      }, {} as Record<string, number>);
  }, [entries]);

  const allTags = Object.keys(tagCounts);
  const hiddenCount = allTags.length - COLLAPSED_TAG_COUNT;
  const hasHiddenTags = hiddenCount > 0;
  const visibleTags = isExpanded ? allTags : allTags.slice(0, COLLAPSED_TAG_COUNT);

  if (allTags.length === 0) {
    return null;
  }

  const toggleTag = (tag: string) => {
    if (selectedTags.includes(tag)) {
      onTagsChange(selectedTags.filter((t) => t !== tag));
    } else {
      onTagsChange([...selectedTags, tag]);
    }
  };

  const clearTags = () => {
    onTagsChange([]);
  };

  return (
    <div className="mb-4 overflow-hidden max-w-full">
      <div className="flex items-center gap-2 mb-2">
        <Tag className="w-4 h-4 text-muted-foreground shrink-0" />
        <span className="text-sm text-muted-foreground">Filter by tags</span>
        {selectedTags.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={clearTags}
            className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground shrink-0"
          >
            <X className="w-3 h-3 mr-1" />
            Clear
          </Button>
        )}
      </div>
      
      {/* Wrapping tag container */}
      <div className="flex flex-wrap gap-2">
        {visibleTags.map((tag) => {
          const isSelected = selectedTags.includes(tag);
          return (
            <Badge
              key={tag}
              variant={isSelected ? "default" : "secondary"}
              className={`cursor-pointer transition-colors max-w-[150px] ${
                isSelected
                  ? "bg-primary text-primary-foreground hover:bg-primary/90"
                  : "hover:bg-accent"
              }`}
              onClick={() => toggleTag(tag)}
              title={tag}
            >
              <span className="truncate">{tag}</span>
              <span className="ml-1 text-xs opacity-70 shrink-0">{tagCounts[tag]}</span>
            </Badge>
          );
        })}
      </div>

      {/* Show more / Show less toggle */}
      {hasHiddenTags && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setIsExpanded(!isExpanded)}
          className="mt-2 h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
        >
          {isExpanded ? (
            <>
              <ChevronUp className="w-3 h-3 mr-1" />
              Show less
            </>
          ) : (
            <>
              <ChevronDown className="w-3 h-3 mr-1" />
              Show {hiddenCount} more
            </>
          )}
        </Button>
      )}
    </div>
  );
}

export default TagFilter;
