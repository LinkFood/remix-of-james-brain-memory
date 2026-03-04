/**
 * useCalendarEntries — Fetches entries with event_date and groups them
 * into overdue, today, this week, and upcoming buckets.
 * Realtime subscription for live updates.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { startOfDay, addDays, format } from 'date-fns';
import type { RealtimeChannel } from '@supabase/supabase-js';
import type { Entry } from '@/types';
import { parseListItems } from '@/lib/parseListItems';

export interface CalendarEntry extends Entry {
  event_date: string; // override optional to required — calendar entries always have event_date
}

export interface CreateEventData {
  title: string;
  description?: string;
  date: string; // YYYY-MM-DD
  time?: string; // HH:MM
  type: 'event' | 'reminder';
  reminderMinutes?: number;
  isRecurring?: boolean;
  recurrencePattern?: string;
}

export interface UseCalendarEntriesResult {
  overdue: CalendarEntry[];
  today: CalendarEntry[];
  thisWeek: CalendarEntry[];
  upcoming: CalendarEntry[];
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  createEvent: (data: CreateEventData) => Promise<void>;
  userId: string;
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
        .select('*')
        .eq('user_id', userId)
        .eq('archived', false)
        .not('event_date', 'is', null)
        .in('content_type', ['reminder', 'event'])
        .order('event_date', { ascending: true })
        .order('event_time', { ascending: true, nullsFirst: false });

      if (fetchError) throw fetchError;
      const parsed = (data || []).map((d: any) => ({
        ...d,
        tags: d.tags || [],
        extracted_data: (d.extracted_data as Record<string, unknown>) || {},
        list_items: parseListItems(d.list_items),
      })) as CalendarEntry[];
      setEntries(parsed);
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

  const createEvent = useCallback(async (data: CreateEventData) => {
    if (!userId) throw new Error('Not authenticated');
    const { error } = await supabase.from('entries').insert({
      user_id: userId,
      title: data.title,
      content: data.description || data.title,
      content_type: data.type,
      event_date: data.date,
      event_time: data.time || null,
      reminder_minutes: data.reminderMinutes || null,
      is_recurring: data.isRecurring || false,
      recurrence_pattern: data.recurrencePattern || null,
    });
    if (error) throw error;
    // Realtime subscription handles refresh automatically
  }, [userId]);

  return { overdue, today, thisWeek, upcoming, isLoading, error, refresh: fetchEntries, createEvent, userId };
}
