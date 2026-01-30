import { useMemo } from "react";
import { format, isToday, isTomorrow, isThisWeek, addDays, startOfDay } from "date-fns";
import { Clock, Calendar as CalendarIcon, Bell } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { Entry } from "@/components/EntryCard";

interface UpcomingPreviewProps {
  entries: Entry[];
  onViewEntry: (entry: Entry) => void;
  maxItems?: number;
}

const contentTypeIcons: Record<string, string> = {
  event: "📅",
  reminder: "⏰",
  list: "📝",
  note: "📄",
};

export function UpcomingPreview({ entries, onViewEntry, maxItems = 5 }: UpcomingPreviewProps) {
  // Group entries by relative date
  const groupedEntries = useMemo(() => {
    const today = startOfDay(new Date());
    const sevenDaysFromNow = addDays(today, 7);
    
    const groups: Record<string, Entry[]> = {};
    
    entries
      .filter(e => e.event_date)
      .slice(0, maxItems)
      .forEach(entry => {
        const eventDate = new Date(entry.event_date!);
        let groupLabel: string;
        
        if (isToday(eventDate)) {
          groupLabel = "Today";
        } else if (isTomorrow(eventDate)) {
          groupLabel = "Tomorrow";
        } else if (isThisWeek(eventDate, { weekStartsOn: 1 })) {
          groupLabel = format(eventDate, "EEEE");
        } else if (eventDate <= sevenDaysFromNow) {
          groupLabel = format(eventDate, "EEE, MMM d");
        } else {
          groupLabel = format(eventDate, "MMM d");
        }
        
        if (!groups[groupLabel]) {
          groups[groupLabel] = [];
        }
        groups[groupLabel].push(entry);
      });
    
    return groups;
  }, [entries, maxItems]);

  if (entries.length === 0) {
    return (
      <div className="text-center py-4 text-muted-foreground text-sm">
        <CalendarIcon className="h-8 w-8 mx-auto mb-2 opacity-50" />
        <p>Nothing scheduled</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {Object.entries(groupedEntries).map(([dateLabel, dateEntries]) => (
        <div key={dateLabel}>
          <div className="text-xs font-medium text-muted-foreground mb-1.5 uppercase tracking-wide">
            {dateLabel}
          </div>
          <div className="space-y-1">
            {dateEntries.map((entry) => (
              <button
                key={entry.id}
                onClick={() => onViewEntry(entry)}
                className="w-full text-left p-2 rounded-md hover:bg-accent/50 transition-colors flex items-start gap-2 group"
              >
                <span className="text-sm shrink-0">
                  {contentTypeIcons[entry.content_type] || "📄"}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium truncate">
                      {entry.title || entry.content.slice(0, 40)}
                    </span>
                    {(entry as Entry & { reminder_minutes?: number | null }).reminder_minutes && (
                      <Bell className="h-3 w-3 text-primary shrink-0" />
                    )}
                    {entry.importance_score && entry.importance_score >= 7 && (
                      <span className="text-xs shrink-0">🔥</span>
                    )}
                  </div>
                  {entry.event_time && (
                    <div className="flex items-center gap-1 text-xs text-muted-foreground mt-0.5">
                      <Clock className="h-3 w-3" />
                      {entry.event_time.slice(0, 5)}
                    </div>
                  )}
                </div>
                {entry.starred && (
                  <span className="text-primary shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                    ★
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
