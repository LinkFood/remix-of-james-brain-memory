import { useMemo } from "react";
import { Tag, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import type { Entry } from "@/components/EntryCard";

interface TagFilterProps {
  entries: Entry[];
  selectedTags: string[];
  onTagsChange: (tags: string[]) => void;
}

export function TagFilter({ entries, selectedTags, onTagsChange }: TagFilterProps) {
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
    <div className="mb-4">
      <div className="flex items-center gap-2 mb-2">
        <Tag className="w-4 h-4 text-muted-foreground" />
        <span className="text-sm text-muted-foreground">Filter by tags</span>
        {selectedTags.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={clearTags}
            className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
          >
            <X className="w-3 h-3 mr-1" />
            Clear
          </Button>
        )}
      </div>
      <ScrollArea className="w-full whitespace-nowrap">
        <div className="flex gap-2 pb-2">
          {allTags.map((tag) => {
            const isSelected = selectedTags.includes(tag);
            return (
              <Badge
                key={tag}
                variant={isSelected ? "default" : "secondary"}
                className={`cursor-pointer transition-colors shrink-0 ${
                  isSelected
                    ? "bg-primary text-primary-foreground hover:bg-primary/90"
                    : "hover:bg-accent"
                }`}
                onClick={() => toggleTag(tag)}
              >
                {tag}
                <span className="ml-1 text-xs opacity-70">{tagCounts[tag]}</span>
              </Badge>
            );
          })}
        </div>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
    </div>
  );
}

export default TagFilter;
