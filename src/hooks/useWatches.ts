/**
 * useWatches — Manage recurring watch tasks.
 *
 * Watches are agent_tasks with cron_expression set.
 * Each watch execution creates a child task.
 */

import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import type { RealtimeChannel } from '@supabase/supabase-js';

export interface Watch {
  id: string;
  intent: string;
  type: string;
  cron_expression: string;
  cron_active: boolean;
  next_run_at: string | null;
  created_at: string;
  input: {
    query: string;
    watchName?: string;
    frequency?: string;
    modelTier?: string;
    timezone?: string;
  };
  totalRuns: number;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  totalCost: number;
}

export function useWatches() {
  const [watches, setWatches] = useState<Watch[]>([]);
  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState('');

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) setUserId(session.user.id);
    });
  }, []);

  const fetchWatches = useCallback(async () => {
    if (!userId) return;

    // Fetch watch templates (tasks with cron_expression set)
    const { data: watchTasks } = await supabase
      .from('agent_tasks')
      .select('id, intent, type, cron_expression, cron_active, next_run_at, created_at, input')
      .eq('user_id', userId)
      .not('cron_expression', 'is', null)
      .order('created_at', { ascending: false });

    if (!watchTasks) {
      setWatches([]);
      return;
    }

    // For each watch, get child task stats
    const enriched: Watch[] = await Promise.all(
      watchTasks.map(async (w) => {
        const { data: runs } = await supabase
          .from('agent_tasks')
          .select('id, status, completed_at, cost_usd')
          .eq('parent_task_id', w.id)
          .order('completed_at', { ascending: false });

        const completedRuns = (runs || []).filter(r => r.status === 'completed');
        const lastRun = completedRuns[0];
        const totalCost = (runs || []).reduce((sum, r) => sum + (r.cost_usd || 0), 0);

        return {
          id: w.id,
          intent: w.intent || '',
          type: w.type || 'research',
          cron_expression: w.cron_expression!,
          cron_active: w.cron_active ?? false,
          next_run_at: w.next_run_at,
          created_at: w.created_at,
          input: (w.input as Watch['input']) || { query: '' },
          totalRuns: (runs || []).length,
          lastRunAt: lastRun?.completed_at || null,
          lastRunStatus: lastRun?.status || null,
          totalCost: Math.round(totalCost * 1000) / 1000,
        };
      })
    );

    setWatches(enriched);
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    fetchWatches().finally(() => setLoading(false));
  }, [userId, fetchWatches]);

  // Realtime subscription
  useEffect(() => {
    if (!userId) return;
    const channel: RealtimeChannel = supabase
      .channel(`watches-${userId}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'agent_tasks',
        filter: `user_id=eq.${userId}`,
      }, () => { fetchWatches(); })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [userId, fetchWatches]);

  const toggleWatch = useCallback(async (id: string, active: boolean) => {
    await supabase
      .from('agent_tasks')
      .update({
        cron_active: active,
        ...(active ? { status: 'running' } : { status: 'completed', completed_at: new Date().toISOString() }),
      })
      .eq('id', id);
    // Optimistic update
    setWatches(prev => prev.map(w => w.id === id ? { ...w, cron_active: active } : w));
  }, []);

  const deleteWatch = useCallback(async (id: string) => {
    await supabase
      .from('agent_tasks')
      .update({ cron_active: false, status: 'cancelled', completed_at: new Date().toISOString() })
      .eq('id', id);
    setWatches(prev => prev.filter(w => w.id !== id));
  }, []);

  const updateModelTier = useCallback(async (id: string, modelTier: string) => {
    const watch = watches.find(w => w.id === id);
    if (!watch) return;
    const newInput = { ...watch.input, modelTier };
    await supabase
      .from('agent_tasks')
      .update({ input: newInput })
      .eq('id', id);
    setWatches(prev => prev.map(w => w.id === id ? { ...w, input: newInput } : w));
  }, [watches]);

  const createWatch = useCallback(async (params: {
    watchName: string;
    query: string;
    cronExpression: string;
    modelTier: string;
    agentType: string;
  }): Promise<string | null> => {
    if (!userId) return null;

    // Get user's Slack channel
    const { data: settings } = await supabase
      .from('user_settings')
      .select('settings')
      .eq('user_id', userId)
      .single();
    const slackChannel = (settings?.settings as Record<string, unknown>)?.slack_channel_id as string | undefined;

    const nextRunAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

    const { data, error } = await supabase
      .from('agent_tasks')
      .insert({
        user_id: userId,
        type: 'research',
        status: 'running',
        intent: params.watchName,
        agent: 'jac-watch-scheduler',
        cron_expression: params.cronExpression,
        cron_active: true,
        next_run_at: nextRunAt,
        input: {
          query: params.query,
          watchName: params.watchName,
          agentType: params.agentType,
          modelTier: params.modelTier,
          timezone: 'America/Chicago',
          slack_channel: slackChannel || null,
          createdAt: new Date().toISOString(),
        },
      })
      .select('id')
      .single();

    if (error || !data) {
      toast.error('Failed to create watch');
      return null;
    }

    toast.success(`Watch created: "${params.watchName}"`);
    fetchWatches();
    return data.id;
  }, [userId, fetchWatches]);

  const updateWatch = useCallback(async (id: string, params: {
    watchName?: string;
    query?: string;
    cronExpression?: string;
    modelTier?: string;
    agentType?: string;
  }) => {
    const watch = watches.find(w => w.id === id);
    if (!watch) return;

    const updates: Record<string, unknown> = {};
    const newInput = { ...watch.input };

    if (params.watchName !== undefined) {
      updates.intent = params.watchName;
      newInput.watchName = params.watchName;
    }
    if (params.query !== undefined) {
      newInput.query = params.query;
    }
    if (params.modelTier !== undefined) {
      newInput.modelTier = params.modelTier;
    }
    if (params.agentType !== undefined) {
      newInput.agentType = params.agentType;
    }
    if (params.cronExpression !== undefined) {
      updates.cron_expression = params.cronExpression;
      updates.next_run_at = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    }

    updates.input = newInput;

    const { error } = await supabase
      .from('agent_tasks')
      .update(updates)
      .eq('id', id);

    if (error) {
      toast.error('Failed to update watch');
      return;
    }

    toast.success('Watch updated');
    fetchWatches();
  }, [watches, fetchWatches]);

  const triggerRun = useCallback(async (watchId: string) => {
    const { data, error } = await supabase.functions.invoke('trigger-watch-run', {
      body: { action: 'run_now', watchId },
    });

    if (error || !data?.success) {
      toast.error('Failed to trigger run');
      return;
    }

    toast.success('Watch run triggered');
  }, []);

  const skipNextRun = useCallback(async (watchId: string) => {
    const { data, error } = await supabase.functions.invoke('trigger-watch-run', {
      body: { action: 'skip_next', watchId },
    });

    if (error || !data?.success) {
      toast.error('Failed to skip next run');
      return;
    }

    toast.success(`Next run skipped`);
    fetchWatches();
  }, [fetchWatches]);

  return {
    watches, loading, userId, fetchWatches,
    toggleWatch, deleteWatch, updateModelTier,
    createWatch, updateWatch, triggerRun, skipNextRun,
  };
}
