/**
 * SystemPulse — Hero header for the dashboard command center
 *
 * Time-of-day gradient background, greeting, briefing prose, live stats row.
 * Replaces DailyBriefing with more ambient, HUD-like treatment.
 */

import { RefreshCw, Sun, Sunset, Moon, Brain, Bell, GitBranch, Activity } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { BrainInsight } from '@/hooks/useProactiveInsights';
import type { DashboardStats } from '@/hooks/useEntries';

interface SystemPulseProps {
  insights: BrainInsight[];
  stats: DashboardStats;
  activeAgentCount: number;
  reminders: { todayCount: number; overdueCount: number };
  latestCodeSession: { branch: string; status: string; prUrl: string | null } | null;
  loading: boolean;
  onRefreshInsights: () => void;
}

function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return { text: 'Good morning', Icon: Sun, gradient: 'from-amber-500/20 via-orange-500/10 to-yellow-500/5' };
  if (hour < 18) return { text: 'Good afternoon', Icon: Sunset, gradient: 'from-violet-500/20 via-purple-500/10 to-fuchsia-500/5' };
  return { text: 'Good evening', Icon: Moon, gradient: 'from-indigo-500/20 via-blue-500/10 to-slate-500/5' };
}

function buildBriefing(insights: BrainInsight[], stats: DashboardStats): string {
  const top = insights.slice(0, 3);
  if (top.length > 0) {
    return top.map(i => i.title).join('. ') + '.';
  }
  const parts: string[] = [];
  if (stats.total > 0) parts.push(`${stats.total} entries`);
  if (stats.today > 0) parts.push(`${stats.today} today`);
  if (stats.important > 0) parts.push(`${stats.important} important`);
  return parts.length > 0 ? parts.join(', ') + '.' : 'Your brain is empty. Dump something in.';
}

function codeStatusLabel(status: string): string {
  switch (status) {
    case 'completed': return 'done';
    case 'active': return 'active';
    case 'failed': return 'failed';
    case 'awaiting_ci': return 'CI';
    default: return status;
  }
}

const SystemPulse = ({
  insights, stats, activeAgentCount, reminders,
  latestCodeSession, loading, onRefreshInsights,
}: SystemPulseProps) => {
  const { text: greeting, Icon: GreetingIcon, gradient } = getGreeting();
  const briefing = buildBriefing(insights, stats);
  const totalReminders = reminders.todayCount + reminders.overdueCount;

  return (
    <div className={cn(
      'relative rounded-xl p-4 bg-gradient-to-br overflow-hidden',
      gradient,
      'border border-white/10 backdrop-blur-sm'
    )}>
      {/* Refresh button */}
      <Button
        variant="ghost"
        size="icon"
        className="absolute top-3 right-3 h-7 w-7 text-muted-foreground hover:text-foreground"
        onClick={onRefreshInsights}
        disabled={loading}
      >
        <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
      </Button>

      {/* Greeting + briefing */}
      <div className="flex items-start gap-3 pr-8">
        <GreetingIcon className="w-5 h-5 text-primary shrink-0 mt-0.5" />
        <div className="min-w-0">
          <p className="text-sm font-semibold">{greeting}</p>
          <p className="text-sm text-muted-foreground mt-0.5 line-clamp-2">{briefing}</p>
        </div>
      </div>

      {/* Stats row */}
      <div className="flex items-center gap-4 mt-3 text-xs text-muted-foreground flex-wrap">
        <span className="flex items-center gap-1.5">
          <Activity className="w-3 h-3" />
          <span className={cn(activeAgentCount > 0 && 'text-blue-400')}>
            {activeAgentCount} agent{activeAgentCount !== 1 ? 's' : ''}
          </span>
        </span>

        <span className="flex items-center gap-1.5">
          <Brain className="w-3 h-3" />
          {stats.total} entries
        </span>

        <span className={cn('flex items-center gap-1.5', reminders.overdueCount > 0 && 'text-red-400')}>
          <Bell className="w-3 h-3" />
          {totalReminders} reminder{totalReminders !== 1 ? 's' : ''}
        </span>

        {latestCodeSession && (
          <span className="flex items-center gap-1.5">
            <GitBranch className="w-3 h-3" />
            <span className="truncate max-w-[120px]">{latestCodeSession.branch}</span>
            <span className={cn(
              'text-[10px]',
              latestCodeSession.status === 'completed' ? 'text-green-400' :
              latestCodeSession.status === 'active' ? 'text-blue-400' :
              latestCodeSession.status === 'failed' ? 'text-red-400' :
              'text-amber-400'
            )}>
              {codeStatusLabel(latestCodeSession.status)}
            </span>
          </span>
        )}
      </div>
    </div>
  );
};

export default SystemPulse;
