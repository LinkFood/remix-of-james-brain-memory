/**
 * SystemPulseWidget — Hero greeting + system stats. Designed for full-width (12 cols).
 */

import { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';
import { useDashboardActivity } from '@/hooks/useDashboardActivity';
import { useEntries } from '@/hooks/useEntries';
import { useProactiveInsights } from '@/hooks/useProactiveInsights';
import { Sun, Sunset, Moon, Bot, Database, Bell, Code2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { WidgetProps } from '@/types/widget';

interface TimeOfDay {
  label: string;
  icon: LucideIcon;
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

export default function SystemPulseWidget({ onNavigate }: WidgetProps) {
  const [userId, setUserId] = useState<string | undefined>(undefined);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) setUserId(session.user.id);
    });
  }, []);

  const { tasks, activeCount, reminders, loading: activityLoading } = useDashboardActivity(userId ?? '');
  const { stats, loading: entriesLoading } = useEntries({ userId: userId ?? '', pageSize: 1 });
  const { insights, loading: insightsLoading } = useProactiveInsights(userId);

  const loading = activityLoading || entriesLoading || insightsLoading;
  const tod = getTimeOfDay();
  const Icon = tod.icon;

  // Build briefing prose from top insights or fallback stats
  const briefing = (() => {
    const parts: string[] = [];
    if (insights.length > 0) {
      const top = insights.slice(0, 3);
      parts.push(...top.map(i => i.title));
    } else {
      if (reminders.overdueCount > 0) parts.push(`${reminders.overdueCount} overdue reminder${reminders.overdueCount !== 1 ? 's' : ''}`);
      if (reminders.todayCount > 0) parts.push(`${reminders.todayCount} due today`);
      if (activeCount > 0) parts.push(`${activeCount} agent${activeCount !== 1 ? 's' : ''} running`);
      if (parts.length === 0 && stats.total > 0) parts.push(`${stats.total} entries in your brain`);
    }
    return parts.join(' · ') || 'All systems nominal.';
  })();

  const statItems = [
    { label: 'Agents', value: tasks.filter(t => t.status === 'running').length, icon: Bot, nav: '/jac' },
    { label: 'Entries', value: stats.total, icon: Database, nav: '/dashboard' },
    { label: 'Reminders', value: reminders.todayCount + reminders.overdueCount, icon: Bell, nav: '/dashboard' },
    { label: 'Code', value: null, icon: Code2, nav: '/code' },
  ];

  return (
    <div
      className={cn(
        'flex items-center gap-6 h-full px-5 py-4',
        'bg-white/[0.03] backdrop-blur-sm border border-white/10 rounded-lg',
        `bg-gradient-to-r ${tod.gradient}`
      )}
    >
      {/* Greeting */}
      <div className="flex items-center gap-3 shrink-0">
        <Icon className={cn('w-7 h-7', tod.color)} />
        <div>
          <div className={cn('text-sm font-semibold', tod.color)}>{tod.label}</div>
          <div className="text-[10px] text-white/40 mt-0.5">JAC Agent OS</div>
        </div>
      </div>

      {/* Divider */}
      <div className="w-px h-8 bg-white/10 shrink-0" />

      {/* Briefing prose */}
      <div className="flex-1 min-w-0">
        {loading ? (
          <span className="text-[10px] text-white/30">Loading system state...</span>
        ) : (
          <p className="text-xs text-white/60 truncate">{briefing}</p>
        )}
      </div>

      {/* Stats row */}
      <div className="flex items-center gap-4 shrink-0">
        {statItems.map(item => {
          const ItemIcon = item.icon;
          return (
            <button
              key={item.label}
              onClick={() => onNavigate(item.nav)}
              className="flex flex-col items-center gap-0.5 hover:opacity-80 transition-opacity"
            >
              <ItemIcon className="w-3.5 h-3.5 text-white/40" />
              <span className="text-sm font-semibold text-white/80">
                {item.value !== null ? item.value : '—'}
              </span>
              <span className="text-[9px] text-white/30 uppercase tracking-wide">
                {item.label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
