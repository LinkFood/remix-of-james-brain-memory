import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Search, FileText, Brain, BarChart3, MessageSquare, Eye,
  CheckCircle2, XCircle, Loader2, Clock, ChevronDown, ChevronUp,
} from 'lucide-react';
import type { AgentTask } from '@/types/agent';

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
};

function elapsedTime(start: string, end?: string | null): string {
  const startDate = new Date(start);
  const endDate = end ? new Date(end) : new Date();
  const diffMs = endDate.getTime() - startDate.getTime();
  if (diffMs < 1000) return '<1s';
  if (diffMs < 60_000) return `${Math.round(diffMs / 1000)}s`;
  return `${Math.round(diffMs / 60_000)}m`;
}

interface TaskCardProps {
  task: AgentTask;
}

export function TaskCard({ task }: TaskCardProps) {
  const [expanded, setExpanded] = useState(false);
  const statusConfig = STATUS_CONFIG[task.status] || STATUS_CONFIG.pending;
  const typeIcon = TYPE_ICONS[task.type] || TYPE_ICONS.general;

  const output = task.output as Record<string, unknown> | null;

  return (
    <Card
      className={`p-3 cursor-pointer transition-all hover:bg-muted/50 ${
        task.status === 'running' ? 'ring-1 ring-blue-500/30' : ''
      }`}
      onClick={() => setExpanded(!expanded)}
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
        <div className="mt-3 pt-3 border-t border-border">
          {task.error && (
            <div className="text-sm text-red-500 mb-2">
              {task.error}
            </div>
          )}

          {output?.brief && (
            <div className="text-sm text-foreground whitespace-pre-wrap max-h-60 overflow-y-auto">
              {String(output.brief).slice(0, 1000)}
            </div>
          )}

          {output?.sources && Array.isArray(output.sources) && output.sources.length > 0 && (
            <div className="mt-2 space-y-1">
              <p className="text-xs font-medium text-muted-foreground">Sources</p>
              {(output.sources as Array<{ title: string; url: string }>).slice(0, 5).map((s, i) => (
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

          {!task.error && !output && task.status !== 'running' && (
            <p className="text-xs text-muted-foreground">No output data</p>
          )}

          {task.status === 'running' && (
            <div className="flex items-center gap-2 text-xs text-blue-500">
              <Loader2 className="w-3 h-3 animate-spin" />
              Working on it...
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
