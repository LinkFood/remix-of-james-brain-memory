/**
 * Ticker — Global status bar across all authenticated pages
 *
 * Fixed 32px bar at the bottom showing agent activity, reminders,
 * and code status at a glance. Bell opens a popover with overdue
 * reminders and quick-archive actions.
 */

import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTickerData } from '@/hooks/useTickerData';
import { useEntryActions } from '@/hooks/useEntryActions';
import { supabase } from '@/integrations/supabase/client';
import { Zap, Bell, GitBranch, ExternalLink, Check } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

interface TickerProps {
  userId: string;
}

interface OverdueEntry {
  id: string;
  title: string | null;
  content: string;
  event_date: string;
}

export function Ticker({ userId }: TickerProps) {
  const navigate = useNavigate();
  const { runningTasks, reminders, latestCodeSession, loading } = useTickerData(userId);
  const [overdueEntries, setOverdueEntries] = useState<OverdueEntry[]>([]);
  const [popoverOpen, setPopoverOpen] = useState(false);

  const handleRemove = useCallback((entryId: string) => {
    setOverdueEntries(prev => prev.filter(e => e.id !== entryId));
  }, []);

  const { toggleArchive } = useEntryActions({
    onEntryRemove: handleRemove,
  });

  // Fetch overdue entries when popover opens
  useEffect(() => {
    if (!popoverOpen || !userId) return;
    const todayStr = new Date().toISOString().split('T')[0];
    supabase
      .from('entries')
      .select('id, title, content, event_date')
      .eq('user_id', userId)
      .eq('archived', false)
      .lt('event_date', todayStr)
      .in('content_type', ['reminder', 'event'])
      .order('event_date', { ascending: true })
      .limit(5)
      .then(({ data }) => {
        if (data) setOverdueEntries(data as OverdueEntry[]);
      });
  }, [popoverOpen, userId]);

  if (loading) return null;

  const isQuiet = runningTasks.count === 0 && reminders.todayCount === 0 && reminders.overdueCount === 0 && !latestCodeSession;

  if (isQuiet) {
    return (
      <div className="fixed bottom-0 left-0 right-0 h-6 bg-card/80 backdrop-blur-sm border-t border-border z-50 flex items-center justify-center">
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground/40">
          <Zap className="w-3 h-3" />
          <span>All quiet</span>
        </div>
      </div>
    );
  }

  const hasOverdue = reminders.overdueCount > 0;

  return (
    <div className="fixed bottom-0 left-0 right-0 h-8 bg-card/80 backdrop-blur-sm border-t border-border z-50">
      <div className="h-full flex items-center justify-between px-4 text-xs">
        {/* Left — Agent activity */}
        <button
          onClick={() => navigate('/jac')}
          className="flex items-center gap-2 hover:text-foreground transition-colors min-w-0"
        >
          {runningTasks.count > 0 ? (
            <>
              <span className="relative flex h-2 w-2 shrink-0">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
              </span>
              <span className="text-blue-400 truncate">
                {runningTasks.count} agent{runningTasks.count > 1 ? 's' : ''} working
                {runningTasks.agents.length > 0 && <span className="text-muted-foreground ml-1">· {runningTasks.agents.join(', ')}</span>}
              </span>
            </>
          ) : (
            <span className="text-muted-foreground/60 flex items-center gap-1.5">
              <Zap className="w-3 h-3" />
              Agents idle
            </span>
          )}
        </button>

        {/* Center — Reminders with popover */}
        <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
          <PopoverTrigger asChild>
            <button
              className="flex items-center gap-1.5 hover:text-foreground transition-colors"
            >
              <Bell className="w-3 h-3 text-muted-foreground" />
              {reminders.overdueCount > 0 && (
                <span className="text-red-400">{reminders.overdueCount} overdue</span>
              )}
              {reminders.overdueCount > 0 && reminders.todayCount > 0 && (
                <span className="text-muted-foreground/40">·</span>
              )}
              {reminders.todayCount > 0 && (
                <span className="text-foreground/70">{reminders.todayCount} today</span>
              )}
              {reminders.todayCount === 0 && reminders.overdueCount === 0 && (
                <span className="text-muted-foreground/60">No reminders</span>
              )}
            </button>
          </PopoverTrigger>
          <PopoverContent
            side="top"
            align="center"
            className="w-72 p-0 bg-zinc-900 border-white/10"
          >
            <div className="px-3 py-2 border-b border-white/10">
              <span className="text-xs font-medium text-white/70">
                {hasOverdue ? 'Overdue Reminders' : 'Reminders'}
              </span>
            </div>
            {overdueEntries.length > 0 ? (
              <div className="divide-y divide-white/5 max-h-48 overflow-y-auto">
                {overdueEntries.map(entry => (
                  <div
                    key={entry.id}
                    className="group flex items-center gap-2 px-3 py-2 hover:bg-white/[0.04] transition-colors"
                  >
                    <span className="text-xs text-white/70 flex-1 truncate">
                      {entry.title || entry.content.slice(0, 50)}
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleArchive(entry.id);
                      }}
                      className="shrink-0 p-0.5 text-white/20 hover:text-emerald-400 transition-colors"
                      title="Mark done"
                    >
                      <Check className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="px-3 py-4 text-center text-[10px] text-white/30">
                {hasOverdue ? 'Loading...' : 'No overdue items'}
              </div>
            )}
            <button
              onClick={() => { setPopoverOpen(false); navigate('/calendar'); }}
              className="w-full px-3 py-2 border-t border-white/10 text-[10px] text-white/40 hover:text-white/60 transition-colors text-center"
            >
              See all in Calendar
            </button>
          </PopoverContent>
        </Popover>

        {/* Right — Code status */}
        <button
          onClick={() => navigate('/code')}
          className="flex items-center gap-1.5 hover:text-foreground transition-colors min-w-0"
        >
          {latestCodeSession ? (
            <>
              <GitBranch className="w-3 h-3 text-muted-foreground shrink-0" />
              <span className="truncate max-w-[150px] text-foreground/70">{latestCodeSession.branch}</span>
              <span className={`text-[10px] ${
                latestCodeSession.status === 'completed' ? 'text-green-500' :
                latestCodeSession.status === 'active' ? 'text-blue-400' :
                latestCodeSession.status === 'failed' ? 'text-red-400' :
                'text-amber-400'
              }`}>
                {latestCodeSession.status}
              </span>
              {latestCodeSession.prUrl && (
                <ExternalLink className="w-3 h-3 text-muted-foreground/40 shrink-0" />
              )}
            </>
          ) : (
            <span className="text-muted-foreground/60 flex items-center gap-1.5">
              <GitBranch className="w-3 h-3" />
              No sessions
            </span>
          )}
        </button>
      </div>
    </div>
  );
}
