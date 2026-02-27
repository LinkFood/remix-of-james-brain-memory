/**
 * useJacAgent — Hook for JAC Agent command center
 *
 * Manages messages, tasks, activity logs, and realtime subscriptions.
 * Gracefully handles missing tables (pre-migration state).
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import type { AgentTask, JacMessage, ActivityLogEntry } from '@/types/agent';
import type { RealtimeChannel } from '@supabase/supabase-js';

const JAC_DISPATCHER_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/jac-dispatcher`;
const JAC_KILL_SWITCH_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/jac-kill-switch`;

export function useJacAgent(userId: string) {
  const [messages, setMessages] = useState<JacMessage[]>([]);
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [activityLogs, setActivityLogs] = useState<Map<string, ActivityLogEntry[]>>(new Map());
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [backendReady, setBackendReady] = useState(true);
  const healthCheckedRef = useRef(false);
  const channelsRef = useRef<RealtimeChannel[]>([]);
  const sendingRef = useRef(false);

  // Health check: ping dispatcher to verify backend is deployed
  useEffect(() => {
    if (!userId || healthCheckedRef.current) return;
    healthCheckedRef.current = true;

    fetch(JAC_DISPATCHER_URL, { method: 'OPTIONS' })
      .then(res => setBackendReady(res.status === 204 || res.status === 200))
      .catch(() => setBackendReady(false));
  }, [userId]);

  // Load conversation history + tasks on mount
  useEffect(() => {
    if (!userId) return;

    const loadInitial = async () => {
      setLoading(true);

      try {
        // Load conversations (may fail if table doesn't exist yet)
        const { data: convos, error: convoError } = await supabase
          .from('agent_conversations' as any)
          .select('role, content, task_ids, created_at')
          .eq('user_id', userId)
          .order('created_at', { ascending: true })
          .limit(100);

        if (convoError) {
          console.warn('[useJacAgent] agent_conversations not ready:', convoError.message);
          setBackendReady(false);
        } else if (convos) {
          setBackendReady(true);
          setMessages(
            (convos as any[]).map((c) => ({
              role: c.role as 'user' | 'assistant',
              content: c.content,
              taskIds: c.task_ids ?? [],
              timestamp: c.created_at,
            }))
          );
        }

        // Load recent tasks
        const { data: taskData } = await supabase
          .from('agent_tasks')
          .select('*')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .limit(50);

        if (taskData) {
          const typedTasks = taskData as unknown as AgentTask[];

          // Clean up stale tasks (stuck in queued/running for >15 minutes)
          // Server-side dispatcher cleans at 10 min; give workers extra headroom
          const fiveMinAgo = Date.now() - 15 * 60 * 1000;
          const staleTasks = typedTasks.filter(
            t => (t.status === 'queued' || t.status === 'running') &&
              new Date(t.updated_at).getTime() < fiveMinAgo
          );
          if (staleTasks.length > 0) {
            console.log(`[useJacAgent] Cleaning up ${staleTasks.length} stale tasks`);
            for (const stale of staleTasks) {
              supabase
                .from('agent_tasks')
                .update({ status: 'failed', error: 'Task timed out', updated_at: new Date().toISOString() } as any)
                .eq('id', stale.id)
                .then(() => {});
              stale.status = 'failed' as any;
              stale.error = 'Task timed out';
            }
          }

          setTasks(typedTasks);
          // Load logs for active tasks
          const activeTaskIds = (taskData as unknown as AgentTask[])
            .filter(t => t.status === 'running' || t.status === 'queued')
            .map(t => t.id);

          if (activeTaskIds.length > 0) {
            const { data: logs } = await (supabase
              .from('agent_activity_log' as any)
              .select('*')
              .in('task_id', activeTaskIds)
              .order('created_at', { ascending: true }) as any);

            if (logs) {
              const logMap = new Map<string, ActivityLogEntry[]>();
              for (const log of logs as unknown as ActivityLogEntry[]) {
                const existing = logMap.get(log.task_id) || [];
                existing.push(log);
                logMap.set(log.task_id, existing);
              }
              setActivityLogs(logMap);
            }
          }
        }
      } catch (err) {
        console.warn('[useJacAgent] Load error:', err);
      }

      setLoading(false);
    };

    loadInitial();
  }, [userId]);

  // Realtime subscriptions
  useEffect(() => {
    if (!userId) return;

    const channels: RealtimeChannel[] = [];

    // agent_tasks realtime
    const taskChannel = supabase
      .channel(`agent-tasks-${userId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'agent_tasks',
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          if (payload.eventType === 'INSERT') {
            setTasks(prev => [payload.new as AgentTask, ...prev]);
          } else if (payload.eventType === 'UPDATE') {
            const updated = payload.new as AgentTask;
            setTasks(prev => prev.map(t => t.id === updated.id ? updated : t));
            if (updated.status === 'completed') {
              toast.success(`Task completed: ${(updated.intent || updated.type).slice(0, 60)}`);
            } else if (updated.status === 'failed') {
              toast.error(`Task failed: ${(updated.error || updated.intent || '').slice(0, 80)}`);
            } else if (updated.status === 'cancelled') {
              toast.info(`Task cancelled: ${(updated.intent || updated.type).slice(0, 60)}`, { style: { backgroundColor: '#f97316', color: 'white' } });
            }
          } else if (payload.eventType === 'DELETE') {
            setTasks(prev => prev.filter(t => t.id !== (payload.old as { id: string }).id));
          }
        }
      )
      .subscribe();
    channels.push(taskChannel);

    // agent_conversations realtime
    const convoChannel = supabase
      .channel(`agent-convos-${userId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'agent_conversations',
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          const newMsg = payload.new as {
            role: string;
            content: string;
            task_ids: string[];
            created_at: string;
          };
          setMessages(prev => {
            // Exact timestamp match
            if (prev.some(m => m.timestamp === newMsg.created_at && m.role === newMsg.role)) return prev;
            const dbTime = new Date(newMsg.created_at).getTime();
            // Dedup for BOTH user and assistant messages:
            // If same role + same content within 30s window, skip (covers optimistic adds & worker results)
            const hasDuplicate = prev.some(m =>
              m.role === newMsg.role &&
              m.content === newMsg.content &&
              Math.abs(new Date(m.timestamp).getTime() - dbTime) < 30_000
            );
            if (hasDuplicate) return prev;
            return [
              ...prev,
              {
                role: newMsg.role as 'user' | 'assistant',
                content: newMsg.content,
                taskIds: newMsg.task_ids ?? [],
                timestamp: newMsg.created_at,
              },
            ];
          });
        }
      )
      .subscribe();
    channels.push(convoChannel);

    // agent_activity_log realtime
    const logChannel = supabase
      .channel(`agent-logs-${userId}`)
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
          setActivityLogs(prev => {
            const updated = new Map(prev);
            const existing = updated.get(newLog.task_id) || [];
            updated.set(newLog.task_id, [...existing, newLog]);
            return updated;
          });
        }
      )
      .subscribe();
    channels.push(logChannel);

    channelsRef.current = channels;

    return () => {
      channels.forEach(ch => supabase.removeChannel(ch));
      channelsRef.current = [];
    };
  }, [userId]);

  // Load logs for a specific task (on-demand)
  const loadTaskLogs = useCallback(async (taskId: string) => {
    const { data: logs } = await (supabase
      .from('agent_activity_log' as any)
      .select('*')
      .eq('task_id', taskId)
      .order('created_at', { ascending: true }) as any);

    if (logs) {
      setActivityLogs(prev => {
        const updated = new Map(prev);
        updated.set(taskId, logs as unknown as ActivityLogEntry[]);
        return updated;
      });
    }
  }, []);

  // Stop a single task
  const stopTask = useCallback(async (taskId: string) => {
    try {
      const { data: session } = await supabase.auth.getSession();
      if (!session?.session?.access_token) throw new Error('Not authenticated');

      const res = await fetch(JAC_KILL_SWITCH_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.session.access_token}`,
          'Content-Type': 'application/json',
          apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        },
        body: JSON.stringify({ action: 'stop_one', taskId }),
      });

      const data = await res.json();
      if (data.cancelled > 0) {
        toast.info('Task stopped');
      }
    } catch (err) {
      toast.error('Failed to stop task');
      console.error('[useJacAgent] stopTask error:', err);
    }
  }, []);

  // Stop all running tasks
  const stopAllTasks = useCallback(async () => {
    try {
      const { data: session } = await supabase.auth.getSession();
      if (!session?.session?.access_token) throw new Error('Not authenticated');

      const res = await fetch(JAC_KILL_SWITCH_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.session.access_token}`,
          'Content-Type': 'application/json',
          apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        },
        body: JSON.stringify({ action: 'stop_all' }),
      });

      const data = await res.json();
      toast.info(`Stopped ${data.cancelled ?? 0} task${(data.cancelled ?? 0) !== 1 ? 's' : ''}`, { style: { backgroundColor: '#f97316', color: 'white' } });
    } catch (err) {
      toast.error('Failed to stop tasks');
      console.error('[useJacAgent] stopAllTasks error:', err);
    }
  }, []);

  // Send message to JAC dispatcher
  const sendMessage = useCallback(
    async (text: string) => {
      if (!text.trim() || sendingRef.current) return;

      const trimmed = text.trim();
      sendingRef.current = true;
      setSending(true);

      // Optimistic user message
      const userMsg: JacMessage = {
        role: 'user',
        content: trimmed,
        taskIds: [],
        timestamp: new Date().toISOString(),
      };
      setMessages(prev => [...prev, userMsg]);

      try {
        const { data: session } = await supabase.auth.getSession();
        if (!session?.session?.access_token) throw new Error('Not authenticated');

        // 90s timeout — dispatcher can take time for Claude intent parsing + enrichment
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 90_000);

        const res = await fetch(JAC_DISPATCHER_URL, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${session.session.access_token}`,
            'Content-Type': 'application/json',
            apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
          },
          body: JSON.stringify({ message: trimmed }),
        });
        clearTimeout(timeout);

        if (!res.ok) {
          const errorData = await res.json().catch(() => ({}));
          throw new Error(errorData.error || `Request failed: ${res.status}`);
        }

        // Don't add assistant response optimistically — let Realtime handle it
        // to avoid duplicate messages. The dispatcher saves to agent_conversations,
        // which triggers the Realtime INSERT subscription above.
        const _data = await res.json();
      } catch (err) {
        const errorText = err instanceof Error ? err.message : 'Unknown error';

        // Provide helpful error messages
        let helpText = errorText;
        if (errorText === 'Failed to fetch') {
          helpText = "Couldn't reach JAC. Check your connection and try again.";
        } else if (errorText.includes('aborted') || errorText.includes('abort')) {
          helpText = 'Request timed out. JAC might be under heavy load — try again.';
        } else if (errorText.includes('404') || errorText.includes('not found')) {
          helpText = 'JAC dispatcher is not deployed yet.';
        } else if (errorText.includes('500')) {
          helpText = 'JAC hit an internal error. Try again in a moment.';
        }

        const errMsg: JacMessage = {
          role: 'assistant',
          content: helpText,
          taskIds: [],
          timestamp: new Date().toISOString(),
        };
        setMessages(prev => [...prev, errMsg]);
      } finally {
        sendingRef.current = false;
        setSending(false);
      }
    },
    []
  );

  return {
    messages,
    tasks,
    activityLogs,
    loading,
    sending,
    backendReady,
    sendMessage,
    loadTaskLogs,
    stopTask,
    stopAllTasks,
  };
}
