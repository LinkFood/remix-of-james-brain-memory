import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import type { AgentTask, JacMessage } from '@/types/agent';
import type { RealtimeChannel } from '@supabase/supabase-js';

export function useJacAgent(userId: string) {
  const [messages, setMessages] = useState<JacMessage[]>([]);
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const taskChannelRef = useRef<RealtimeChannel | null>(null);
  const convoChannelRef = useRef<RealtimeChannel | null>(null);

  // Load conversation history + tasks on mount
  useEffect(() => {
    if (!userId) return;

    const loadInitial = async () => {
      setLoading(true);

      // Load conversations
      const { data: convos } = await supabase
        .from('agent_conversations')
        .select('role, content, task_ids, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: true })
        .limit(100);

      if (convos) {
        setMessages(
          convos.map((c) => ({
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
        setTasks(taskData as AgentTask[]);
      }

      setLoading(false);
    };

    loadInitial();
  }, [userId]);

  // Realtime subscription for agent_tasks
  useEffect(() => {
    if (!userId) return;

    const channel = supabase
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
            setTasks((prev) => [payload.new as AgentTask, ...prev]);
          } else if (payload.eventType === 'UPDATE') {
          const updated = payload.new as AgentTask;
            setTasks((prev) =>
              prev.map((t) => (t.id === updated.id ? updated : t))
            );
            // Toast on task completion/failure
            if (updated.status === 'completed') {
              toast.success(`Task completed: ${updated.intent.slice(0, 60)}`);
            } else if (updated.status === 'failed') {
              toast.error(`Task failed: ${updated.error?.slice(0, 80) || updated.intent.slice(0, 60)}`);
            }
          } else if (payload.eventType === 'DELETE') {
            setTasks((prev) => prev.filter((t) => t.id !== (payload.old as { id: string }).id));
          }
        }
      )
      .subscribe();

    taskChannelRef.current = channel;

    return () => {
      if (taskChannelRef.current) {
        supabase.removeChannel(taskChannelRef.current);
        taskChannelRef.current = null;
      }
    };
  }, [userId]);

  // Realtime subscription for agent_conversations
  useEffect(() => {
    if (!userId) return;

    const channel = supabase
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
          setMessages((prev) => {
            // Avoid duplicates (we optimistically add messages)
            const isDuplicate = prev.some(
              (m) => m.content === newMsg.content && m.role === newMsg.role
            );
            if (isDuplicate) return prev;
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

    convoChannelRef.current = channel;

    return () => {
      if (convoChannelRef.current) {
        supabase.removeChannel(convoChannelRef.current);
        convoChannelRef.current = null;
      }
    };
  }, [userId]);

  // Send message to JAC dispatcher
  const sendMessage = useCallback(
    async (text: string) => {
      if (!text.trim() || sending) return;

      const trimmed = text.trim();
      setSending(true);

      // Optimistic user message
      const userMsg: JacMessage = {
        role: 'user',
        content: trimmed,
        taskIds: [],
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, userMsg]);

      try {
        const { data: session } = await supabase.auth.getSession();
        if (!session?.session?.access_token) throw new Error('Not authenticated');

        const res = await fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/jac-dispatcher`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${session.session.access_token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ message: trimmed }),
          }
        );

        if (!res.ok) {
          const errorData = await res.json().catch(() => ({}));
          throw new Error(errorData.error || `Request failed: ${res.status}`);
        }

        const data = await res.json();

        // Optimistic assistant response
        const assistantMsg: JacMessage = {
          role: 'assistant',
          content: data.response,
          taskIds: [data.taskId, data.childTaskId].filter(Boolean),
          timestamp: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, assistantMsg]);
      } catch (err) {
        // Error message
        const errMsg: JacMessage = {
          role: 'assistant',
          content: `Something went wrong: ${err instanceof Error ? err.message : 'Unknown error'}`,
          taskIds: [],
          timestamp: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, errMsg]);
      } finally {
        setSending(false);
      }
    },
    [sending]
  );

  return {
    messages,
    tasks,
    loading,
    sending,
    sendMessage,
  };
}
