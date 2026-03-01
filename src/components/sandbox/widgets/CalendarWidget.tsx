/**
 * CalendarWidget — Compact month grid + upcoming items for the dashboard.
 */

import { useState, useEffect, useMemo } from 'react';
import {
  format, startOfMonth, endOfMonth, startOfWeek, endOfWeek,
  addMonths, subMonths, eachDayOfInterval, isSameMonth, isSameDay, isToday,
} from 'date-fns';
import { ChevronLeft, ChevronRight, CalendarCheck } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { cn } from '@/lib/utils';
import type { WidgetProps } from '@/types/widget';

interface CalEntry {
  id: string;
  title: string | null;
  content: string;
  content_type: string;
  event_date: string;
  event_time: string | null;
}

const DOT_COLORS: Record<string, string> = {
  reminder: 'bg-amber-400',
  event: 'bg-blue-400',
  default: 'bg-white/40',
};

export default function CalendarWidget({ compact, onNavigate }: WidgetProps) {
  const [userId, setUserId] = useState('');
  const [entries, setEntries] = useState<CalEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) setUserId(session.user.id);
    });
  }, []);

  useEffect(() => {
    if (!userId) return;
    supabase
      .from('entries')
      .select('id, title, content, content_type, event_date, event_time')
      .eq('user_id', userId)
      .eq('archived', false)
      .not('event_date', 'is', null)
      .order('event_date', { ascending: true })
      .limit(200)
      .then(({ data }) => {
        if (data) setEntries(data as CalEntry[]);
        setLoading(false);
      });
  }, [userId]);

  // Date -> entry info map
  const dateMap = useMemo(() => {
    const map: Record<string, { count: number; types: Set<string> }> = {};
    for (const e of entries) {
      if (!map[e.event_date]) map[e.event_date] = { count: 0, types: new Set() };
      map[e.event_date].count++;
      map[e.event_date].types.add(e.content_type);
    }
    return map;
  }, [entries]);

  // Selected day entries
  const dayEntries = useMemo(() => {
    if (!selectedDate) return [];
    const dateStr = format(selectedDate, 'yyyy-MM-dd');
    return entries.filter(e => e.event_date === dateStr);
  }, [selectedDate, entries]);

  const monthStart = startOfMonth(currentMonth);
  const monthEnd = endOfMonth(currentMonth);
  const calStart = startOfWeek(monthStart, { weekStartsOn: 0 });
  const calEnd = endOfWeek(monthEnd, { weekStartsOn: 0 });
  const days = eachDayOfInterval({ start: calStart, end: calEnd });

  const todayStr = format(new Date(), 'yyyy-MM-dd');

  return (
    <div className="flex flex-col h-full bg-white/[0.03] backdrop-blur-sm border border-white/10 rounded-lg overflow-hidden">
      {/* Header with month nav */}
      <div className="px-3 py-1.5 border-b border-white/10 shrink-0 flex items-center justify-between">
        <button
          onClick={() => setCurrentMonth(prev => subMonths(prev, 1))}
          className="p-0.5 rounded hover:bg-white/10 text-white/40 hover:text-white/70 transition-colors"
        >
          <ChevronLeft className="w-3 h-3" />
        </button>
        <button
          onClick={() => onNavigate('/calendar')}
          className="text-xs font-medium text-white/70 hover:text-white/90 transition-colors"
        >
          {format(currentMonth, 'MMM yyyy')}
        </button>
        <button
          onClick={() => setCurrentMonth(prev => addMonths(prev, 1))}
          className="p-0.5 rounded hover:bg-white/10 text-white/40 hover:text-white/70 transition-colors"
        >
          <ChevronRight className="w-3 h-3" />
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center flex-1">
          <span className="text-[10px] text-white/30">Loading...</span>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {/* Day headers */}
          <div className="grid grid-cols-7 px-2 pt-1">
            {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
              <div key={i} className="text-center text-[8px] text-white/25 font-medium">
                {d}
              </div>
            ))}
          </div>

          {/* Day cells */}
          <div className="grid grid-cols-7 px-2 gap-y-0">
            {days.map(day => {
              const dateStr = format(day, 'yyyy-MM-dd');
              const info = dateMap[dateStr];
              const inMonth = isSameMonth(day, currentMonth);
              const today_ = isToday(day);
              const isSelected = selectedDate && isSameDay(day, selectedDate);
              const isPast = dateStr < todayStr;
              const hasOverdue = isPast && info && info.count > 0;

              return (
                <button
                  key={dateStr}
                  onClick={() => {
                    if (info) setSelectedDate(prev => prev && isSameDay(prev, day) ? null : day);
                  }}
                  className={cn(
                    'relative flex flex-col items-center py-0.5 rounded transition-colors',
                    inMonth ? 'text-white/60' : 'text-white/10',
                    info && 'cursor-pointer hover:bg-white/[0.06]',
                    !info && 'cursor-default',
                    isSelected && 'bg-blue-500/20',
                    today_ && !isSelected && 'bg-white/[0.04]',
                  )}
                >
                  <span
                    className={cn(
                      'text-[10px] font-mono leading-tight',
                      today_ && 'text-blue-400 font-bold',
                      hasOverdue && 'text-red-400',
                    )}
                  >
                    {format(day, 'd')}
                  </span>
                  {info && (
                    <div className="flex items-center gap-px">
                      {info.count <= 3 ? (
                        Array.from({ length: info.count }).map((_, i) => {
                          const type = [...info.types][i % info.types.size];
                          return (
                            <span
                              key={i}
                              className={cn(
                                'w-0.5 h-0.5 rounded-full',
                                hasOverdue ? 'bg-red-400' : (DOT_COLORS[type] || DOT_COLORS.default),
                              )}
                            />
                          );
                        })
                      ) : (
                        <span className="text-[7px] text-white/30">{info.count}</span>
                      )}
                    </div>
                  )}
                </button>
              );
            })}
          </div>

          {/* Selected day detail */}
          {selectedDate && dayEntries.length > 0 && (
            <div className="border-t border-white/10 mt-1">
              <div className="px-2 py-1 text-[10px] text-white/40 font-medium">
                {format(selectedDate, 'EEE, MMM d')}
              </div>
              <div className="divide-y divide-white/5">
                {dayEntries.slice(0, compact ? 3 : 6).map(e => (
                  <button
                    key={e.id}
                    onClick={() => onNavigate('/calendar')}
                    className="w-full text-left px-2 py-1.5 hover:bg-white/[0.04] transition-colors flex items-center gap-1.5"
                  >
                    <span className="text-xs text-white/70 truncate flex-1">
                      {e.title || e.content.slice(0, 50)}
                    </span>
                    {e.event_time && (
                      <span className="text-[9px] text-white/30 shrink-0">
                        {e.event_time.slice(0, 5)}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Empty state if no entries at all */}
          {entries.length === 0 && (
            <div className="flex flex-col items-center justify-center py-4 gap-1 text-white/20">
              <CalendarCheck className="w-5 h-5" />
              <span className="text-[10px]">No events</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
