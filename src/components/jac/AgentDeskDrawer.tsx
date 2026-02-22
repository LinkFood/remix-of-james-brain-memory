/**
 * AgentDeskDrawer — Click an agent to see their full work history
 *
 * Like opening an agent's desk drawer: all tasks, logs, results.
 * Slides in from the right via Sheet.
 */

import { useMemo } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  CheckCircle2, XCircle, Loader2, Clock, Brain,
  Globe, ExternalLink,
} from 'lucide-react';
import type { AgentTask, ActivityLogEntry } from '@/types/agent';

interface AgentDeskDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentId: string;
  agentName: string;
  agentRole: string;
  agentIcon: React.ReactNode;
  tasks: AgentTask[];
  activityLogs: Map<string, ActivityLogEntry[]>;
}

function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function TaskEntry({ task, logs }: { task: AgentTask; logs?: ActivityLogEntry[] }) {
  const output = task.output as Record<string, unknown> | null;
  const brief = output?.brief ? String(output.brief) : null;
  const sources = output?.sources as Array<{ title: string; url: string }> | undefined;
  const brainEntryId = output?.brainEntryId ? String(output.brainEntryId) : null;
  const completedSteps = logs?.filter(l => l.status === 'completed').length || 0;

  return (
    <div className={`p-3 rounded-lg border transition-all ${
      task.status === 'running' ? 'border-blue-500/30 bg-blue-500/[0.03]' :
      task.status === 'completed' ? 'border-green-500/20 bg-green-500/[0.02]' :
      task.status === 'failed' ? 'border-red-500/20 bg-red-500/[0.02]' :
      'border-border bg-card/30'
    }`}>
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium truncate">{task.intent || task.type}</p>
          <div className="flex items-center gap-2 mt-0.5 text-[10px] text-muted-foreground">
            <span>{timeAgo(task.completed_at || task.updated_at)}</span>
            {completedSteps > 0 && <span>{completedSteps} steps</span>}
          </div>
        </div>
        <Badge variant="outline" className={`shrink-0 text-[10px] ${
          task.status === 'running' ? 'text-blue-400 border-blue-500/30' :
          task.status === 'completed' ? 'text-green-600 border-green-500/30' :
          task.status === 'failed' ? 'text-red-600 border-red-500/30' :
          ''
        }`}>
          {task.status === 'running' && <Loader2 className="w-2.5 h-2.5 animate-spin mr-1" />}
          {task.status === 'completed' && <CheckCircle2 className="w-2.5 h-2.5 mr-1" />}
          {task.status === 'failed' && <XCircle className="w-2.5 h-2.5 mr-1" />}
          {task.status}
        </Badge>
      </div>

      {/* Error */}
      {task.error && (
        <p className="mt-2 text-xs text-red-400">{task.error}</p>
      )}

      {/* Brief */}
      {brief && (
        <p className="mt-2 text-xs text-foreground/80 whitespace-pre-wrap leading-relaxed line-clamp-4">
          {brief}
        </p>
      )}

      {/* Activity log steps */}
      {logs && logs.length > 0 && (
        <div className="mt-2 space-y-0.5">
          {logs.map((log) => (
            <div key={log.id} className="flex items-center gap-1.5 text-[10px]">
              {log.status === 'completed' ? (
                <CheckCircle2 className="w-2.5 h-2.5 text-green-500 shrink-0" />
              ) : log.status === 'failed' ? (
                <XCircle className="w-2.5 h-2.5 text-red-500 shrink-0" />
              ) : log.status === 'started' ? (
                <Loader2 className="w-2.5 h-2.5 animate-spin text-blue-400 shrink-0" />
              ) : (
                <Clock className="w-2.5 h-2.5 text-muted-foreground shrink-0" />
              )}
              <span className="text-muted-foreground truncate">
                {log.step.replace(/_/g, ' ')}
              </span>
              {log.duration_ms != null && log.duration_ms > 0 && (
                <span className="text-muted-foreground/60 ml-auto shrink-0">
                  {log.duration_ms < 1000 ? `${log.duration_ms}ms` : `${(log.duration_ms / 1000).toFixed(1)}s`}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Sources */}
      {sources && sources.length > 0 && (
        <div className="mt-2 space-y-0.5">
          {sources.filter(s => isSafeUrl(s.url)).slice(0, 3).map((s, i) => (
            <a
              key={i}
              href={s.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-[10px] text-primary hover:underline truncate"
            >
              <ExternalLink className="w-2.5 h-2.5 shrink-0" />
              {s.title}
            </a>
          ))}
        </div>
      )}

      {/* Brain save */}
      {brainEntryId && (
        <div className="mt-2 flex items-center gap-1 text-[10px] text-muted-foreground">
          <Brain className="w-2.5 h-2.5 text-violet-500" />
          Saved to brain
          <code className="text-violet-400 font-mono">{brainEntryId.slice(0, 8)}</code>
        </div>
      )}
    </div>
  );
}

export function AgentDeskDrawer({
  open, onOpenChange, agentId, agentName, agentRole, agentIcon,
  tasks, activityLogs,
}: AgentDeskDrawerProps) {
  const agentTasks = useMemo(
    () => tasks
      .filter(t => t.agent === agentId)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()),
    [tasks, agentId]
  );

  const stats = useMemo(() => ({
    total: agentTasks.length,
    completed: agentTasks.filter(t => t.status === 'completed').length,
    failed: agentTasks.filter(t => t.status === 'failed').length,
    running: agentTasks.filter(t => t.status === 'running').length,
  }), [agentTasks]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-[400px] sm:w-[440px] p-0 flex flex-col">
        <SheetHeader className="px-4 pt-4 pb-3 border-b border-border">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
              {agentIcon}
            </div>
            <div>
              <SheetTitle className="text-base">{agentName}</SheetTitle>
              <p className="text-xs text-muted-foreground">{agentRole}</p>
            </div>
          </div>

          {/* Stats */}
          <div className="flex items-center gap-3 mt-3">
            {stats.running > 0 && (
              <div className="flex items-center gap-1 text-xs text-blue-400">
                <Loader2 className="w-3 h-3 animate-spin" />
                {stats.running} active
              </div>
            )}
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <CheckCircle2 className="w-3 h-3 text-green-500" />
              {stats.completed} done
            </div>
            {stats.failed > 0 && (
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <XCircle className="w-3 h-3 text-red-500" />
                {stats.failed} failed
              </div>
            )}
            <span className="text-[10px] text-muted-foreground/50 ml-auto">
              {stats.total} total ops
            </span>
          </div>
        </SheetHeader>

        <ScrollArea className="flex-1">
          <div className="p-4 space-y-2">
            {agentTasks.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                <Clock className="w-8 h-8 opacity-20 mb-2" />
                <p className="text-sm">No operations yet</p>
                <p className="text-xs opacity-60 mt-1">
                  {agentName} is waiting for commands
                </p>
              </div>
            ) : (
              agentTasks.map(task => (
                <TaskEntry
                  key={task.id}
                  task={task}
                  logs={activityLogs.get(task.id)}
                />
              ))
            )}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
