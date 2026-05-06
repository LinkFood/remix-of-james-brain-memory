/**
 * useTokenCounter — unified daily Claude cost view.
 *
 * Sums TWO sources for "today's" total:
 *   - agent_tasks.cost_usd   (JAC dispatcher: research/save/search/code)
 *   - ct_claude_usage.cost_usd  (every Co-Trader cron — specialists, watcher,
 *     tape-reader, EOD, brief, news-ingester, self-grader, idea-generator,
 *     curiosity, replay)
 *
 * Also returns a 7-day rolling series so the popover can show daily/weekly
 * spend at a glance without a trip to /cost.
 *
 * Realtime: subscribes to BOTH tables — a CT specialist firing during RTH
 * updates the indicator immediately.
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

export interface CtSourceBreakdown {
  source: string;
  calls: number;
  cost: number;
}

export interface DayCost {
  date: string; // YYYY-MM-DD local
  cost: number;
}

function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function useTokenCounter(userId: string) {
  const [totalCostToday, setTotalCostToday] = useState(0);
  const [jacCostToday, setJacCostToday] = useState(0);
  const [ctCostToday, setCtCostToday] = useState(0);
  const [recentTasks, setRecentTasks] = useState<RecentTask[]>([]);
  const [ctBreakdownToday, setCtBreakdownToday] = useState<CtSourceBreakdown[]>([]);
  const [last7Days, setLast7Days] = useState<DayCost[]>([]);

  const fetchAll = useCallback(async () => {
    if (!userId) return;

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6); // 7-day window inclusive of today
    sevenDaysAgo.setHours(0, 0, 0, 0);

    try {
      const [jacTodayRes, ctTodayRes, jac7dRes, ct7dRes] = await Promise.all([
        supabase
          .from('agent_tasks')
          .select('id, intent, agent, cost_usd, created_at')
          .eq('user_id', userId)
          .gte('created_at', todayStart.toISOString())
          .order('created_at', { ascending: false })
          .limit(50),
        supabase
          .from('ct_claude_usage')
          .select('source, cost_usd, created_at')
          .gte('created_at', todayStart.toISOString()),
        supabase
          .from('agent_tasks')
          .select('cost_usd, created_at')
          .eq('user_id', userId)
          .gte('created_at', sevenDaysAgo.toISOString()),
        supabase
          .from('ct_claude_usage')
          .select('cost_usd, created_at')
          .gte('created_at', sevenDaysAgo.toISOString()),
      ]);

      // JAC today
      const jacTasks = (jacTodayRes.data ?? []) as RecentTask[];
      const jacTotal = jacTasks.reduce((s, t) => s + (t.cost_usd ?? 0), 0);

      // CT today
      const ctRows = (ctTodayRes.data ?? []) as Array<{
        source: string | null;
        cost_usd: number | null;
        created_at: string;
      }>;
      const ctTotal = ctRows.reduce((s, r) => s + (r.cost_usd ?? 0), 0);

      // CT breakdown by source (top spenders today)
      const bySource = new Map<string, { calls: number; cost: number }>();
      for (const r of ctRows) {
        const s = r.source ?? '?';
        const cur = bySource.get(s) ?? { calls: 0, cost: 0 };
        cur.calls += 1;
        cur.cost += r.cost_usd ?? 0;
        bySource.set(s, cur);
      }
      const breakdown: CtSourceBreakdown[] = Array.from(bySource.entries())
        .map(([source, v]) => ({ source, calls: v.calls, cost: v.cost }))
        .sort((a, b) => b.cost - a.cost);

      // 7-day rolling — combine JAC + CT, group by local date
      const jac7Rows = (jac7dRes.data ?? []) as Array<{ cost_usd: number | null; created_at: string }>;
      const ct7Rows = (ct7dRes.data ?? []) as Array<{ cost_usd: number | null; created_at: string }>;
      const dayMap = new Map<string, number>();
      for (const r of [...jac7Rows, ...ct7Rows]) {
        const key = localDateKey(new Date(r.created_at));
        dayMap.set(key, (dayMap.get(key) ?? 0) + (r.cost_usd ?? 0));
      }
      const days: DayCost[] = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const key = localDateKey(d);
        days.push({ date: key, cost: dayMap.get(key) ?? 0 });
      }

      setJacCostToday(jacTotal);
      setCtCostToday(ctTotal);
      setTotalCostToday(jacTotal + ctTotal);
      setRecentTasks(jacTasks.slice(0, 10));
      setCtBreakdownToday(breakdown.slice(0, 8));
      setLast7Days(days);
    } catch (err) {
      console.warn('[useTokenCounter] fetch failed (non-blocking):', err);
    }
  }, [userId]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  // Polling — realtime INSERT events on ct_claude_usage are unreliable
  // (same class as the agent_conversations gotcha), so a 30s tick is the
  // primary refresh path. Also refetch on window focus.
  useEffect(() => {
    if (!userId) return;
    const interval = setInterval(fetchAll, 30_000);
    const onFocus = () => fetchAll();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, [userId, fetchAll]);

  // Realtime — best-effort fast path. agent_tasks INSERT for the user is
  // reliable; ct_claude_usage INSERT often misses, which is why polling is
  // load-bearing above.
  useEffect(() => {
    if (!userId) return;
    const channel: RealtimeChannel = supabase
      .channel(`token-counter-${userId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'agent_tasks', filter: `user_id=eq.${userId}` },
        () => fetchAll(),
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'ct_claude_usage' },
        () => fetchAll(),
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId, fetchAll]);

  const weeklyCost = last7Days.reduce((s, d) => s + d.cost, 0);

  return {
    totalCostToday,
    jacCostToday,
    ctCostToday,
    recentTasks,
    ctBreakdownToday,
    last7Days,
    weeklyCost,
  };
}
