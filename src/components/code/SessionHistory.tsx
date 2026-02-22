/**
 * SessionHistory — List of past coding sessions
 *
 * Card per session with branch name, PR link, status badge,
 * files changed count, and timestamp.
 */

import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { GitBranch, ExternalLink, FileText, Clock, Code2 } from 'lucide-react';
import type { CodeSession } from '@/types/agent';

interface SessionHistoryProps {
  sessions: CodeSession[];
}

const STATUS_STYLES: Record<string, { label: string; classes: string }> = {
  active: { label: 'Active', classes: 'border-blue-500/30 text-blue-400 bg-blue-500/10' },
  completed: { label: 'Completed', classes: 'border-green-500/30 text-green-500 bg-green-500/10' },
  failed: { label: 'Failed', classes: 'border-red-500/30 text-red-400 bg-red-500/10' },
  awaiting_ci: { label: 'Awaiting CI', classes: 'border-amber-500/30 text-amber-400 bg-amber-500/10' },
};

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function SessionHistory({ sessions }: SessionHistoryProps) {
  if (sessions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <Code2 className="w-10 h-10 text-muted-foreground/20 mb-3" />
        <p className="text-sm text-muted-foreground">No coding sessions yet</p>
        <p className="text-[10px] text-muted-foreground/60 mt-1">Sessions will appear here as JAC writes code</p>
      </div>
    );
  }

  return (
    <div className="space-y-2 p-2">
      {sessions.map((session) => {
        const style = STATUS_STYLES[session.status] || STATUS_STYLES.active;
        const filesChanged = (session.files_written?.length || 0);

        return (
          <Card key={session.id} className="p-3 bg-card/50 border-border hover:bg-muted/20 transition-colors">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                {/* Branch name */}
                <div className="flex items-center gap-1.5">
                  <GitBranch className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                  <span className="text-xs font-mono font-medium truncate">{session.branch_name}</span>
                </div>

                {/* Intent */}
                <p className="text-[11px] text-muted-foreground mt-1 truncate">{session.intent}</p>

                {/* Meta row */}
                <div className="flex items-center gap-3 mt-2">
                  {filesChanged > 0 && (
                    <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                      <FileText className="w-3 h-3" />
                      {filesChanged} file{filesChanged !== 1 ? 's' : ''}
                    </span>
                  )}
                  <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                    <Clock className="w-3 h-3" />
                    {formatRelativeTime(session.updated_at)}
                  </span>
                  {session.pr_url && (
                    <a
                      href={session.pr_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 text-[10px] text-blue-400 hover:text-blue-300 transition-colors"
                    >
                      <ExternalLink className="w-3 h-3" />
                      PR #{session.pr_number}
                    </a>
                  )}
                </div>
              </div>

              <Badge variant="outline" className={`shrink-0 text-[9px] px-1.5 py-0 ${style.classes}`}>
                {style.label}
              </Badge>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
