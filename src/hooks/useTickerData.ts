/**
 * useTickerData — Lightweight hook for the global Ticker bar
 *
 * Queries only the minimum data needed: running task count + agents,
 * today's reminder count, and the latest code session.
 * Realtime subscription on agent_tasks for live updates.
 */

import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { RealtimeChannel } from '@supabase/supabase-js';

interface TickerData {
  runningTasks: { count: number; agents: string[] };
  reminders: { todayCount: number; overdueCount: number };
  latestCodeSession: { branch: string; status: string; prUrl: string | null } | null;
  loading: boolean;
}

const AGENT_LABELS: Record<string, string> = {
  'jac-dispatcher': 'JAC',
  'jac-research-agent': 'Research',
  'jac-save-agent': 'Save',
  'jac-search-agent': 'Search',
  'jac-code-agent': 'Code',
};

export function useTickerData(userId: string): TickerData {
  const [runningTasks, setRunningTasks] = useState<{ count: number; agents: string[] }>({ count: 0, agents: [] });
  const [reminders, setReminders] = useState<{ todayCount: number; overdueCount: number }>({ todayCount: 0, overdueCount: 0 });
  const [latestCodeSession, setLatestCodeSession] = useState<{ branch: string; status: string; prUrl: string | null } | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchRunningTasks = useCallback(async () => {
    try {
      const { data } = await supabase
        .from('agent_tasks')
        .select('agent')
        .eq('user_id', userId)
        .eq('status', 'running');

      if (data) {
        const agents = [...new Set(
          (data as { agent: string }[])
            .map(t => AGENT_LABELS[t.agent] || t.agent)
            .filter(Boolean)
        )];
        setRunningTasks({ count: data.length, agents });
      }
    } catch (err) {
      console.warn('[useTickerData] fetchRunningTasks failed (non-blocking):', err);
    }
  }, [userId]);

  const fetchReminders = useCallback(async () => {
    try {
      const todayStr = new Date().toISOString().split('T')[0];

      const { data } = await supabase
        .from('entries')
        .select('event_date')
        .eq('user_id', userId)
        .eq('archived', false)
        .not('event_date', 'is', null)
        .lte('event_date', todayStr);

      if (data) {
        let todayCount = 0;
        let overdueCount = 0;
        for (const entry of data as { event_date: string }[]) {
          if (entry.event_date === todayStr) todayCount++;
          else if (entry.event_date < todayStr) overdueCount++;
        }
        setReminders({ todayCount, overdueCount });
      }
    } catch (err) {
      console.warn('[useTickerData] fetchReminders failed (non-blocking):', err);
    }
  }, [userId]);

  const fetchLatestCodeSession = useCallback(async () => {
    try {
      const { data } = await supabase
        .from('code_sessions')
        .select('branch_name, status, pr_url')
        .eq('user_id', userId)
        .order('updated_at', { ascending: false })
        .limit(1);

      if (data && data.length > 0) {
        const session = data[0] as { branch_name: string; status: string; pr_url: string | null };
        setLatestCodeSession({
          branch: session.branch_name,
          status: session.status,
          prUrl: session.pr_url,
        });
      }
    } catch (err) {
      console.warn('[useTickerData] fetchLatestCodeSession failed (non-blocking):', err);
    }
  }, [userId]);

  // Initial fetch
  useEffect(() => {
    if (!userId) return;

    Promise.all([fetchRunningTasks(), fetchReminders(), fetchLatestCodeSession()])
      .finally(() => setLoading(false));
  }, [userId, fetchRunningTasks, fetchReminders, fetchLatestCodeSession]);

  // Realtime subscription on agent_tasks for live running count
  useEffect(() => {
    if (!userId) return;

    const channel: RealtimeChannel = supabase
      .channel(`ticker-tasks-${userId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'agent_tasks',
          filter: `user_id=eq.${userId}`,
        },
        () => {
          // Refetch running tasks on any task change
          fetchRunningTasks();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId, fetchRunningTasks]);

  // Refresh reminders every 5 minutes (they don't change often)
  useEffect(() => {
    if (!userId) return;
    const interval = setInterval(fetchReminders, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [userId, fetchReminders]);

  return { runningTasks, reminders, latestCodeSession, loading };
}
