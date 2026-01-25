import { useMemo } from "react";
import { format, isToday, isYesterday, isThisWeek, startOfDay } from "date-fns";
import { Code, List, Lightbulb, Link, Calendar, Bell, StickyNote, User } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { useEntries } from "@/hooks/useEntries";
import type { Entry } from "@/components/EntryCard";

interface TimelineViewProps {
  userId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onViewEntry: (entry: Entry) => void;
}

const contentTypeIcons: Record<string, typeof Code> = {
  code: Code,
  list: List,
  idea: Lightbulb,
  link: Link,
  event: Calendar,
  reminder: Bell,
  contact: User,
  note: StickyNote,
};

function getDateLabel(date: Date): string {
  if (isToday(date)) return "Today";
  if (isYesterday(date)) return "Yesterday";
  if (isThisWeek(date)) return format(date, "EEEE");
  return format(date, "MMMM d, yyyy");
}

interface GroupedEntries {
  label: string;
  date: Date;
  entries: Entry[];
}

export function TimelineView({ userId, open, onOpenChange, onViewEntry }: TimelineViewProps) {
  const { entries, loading } = useEntries({ userId });

  const groupedEntries = useMemo(() => {
    if (!entries.length) return [];

    const groups: Map<string, GroupedEntries> = new Map();

    entries
      .filter((e) => !e.archived)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .forEach((entry) => {
        const date = startOfDay(new Date(entry.created_at));
        const key = date.toISOString();

        if (!groups.has(key)) {
          groups.set(key, {
            label: getDateLabel(date),
            date,
            entries: [],
          });
        }
        groups.get(key)!.entries.push(entry);
      });

    return Array.from(groups.values());
  }, [entries]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-lg p-0">
        <SheetHeader className="p-6 pb-4 border-b border-border">
          <SheetTitle className="flex items-center gap-2">
            <Calendar className="w-5 h-5" />
            Timeline
          </SheetTitle>
        </SheetHeader>

        <ScrollArea className="h-[calc(100vh-80px)]">
          <div className="p-6">
            {loading ? (
              <div className="space-y-4">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="h-20 bg-muted rounded-lg animate-pulse" />
                ))}
              </div>
            ) : groupedEntries.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <Calendar className="w-12 h-12 mx-auto mb-4 opacity-50" />
                <p>No entries yet</p>
                <p className="text-sm">Start dumping to see your timeline</p>
              </div>
            ) : (
              <div className="space-y-8">
                {groupedEntries.map((group) => (
                  <div key={group.date.toISOString()}>
                    {/* Date header */}
                    <div className="flex items-center gap-3 mb-4">
                      <div className="w-3 h-3 rounded-full bg-primary" />
                      <h3 className="text-sm font-semibold text-foreground">
                        {group.label}
                      </h3>
                      <div className="flex-1 h-px bg-border" />
                    </div>

                    {/* Entries */}
                    <div className="space-y-3 ml-6 pl-4 border-l border-border">
                      {group.entries.map((entry) => {
                        const Icon = contentTypeIcons[entry.content_type] || StickyNote;
                        return (
                          <button
                            key={entry.id}
                            onClick={() => onViewEntry(entry)}
                            className="w-full text-left p-3 rounded-lg bg-card hover:bg-accent border border-border transition-colors"
                          >
                            <div className="flex items-start gap-3">
                              <div className="p-2 rounded-lg bg-muted">
                                <Icon className="w-4 h-4 text-muted-foreground" />
                              </div>
                              <div className="flex-1 min-w-0">
                                <p className="font-medium text-sm truncate">
                                  {entry.title || entry.content.slice(0, 50)}
                                </p>
                                <p className="text-xs text-muted-foreground mt-1">
                                  {format(new Date(entry.created_at), "h:mm a")}
                                </p>
                                {entry.tags && entry.tags.length > 0 && (
                                  <div className="flex flex-wrap gap-1 mt-2">
                                    {entry.tags.slice(0, 3).map((tag) => (
                                      <Badge key={tag} variant="secondary" className="text-xs">
                                        {tag}
                                      </Badge>
                                    ))}
                                    {entry.tags.length > 3 && (
                                      <Badge variant="secondary" className="text-xs">
                                        +{entry.tags.length - 3}
                                      </Badge>
                                    )}
                                  </div>
                                )}
                              </div>
                              {entry.importance_score && entry.importance_score >= 7 && (
                                <span className="text-sm">🔥</span>
                              )}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

export default TimelineView;
