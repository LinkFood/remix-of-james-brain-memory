import { useState, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { TaskCard } from './TaskCard';
import type { AgentTask, TaskStatus, ActivityLogEntry } from '@/types/agent';

const FILTER_OPTIONS: { label: string; value: TaskStatus | 'all' }[] = [
  { label: 'All', value: 'all' },
  { label: 'Running', value: 'running' },
  { label: 'Completed', value: 'completed' },
  { label: 'Failed', value: 'failed' },
];

interface ActivityFeedProps {
  tasks: AgentTask[];
  activityLogs: Map<string, ActivityLogEntry[]>;
  loading: boolean;
  onExpandTask?: (taskId: string) => void;
}

export function ActivityFeed({ tasks, activityLogs, loading, onExpandTask }: ActivityFeedProps) {
  const [filter, setFilter] = useState<TaskStatus | 'all'>('all');

  const filtered = useMemo(() => {
    if (filter === 'all') return tasks;
    return tasks.filter((t) => t.status === filter);
  }, [tasks, filter]);

  return (
    <div className="flex flex-col h-full">
      {/* Filter bar */}
      <div className="flex items-center gap-1 p-3 border-b border-border overflow-x-auto">
        {FILTER_OPTIONS.map((opt) => (
          <Button
            key={opt.value}
            variant={filter === opt.value ? 'default' : 'ghost'}
            size="sm"
            className="text-xs shrink-0"
            onClick={() => setFilter(opt.value)}
          >
            {opt.label}
            {opt.value !== 'all' && (
              <span className="ml-1 opacity-60">
                {tasks.filter((t) => t.status === opt.value).length}
              </span>
            )}
          </Button>
        ))}
      </div>

      {/* Task list */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {loading ? (
          <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
            Loading tasks...
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-sm text-muted-foreground">
            <p>No tasks{filter !== 'all' ? ` with status "${filter}"` : ''}</p>
            {filter === 'all' && (
              <p className="mt-1 text-xs">Send JAC a message to get started</p>
            )}
          </div>
        ) : (
          filtered.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              logs={activityLogs.get(task.id)}
              onExpand={onExpandTask}
            />
          ))
        )}
      </div>
    </div>
  );
}
