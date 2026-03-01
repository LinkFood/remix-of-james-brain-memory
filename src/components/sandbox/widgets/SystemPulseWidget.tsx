/**
 * SystemPulseWidget — Time-of-day greeting + prioritized briefing rows.
 * Designed for full-width (12 cols).
 */

import { useState, useEffect, useMemo } from 'react';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';
import { useDashboardActivity } from '@/hooks/useDashboardActivity';
import { useProactiveInsights } from '@/hooks/useProactiveInsights';
import { useUpcomingReminders } from '@/hooks/useUpcomingReminders';
import { Sun, Sunset, Moon } from 'lucide-react';
import type { WidgetProps } from '@/types/widget';

interface TimeOfDay {
  label: string;
  icon: typeof Sun;
  gradient: string;
  color: string;
}

function getTimeOfDay(): TimeOfDay {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12) {
    return {
      label: 'Good morning',
      icon: Sun,
      gradient: 'from-amber-500/10 to-transparent',
      color: 'text-amber-400',
    };
  }
  if (hour >= 12 && hour < 18) {
    return {
      label: 'Good afternoon',
      icon: Sunset,
      gradient: 'from-violet-500/10 to-transparent',
      color: 'text-violet-400',
    };
  }
  return {
    label: 'Good evening',
    icon: Moon,
    gradient: 'from-indigo-500/10 to-transparent',
    color: 'text-indigo-400',
  };
}

interface BriefingItem {
  key: string;
  dotColor: string;
  title: string;
  context: string;
  onClick?: () => void;
}

export default function SystemPulseWidget({ compact, expanded, onNavigate }: WidgetProps) {
  const [userId, setUserId] = useState<string | undefined>(undefined);
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) setUserId(session.user.id);
    });
  }, []);

  // Update clock every 60 seconds
  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(interval);
  }, []);

  const { tasks, loading: activityLoading } = useDashboardActivity(userId ?? '');
  const { insights, loading: insightsLoading } = useProactiveInsights(userId);
  const { overdueReminders, todayReminders, loading: remindersLoading } = useUpcomingReminders(userId);

  const loading = activityLoading || insightsLoading || remindersLoading;
  const tod = getTimeOfDay();
  const Icon = tod.icon;

  const timeString = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

  const briefingItems = useMemo<BriefingItem[]>(() => {
    const items: BriefingItem[] = [];

    // 1. Overdue reminders (red)
    for (const entry of overdueReminders) {
      const title = entry.title || entry.content.slice(0, 60);
      const eventDate = new Date(entry.event_date + 'T00:00:00');
      const daysOverdue = Math.floor((Date.now() - eventDate.getTime()) / (1000 * 60 * 60 * 24));
      items.push({
        key: `overdue-${entry.id}`,
        dotColor: 'bg-red-500',
        title,
        context: `${daysOverdue}d overdue`,
        onClick: () => onNavigate(`/brain?entryId=${entry.id}`),
      });
    }

    // 2. Today's reminders (amber)
    for (const entry of todayReminders) {
      const title = entry.title || entry.content.slice(0, 60);
      items.push({
        key: `today-${entry.id}`,
        dotColor: 'bg-amber-500',
        title,
        context: entry.event_time || 'Today',
        onClick: () => onNavigate(`/brain?entryId=${entry.id}`),
      });
    }

    // 3. Top insights (violet), sorted by priority asc
    const sorted = [...insights].sort((a, b) => a.priority - b.priority);
    for (const insight of sorted) {
      items.push({
        key: `insight-${insight.id}`,
        dotColor: 'bg-violet-500',
        title: insight.title,
        context: insight.type,
      });
    }

    // 4. Last completed agent task (green)
    const completed = tasks.find(t => t.status === 'completed');
    if (completed) {
      const ago = Date.now() - new Date(completed.updated_at).getTime();
      const mins = Math.floor(ago / 60_000);
      const hours = Math.floor(mins / 60);
      const relTime = hours > 0 ? `${hours}h ago` : mins > 0 ? `${mins}m ago` : 'just now';
      items.push({
        key: `task-${completed.id}`,
        dotColor: 'bg-emerald-500',
        title: completed.intent || 'Agent task',
        context: relTime,
        onClick: () => onNavigate('/jac'),
      });
    }

    return items;
  }, [overdueReminders, todayReminders, insights, tasks, onNavigate]);

  // Item limits: compact 3, normal 5, expanded all
  const limit = expanded ? briefingItems.length : compact ? 3 : 5;
  const visibleItems = briefingItems.slice(0, limit);

  return (
    <div
      className={cn(
        'flex flex-col h-full',
        'bg-white/[0.03] backdrop-blur-sm border border-white/10 rounded-lg',
        `bg-gradient-to-r ${tod.gradient}`
      )}
    >
      {/* Header row */}
      <div className="flex items-center justify-between px-4 pt-3 pb-2 shrink-0">
        <div className="flex items-center gap-2.5">
          <Icon className={cn('w-5 h-5', tod.color)} />
          <span className={cn('text-sm font-semibold', tod.color)}>{tod.label}</span>
        </div>
        <span className="text-xs text-white/40">{timeString}</span>
      </div>

      {/* Briefing items */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {loading ? (
          <div className="px-4 py-2">
            <span className="text-[10px] text-white/30">Loading...</span>
          </div>
        ) : visibleItems.length === 0 ? (
          <div className="px-4 py-2">
            <span className="text-xs text-white/30">All clear — nothing needs your attention</span>
          </div>
        ) : (
          visibleItems.map(item => (
            <button
              key={item.key}
              onClick={item.onClick}
              disabled={!item.onClick}
              className="flex items-center gap-2.5 px-3 py-2 hover:bg-white/5 transition-colors w-full text-left"
            >
              <div className={cn('w-2 h-2 rounded-full shrink-0', item.dotColor)} />
              <span className="text-xs text-white/70 flex-1 min-w-0 line-clamp-1">{item.title}</span>
              <span className="text-[10px] text-white/30 shrink-0">{item.context}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
