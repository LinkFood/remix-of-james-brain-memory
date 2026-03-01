/**
 * Calendar page — Month grid + timeline view of reminders and events.
 * Top: navigable month grid with event dots.
 * Bottom: Overdue, Today, This Week, Upcoming sections.
 */

import { useState, useMemo, useRef } from 'react';
import {
  format, parseISO, startOfMonth, endOfMonth, startOfWeek, endOfWeek,
  addMonths, subMonths, eachDayOfInterval, isSameMonth, isSameDay, isToday,
} from 'date-fns';
import {
  AlertTriangle,
  CalendarDays,
  Clock,
  Repeat,
  Loader2,
  CalendarCheck,
  ChevronLeft,
  ChevronRight,
  Plus,
} from 'lucide-react';
import { useCalendarEntries, type CalendarEntry, type CreateEventData } from '@/hooks/useCalendarEntries';
import { cn } from '@/lib/utils';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { useToast } from '@/hooks/use-toast';

// --- Category badge colors ---
const CATEGORY_COLORS: Record<string, string> = {
  reminder: 'bg-amber-500/20 text-amber-400',
  event: 'bg-blue-500/20 text-blue-400',
  note: 'bg-white/10 text-white/50',
  idea: 'bg-purple-500/20 text-purple-400',
  link: 'bg-cyan-500/20 text-cyan-400',
  code: 'bg-indigo-500/20 text-indigo-400',
  contact: 'bg-emerald-500/20 text-emerald-400',
  list: 'bg-orange-500/20 text-orange-400',
  document: 'bg-rose-500/20 text-rose-400',
  image: 'bg-pink-500/20 text-pink-400',
};

const DOT_COLORS: Record<string, string> = {
  reminder: 'bg-amber-400',
  event: 'bg-blue-400',
  default: 'bg-white/40',
};

function formatEventDate(dateStr: string): string {
  try {
    return format(parseISO(dateStr), 'EEE, MMM d');
  } catch {
    return dateStr;
  }
}

function formatEventTime(timeStr: string | null): string | null {
  if (!timeStr) return null;
  try {
    const [h, m] = timeStr.split(':');
    const hour = parseInt(h, 10);
    const minute = m || '00';
    const ampm = hour >= 12 ? 'PM' : 'AM';
    const h12 = hour % 12 || 12;
    return `${h12}:${minute} ${ampm}`;
  } catch {
    return timeStr;
  }
}

