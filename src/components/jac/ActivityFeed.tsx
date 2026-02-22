/**
 * ActivityFeed — Live operations tracker
 *
 * Shows running and recent tasks with live status updates.
 * Running tasks auto-expand to show step-by-step progress.
 */

import { useState, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { TaskCard } from './TaskCard';
import { Loader2, CheckCircle2, XCircle, Clock, StopCircle } from 'lucide-react';
import type { AgentTask, TaskStatus, ActivityLogEntry } from '@/types/agent';

const FILTER_OPTIONS: { label: string; value: TaskStatus | 'all' }[] = [
  { label: 'All', value: 'all' },
  { label: 'Running', value: 'running' },
  { label: 'Completed', value: 'completed' },
  { label: 'Failed', value: 'failed' },
  { label: 'Cancelled', value: 'cancelled' },
];

const FILTER_ICONS: Record<string, React.ReactNode> = {
  running: <Loader2 className="w-3 h-3 animate-spin" />,
  completed: <CheckCircle2 className="w-3 h-3" />,
  failed: <XCircle className="w-3 h-3" />,
  cancelled: <StopCircle className="w-3 h-3" />,
};

interface ActivityFeedProps {
  tasks: AgentTask[];
  activityLogs: Map<string, ActivityLogEntry[]>;
  loading: boolean;
  onExpandTask?: (taskId: string) => void;
  onStopTask?: (taskId: string) => void;
  onStopAll?: () => void;
}

export function ActivityFeed({ tasks, activityLogs, loading, onExpandTask, onStopTask, onStopAll }: ActivityFeedProps) {
  const [filter, setFilter] = useState<TaskStatus | 'all'>('all');

  const filtered = useMemo(() => {
    const list = filter === 'all' ? tasks : tasks.filter(t => t.status === filter);
    // Don't show dispatcher parent tasks — they're just routing
    return list.filter(t => t.agent !== 'jac-dispatcher' || t.status === 'running');
  }, [tasks, filter]);

  const runningCount = tasks.filter(t => t.status === 'running').length;

  return (
    <div className="flex flex-col h-full">
      {/* Filter bar */}
      <div className="flex items-center gap-1 p-2 border-b border-border overflow-x-auto">
        {FILTER_OPTIONS.map((opt) => {
          const count = opt.value === 'all' ? tasks.length : tasks.filter(t => t.status === opt.value).length;
          return (
            <Button
              key={opt.value}
              variant={filter === opt.value ? 'default' : 'ghost'}
              size="sm"
              className="text-xs shrink-0 h-7 gap-1"
              onClick={() => setFilter(opt.value)}
            >
              {FILTER_ICONS[opt.value]}
              {opt.label}
              <span className="opacity-50">{count}</span>
            </Button>
          );
        })}
      </div>

      {/* Live indicator */}
      {runningCount > 0 && (
        <div className="px-3 py-1.5 bg-blue-500/5 border-b border-blue-500/10 flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
          </span>
          <span className="text-[10px] text-blue-400 font-medium">
            {runningCount} operation{runningCount > 1 ? 's' : ''} in progress
          </span>
          {onStopAll && (
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto h-5 text-[10px] text-red-400 hover:text-red-500 hover:bg-red-500/10 px-2"
              onClick={onStopAll}
            >
              <StopCircle className="w-3 h-3 mr-1" />
              Stop all
            </Button>
          )}
        </div>
      )}

      {/* Task list */}
      <ScrollArea className="flex-1">
        <div className="p-3 space-y-2">
          {loading ? (
            <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin mr-2" />
              Loading...
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <Clock className="w-8 h-8 opacity-20 mb-2" />
              <p className="text-sm">No operations{filter !== 'all' ? ` with status "${filter}"` : ''}</p>
              {filter === 'all' && (
                <p className="mt-1 text-xs opacity-60">Send JAC a command to get started</p>
              )}
            </div>
          ) : (
            filtered.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                logs={activityLogs.get(task.id)}
                onExpand={onExpandTask}
                onStop={onStopTask}
              />
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
