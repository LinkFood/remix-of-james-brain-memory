import { useState, useEffect } from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Search, FileText, Brain, BarChart3, MessageSquare, Eye,
  CheckCircle2, XCircle, Loader2, Clock, ChevronDown, ChevronUp, StopCircle,
} from 'lucide-react';
import type { AgentTask, ActivityLogEntry } from '@/types/agent';

const TYPE_ICONS: Record<string, React.ReactNode> = {
  research: <Search className="w-4 h-4" />,
  save: <FileText className="w-4 h-4" />,
  search: <Brain className="w-4 h-4" />,
  report: <BarChart3 className="w-4 h-4" />,
  general: <MessageSquare className="w-4 h-4" />,
  monitor: <Eye className="w-4 h-4" />,
};

const STATUS_CONFIG: Record<string, { color: string; icon: React.ReactNode }> = {
  pending: { color: 'bg-muted text-muted-foreground', icon: <Clock className="w-3 h-3" /> },
  queued: { color: 'bg-yellow-500/10 text-yellow-600', icon: <Clock className="w-3 h-3" /> },
  running: { color: 'bg-blue-500/10 text-blue-600', icon: <Loader2 className="w-3 h-3 animate-spin" /> },
  completed: { color: 'bg-green-500/10 text-green-600', icon: <CheckCircle2 className="w-3 h-3" /> },
  failed: { color: 'bg-red-500/10 text-red-600', icon: <XCircle className="w-3 h-3" /> },
  cancelled: { color: 'bg-orange-500/10 text-orange-600', icon: <StopCircle className="w-3 h-3" /> },
};

const LOG_STATUS_ICON: Record<string, React.ReactNode> = {
  started: <Loader2 className="w-3 h-3 animate-spin text-blue-500" />,
  completed: <CheckCircle2 className="w-3 h-3 text-green-500" />,
  failed: <XCircle className="w-3 h-3 text-red-500" />,
  skipped: <Clock className="w-3 h-3 text-muted-foreground" />,
};

function elapsedTime(start: string, end?: string | null): string {
  const startDate = new Date(start);
  const endDate = end ? new Date(end) : new Date();
  const diffMs = endDate.getTime() - startDate.getTime();
  if (diffMs < 1000) return '<1s';
  if (diffMs < 60_000) return `${Math.round(diffMs / 1000)}s`;
  return `${Math.round(diffMs / 60_000)}m`;
}

