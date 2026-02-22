/**
 * AgentResultsFeed — Where agents dump their completed work
 *
 * Like a team Slack channel but for agents. Each completed task
 * gets a rich result card showing what was done, what was found,
 * and what was saved to the brain.
 */

import { useMemo } from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  CheckCircle2, XCircle, Globe, Brain, FileText,
  ExternalLink, Clock, Zap, BookOpen,
} from 'lucide-react';
import type { AgentTask, ActivityLogEntry } from '@/types/agent';

interface AgentResultsFeedProps {
  tasks: AgentTask[];
  activityLogs: Map<string, ActivityLogEntry[]>;
  onExpandTask?: (taskId: string) => void;
}

const AGENT_NAMES: Record<string, string> = {
  'jac-dispatcher': 'JAC',
  'jac-research-agent': 'Scout',
  'jac-save-agent': 'Scribe',
  'jac-search-agent': 'Oracle',
  'jac-report-agent': 'Analyst',
  'jac-monitor-agent': 'Sentinel',
};

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

function ResultCard({ task, logs }: { task: AgentTask; logs?: ActivityLogEntry[] }) {
  const output = task.output as Record<string, unknown> | null;
  const isCompleted = task.status === 'completed';
  const isFailed = task.status === 'failed';
  const agentName = AGENT_NAMES[task.agent || ''] || task.agent || 'Agent';

  const brief = output?.brief ? String(output.brief) : null;
  const sources = output?.sources as Array<{ title: string; url: string }> | undefined;
  const brainEntryId = output?.brainEntryId ? String(output.brainEntryId) : null;
  const stepCount = logs?.filter(l => l.status === 'completed').length || 0;
  const totalDuration = logs?.reduce((sum, l) => sum + (l.duration_ms || 0), 0) || 0;

  return (
    <Card className={`p-4 transition-all ${
      isCompleted ? 'border-green-500/20 bg-green-500/[0.02]' :
      isFailed ? 'border-red-500/20 bg-red-500/[0.02]' :
      'border-border'
    }`}>
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <div className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 ${
            isCompleted ? 'bg-green-500/10' : 'bg-red-500/10'
          }`}>
            {isCompleted ? (
              <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />
            ) : (
              <XCircle className="w-3.5 h-3.5 text-red-500" />
            )}
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">
              {task.intent || task.type}
            </p>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-[10px] text-muted-foreground">{agentName}</span>
              <span className="text-[10px] text-muted-foreground">{timeAgo(task.completed_at || task.updated_at)}</span>
              {stepCount > 0 && (
                <span className="text-[10px] text-muted-foreground">{stepCount} steps</span>
              )}
              {totalDuration > 0 && (
                <span className="text-[10px] text-muted-foreground">
                  {totalDuration < 1000 ? `${totalDuration}ms` : `${(totalDuration / 1000).toFixed(1)}s`}
                </span>
              )}
            </div>
          </div>
        </div>

        <Badge variant="outline" className={`shrink-0 text-[10px] ${
          isCompleted ? 'text-green-600 border-green-500/30' : 'text-red-600 border-red-500/30'
        }`}>
          {task.status}
        </Badge>
      </div>

      {/* Error */}
      {task.error && (
        <div className="mt-3 p-2 rounded bg-red-500/5 border border-red-500/10">
          <p className="text-xs text-red-400">{task.error}</p>
        </div>
      )}

      {/* Brief / Result */}
      {brief && (
        <div className="mt-3 text-sm text-foreground/90 whitespace-pre-wrap leading-relaxed max-h-48 overflow-y-auto">
          {brief.length > 500 ? brief.slice(0, 500) + '...' : brief}
        </div>
      )}

      {/* Sources */}
      {sources && sources.length > 0 && (
        <div className="mt-3 space-y-1">
          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1">
            <Globe className="w-3 h-3" /> Sources
          </p>
          {sources.filter(s => isSafeUrl(s.url)).slice(0, 4).map((s, i) => (
            <a
              key={i}
              href={s.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-xs text-primary hover:underline truncate"
            >
              <ExternalLink className="w-3 h-3 shrink-0" />
              {s.title}
            </a>
          ))}
          {sources.length > 4 && (
            <p className="text-[10px] text-muted-foreground">+{sources.length - 4} more</p>
          )}
        </div>
      )}

      {/* Brain save indicator */}
      {brainEntryId && (
        <div className="mt-3 flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <Brain className="w-3 h-3 text-violet-500" />
          Saved to brain
          <code className="text-violet-400 font-mono">{brainEntryId.slice(0, 8)}</code>
        </div>
      )}
    </Card>
  );
}

export function AgentResultsFeed({ tasks, activityLogs, onExpandTask }: AgentResultsFeedProps) {
  // Show completed + failed tasks, most recent first
  const finishedTasks = useMemo(
    () => tasks
      .filter(t => t.status === 'completed' || t.status === 'failed')
      .filter(t => t.agent !== 'jac-dispatcher') // Don't show dispatcher tasks in results
      .sort((a, b) => new Date(b.completed_at || b.updated_at).getTime() - new Date(a.completed_at || a.updated_at).getTime()),
    [tasks]
  );

  if (finishedTasks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full py-12 px-4">
        <div className="w-12 h-12 rounded-full bg-muted/30 flex items-center justify-center mb-3">
          <BookOpen className="w-6 h-6 text-muted-foreground/30" />
        </div>
        <p className="text-sm text-muted-foreground">No results yet</p>
        <p className="text-xs text-muted-foreground/60 mt-1 text-center">
          When agents complete tasks, their work shows up here
        </p>
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className="p-3 space-y-3">
        {finishedTasks.map(task => (
          <ResultCard
            key={task.id}
            task={task}
            logs={activityLogs.get(task.id)}
          />
        ))}
      </div>
    </ScrollArea>
  );
}
