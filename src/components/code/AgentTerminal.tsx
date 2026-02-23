/**
 * AgentTerminal — Terminal-style log feed for coding agent activity
 *
 * Dark background, monospace font, color-coded status lines.
 * Collapses start/complete pairs into single lines.
 * Adds session dividers between different task runs.
 * Auto-scrolls to bottom as new entries arrive.
 */

import { useRef, useEffect, useMemo } from 'react';
import { CheckCircle2, XCircle, Loader2, SkipForward, Terminal, OctagonX } from 'lucide-react';
import type { ActivityLogEntry } from '@/types/agent';

interface AgentTerminalProps {
  logs: ActivityLogEntry[];
  sessionStatus: string | null;
  onCancel?: () => void;
  isRunning?: boolean;
}

interface CollapsedLogEntry {
  id: string;
  step: string;
  status: 'completed' | 'failed' | 'started' | 'skipped' | string;
  timestamp: string;
  duration_ms: number | null;
  detail: Record<string, unknown>;
  taskId: string;
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

/**
 * Collapse raw logs into single entries per step.
 * Each step logs twice: started → completed/failed.
 * We merge them into one line showing the final status + duration.
 * Only show the spinner for steps that are genuinely in-progress
 * (started with no matching completed/failed entry).
 */
function collapseLogs(logs: ActivityLogEntry[]): CollapsedLogEntry[] {
  const result: CollapsedLogEntry[] = [];
  // Map: "taskId:step" → index in result array
  const stepMap = new Map<string, number>();

  for (const log of logs) {
    const key = `${log.task_id}:${log.step}`;

    if (log.status === 'started') {
      // Create a new entry — may be updated later by completed/failed
      const idx = result.length;
      stepMap.set(key, idx);
      result.push({
        id: log.id,
        step: log.step,
        status: 'started',
        timestamp: log.created_at,
        duration_ms: null,
        detail: log.detail,
        taskId: log.task_id,
      });
    } else if (log.status === 'completed' || log.status === 'failed' || log.status === 'skipped') {
      const existingIdx = stepMap.get(key);
      if (existingIdx !== undefined) {
        // Merge into the existing started entry
        result[existingIdx] = {
          ...result[existingIdx],
          status: log.status,
          duration_ms: log.duration_ms,
          detail: { ...result[existingIdx].detail, ...log.detail },
        };
      } else {
        // No matching started entry — show standalone
        result.push({
          id: log.id,
          step: log.step,
          status: log.status,
          timestamp: log.created_at,
          duration_ms: log.duration_ms,
          detail: log.detail,
          taskId: log.task_id,
        });
      }
    } else {
      // info or other status — show as-is
      result.push({
        id: log.id,
        step: log.step,
        status: log.status,
        timestamp: log.created_at,
        duration_ms: log.duration_ms,
        detail: log.detail,
        taskId: log.task_id,
      });
    }
  }

  return result;
}

export function AgentTerminal({ logs, sessionStatus, onCancel, isRunning }: AgentTerminalProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs.length]);

  const collapsed = useMemo(() => collapseLogs(logs), [logs]);

  // Track task_id changes to insert session dividers
  let lastTaskId: string | null = null;
  let sessionNumber = 0;

  return (
    <div className="flex flex-col h-full bg-[#0d1117] rounded-lg border border-border overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/50 bg-[#161b22]">
        <Terminal className="w-3.5 h-3.5 text-green-400" />
        <span className="text-xs font-mono text-green-400/80">agent-terminal</span>
        <div className="ml-auto flex items-center gap-2">
          {isRunning && onCancel && (
            <button
              onClick={onCancel}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono text-red-400 hover:text-red-300 hover:bg-red-500/10 transition-colors"
              title="Kill running task"
            >
              <OctagonX className="w-3 h-3" />
              kill
            </button>
          )}
          {sessionStatus && (
            <span className={`text-[10px] font-mono ${
              sessionStatus === 'active' ? 'text-blue-400' :
              sessionStatus === 'completed' ? 'text-green-400' :
              sessionStatus === 'failed' ? 'text-red-400' :
              'text-amber-400'
            }`}>
              [{sessionStatus}]
            </span>
          )}
        </div>
      </div>

      {/* Log lines */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-0.5">
        {collapsed.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-xs font-mono text-muted-foreground/50">Waiting for agent...</p>
          </div>
        ) : (
          collapsed.map((entry) => {
            // Session divider when task_id changes
            let divider = null;
            if (entry.taskId !== lastTaskId) {
              sessionNumber++;
              if (lastTaskId !== null) {
                divider = (
                  <div key={`div-${entry.id}`} className="flex items-center gap-2 py-1.5 my-1">
                    <div className="flex-1 border-t border-border/30" />
                    <span className="text-[9px] font-mono text-muted-foreground/30">session {sessionNumber}</span>
                    <div className="flex-1 border-t border-border/30" />
                  </div>
                );
              }
              lastTaskId = entry.taskId;
            }

            const summary = getDetailSummary(entry.detail);
            const line = (
              <div key={entry.id} className="flex items-start gap-2 text-[11px] font-mono leading-relaxed">
                <span className="text-muted-foreground/50 shrink-0">{formatTimestamp(entry.timestamp)}</span>
                <StatusIcon status={entry.status} />
                <span className={`shrink-0 ${statusColor(entry.status)}`}>{entry.step}</span>
                {summary && (
                  <span className="text-muted-foreground/70 truncate">{summary}</span>
                )}
                {entry.duration_ms !== null && entry.duration_ms > 0 && (
                  <span className="ml-auto text-muted-foreground/40 shrink-0">{entry.duration_ms}ms</span>
                )}
              </div>
            );

            return divider ? <>{divider}{line}</> : line;
          })
        )}
      </div>
    </div>
  );
}
