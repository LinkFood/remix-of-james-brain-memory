/**
 * Ticker — Global status bar across all authenticated pages
 *
 * Fixed 32px bar at the bottom showing agent activity, reminders,
 * and code status at a glance. Collapses to 24px "All quiet" when idle.
 */

import { useNavigate } from 'react-router-dom';
import { useTickerData } from '@/hooks/useTickerData';
import { Zap, Bell, GitBranch, ExternalLink } from 'lucide-react';

interface TickerProps {
  userId: string;
}

export function Ticker({ userId }: TickerProps) {
  const navigate = useNavigate();
  const { runningTasks, reminders, latestCodeSession, loading } = useTickerData(userId);

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

        {/* Center — Reminders */}
        <button
          onClick={() => navigate('/dashboard')}
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
