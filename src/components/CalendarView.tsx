import { useState, useEffect, useMemo, useCallback } from "react";
import { format, isSameDay, startOfDay, addDays } from "date-fns";
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight, CalendarPlus } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Calendar } from "@/components/ui/calendar";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { QuickAddEvent, UpcomingPreview } from "@/components/calendar";
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

// Color-coded dots for calendar based on entry type
const getEntryDotColors = (dateEntries: Entry[]): string[] => {
  const colors = new Set<string>();
  dateEntries.forEach(e => {
    if (e.content_type === 'reminder' || e.content_type === 'event') {
      colors.add('bg-red-400');
    } else if (e.content_type === 'list') {
      colors.add('bg-blue-400');
    } else if (e.content_type === 'code') {
      colors.add('bg-purple-400');
    } else if (e.content_type === 'idea') {
      colors.add('bg-yellow-400');
    } else {
      colors.add('bg-primary');
    }
  });
  return Array.from(colors).slice(0, 3); // Max 3 dots
};

export function CalendarView({ userId, open, onOpenChange, onViewEntry }: CalendarViewProps) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(new Date());
  const [currentMonth, setCurrentMonth] = useState<Date>(new Date());
  const [showQuickAdd, setShowQuickAdd] = useState(false);

  // Fetch entries with event_date
  const fetchEntries = useCallback(async () => {
    if (!userId) return;
    
    setLoading(true);
    const { data, error } = await supabase
      .from("entries")
      .select("*")
      .eq("user_id", userId)
      .not("event_date", "is", null)
      .eq("archived", false)
      .order("event_date", { ascending: true });

    if (!error && data) {
      const transformedData = data.map(entry => ({
        ...entry,
        tags: entry.tags || [],
        extracted_data: (entry.extracted_data || {}) as Record<string, unknown>,
        list_items: (entry.list_items || []) as Array<{ text: string; checked: boolean }>,
      }));
      setEntries(transformedData);
    }
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    if (open) {
      fetchEntries();
    }
  }, [open, fetchEntries]);

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

  // Upcoming entries (next 7 days)
  const upcomingEntries = useMemo(() => {
    const today = startOfDay(new Date());
    const nextWeek = addDays(today, 7);
    const todayStr = format(today, "yyyy-MM-dd");
    const nextWeekStr = format(nextWeek, "yyyy-MM-dd");
    
    return entries
      .filter(e => e.event_date && e.event_date >= todayStr && e.event_date <= nextWeekStr)
      .sort((a, b) => {
        const dateA = a.event_date || "";
        const dateB = b.event_date || "";
        if (dateA !== dateB) return dateA.localeCompare(dateB);
        const timeA = a.event_time || "99:99";
        const timeB = b.event_time || "99:99";
        return timeA.localeCompare(timeB);
      });
  }, [entries]);

  // Custom day render to show dots for dates with entries
  const modifiers = useMemo(() => ({
    hasEntry: datesWithEntries,
  }), [datesWithEntries]);

  const modifiersStyles = {
    hasEntry: {
      position: "relative" as const,
    },
  };

  const handleDateSelect = (date: Date | undefined) => {
    setSelectedDate(date);
    setShowQuickAdd(false);
  };

  const goToToday = () => {
    const today = new Date();
    setSelectedDate(today);
    setCurrentMonth(today);
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
            <Button variant="outline" size="sm" onClick={goToToday}>
              Today
            </Button>
          </div>
        </SheetHeader>

        <div className="flex-1 overflow-hidden flex flex-col">
          {/* Coming Up Section */}
          {upcomingEntries.length > 0 && (
            <div className="px-4 py-3 border-b border-border bg-muted/20">
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
                Coming Up
              </h3>
              <UpcomingPreview 
                entries={upcomingEntries} 
                onViewEntry={onViewEntry}
                maxItems={4}
              />
            </div>
          )}

          {/* Calendar */}
          <div className="p-4 border-b border-border">
            <Calendar
              mode="single"
              selected={selectedDate}
              onSelect={handleDateSelect}
              month={currentMonth}
              onMonthChange={setCurrentMonth}
              modifiers={modifiers}
              modifiersStyles={modifiersStyles}
              className="mx-auto pointer-events-auto"
              components={{
                DayContent: ({ date }) => {
                  const dateEntries = entries.filter(e => 
                    e.event_date && isSameDay(new Date(e.event_date), date)
                  );
                  const dotColors = getEntryDotColors(dateEntries);
                  
                  return (
                    <div className="relative w-full h-full flex items-center justify-center">
                      {date.getDate()}
                      {dotColors.length > 0 && (
                        <div className="absolute bottom-0 left-1/2 -translate-x-1/2 flex gap-0.5">
                          {dotColors.map((color, i) => (
                            <span key={i} className={`w-1 h-1 rounded-full ${color}`} />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                },
              }}
            />
          </div>

          {/* Quick Add Form */}
          {showQuickAdd && selectedDate && (
            <QuickAddEvent
              userId={userId}
              selectedDate={selectedDate}
              onClose={() => setShowQuickAdd(false)}
              onEventAdded={fetchEntries}
            />
          )}

          {/* Selected date entries */}
          <div className="flex-1 flex flex-col min-h-0">
            <div className="px-4 py-3 border-b border-border bg-muted/30 flex items-center justify-between">
              <div>
                <h3 className="font-medium text-sm">
                  {selectedDate ? format(selectedDate, "EEEE, MMMM d, yyyy") : "Select a date"}
                </h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {entriesForSelectedDate.length} {entriesForSelectedDate.length === 1 ? "entry" : "entries"}
                </p>
              </div>
              {selectedDate && !showQuickAdd && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowQuickAdd(true)}
                  className="gap-1"
                >
                  <CalendarPlus className="h-4 w-4" />
                  Add
                </Button>
              )}
            </div>

            <ScrollArea className="flex-1">
              <div className="p-4 space-y-2">
                {loading ? (
                  <div className="text-center py-8 text-muted-foreground text-sm">
                    Loading...
                  </div>
                ) : entriesForSelectedDate.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground text-sm">
                    <CalendarIcon className="h-8 w-8 mx-auto mb-2 opacity-50" />
                    <p>No entries for this date</p>
                    {selectedDate && (
                      <Button
                        variant="link"
                        size="sm"
                        onClick={() => setShowQuickAdd(true)}
                        className="mt-2"
                      >
                        Add something
                      </Button>
                    )}
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
                          <span className="text-primary shrink-0">★</span>
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
