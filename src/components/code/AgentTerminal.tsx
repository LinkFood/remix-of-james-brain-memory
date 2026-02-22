/**
 * AgentTerminal — Terminal-style log feed for coding agent activity
 *
 * Dark background, monospace font, color-coded status lines.
 * Auto-scrolls to bottom as new entries arrive.
 */

import { useRef, useEffect } from 'react';
import { CheckCircle2, XCircle, Loader2, SkipForward, Terminal } from 'lucide-react';
import type { ActivityLogEntry } from '@/types/agent';

interface AgentTerminalProps {
  logs: ActivityLogEntry[];
  sessionStatus: string | null;
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'completed':
      return <CheckCircle2 className="w-3 h-3 text-green-400 shrink-0" />;
    case 'failed':
      return <XCircle className="w-3 h-3 text-red-400 shrink-0" />;
    case 'started':
      return <Loader2 className="w-3 h-3 text-blue-400 animate-spin shrink-0" />;
    case 'skipped':
      return <SkipForward className="w-3 h-3 text-amber-400 shrink-0" />;
    default:
      return <span className="w-3 h-3 shrink-0" />;
  }
}

function statusColor(status: string): string {
  switch (status) {
    case 'completed': return 'text-green-400';
    case 'failed': return 'text-red-400';
    case 'started': return 'text-blue-400';
    case 'skipped': return 'text-amber-400';
    default: return 'text-muted-foreground';
  }
}

function getDetailSummary(detail: Record<string, unknown>): string {
  if (detail.message && typeof detail.message === 'string') return detail.message;
  if (detail.error && typeof detail.error === 'string') return detail.error;
  if (detail.file && typeof detail.file === 'string') return detail.file;
  if (detail.brief && typeof detail.brief === 'string') return detail.brief;
  return '';
}

export function AgentTerminal({ logs, sessionStatus }: AgentTerminalProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs.length]);

  return (
    <div className="flex flex-col h-full bg-[#0d1117] rounded-lg border border-border overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/50 bg-[#161b22]">
        <Terminal className="w-3.5 h-3.5 text-green-400" />
        <span className="text-xs font-mono text-green-400/80">agent-terminal</span>
        {sessionStatus && (
          <span className={`ml-auto text-[10px] font-mono ${
            sessionStatus === 'active' ? 'text-blue-400' :
            sessionStatus === 'completed' ? 'text-green-400' :
            sessionStatus === 'failed' ? 'text-red-400' :
            'text-amber-400'
          }`}>
            [{sessionStatus}]
          </span>
        )}
      </div>

      {/* Log lines */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-0.5">
        {logs.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-xs font-mono text-muted-foreground/50">Waiting for agent...</p>
          </div>
        ) : (
          logs.map((log) => {
            const summary = getDetailSummary(log.detail);
            return (
              <div key={log.id} className="flex items-start gap-2 text-[11px] font-mono leading-relaxed">
                <span className="text-muted-foreground/50 shrink-0">{formatTimestamp(log.created_at)}</span>
                <StatusIcon status={log.status} />
                <span className={`shrink-0 ${statusColor(log.status)}`}>{log.step}</span>
                {summary && (
                  <span className="text-muted-foreground/70 truncate">{summary}</span>
                )}
                {log.duration_ms !== null && (
                  <span className="ml-auto text-muted-foreground/40 shrink-0">{log.duration_ms}ms</span>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
