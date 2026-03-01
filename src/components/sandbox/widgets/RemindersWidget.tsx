/**
 * RemindersWidget — Today and overdue reminders.
 */

import { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';
import { useDashboardActivity } from '@/hooks/useDashboardActivity';
import { CheckCircle } from 'lucide-react';
import type { WidgetProps } from '@/types/widget';

interface ReminderEntry {
  id: string;
  title: string | null;
  content: string | null;
  event_date: string | null;
  content_type: string;
}

function dateLabel(eventDate: string): { label: string; className: string } {
  const todayStr = new Date().toISOString().split('T')[0];
  if (eventDate < todayStr) return { label: 'Overdue', className: 'text-red-400' };
  if (eventDate === todayStr) return { label: 'Today', className: 'text-amber-400' };
  return { label: 'Upcoming', className: 'text-emerald-400' };
}

export default function RemindersWidget({ onNavigate }: WidgetProps) {
  const [userId, setUserId] = useState('');
  const [reminderEntries, setReminderEntries] = useState<ReminderEntry[]>([]);
  const [loadingEntries, setLoadingEntries] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) setUserId(session.user.id);
    });
  }, []);

  const { reminders, loading: activityLoading } = useDashboardActivity(userId);

  useEffect(() => {
    if (!userId) return;
    const todayStr = new Date().toISOString().split('T')[0];
    supabase
      .from('entries')
      .select('id, title, content, event_date, content_type')
      .eq('user_id', userId)
      .eq('archived', false)
      .lte('event_date', todayStr)
      .in('content_type', ['reminder', 'event'])
      .order('event_date', { ascending: true })
      .limit(10)
      .then(({ data }) => {
        if (data) setReminderEntries(data as ReminderEntry[]);
        setLoadingEntries(false);
      });
  }, [userId]);

  const loading = activityLoading || loadingEntries;
  const allClear = !loading && reminders.overdueCount === 0 && reminders.todayCount === 0;

  return (
    <div className="flex flex-col h-full bg-white/[0.03] backdrop-blur-sm border border-white/10 rounded-lg overflow-hidden">
      <div className="px-3 py-2 border-b border-white/10 shrink-0 flex items-center gap-2">
        <span className="text-xs font-medium text-white/70">Reminders</span>
        {!loading && reminders.overdueCount > 0 && (
          <span className="text-[9px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-400 font-medium">
            {reminders.overdueCount} overdue
          </span>
        )}
        {!loading && reminders.todayCount > 0 && (
          <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 font-medium">
            {reminders.todayCount} today
          </span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center h-16">
            <span className="text-[10px] text-white/30">Loading...</span>
          </div>
        ) : allClear ? (
          <div className="flex flex-col items-center justify-center h-full gap-1.5 text-emerald-400/60">
            <CheckCircle className="w-5 h-5" />
            <span className="text-[10px]">All clear</span>
          </div>
        ) : (
          <div className="divide-y divide-white/5">
            {reminderEntries.map(entry => {
              const { label, className } = entry.event_date
                ? dateLabel(entry.event_date)
                : { label: '', className: '' };
              return (
                <button
                  key={entry.id}
                  onClick={() => onNavigate('/dashboard')}
                  className="w-full flex items-center gap-2 px-3 py-2 hover:bg-white/[0.04] transition-colors text-left"
                >
                  <span
                    className={cn(
                      'text-[9px] font-medium shrink-0 w-12',
                      className
                    )}
                  >
                    {label}
                  </span>
                  <span className="text-xs text-white/70 flex-1 truncate">
                    {entry.title || entry.content?.slice(0, 60) || 'Untitled'}
                  </span>
                  {entry.event_date && (
                    <span className="text-[10px] text-white/30 shrink-0">
                      {entry.event_date}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
