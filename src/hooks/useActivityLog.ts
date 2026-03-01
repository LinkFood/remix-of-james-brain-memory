/**
 * useActivityLog — Firehose feed of all JAC activity.
 *
 * Merges agent_tasks, agent_activity_log, and jac_reflections into
 * a single reverse-chronological feed with filtering and pagination.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { RealtimeChannel } from '@supabase/supabase-js';

// --------------- Types ---------------

export type ActivityItemType = 'task' | 'activity' | 'reflection';
export type AgentTypeFilter = 'all' | 'research' | 'save' | 'search' | 'code' | 'general';
export type StatusFilter = 'all' | 'completed' | 'running' | 'failed' | 'cancelled';

export interface ActivityFilters {
  type: ActivityItemType | 'all';
  agentType: AgentTypeFilter;
  status: StatusFilter;
}

interface TaskItem {
  kind: 'task';
  id: string;
  agent: string | null;
  type: string;
  intent: string;
  status: string;
  cost_usd: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface ActivityStepItem {
  kind: 'activity';
  id: string;
  task_id: string;
  agent: string;
  step: string;
  status: string;
  detail: Record<string, unknown>;
  duration_ms: number | null;
  created_at: string;
}

interface ReflectionItem {
  kind: 'reflection';
  id: string;
  task_type: string;
  intent: string | null;
  summary: string;
  connections: string[] | null;
  created_at: string;
}

export type ActivityItem = TaskItem | ActivityStepItem | ReflectionItem;

export interface UseActivityLogReturn {
  items: ActivityItem[];
  isLoading: boolean;
  loadMore: () => void;
  hasMore: boolean;
  filters: ActivityFilters;
  setFilters: (f: ActivityFilters) => void;
}

const PAGE_SIZE = 50;

// Normalize agent column to a display-friendly filter key
function agentToFilterKey(agent: string | null | undefined): string {
  if (!agent) return 'general';
  if (agent.includes('research')) return 'research';
  if (agent.includes('save')) return 'save';
  if (agent.includes('search')) return 'search';
  if (agent.includes('code')) return 'code';
  if (agent.includes('dispatcher')) return 'general';
  return 'general';
}

export function useActivityLog(userId: string): UseActivityLogReturn {
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [hasMore, setHasMore] = useState(true);
  const [filters, setFilters] = useState<ActivityFilters>({
    type: 'all',
    agentType: 'all',
    status: 'all',
  });
  const offsetRef = useRef({ tasks: 0, activities: 0, reflections: 0 });

  // Fetch a page of data from all 3 sources, merge, sort
  const fetchPage = useCallback(
    async (append: boolean) => {
      if (!userId) return;
      if (!append) {
        offsetRef.current = { tasks: 0, activities: 0, reflections: 0 };
        setHasMore(true);
      }

      setIsLoading(true);

      const shouldFetchTasks =
        filters.type === 'all' || filters.type === 'task';
      const shouldFetchActivities =
        filters.type === 'all' || filters.type === 'activity';
      const shouldFetchReflections =
        (filters.type === 'all' || filters.type === 'reflection') &&
        filters.status === 'all'; // reflections don't have status

      const results: ActivityItem[] = [];

      // --- Tasks ---
      if (shouldFetchTasks) {
        let query = supabase
          .from('agent_tasks')
          .select(
            'id, agent, type, intent, status, cost_usd, tokens_in, tokens_out, created_at, updated_at, completed_at',
          )
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .range(
            offsetRef.current.tasks,
            offsetRef.current.tasks + PAGE_SIZE - 1,
          );

        if (filters.status !== 'all') {
          query = query.eq('status', filters.status);
        }

        const { data } = await query;
        if (data) {
          const typed = data as Array<{
            id: string;
            agent: string | null;
            type: string;
            intent: string;
            status: string;
            cost_usd: number | null;
            tokens_in: number | null;
            tokens_out: number | null;
            created_at: string;
            updated_at: string;
            completed_at: string | null;
          }>;
          for (const t of typed) {
            if (
              filters.agentType !== 'all' &&
              agentToFilterKey(t.agent) !== filters.agentType
            )
              continue;
            results.push({ kind: 'task', ...t });
          }
          offsetRef.current.tasks += typed.length;
          if (typed.length < PAGE_SIZE) {
            // No more tasks
          }
        }
      }

      // --- Activity steps ---
      if (shouldFetchActivities) {
        const { data } = await (supabase
          .from('agent_activity_log' as any)
          .select('id, task_id, agent, step, status, detail, duration_ms, created_at')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .range(
            offsetRef.current.activities,
            offsetRef.current.activities + PAGE_SIZE - 1,
          ) as any);

        if (data) {
          const typed = data as Array<{
            id: string;
            task_id: string;
            agent: string;
            step: string;
            status: string;
            detail: Record<string, unknown>;
            duration_ms: number | null;
            created_at: string;
          }>;
          for (const a of typed) {
            if (
              filters.agentType !== 'all' &&
              agentToFilterKey(a.agent) !== filters.agentType
            )
              continue;
            results.push({ kind: 'activity', ...a });
          }
          offsetRef.current.activities += typed.length;
        }
      }

      // --- Reflections ---
      if (shouldFetchReflections) {
        const { data } = await (supabase
          .from('jac_reflections' as any)
          .select('id, task_type, intent, summary, connections, created_at')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .range(
            offsetRef.current.reflections,
            offsetRef.current.reflections + PAGE_SIZE - 1,
          ) as any);

        if (data) {
          const typed = data as Array<{
            id: string;
            task_type: string;
            intent: string | null;
            summary: string;
            connections: string[] | null;
            created_at: string;
          }>;
          for (const r of typed) {
            if (
              filters.agentType !== 'all' &&
              agentToFilterKey(r.task_type) !== filters.agentType &&
              r.task_type !== filters.agentType
            )
              continue;
            results.push({ kind: 'reflection', ...r });
          }
          offsetRef.current.reflections += typed.length;
        }
      }

      // Sort merged results by created_at DESC
      results.sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      );

      // If we got fewer than PAGE_SIZE from ALL sources combined, no more data
      if (results.length < PAGE_SIZE) {
        setHasMore(false);
      }

      if (append) {
        setItems((prev) => [...prev, ...results]);
      } else {
        setItems(results);
      }

      setIsLoading(false);
    },
    [userId, filters],
  );

  // Initial fetch + re-fetch when filters change
  useEffect(() => {
    fetchPage(false);
  }, [fetchPage]);

  // Load more
  const loadMore = useCallback(() => {
    if (!hasMore || isLoading) return;
    fetchPage(true);
  }, [fetchPage, hasMore, isLoading]);

  // Realtime subscription on agent_tasks for live updates
  useEffect(() => {
    if (!userId) return;

    const channel: RealtimeChannel = supabase
      .channel(`activity-log-${userId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'agent_tasks',
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          const t = payload.new as {
            id: string;
            agent: string | null;
            type: string;
            intent: string;
            status: string;
            cost_usd: number | null;
            tokens_in: number | null;
            tokens_out: number | null;
            created_at: string;
            updated_at: string;
            completed_at: string | null;
          };

          // Apply current filters
          if (filters.type !== 'all' && filters.type !== 'task') return;
          if (filters.status !== 'all' && t.status !== filters.status) return;
          if (
            filters.agentType !== 'all' &&
            agentToFilterKey(t.agent) !== filters.agentType
          )
            return;

          const item: TaskItem = { kind: 'task', ...t };
          setItems((prev) => [item, ...prev]);
        },
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'agent_tasks',
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          const t = payload.new as {
            id: string;
            agent: string | null;
            type: string;
            intent: string;
            status: string;
            cost_usd: number | null;
            tokens_in: number | null;
            tokens_out: number | null;
            created_at: string;
            updated_at: string;
            completed_at: string | null;
          };

          setItems((prev) =>
            prev.map((item) =>
              item.kind === 'task' && item.id === t.id
                ? { kind: 'task', ...t }
                : item,
            ),
          );
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId, filters]);

  return { items, isLoading, loadMore, hasMore, filters, setFilters };
}
