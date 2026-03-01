/**
 * useAgentStats — Per-agent stats and task history from agent_tasks.
 *
 * Returns stats per agent: total tasks, success rate, cost, tokens, recent tasks.
 * Realtime subscription for live updates.
 */

import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { AGENT_DEFS, deriveAgentStates, type AgentState } from '@/lib/agents';
import type { AgentTask } from '@/types/agent';
import type { RealtimeChannel } from '@supabase/supabase-js';

export interface AgentStats {
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  successRate: number;
  totalCost: number;
  totalTokens: number;
  recentTasks: AgentTask[];
}

export function useAgentStats(userId: string) {
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchTasks = useCallback(async () => {
    if (!userId) return;

    try {
      const { data } = await supabase
        .from('agent_tasks')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(200);

      if (data) {
        setTasks(data as AgentTask[]);
      }
    } catch (err) {
      console.warn('[useAgentStats] Fetch failed (non-blocking):', err);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  // Realtime subscription
  useEffect(() => {
    if (!userId) return;

    const channel: RealtimeChannel = supabase
      .channel(`agent-stats-${userId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'agent_tasks',
          filter: `user_id=eq.${userId}`,
        },
        () => {
          fetchTasks();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId, fetchTasks]);

  // Derive per-agent stats
  const agentStatsMap = new Map<string, AgentStats>();
  for (const agent of AGENT_DEFS) {
    const agentTasks = tasks.filter(t => t.agent === agent.id);
    const completed = agentTasks.filter(t => t.status === 'completed');
    const failed = agentTasks.filter(t => t.status === 'failed');

    agentStatsMap.set(agent.id, {
      totalTasks: agentTasks.length,
      completedTasks: completed.length,
      failedTasks: failed.length,
      successRate: agentTasks.length > 0
        ? completed.length / (completed.length + failed.length) || 0
        : 0,
      totalCost: agentTasks.reduce((sum, t) => sum + (t.cost_usd || 0), 0),
      totalTokens: agentTasks.reduce((sum, t) => sum + (t.tokens_in || 0) + (t.tokens_out || 0), 0),
      recentTasks: agentTasks.slice(0, 10),
    });
  }

  // Derive live states
  const agentStates: Map<string, AgentState> = deriveAgentStates(tasks);

  return { agentStatsMap, agentStates, loading };
}