// --- Month Grid ---
function MonthGrid({
  allEntries,
  selectedDate,
  onSelectDate,
  onCreateEvent,
}: {
  allEntries: CalendarEntry[];
  selectedDate: Date | null;
  onSelectDate: (date: Date) => void;
  onCreateEvent: (date: Date) => void;
}) {
  const [currentMonth, setCurrentMonth] = useState(new Date());

  // Build a map of date string -> entry count + types
  const dateMap = useMemo(() => {
    const map: Record<string, { count: number; types: Set<string> }> = {};
    for (const entry of allEntries) {
      if (!map[entry.event_date]) {
        map[entry.event_date] = { count: 0, types: new Set() };
      }
      map[entry.event_date].count++;
      map[entry.event_date].types.add(entry.content_type);
    }
    return map;
  }, [allEntries]);

  const monthStart = startOfMonth(currentMonth);
  const monthEnd = endOfMonth(currentMonth);
  const calStart = startOfWeek(monthStart, { weekStartsOn: 0 });
  const calEnd = endOfWeek(monthEnd, { weekStartsOn: 0 });
  const days = eachDayOfInterval({ start: calStart, end: calEnd });

  return (
    <div className="border-b border-white/10 pb-4">
      {/* Month navigation */}
      <div className="flex items-center justify-between px-6 py-3">
        <button
          onClick={() => setCurrentMonth(prev => subMonths(prev, 1))}
          className="p-1 rounded hover:bg-white/10 text-white/50 hover:text-white/80 transition-colors"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <span className="text-sm font-medium text-white/80">
          {format(currentMonth, 'MMMM yyyy')}
        </span>
        <button
          onClick={() => setCurrentMonth(prev => addMonths(prev, 1))}
          className="p-1 rounded hover:bg-white/10 text-white/50 hover:text-white/80 transition-colors"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>

      {/* Day headers */}
      <div className="grid grid-cols-7 px-6 mb-1">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => (
          <div key={d} className="text-center text-[10px] text-white/30 font-medium py-1">
            {d}
          </div>
        ))}
      </div>

      {/* Day cells */}
      <div className="grid grid-cols-7 px-6 gap-y-0.5">
        {days.map(day => {
          const dateStr = format(day, 'yyyy-MM-dd');
          const info = dateMap[dateStr];
          const inMonth = isSameMonth(day, currentMonth);
          const today = isToday(day);
          const isSelected = selectedDate && isSameDay(day, selectedDate);
          const isPast = day < new Date() && !today;
          const hasOverdue = isPast && info && info.count > 0;

          return (
            <button
              key={dateStr}
              onClick={() => {
                if (!inMonth) return;
                if (info) {
                  onSelectDate(day);
                } else {
                  onCreateEvent(day);
                }
              }}
              className={cn(
                'relative flex flex-col items-center py-1.5 rounded-md transition-colors',
                inMonth ? 'text-white/70 cursor-pointer hover:bg-white/[0.06]' : 'text-white/15 cursor-default',
                isSelected && 'bg-blue-500/20 ring-1 ring-blue-500/40',
                today && !isSelected && 'bg-white/[0.05]',
              )}
            >
              <span
                className={cn(
                  'text-xs font-mono',
                  today && 'text-blue-400 font-bold',
                  hasOverdue && 'text-red-400',
                )}
              >
                {format(day, 'd')}
              </span>
              {/* Event dots */}
              {info && (
                <div className="flex items-center gap-0.5 mt-0.5">
                  {info.count <= 3 ? (
                    Array.from({ length: info.count }).map((_, i) => {
                      const type = [...info.types][i % info.types.size];
                      return (
                        <span
                          key={i}
                          className={cn(
                            'w-1 h-1 rounded-full',
                            hasOverdue ? 'bg-red-400' : (DOT_COLORS[type] || DOT_COLORS.default),
                          )}
                        />
                      );
                    })
                  ) : (
                    <span className="text-[8px] text-white/40 font-mono">{info.count}</span>
                  )}
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// --- Single calendar item row ---
function CalendarItem({ entry, isOverdue }: { entry: CalendarEntry; isOverdue?: boolean }) {
  const categoryStyle = CATEGORY_COLORS[entry.content_type] ?? 'bg-white/10 text-white/50';
  const formattedTime = formatEventTime(entry.event_time);

  return (
    <div
      className={cn(
        'flex items-start gap-3 px-4 py-3 hover:bg-white/[0.04] transition-colors',
        isOverdue && 'border-l-2 border-red-500'
      )}
    >
      {/* Date + time column */}
      <div className="shrink-0 w-20 text-right">
        <div className={cn('text-xs font-medium', isOverdue ? 'text-red-400' : 'text-white/60')}>
          {formatEventDate(entry.event_date)}
        </div>
        {formattedTime && (
          <div className="text-[10px] text-white/30 flex items-center justify-end gap-0.5 mt-0.5">
            <Clock className="w-2.5 h-2.5" />
            {formattedTime}
          </div>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="text-sm text-white/90 truncate">
          {entry.title || entry.content.slice(0, 80) || 'Untitled'}
        </div>
        {entry.title && entry.content && entry.content !== entry.title && (
          <div className="text-xs text-white/40 truncate mt-0.5">
            {entry.content.slice(0, 120)}
          </div>
        )}
      </div>

      {/* Badges */}
      <div className="flex items-center gap-1.5 shrink-0">
        {entry.is_recurring && (
          <span className="text-[9px] px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-400 font-medium flex items-center gap-0.5">
            <Repeat className="w-2.5 h-2.5" />
            {entry.recurrence_pattern || 'recurring'}
          </span>
        )}
        <span
          className={cn(
            'text-[9px] px-1.5 py-0.5 rounded font-medium uppercase tracking-wide',
            categoryStyle
          )}
        >
          {entry.content_type}
        </span>
      </div>
    </div>
  );
}

// --- Section with header ---
function Section({
  title,
  icon: Icon,
  entries,
  headerClass,
  countClass,
  isOverdue,
  emptyText,
  sectionRef,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  entries: CalendarEntry[];
  headerClass?: string;
  countClass?: string;
  isOverdue?: boolean;
  emptyText?: string;
  sectionRef?: React.RefObject<HTMLDivElement | null>;
}) {
  if (entries.length === 0 && !emptyText) return null;

  return (
    <div className="mb-1" ref={sectionRef}>
      <div className="flex items-center gap-2 px-4 py-2 sticky top-0 z-10 bg-black/80 backdrop-blur-sm border-b border-white/5">
        <Icon className={cn('w-3.5 h-3.5', headerClass || 'text-white/50')} />
        <span className={cn('text-xs font-semibold uppercase tracking-wider', headerClass || 'text-white/50')}>
          {title}
        </span>
        {entries.length > 0 && (
          <span
            className={cn(
              'text-[10px] px-1.5 py-0.5 rounded font-medium ml-auto',
              countClass || 'bg-white/10 text-white/40'
            )}
          >
            {entries.length}
          </span>
        )}
      </div>

      {entries.length === 0 ? (
        <div className="px-4 py-4 text-xs text-white/30 text-center">
          {emptyText}
        </div>
      ) : (
        <div className="divide-y divide-white/5">
          {entries.map((entry) => (
            <CalendarItem key={entry.id} entry={entry} isOverdue={isOverdue} />
          ))}
        </div>
      )}
    </div>
  );
}

// --- Selected day detail ---
function DayDetail({
  date,
  entries,
  onClose,
  onAddEvent,
}: {
  date: Date;
  entries: CalendarEntry[];
  onClose: () => void;
  onAddEvent: () => void;
}) {
  const isPast = date < new Date() && !isToday(date);

  return (
    <div className="border-b border-white/10 bg-white/[0.02]">
      <div className="flex items-center justify-between px-4 py-2">
        <div className="flex items-center gap-2">
          <CalendarDays className={cn('w-3.5 h-3.5', isPast ? 'text-red-400' : 'text-blue-400')} />
          <span className={cn('text-xs font-semibold', isPast ? 'text-red-400' : 'text-blue-400')}>
            {format(date, 'EEEE, MMMM d')}
          </span>
          <span className="text-[10px] text-white/30">
            {entries.length} item{entries.length !== 1 ? 's' : ''}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={onAddEvent}
            className="text-[10px] text-white/30 hover:text-white/60 px-2 py-1 rounded hover:bg-white/10 transition-colors flex items-center gap-1"
          >
            <Plus className="w-3 h-3" />
            add
          </button>
          <button
            onClick={onClose}
            className="text-[10px] text-white/30 hover:text-white/60 px-2 py-1 rounded hover:bg-white/10 transition-colors"
          >
            close
          </button>
        </div>
      </div>
      <div className="divide-y divide-white/5">
        {entries.map((entry) => (
          <CalendarItem key={entry.id} entry={entry} isOverdue={isPast && !isToday(date)} />
        ))}
      </div>
    </div>
  );
}

// --- Create Event Modal ---
function CreateEventModal({
  open,
  onOpenChange,
  defaultDate,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultDate: Date | null;
  onSubmit: (data: CreateEventData) => Promise<void>;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [type, setType] = useState<'event' | 'reminder'>('event');
  const [reminderMinutes, setReminderMinutes] = useState(30);
  const [isRecurring, setIsRecurring] = useState(false);
  const [recurrencePattern, setRecurrencePattern] = useState('weekly');
  const [submitting, setSubmitting] = useState(false);

  // Reset form when modal opens with a new date
  const dateStr = defaultDate ? format(defaultDate, 'yyyy-MM-dd') : '';
  useMemo(() => {
    if (open) {
      setTitle('');
      setDescription('');
      setDate(dateStr);
      setTime('');
      setType('event');
      setReminderMinutes(30);
      setIsRecurring(false);
      setRecurrencePattern('weekly');
    }
  }, [open, dateStr]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !date) return;
    setSubmitting(true);
    try {
      await onSubmit({
        title: title.trim(),
        description: description.trim() || undefined,
        date,
        time: time || undefined,
        type,
        reminderMinutes: type === 'reminder' ? reminderMinutes : undefined,
        isRecurring,
        recurrencePattern: isRecurring ? recurrencePattern : undefined,
      });
      onOpenChange(false);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-zinc-900 border-white/10 text-white max-w-md">
        <DialogHeader>
          <DialogTitle className="text-white">New event</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Title */}
          <div>
            <label className="text-xs text-white/50 mb-1 block">Title *</label>
            <Input
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="What's happening?"
              className="bg-white/5 border-white/10 text-white placeholder:text-white/30"
              autoFocus
              required
            />
          </div>

          {/* Description */}
          <div>
            <label className="text-xs text-white/50 mb-1 block">Description</label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Optional details..."
              rows={2}
              className="w-full rounded-md bg-white/5 border border-white/10 text-white placeholder:text-white/30 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500/40"
            />
          </div>

          {/* Date + Time row */}
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="text-xs text-white/50 mb-1 block">Date *</label>
              <Input
                type="date"
                value={date}
                onChange={e => setDate(e.target.value)}
                className="bg-white/5 border-white/10 text-white"
                required
              />
            </div>
            <div className="flex-1">
              <label className="text-xs text-white/50 mb-1 block">Time</label>
              <Input
                type="time"
                value={time}
                onChange={e => setTime(e.target.value)}
                className="bg-white/5 border-white/10 text-white"
              />
            </div>
          </div>

          {/* Type toggle */}
          <div>
            <label className="text-xs text-white/50 mb-1 block">Type</label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setType('event')}
                className={cn(
                  'flex-1 text-xs py-2 rounded-md border transition-colors',
                  type === 'event'
                    ? 'bg-blue-500/20 border-blue-500/40 text-blue-400'
                    : 'bg-white/5 border-white/10 text-white/50 hover:text-white/70',
                )}
              >
                Event
              </button>
              <button
                type="button"
                onClick={() => setType('reminder')}
                className={cn(
                  'flex-1 text-xs py-2 rounded-md border transition-colors',
                  type === 'reminder'
                    ? 'bg-amber-500/20 border-amber-500/40 text-amber-400'
                    : 'bg-white/5 border-white/10 text-white/50 hover:text-white/70',
                )}
              >
                Reminder
              </button>
            </div>
          </div>

          {/* Reminder minutes (only for reminders) */}
          {type === 'reminder' && (
            <div>
              <label className="text-xs text-white/50 mb-1 block">Remind me (minutes before)</label>
              <Input
                type="number"
                value={reminderMinutes}
                onChange={e => setReminderMinutes(parseInt(e.target.value, 10) || 0)}
                min={0}
                className="bg-white/5 border-white/10 text-white w-32"
              />
            </div>
          )}

          {/* Recurring */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Checkbox
                id="recurring"
                checked={isRecurring}
                onCheckedChange={(checked) => setIsRecurring(checked === true)}
                className="border-white/20 data-[state=checked]:bg-blue-500 data-[state=checked]:border-blue-500"
              />
              <label htmlFor="recurring" className="text-xs text-white/60 cursor-pointer">
                Recurring
              </label>
            </div>
            {isRecurring && (
              <div className="flex gap-2 pl-6">
                {['daily', 'weekly', 'monthly', 'yearly'].map(p => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setRecurrencePattern(p)}
                    className={cn(
                      'text-[10px] px-2 py-1 rounded border transition-colors capitalize',
                      recurrencePattern === p
                        ? 'bg-violet-500/20 border-violet-500/40 text-violet-400'
                        : 'bg-white/5 border-white/10 text-white/40 hover:text-white/60',
                    )}
                  >
                    {p}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Submit */}
          <div className="flex justify-end pt-2">
            <Button
              type="submit"
              disabled={!title.trim() || !date || submitting}
              className="bg-blue-600 hover:bg-blue-700 text-white text-xs px-4"
            >
              {submitting ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Plus className="w-3 h-3 mr-1" />}
              Create
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// --- Main page ---
const Calendar = () => {
  const { overdue, today, thisWeek, upcoming, isLoading, error, createEvent, userId } = useCalendarEntries();
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [createModalDate, setCreateModalDate] = useState<Date | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();

  const allEntries = useMemo(
    () => [...overdue, ...today, ...thisWeek, ...upcoming],
    [overdue, today, thisWeek, upcoming],
  );

  const totalCount = allEntries.length;

  // Entries for the selected date
  const selectedDateEntries = useMemo(() => {
    if (!selectedDate) return [];
    const dateStr = format(selectedDate, 'yyyy-MM-dd');
    return allEntries.filter(e => e.event_date === dateStr);
  }, [selectedDate, allEntries]);

  const handleSelectDate = (date: Date) => {
    setSelectedDate(prev => prev && isSameDay(prev, date) ? null : date);
  };

  const handleCreateEvent = async (data: CreateEventData) => {
    await createEvent(data);
    toast({ title: 'Event created', description: data.title });
  };

  return (
    <div className="h-[calc(100vh-3.5rem)] bg-black flex flex-col overflow-hidden">
      {/* Page header */}
      <div className="px-6 py-3 border-b border-white/10 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <CalendarDays className="w-5 h-5 text-white/70" />
          <h1 className="text-lg font-semibold text-white">Calendar</h1>
        </div>
        {!isLoading && (
          <span className="text-xs text-white/40">
            {totalCount} event{totalCount !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center flex-1">
          <Loader2 className="w-5 h-5 text-white/30 animate-spin" />
        </div>
      ) : error ? (
        <div className="flex flex-col items-center justify-center flex-1 gap-2">
          <AlertTriangle className="w-5 h-5 text-red-400" />
          <span className="text-sm text-red-400">{error}</span>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto" ref={timelineRef}>
          <div className="max-w-3xl mx-auto">
            {/* Month grid */}
            <MonthGrid
              allEntries={allEntries}
              selectedDate={selectedDate}
              onSelectDate={handleSelectDate}
              onCreateEvent={(date) => setCreateModalDate(date)}
            />

            {/* Selected day detail */}
            {selectedDate && selectedDateEntries.length > 0 && (
              <DayDetail
                date={selectedDate}
                entries={selectedDateEntries}
                onClose={() => setSelectedDate(null)}
                onAddEvent={() => setCreateModalDate(selectedDate)}
              />
            )}

            {/* Timeline sections */}
            {totalCount === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 gap-2 text-white/30">
                <CalendarCheck className="w-8 h-8" />
                <span className="text-sm">No upcoming events or reminders</span>
              </div>
            ) : (
              <>
                <Section
                  title="Overdue"
                  icon={AlertTriangle}
                  entries={overdue}
                  headerClass="text-red-400"
                  countClass="bg-red-500/20 text-red-400"
                  isOverdue
                />
                <Section
                  title="Today"
                  icon={CalendarDays}
                  entries={today}
                  headerClass="text-amber-400"
                  countClass="bg-amber-500/20 text-amber-400"
                  emptyText="Nothing scheduled today"
                />
                <Section
                  title="This Week"
                  icon={CalendarDays}
                  entries={thisWeek}
                  headerClass="text-blue-400"
                  countClass="bg-blue-500/20 text-blue-400"
                />
                <Section
                  title="Upcoming"
                  icon={Clock}
                  entries={upcoming}
                  headerClass="text-emerald-400"
                  countClass="bg-emerald-500/20 text-emerald-400"
                />
              </>
            )}
          </div>
        </div>
      )}

      {/* Create event modal */}
      <CreateEventModal
        open={createModalDate !== null}
        onOpenChange={(open) => { if (!open) setCreateModalDate(null); }}
        defaultDate={createModalDate}
        onSubmit={handleCreateEvent}
      />
    </div>
  );
};

export default Calendar;
