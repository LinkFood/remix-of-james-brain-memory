/**
 * ActivityRail — Horizontal scroll of recent completed agent tasks
 *
 * Color-coded chips by agent. Shows intent or brief result.
 * Click navigates to /jac for full activity feed.
 */

import { AGENT_DEFS } from '@/lib/agents';
import { cn } from '@/lib/utils';
import type { DashboardActivityTask } from '@/hooks/useDashboardActivity';

interface ActivityRailProps {
  tasks: DashboardActivityTask[];
  onNavigateToJac: () => void;
}

const agentMap = new Map(AGENT_DEFS.map(a => [a.id, a]));

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

function getTaskLabel(task: DashboardActivityTask): string {
  const output = task.output as Record<string, unknown> | null;
  if (output?.brief) return String(output.brief).slice(0, 50);
  return task.intent?.slice(0, 50) || 'Task completed';
}

const ActivityRail = ({ tasks, onNavigateToJac }: ActivityRailProps) => {
  // Filter to completed/failed, exclude dispatcher, take first 8
  const recentTasks = tasks
    .filter(t => (t.status === 'completed' || t.status === 'failed') && t.agent !== 'jac-dispatcher')
    .slice(0, 8);

  if (recentTasks.length === 0) return null;

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
          Recent Activity
        </p>
        <button
          onClick={onNavigateToJac}
          className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
        >
          View all
        </button>
      </div>
      <div
        className="overflow-x-auto flex gap-2 pb-1 snap-x snap-mandatory"
        style={{ scrollbarWidth: 'none' }}
      >
        {recentTasks.map((task) => {
          const agent = agentMap.get(task.agent);
          const borderClass = agent?.borderColor ?? 'border-muted-foreground';

          return (
            <div
              key={task.id}
              className={cn(
                'min-w-[200px] max-w-[260px] rounded-lg border-l-2 p-2.5 snap-start shrink-0',
                'bg-white/[0.03] backdrop-blur-sm border border-white/10',
                borderClass,
              )}
              onClick={onNavigateToJac}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter') onNavigateToJac(); }}
              style={{ cursor: 'pointer' }}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium truncate">
                  {agent?.name ?? 'Agent'}
                </span>
                <span className="text-[10px] text-muted-foreground shrink-0">
                  {timeAgo(task.updated_at)}
                </span>
              </div>
              <p className="text-[11px] text-muted-foreground truncate mt-0.5">
                {getTaskLabel(task)}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default ActivityRail;