function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function formatStepName(step: string): string {
  return step
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

interface TaskCardProps {
  task: AgentTask;
  logs?: ActivityLogEntry[];
  onExpand?: (taskId: string) => void;
  onStop?: (taskId: string) => void;
}

export function TaskCard({ task, logs, onExpand, onStop }: TaskCardProps) {
  const [expanded, setExpanded] = useState(false);
  const statusConfig = STATUS_CONFIG[task.status] || STATUS_CONFIG.pending;
  const typeIcon = TYPE_ICONS[task.type] || TYPE_ICONS.general;

  const output = task.output as Record<string, unknown> | null;

  // Deduplicate logs — show only the final status per step
  const deduplicatedLogs = logs
    ? Array.from(
        logs.reduce((map, log) => {
          const existing = map.get(log.step);
          // Keep the newest entry, but prefer completed/failed over started
          if (!existing || log.status !== 'started' || existing.status === 'started') {
            map.set(log.step, log);
          }
          return map;
        }, new Map<string, ActivityLogEntry>())
      ).map(([, log]) => log)
    : [];

  const handleClick = () => {
    const willExpand = !expanded;
    setExpanded(willExpand);
    if (willExpand && onExpand) {
      onExpand(task.id);
    }
  };

  // Auto-expand running tasks
  useEffect(() => {
    if (task.status === 'running' && !expanded) {
      setExpanded(true);
      onExpand?.(task.id);
    }
  }, [task.status, task.id, expanded, onExpand]);

  return (
    <Card
      className={`p-3 cursor-pointer transition-all hover:bg-muted/50 ${
        task.status === 'running' ? 'ring-1 ring-blue-500/30' : ''
      }`}
      onClick={handleClick}
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 text-muted-foreground">{typeIcon}</div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium truncate">
              {task.intent || task.type}
            </span>
            <Badge variant="secondary" className={`text-[10px] px-1.5 py-0 ${statusConfig.color}`}>
              <span className="mr-1">{statusConfig.icon}</span>
              {task.status}
            </Badge>
            {onStop && (task.status === 'running' || task.status === 'queued') && (
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5 text-muted-foreground hover:text-red-500"
                onClick={(e) => { e.stopPropagation(); onStop(task.id); }}
              >
                <StopCircle className="w-3.5 h-3.5" />
              </Button>
            )}
          </div>

          <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
            {task.agent && <span>{task.agent}</span>}
            <span>{elapsedTime(task.created_at, task.completed_at)}</span>
            {task.slack_notified && <span>notified</span>}
          </div>
        </div>

        <div className="text-muted-foreground">
          {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </div>
      </div>

      {expanded && (
        <div className="mt-3 pt-3 border-t border-border space-y-3">
          {/* Live step log */}
          {deduplicatedLogs.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground mb-1.5">Activity Log</p>
              {deduplicatedLogs.map((log) => (
                <div
                  key={log.id}
                  className="flex items-center gap-2 text-xs"
                >
                  {LOG_STATUS_ICON[log.status] || LOG_STATUS_ICON.skipped}
                  <span className={log.status === 'failed' ? 'text-red-500' : 'text-foreground'}>
                    {formatStepName(log.step)}
                  </span>
                  {log.duration_ms != null && log.duration_ms > 0 && (
                    <span className="text-muted-foreground">
                      {log.duration_ms < 1000 ? `${log.duration_ms}ms` : `${(log.duration_ms / 1000).toFixed(1)}s`}
                    </span>
                  )}
                  {log.detail?.error && (
                    <span className="text-red-500 truncate max-w-[200px]">
                      {String(log.detail.error)}
                    </span>
                  )}
                  {log.detail?.resultCount != null && (
                    <span className="text-muted-foreground">
                      ({String(log.detail.resultCount)} results)
                    </span>
                  )}
                  {log.detail?.matchCount != null && (
                    <span className="text-muted-foreground">
                      ({String(log.detail.matchCount)} matches)
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Running indicator when no logs yet */}
          {task.status === 'running' && deduplicatedLogs.length === 0 && (
            <div className="flex items-center gap-2 text-xs text-blue-500">
              <Loader2 className="w-3 h-3 animate-spin" />
              Working on it...
            </div>
          )}

          {task.error && (
            <div className="text-sm text-red-500">
              {task.error}
            </div>
          )}

          {output?.brief && (
            <div className="text-sm text-foreground whitespace-pre-wrap max-h-60 overflow-y-auto">
              {String(output.brief).slice(0, 1000)}
            </div>
          )}

          {output?.sources && Array.isArray(output.sources) && output.sources.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">Sources</p>
              {(output.sources as Array<{ title: string; url: string }>).filter(s => isSafeUrl(s.url)).slice(0, 5).map((s, i) => (
                <a
                  key={i}
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block text-xs text-primary hover:underline truncate"
                  onClick={(e) => e.stopPropagation()}
                >
                  {s.title}
                </a>
              ))}
            </div>
          )}

          {output?.brainEntryId && (
            <p className="mt-2 text-xs text-muted-foreground">
              Saved to brain: <code className="text-primary">{String(output.brainEntryId).slice(0, 8)}</code>
            </p>
          )}

          {!task.error && !output && task.status !== 'running' && deduplicatedLogs.length === 0 && (
            <p className="text-xs text-muted-foreground">No output data</p>
          )}
        </div>
      )}
    </Card>
  );
}
