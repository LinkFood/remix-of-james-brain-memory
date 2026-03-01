/**
 * Calendar page — Month grid + timeline view of reminders and events.
 * Top: navigable month grid with event dots.
 * Bottom: Overdue, Today, This Week, Upcoming sections with action menus.
 */

import { useState, useMemo, useRef, useCallback } from 'react';
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
  MoreVertical,
  Eye,
  Check,
  Trash2,
} from 'lucide-react';
import { useCalendarEntries, type CalendarEntry, type CreateEventData } from '@/hooks/useCalendarEntries';
import { useEntryActions } from '@/hooks/useEntryActions';
import { cn } from '@/lib/utils';
import { CreateEventModal } from '@/components/calendar/CreateEventModal';
import EntryView from '@/components/EntryView';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useToast } from '@/hooks/use-toast';
import type { Entry } from '@/types';

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

      <div className="grid grid-cols-7 px-6 mb-1">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => (
          <div key={d} className="text-center text-[10px] text-white/30 font-medium py-1">
            {d}
          </div>
        ))}
      </div>

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

// --- Single calendar item row with action menu ---
function CalendarItem({
  entry,
  isOverdue,
  onView,
  onArchive,
  onDelete,
}: {
  entry: CalendarEntry;
  isOverdue?: boolean;
  onView: (entry: CalendarEntry) => void;
  onArchive: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const categoryStyle = CATEGORY_COLORS[entry.content_type] ?? 'bg-white/10 text-white/50';
  const formattedTime = formatEventTime(entry.event_time);

  return (
    <div
      className={cn(
        'group flex items-start gap-3 px-4 py-3 hover:bg-white/[0.04] transition-colors',
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

      {/* Content — clickable */}
      <button
        onClick={() => onView(entry)}
        className="flex-1 min-w-0 text-left"
      >
        <div className="text-sm text-white/90 truncate">
          {entry.title || entry.content.slice(0, 80) || 'Untitled'}
        </div>
        {entry.title && entry.content && entry.content !== entry.title && (
          <div className="text-xs text-white/40 truncate mt-0.5">
            {entry.content.slice(0, 120)}
          </div>
        )}
      </button>

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

        {/* Three-dot action menu */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              onClick={(e) => e.stopPropagation()}
              className="p-0.5 text-white/20 hover:text-white/60 transition-colors opacity-0 group-hover:opacity-100"
            >
              <MoreVertical className="w-3.5 h-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-36">
            <DropdownMenuItem onClick={() => onView(entry)}>
              <Eye className="w-3.5 h-3.5 mr-2" />
              View / Edit
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onArchive(entry.id)}>
              <Check className="w-3.5 h-3.5 mr-2" />
              Mark Done
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-red-400 focus:text-red-400"
              onClick={() => onDelete(entry.id)}
            >
              <Trash2 className="w-3.5 h-3.5 mr-2" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
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
  onView,
  onArchive,
  onDelete,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  entries: CalendarEntry[];
  headerClass?: string;
  countClass?: string;
  isOverdue?: boolean;
  emptyText?: string;
  sectionRef?: React.RefObject<HTMLDivElement | null>;
  onView: (entry: CalendarEntry) => void;
  onArchive: (id: string) => void;
  onDelete: (id: string) => void;
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
            <CalendarItem
              key={entry.id}
              entry={entry}
              isOverdue={isOverdue}
              onView={onView}
              onArchive={onArchive}
              onDelete={onDelete}
            />
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
  onView,
  onArchive,
  onDelete,
}: {
  date: Date;
  entries: CalendarEntry[];
  onClose: () => void;
  onAddEvent: () => void;
  onView: (entry: CalendarEntry) => void;
  onArchive: (id: string) => void;
  onDelete: (id: string) => void;
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
          <CalendarItem
            key={entry.id}
            entry={entry}
            isOverdue={isPast && !isToday(date)}
            onView={onView}
            onArchive={onArchive}
            onDelete={onDelete}
          />
        ))}
      </div>
    </div>
  );
}

// --- Main page ---
const Calendar = () => {
  const { overdue, today, thisWeek, upcoming, isLoading, error, createEvent } = useCalendarEntries();
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [createModalDate, setCreateModalDate] = useState<Date | null>(null);
  const [viewEntry, setViewEntry] = useState<Entry | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();

  const { toggleArchive, deleteEntry } = useEntryActions();

  const allEntries = useMemo(
    () => [...overdue, ...today, ...thisWeek, ...upcoming],
    [overdue, today, thisWeek, upcoming],
  );

  const totalCount = allEntries.length;

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

  const handleView = useCallback((entry: CalendarEntry) => {
    setViewEntry(entry as Entry);
  }, []);

  const handleArchive = useCallback((id: string) => {
    toggleArchive(id);
  }, [toggleArchive]);

  const handleDelete = useCallback((id: string) => {
    setDeleteId(id);
  }, []);

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
                onView={handleView}
                onArchive={handleArchive}
                onDelete={handleDelete}
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
                  onView={handleView}
                  onArchive={handleArchive}
                  onDelete={handleDelete}
                />
                <Section
                  title="Today"
                  icon={CalendarDays}
                  entries={today}
                  headerClass="text-amber-400"
                  countClass="bg-amber-500/20 text-amber-400"
                  emptyText="Nothing scheduled today"
                  onView={handleView}
                  onArchive={handleArchive}
                  onDelete={handleDelete}
                />
                <Section
                  title="This Week"
                  icon={CalendarDays}
                  entries={thisWeek}
                  headerClass="text-blue-400"
                  countClass="bg-blue-500/20 text-blue-400"
                  onView={handleView}
                  onArchive={handleArchive}
                  onDelete={handleDelete}
                />
                <Section
                  title="Upcoming"
                  icon={Clock}
                  entries={upcoming}
                  headerClass="text-emerald-400"
                  countClass="bg-emerald-500/20 text-emerald-400"
                  onView={handleView}
                  onArchive={handleArchive}
                  onDelete={handleDelete}
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

      {/* EntryView modal */}
      <EntryView
        entry={viewEntry}
        open={!!viewEntry}
        onClose={() => setViewEntry(null)}
        onUpdate={(updated) => setViewEntry(updated)}
        onDelete={() => setViewEntry(null)}
      />

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteId} onOpenChange={(open) => { if (!open) setDeleteId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this entry?</AlertDialogTitle>
            <AlertDialogDescription>
              This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              onClick={() => {
                if (deleteId) deleteEntry(deleteId);
                setDeleteId(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default Calendar;
