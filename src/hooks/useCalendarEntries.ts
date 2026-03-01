/**
 * useCalendarEntries — Fetches entries with event_date and groups them
 * into overdue, today, this week, and upcoming buckets.
 * Realtime subscription for live updates.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { startOfDay, addDays, format } from 'date-fns';
import type { RealtimeChannel } from '@supabase/supabase-js';

export interface CalendarEntry {
  id: string;
  title: string | null;
  content: string;
  content_type: string;
  event_date: string;
  event_time: string | null;
  reminder_minutes: number | null;
  is_recurring: boolean | null;
  recurrence_pattern: string | null;
  created_at: string;
}

export interface UseCalendarEntriesResult {
  overdue: CalendarEntry[];
  today: CalendarEntry[];
  thisWeek: CalendarEntry[];
  upcoming: CalendarEntry[];
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useCalendarEntries(): UseCalendarEntriesResult {
  const [userId, setUserId] = useState<string>('');
  const [entries, setEntries] = useState<CalendarEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Get user ID
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) setUserId(session.user.id);
    });
  }, []);

  const fetchEntries = useCallback(async () => {
    if (!userId) return;

    try {
      setError(null);
      const { data, error: fetchError } = await supabase
        .from('entries')
        .select(
          'id, title, content, content_type, event_date, event_time, reminder_minutes, is_recurring, recurrence_pattern, created_at'
        )
        .eq('user_id', userId)
        .eq('archived', false)
        .not('event_date', 'is', null)
        .order('event_date', { ascending: true })
        .order('event_time', { ascending: true, nullsFirst: false });

      if (fetchError) throw fetchError;
      setEntries((data as CalendarEntry[]) || []);
    } catch (err) {
      // Suppress error toasts on passive load — show empty state instead
      console.warn('[useCalendarEntries] Fetch failed (showing empty state):', err);
      setEntries([]);
    } finally {
      setIsLoading(false);
    }
  }, [userId]);

  // Initial fetch
  useEffect(() => {
    if (userId) fetchEntries();
  }, [userId, fetchEntries]);

  // Realtime subscription
  useEffect(() => {
    if (!userId) return;

    const channel: RealtimeChannel = supabase
      .channel(`calendar-entries-${userId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'entries',
          filter: `user_id=eq.${userId}`,
        },
        () => {
          // Refetch on any entry change
          fetchEntries();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId, fetchEntries]);

  // Group entries into buckets
  const { overdue, today, thisWeek, upcoming } = useMemo(() => {
    const now = new Date();
    const todayStr = format(startOfDay(now), 'yyyy-MM-dd');
    const endOfWeekStr = format(addDays(startOfDay(now), 7), 'yyyy-MM-dd');

    const overdueArr: CalendarEntry[] = [];
    const todayArr: CalendarEntry[] = [];
    const thisWeekArr: CalendarEntry[] = [];
    const upcomingArr: CalendarEntry[] = [];

    for (const entry of entries) {
      const d = entry.event_date;
      if (d < todayStr) {
        overdueArr.push(entry);
      } else if (d === todayStr) {
        todayArr.push(entry);
      } else if (d <= endOfWeekStr) {
        thisWeekArr.push(entry);
      } else {
        upcomingArr.push(entry);
      }
    }

    return {
      overdue: overdueArr,
      today: todayArr,
      thisWeek: thisWeekArr,
      upcoming: upcomingArr,
    };
  }, [entries]);

  return { overdue, today, thisWeek, upcoming, isLoading, error, refresh: fetchEntries };
}
