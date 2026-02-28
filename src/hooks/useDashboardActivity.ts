/**
 * useDashboardActivity — Lightweight hook for dashboard command center
 *
 * Combines: recent agent tasks, active count, latest code session,
 * and reminder counts. Realtime subscription for live task updates.
 */

import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { RealtimeChannel } from '@supabase/supabase-js';
import type { AgentTask } from '@/types/agent';

export interface DashboardActivityTask {
  id: string;
  agent: string;
  status: string;
  intent: string | null;
  output: Record<string, unknown> | null;
  updated_at: string;
}

interface DashboardActivity {
  tasks: DashboardActivityTask[];
  activeCount: number;
  latestCodeSession: { branch: string; status: string; prUrl: string | null } | null;
  reminders: { todayCount: number; overdueCount: number };
  loading: boolean;
}

export function useDashboardActivity(userId: string): DashboardActivity {
  const [tasks, setTasks] = useState<DashboardActivityTask[]>([]);
  const [activeCount, setActiveCount] = useState(0);
  const [latestCodeSession, setLatestCodeSession] = useState<DashboardActivity['latestCodeSession']>(null);
  const [reminders, setReminders] = useState<DashboardActivity['reminders']>({ todayCount: 0, overdueCount: 0 });
  const [loading, setLoading] = useState(true);

  const fetchTasks = useCallback(async () => {
    const { data } = await supabase
      .from('agent_tasks')
      .select('id, agent, status, intent, output, updated_at')
      .eq('user_id', userId)
      .neq('agent', 'jac-dispatcher')
      .in('status', ['running', 'completed', 'failed'])
      .order('updated_at', { ascending: false })
      .limit(15);

    if (data) {
      const mapped: DashboardActivityTask[] = (data as Array<{
        id: string; agent: string; status: string;
        intent: string | null; output: Record<string, unknown> | null;
        updated_at: string;
      }>).map(t => ({
        id: t.id,
        agent: t.agent,
        status: t.status,
        intent: t.intent,
        output: t.output,
        updated_at: t.updated_at,
      }));
      setTasks(mapped);
      setActiveCount(mapped.filter(t => t.status === 'running').length);
    }
  }, [userId]);

  const fetchCodeSession = useCallback(async () => {
    const { data } = await supabase
      .from('code_sessions')
      .select('branch_name, status, pr_url')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false })
      .limit(1);

    if (data && data.length > 0) {
      const s = data[0] as { branch_name: string; status: string; pr_url: string | null };
      setLatestCodeSession({ branch: s.branch_name, status: s.status, prUrl: s.pr_url });
    }
  }, [userId]);

  const fetchReminders = useCallback(async () => {
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
  }, [userId]);

  // Initial fetch
  useEffect(() => {
    if (!userId) return;
    Promise.all([fetchTasks(), fetchCodeSession(), fetchReminders()])
      .finally(() => setLoading(false));
  }, [userId, fetchTasks, fetchCodeSession, fetchReminders]);

  // Realtime subscription on agent_tasks
  useEffect(() => {
    if (!userId) return;

    const channel: RealtimeChannel = supabase
      .channel(`dashboard-activity-${userId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'agent_tasks',
          filter: `user_id=eq.${userId}`,
        },
        () => { fetchTasks(); }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [userId, fetchTasks]);

  // Refresh reminders every 5 minutes
  useEffect(() => {
    if (!userId) return;
    const interval = setInterval(fetchReminders, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [userId, fetchReminders]);

  return { tasks, activeCount, latestCodeSession, reminders, loading };
}
