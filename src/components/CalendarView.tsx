import { useState, useEffect, useMemo } from "react";
import { format, isSameDay } from "date-fns";
import { Calendar as CalendarIcon } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Calendar } from "@/components/ui/calendar";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import type { Entry } from "@/components/EntryCard";

interface CalendarViewProps {
  userId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onViewEntry: (entry: Entry) => void;
}

const contentTypeIcons: Record<string, string> = {
  code: "💻",
  list: "📝",
  idea: "💡",
  link: "🔗",
  contact: "👤",
  event: "📅",
  reminder: "⏰",
  note: "📄",
};

export function CalendarView({ userId, open, onOpenChange, onViewEntry }: CalendarViewProps) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(new Date());
  const [currentMonth, setCurrentMonth] = useState<Date>(new Date());

  // Fetch entries with event_date
  useEffect(() => {
    if (!open || !userId) return;

    const fetchEntries = async () => {
      setLoading(true);
      const { data, error } = await supabase
        .from("entries")
        .select("*")
        .eq("user_id", userId)
        .not("event_date", "is", null)
        .eq("archived", false)
        .order("event_date", { ascending: true });

      if (!error && data) {
        // Transform data to match Entry type
        const transformedData = data.map(entry => ({
          ...entry,
          tags: entry.tags || [],
          extracted_data: (entry.extracted_data || {}) as Record<string, unknown>,
          list_items: (entry.list_items || []) as Array<{ text: string; checked: boolean }>,
        }));
        setEntries(transformedData);
      }
      setLoading(false);
    };

    fetchEntries();
  }, [open, userId]);

  // Get dates that have entries
  const datesWithEntries = useMemo(() => {
    return entries
      .filter(e => e.event_date)
      .map(e => new Date(e.event_date!));
  }, [entries]);

  // Get entries for selected date
  const entriesForSelectedDate = useMemo(() => {
    if (!selectedDate) return [];
    return entries.filter(e => 
      e.event_date && isSameDay(new Date(e.event_date), selectedDate)
    );
  }, [entries, selectedDate]);

  // Custom day render to show dots for dates with entries
  const modifiers = useMemo(() => ({
    hasEntry: datesWithEntries,
  }), [datesWithEntries]);

  const modifiersStyles = {
    hasEntry: {
      position: "relative" as const,
    },
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-lg p-0 flex flex-col">
        <SheetHeader className="px-6 py-4 border-b border-border">
          <div className="flex items-center justify-between">
            <SheetTitle className="flex items-center gap-2">
              <CalendarIcon className="h-5 w-5" />
              Calendar
            </SheetTitle>
          </div>
        </SheetHeader>

        <div className="flex-1 overflow-hidden flex flex-col">
          {/* Calendar */}
          <div className="p-4 border-b border-border">
            <Calendar
              mode="single"
              selected={selectedDate}
              onSelect={setSelectedDate}
              month={currentMonth}
              onMonthChange={setCurrentMonth}
              modifiers={modifiers}
              modifiersStyles={modifiersStyles}
              className="mx-auto"
              components={{
                DayContent: ({ date }) => {
                  const hasEntry = datesWithEntries.some(d => isSameDay(d, date));
                  return (
                    <div className="relative w-full h-full flex items-center justify-center">
                      {date.getDate()}
                      {hasEntry && (
                        <span className="absolute bottom-0 left-1/2 -translate-x-1/2 w-1.5 h-1.5 rounded-full bg-primary" />
                      )}
                    </div>
                  );
                },
              }}
            />
          </div>

          {/* Selected date entries */}
          <div className="flex-1 flex flex-col min-h-0">
            <div className="px-4 py-3 border-b border-border bg-muted/30">
              <h3 className="font-medium text-sm">
                {selectedDate ? format(selectedDate, "EEEE, MMMM d, yyyy") : "Select a date"}
              </h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                {entriesForSelectedDate.length} {entriesForSelectedDate.length === 1 ? "entry" : "entries"}
              </p>
            </div>

            <ScrollArea className="flex-1">
              <div className="p-4 space-y-2">
                {loading ? (
                  <div className="text-center py-8 text-muted-foreground text-sm">
                    Loading...
                  </div>
                ) : entriesForSelectedDate.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground text-sm">
                    No entries for this date
                  </div>
                ) : (
                  entriesForSelectedDate.map((entry) => (
                    <button
                      key={entry.id}
                      onClick={() => onViewEntry(entry)}
                      className="w-full text-left p-3 rounded-lg border border-border bg-card hover:bg-accent/50 transition-colors"
                    >
                      <div className="flex items-start gap-2">
                        <span className="text-lg shrink-0">
                          {contentTypeIcons[entry.content_type] || "📄"}
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-sm truncate">
                              {entry.title || entry.content.slice(0, 50)}
                            </span>
                            {entry.importance_score && entry.importance_score >= 7 && (
                              <span className="text-xs">🔥</span>
                            )}
                          </div>
                          {entry.event_time && (
                            <p className="text-xs text-muted-foreground mt-0.5">
                              {entry.event_time.slice(0, 5)}
                            </p>
                          )}
                          {entry.tags && entry.tags.length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-1.5">
                              {entry.tags.slice(0, 3).map((tag) => (
                                <Badge key={tag} variant="secondary" className="text-xs px-1.5 py-0">
                                  {tag}
                                </Badge>
                              ))}
                            </div>
                          )}
                        </div>
                        {entry.starred && (
                          <span className="text-yellow-500 shrink-0">★</span>
                        )}
                      </div>
                    </button>
                  ))
                )}
              </div>
            </ScrollArea>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
