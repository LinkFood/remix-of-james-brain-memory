import { useState, useEffect, useMemo } from "react";
import { startOfDay, addDays, isToday, isPast, parseISO } from "date-fns";
import { supabase } from "@/integrations/supabase/client";

interface ReminderEntry {
  id: string;
  title: string | null;
  content: string;
  content_type: string;
  event_date: string;
  event_time: string | null;
  reminder_minutes: number | null;
  importance_score: number | null;
  starred: boolean;
}

interface UseUpcomingRemindersResult {
  todayReminders: ReminderEntry[];
  overdueReminders: ReminderEntry[];
  upcomingCount: number;
  loading: boolean;
  refresh: () => Promise<void>;
}

export function useUpcomingReminders(userId: string | undefined): UseUpcomingRemindersResult {
  const [entries, setEntries] = useState<ReminderEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchReminders = async () => {
    if (!userId) {
      setLoading(false);
      return;
    }

    try {
      const today = startOfDay(new Date());
      const nextWeek = addDays(today, 7);

      const { data, error } = await supabase
        .from("entries")
        .select("id, title, content, content_type, event_date, event_time, reminder_minutes, importance_score, starred")
        .eq("user_id", userId)
        .eq("archived", false)
        .not("event_date", "is", null)
        .lte("event_date", nextWeek.toISOString().split("T")[0])
        .order("event_date", { ascending: true })
        .order("event_time", { ascending: true, nullsFirst: false });

      if (error) throw error;

      setEntries(data || []);
    } catch (error) {
      console.error("Failed to fetch reminders:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchReminders();
  }, [userId]);

  // Memoized computed values
  const { todayReminders, overdueReminders, upcomingCount } = useMemo(() => {
    const today: ReminderEntry[] = [];
    const overdue: ReminderEntry[] = [];
    let upcoming = 0;

    const todayStr = new Date().toISOString().split("T")[0];

    entries.forEach((entry) => {
      const eventDate = entry.event_date;
      
      if (eventDate === todayStr) {
        today.push(entry);
        upcoming++;
      } else if (eventDate < todayStr) {
        overdue.push(entry);
      } else {
        upcoming++;
      }
    });

    return {
      todayReminders: today,
      overdueReminders: overdue,
      upcomingCount: upcoming,
    };
  }, [entries]);

  return {
    todayReminders,
    overdueReminders,
    upcomingCount,
    loading,
    refresh: fetchReminders,
  };
}
