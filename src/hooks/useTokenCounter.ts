/**
 * useTokenCounter — Queries agent_tasks for today's total cost_usd.
 *
 * Returns totalCostToday + recentTasks for the popover breakdown.
 * Subscribes to realtime for live updates.
 */

import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { RealtimeChannel } from '@supabase/supabase-js';

interface RecentTask {
  id: string;
  intent: string | null;
  agent: string | null;
  cost_usd: number | null;
  created_at: string;
}

export function useTokenCounter(userId: string) {
  const [totalCostToday, setTotalCostToday] = useState(0);
  const [recentTasks, setRecentTasks] = useState<RecentTask[]>([]);

  const fetchTodaysCost = useCallback(async () => {
    if (!userId) return;

    try {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const { data } = await supabase
        .from('agent_tasks')
        .select('id, intent, agent, cost_usd, created_at')
        .eq('user_id', userId)
        .gte('created_at', todayStart.toISOString())
        .order('created_at', { ascending: false })
        .limit(50);

      if (data) {
        const tasks = data as RecentTask[];
        const total = tasks.reduce((sum, t) => sum + (t.cost_usd || 0), 0);
        setTotalCostToday(total);
        setRecentTasks(tasks.slice(0, 10));
      }
    } catch (err) {
      console.warn('[useTokenCounter] Fetch failed (non-blocking):', err);
    }
  }, [userId]);

  // Initial fetch
  useEffect(() => {
    fetchTodaysCost();
  }, [fetchTodaysCost]);

  // Realtime subscription — refetch on any task change
  useEffect(() => {
    if (!userId) return;

    const channel: RealtimeChannel = supabase
      .channel(`token-counter-${userId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'agent_tasks',
          filter: `user_id=eq.${userId}`,
        },
        () => {
          fetchTodaysCost();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId, fetchTodaysCost]);

  return { totalCostToday, recentTasks };
}
