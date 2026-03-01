/**
 * Calendar page — Timeline view of reminders and events.
 * Sections: Overdue, Today, This Week, Upcoming.
 */

import { format, parseISO } from 'date-fns';
import {
  AlertTriangle,
  CalendarDays,
  Clock,
  Repeat,
  Loader2,
  CalendarCheck,
} from 'lucide-react';
import { useCalendarEntries, type CalendarEntry } from '@/hooks/useCalendarEntries';
import { cn } from '@/lib/utils';

// --- Category badge colors (matches existing codebase patterns) ---
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
    // event_time is HH:mm:ss or HH:mm
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
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  entries: CalendarEntry[];
  headerClass?: string;
  countClass?: string;
  isOverdue?: boolean;
  emptyText?: string;
}) {
  if (entries.length === 0 && !emptyText) return null;

  return (
    <div className="mb-1">
      {/* Section header */}
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

      {/* Items */}
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

// --- Main page ---
const Calendar = () => {
  const { overdue, today, thisWeek, upcoming, isLoading, error } = useCalendarEntries();

  const totalCount = overdue.length + today.length + thisWeek.length + upcoming.length;

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-black">
      {/* Page header */}
      <div className="px-6 py-4 border-b border-white/10 flex items-center justify-between">
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

      {/* Content */}
      <div className="max-w-3xl mx-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-5 h-5 text-white/30 animate-spin" />
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center py-20 gap-2">
            <AlertTriangle className="w-5 h-5 text-red-400" />
            <span className="text-sm text-red-400">{error}</span>
          </div>
        ) : totalCount === 0 ? (
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
  );
};

export default Calendar;
