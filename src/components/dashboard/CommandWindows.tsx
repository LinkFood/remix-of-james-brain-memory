/**
 * CommandWindows — Side-by-side Code + Brain preview cards
 *
 * Click-through to /code or Browse view. Shows latest code session
 * and brain entry stats at a glance.
 */

import { GitBranch, Brain, ExternalLink, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { DashboardStats } from '@/hooks/useEntries';

interface CommandWindowsProps {
  latestCodeSession: { branch: string; status: string; prUrl: string | null } | null;
  stats: DashboardStats;
  onNavigateToCode: () => void;
  onNavigateToBrowse: () => void;
}

function codeStatusBadge(status: string) {
  const styles: Record<string, string> = {
    completed: 'bg-green-500/20 text-green-400',
    active: 'bg-blue-500/20 text-blue-400',
    failed: 'bg-red-500/20 text-red-400',
    awaiting_ci: 'bg-amber-500/20 text-amber-400',
  };
  return styles[status] ?? 'bg-muted text-muted-foreground';
}

const CommandWindows = ({ latestCodeSession, stats, onNavigateToCode, onNavigateToBrowse }: CommandWindowsProps) => {
  // Top content types for badge display
  const topTypes = Object.entries(stats.byType)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3);

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {/* Code Window */}
      <div
        className={cn(
          'rounded-xl p-4 cursor-pointer transition-all hover:bg-white/[0.06]',
          'bg-white/[0.03] backdrop-blur-sm border border-white/10',
        )}
        onClick={onNavigateToCode}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter') onNavigateToCode(); }}
      >
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
            <GitBranch className="w-3.5 h-3.5" />
            Code
          </div>
          <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
        </div>
        {latestCodeSession ? (
          <div className="space-y-1.5">
            <p className="text-sm font-medium truncate">{latestCodeSession.branch}</p>
            <div className="flex items-center gap-2">
              <span className={cn('text-[10px] px-1.5 py-0.5 rounded-full', codeStatusBadge(latestCodeSession.status))}>
                {latestCodeSession.status}
              </span>
              {latestCodeSession.prUrl && (
                <a
                  href={latestCodeSession.prUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="text-blue-400 hover:text-blue-300"
                >
                  <ExternalLink className="w-3 h-3" />
                </a>
              )}
            </div>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">No recent sessions</p>
        )}
      </div>

      {/* Brain Window */}
      <div
        className={cn(
          'rounded-xl p-4 cursor-pointer transition-all hover:bg-white/[0.06]',
          'bg-white/[0.03] backdrop-blur-sm border border-white/10',
        )}
        onClick={onNavigateToBrowse}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter') onNavigateToBrowse(); }}
      >
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
            <Brain className="w-3.5 h-3.5" />
            Brain
          </div>
          <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
        </div>
        <div className="space-y-1.5">
          <p className="text-sm font-medium">{stats.total} entries</p>
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
            <span>{stats.today} today</span>
            <span className="text-muted-foreground/50">·</span>
            <span>{stats.important} important</span>
          </div>
          {topTypes.length > 0 && (
            <div className="flex gap-1.5 flex-wrap mt-1">
              {topTypes.map(([type, count]) => (
                <span key={type} className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted/50 text-muted-foreground">
                  {type} {count}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default CommandWindows;
