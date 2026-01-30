/**
 * RelatedEntries — Shows semantically related entries in EntryView
 *
 * Part of the Connect layer. Shows entries connected by
 * embedding similarity, tag overlap, or manual linking.
 */

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, Link2, ChevronRight, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { format } from "date-fns";
import { useRelatedEntries, type RelatedEntry } from "@/hooks/useRelatedEntries";
import type { Entry } from "@/types";

interface RelatedEntriesProps {
  entryId: string | null;
  onViewEntry?: (entry: Entry) => void;
}

const relationshipColors: Record<string, string> = {
  semantic: "bg-sky-500/10 text-sky-500 border-sky-500/20",
  semantic_live: "bg-purple-500/10 text-purple-500 border-purple-500/20",
  tag_overlap: "bg-green-500/10 text-green-500 border-green-500/20",
};

const RelatedEntries = ({ entryId, onViewEntry }: RelatedEntriesProps) => {
  const { related, patterns, loading, error } = useRelatedEntries(entryId);

  if (!entryId) return null;

  if (loading) {
    return (
      <div className="mt-6 pt-4 border-t">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span className="text-sm">Finding connections...</span>
        </div>
      </div>
    );
  }

  if (error || related.length === 0) return null;

  return (
    <div className="mt-6 pt-4 border-t">
      <div className="flex items-center gap-2 mb-3">
        <Link2 className="w-4 h-4 text-sky-400" />
        <p className="text-sm font-medium">Related Entries</p>
        <Badge variant="secondary" className="text-xs">
          {related.length}
        </Badge>
      </div>

      <div className="space-y-2">
        {related.map((entry) => (
          <Card
            key={entry.id}
            className={cn(
              "p-3 cursor-pointer hover:border-primary/30 transition-all group",
              "hover:shadow-sm"
            )}
            onClick={() => {
              if (onViewEntry) {
                onViewEntry({
                  id: entry.id,
                  user_id: "",
                  content: entry.content,
                  title: entry.title,
                  content_type: entry.content_type,
                  content_subtype: entry.content_subtype || null,
                  tags: entry.tags || [],
                  extracted_data: {},
                  importance_score: entry.importance_score,
                  list_items: [],
                  source: "manual",
                  starred: entry.starred || false,
                  archived: false,
                  image_url: entry.image_url,
                  created_at: entry.created_at,
                  updated_at: entry.created_at,
                });
              }
            }}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">
                  {entry.title || "Untitled"}
                </p>
                <p className="text-xs text-muted-foreground truncate mt-0.5">
                  {entry.content.slice(0, 100)}
                </p>
                <div className="flex items-center gap-2 mt-1.5">
                  <Badge
                    variant="outline"
                    className={cn(
                      "text-xs",
                      relationshipColors[entry.relationship_type] ||
                        relationshipColors.semantic
                    )}
                  >
                    {Math.round(entry.similarity * 100)}% match
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {format(new Date(entry.created_at), "MMM d")}
                  </span>
                </div>
              </div>
              <ChevronRight className="w-4 h-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0 mt-1" />
            </div>
          </Card>
        ))}
      </div>

      {/* Pattern insights */}
      {patterns.commonTags && patterns.commonTags.length > 0 && (
        <div className="mt-3 flex items-center gap-2">
          <Sparkles className="w-3 h-3 text-yellow-400" />
          <span className="text-xs text-muted-foreground">
            Common themes:{" "}
            {patterns.commonTags.map((t) => t.tag).join(", ")}
          </span>
        </div>
      )}

      {patterns.timeSpan && patterns.timeSpan.daySpan > 0 && (
        <p className="text-xs text-muted-foreground/70 mt-1">
          Related entries span {patterns.timeSpan.daySpan} days
        </p>
      )}
    </div>
  );
};

export default RelatedEntries;
