/**
 * AgentLiveStreamWidget — Real-time agent activity log feed on the dashboard.
 *
 * Subscribes to agent_activity_log INSERT events and shows steps as they happen.
 * Terminal-style rendering with status icons, step names, durations.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { CheckCircle2, XCircle, Loader2, SkipForward } from 'lucide-react';
import type { WidgetProps } from '@/types/widget';
import type { ActivityLogEntry } from '@/types/agent';
import type { RealtimeChannel } from '@supabase/supabase-js';

function timeStr(iso: string): string {
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
    default: return 'text-white/40';
  }
}

function agentShort(agent: string): string {
  return agent.replace('jac-', '').replace('-agent', '');
}

function getDetail(detail: Record<string, unknown>): string {
  if (detail.message && typeof detail.message === 'string') return detail.message;
  if (detail.error && typeof detail.error === 'string') return detail.error;
  if (detail.query && typeof detail.query === 'string') return String(detail.query).slice(0, 50);
  if (detail.brief && typeof detail.brief === 'string') return detail.brief;
  return '';
}

interface CollapsedEntry {
  id: string;
  agent: string;
  step: string;
  status: string;
  timestamp: string;
  duration_ms: number | null;
  detail: Record<string, unknown>;
}

function collapseEntries(logs: ActivityLogEntry[]): CollapsedEntry[] {
  const result: CollapsedEntry[] = [];
  const stepMap = new Map<string, number>();

  for (const log of logs) {
    const key = `${log.task_id}:${log.step}`;

    if (log.status === 'started') {
      const idx = result.length;
      stepMap.set(key, idx);
      result.push({
        id: log.id,
        agent: log.agent,
        step: log.step,
        status: 'started',
        timestamp: log.created_at,
        duration_ms: null,
        detail: log.detail,
      });
    } else if (log.status === 'completed' || log.status === 'failed' || log.status === 'skipped') {
      const existingIdx = stepMap.get(key);
      if (existingIdx !== undefined) {
        result[existingIdx] = {
          ...result[existingIdx],
          status: log.status,
          duration_ms: log.duration_ms,
          detail: { ...result[existingIdx].detail, ...log.detail },
        };
      } else {
        result.push({
          id: log.id,
          agent: log.agent,
          step: log.step,
          status: log.status,
          timestamp: log.created_at,
          duration_ms: log.duration_ms,
          detail: log.detail,
        });
      }
    } else {
      result.push({
        id: log.id,
        agent: log.agent,
        step: log.step,
        status: log.status,
        timestamp: log.created_at,
        duration_ms: log.duration_ms,
        detail: log.detail,
      });
    }
  }

  return result;
}

export default function AgentLiveStreamWidget({ compact }: WidgetProps) {
  const [userId, setUserId] = useState('');
  const [logs, setLogs] = useState<ActivityLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) setUserId(session.user.id);
    });
  }, []);

  const fetchLogs = useCallback(async () => {
    if (!userId) return;
    const { data } = await supabase
      .from('agent_activity_log')
      .select('id, task_id, user_id, agent, step, status, detail, duration_ms, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(40);

    if (data) {
      setLogs((data as ActivityLogEntry[]).reverse());
    }
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    fetchLogs().finally(() => setLoading(false));
  }, [userId, fetchLogs]);

  // Realtime subscription — append new entries
  useEffect(() => {
    if (!userId) return;

    const channel: RealtimeChannel = supabase
      .channel(`live-stream-${userId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'agent_activity_log',
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          const newLog = payload.new as ActivityLogEntry;
          setLogs(prev => [...prev.slice(-39), newLog]);
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [userId]);

  // Auto-scroll on new entries
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs.length]);

  const collapsed = useMemo(() => collapseEntries(logs), [logs]);
  const visible = compact ? collapsed.slice(-6) : collapsed.slice(-20);

  return (
    <div className="flex flex-col h-full bg-[#0d1117] backdrop-blur-sm border border-white/10 rounded-lg overflow-hidden">
      <div className="px-3 py-2 border-b border-white/10 flex items-center justify-between shrink-0">
        <span className="text-xs font-mono text-green-400/80">live-stream</span>
        {!loading && (
          <span className="text-[10px] text-white/30">{collapsed.length} steps</span>
        )}
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-2 space-y-0.5">
        {loading ? (
          <div className="flex items-center justify-center h-16">
            <span className="text-[10px] font-mono text-white/30">Loading...</span>
          </div>
        ) : visible.length === 0 ? (
          <div className="flex items-center justify-center h-16">
            <span className="text-[10px] font-mono text-white/30">Waiting for agent activity...</span>
          </div>
        ) : (
          visible.map(entry => {
            const detail = getDetail(entry.detail);
            return (
              <div key={entry.id} className="flex items-start gap-1.5 text-[10px] font-mono leading-relaxed">
                <span className="text-white/20 shrink-0">{timeStr(entry.timestamp)}</span>
                <StatusIcon status={entry.status} />
                <span className="text-white/40 shrink-0 w-12 truncate">{agentShort(entry.agent)}</span>
                <span className={`shrink-0 ${statusColor(entry.status)}`}>{entry.step}</span>
                {detail && (
                  <span className="text-white/30 truncate">{detail}</span>
                )}
                {entry.duration_ms !== null && entry.duration_ms > 0 && (
                  <span className="ml-auto text-white/20 shrink-0">{entry.duration_ms}ms</span>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
