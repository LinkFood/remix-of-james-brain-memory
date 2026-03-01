/**
 * WatchesWidget — Dashboard widget showing active watches at a glance.
 *
 * Queries agent_tasks where cron_expression IS NOT NULL.
 * Follows the AgentOutputsWidget pattern exactly.
 */

import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Eye } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import type { WidgetProps } from '@/types/widget';
import type { RealtimeChannel } from '@supabase/supabase-js';

interface WatchSummary {
  id: string;
  name: string;
  query: string;
  cron_expression: string;
  cron_active: boolean;
  next_run_at: string | null;
  totalRuns: number;
  lastRunAt: string | null;
  modelTier: string;
}

function timeAgo(dateStr: string): string {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'now';
  if (diffMin < 60) return `${diffMin}m`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h`;
  return `${Math.floor(diffH / 24)}d`;
}

function timeUntil(dateStr: string): string {
  const diffMs = new Date(dateStr).getTime() - Date.now();
  if (diffMs < 0) return 'due';
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 60) return `${diffMin}m`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h`;
  return `${Math.floor(diffH / 24)}d`;
}

/** Convert cron schedule to human-readable */
function prettyCron(schedule: string): string {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return schedule;

  const [min, hour, , , dow] = parts;

  const everyMinMatch = min.match(/^\*\/(\d+)$/);
  if (everyMinMatch && hour === '*') return `Every ${everyMinMatch[1]}m`;

  if (min.match(/^\d+$/) && hour.match(/^\d+$/)) {
    const h = parseInt(hour);
    const m = parseInt(min);
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    const time = `${h12}:${m.toString().padStart(2, '0')} ${ampm}`;

    if (dow === '0') return `Sun ${time}`;
    if (dow !== '*') return `${time} (dow=${dow})`;
    return `Daily ${time}`;
  }

  return schedule;
}

export default function WatchesWidget({ compact, onNavigate }: WidgetProps) {
  const [userId, setUserId] = useState('');
  const [watches, setWatches] = useState<WatchSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) setUserId(session.user.id);
    });
  }, []);

  const fetchWatches = useCallback(async () => {
    if (!userId) return;

    const { data: watchTasks } = await supabase
      .from('agent_tasks')
      .select('id, intent, cron_expression, cron_active, next_run_at, input')
      .eq('user_id', userId)
      .not('cron_expression', 'is', null)
      .order('created_at', { ascending: false });

    if (!watchTasks) {
      setWatches([]);
      return;
    }

    const enriched: WatchSummary[] = await Promise.all(
      watchTasks.map(async (w) => {
        const { count } = await supabase
          .from('agent_tasks')
          .select('id', { count: 'exact', head: true })
          .eq('parent_task_id', w.id);

        const { data: lastRun } = await supabase
          .from('agent_tasks')
          .select('completed_at')
          .eq('parent_task_id', w.id)
          .eq('status', 'completed')
          .order('completed_at', { ascending: false })
          .limit(1);

        const input = (w.input as Record<string, unknown>) || {};

        return {
          id: w.id,
          name: (input.watchName as string) || w.intent || '',
          query: (input.query as string) || '',
          cron_expression: w.cron_expression!,
          cron_active: w.cron_active ?? false,
          next_run_at: w.next_run_at,
          totalRuns: count ?? 0,
          lastRunAt: lastRun?.[0]?.completed_at || null,
          modelTier: (input.modelTier as string) || 'haiku',
        };
      })
    );

    setWatches(enriched);
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    fetchWatches().finally(() => setLoading(false));
  }, [userId, fetchWatches]);

  // Realtime subscription for live updates
  useEffect(() => {
    if (!userId) return;

    const channel: RealtimeChannel = supabase
      .channel(`watches-widget-${userId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'agent_tasks',
          filter: `user_id=eq.${userId}`,
        },
        () => { fetchWatches(); }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [userId, fetchWatches]);

  const handleToggle = async (id: string, active: boolean) => {
    await supabase
      .from('agent_tasks')
      .update({
        cron_active: active,
        ...(active ? { status: 'running' } : { status: 'completed', completed_at: new Date().toISOString() }),
      })
      .eq('id', id);
    setWatches(prev => prev.map(w => w.id === id ? { ...w, cron_active: active } : w));
  };

  const visible = watches.slice(0, compact ? 2 : 8);

  return (
    <div className="flex flex-col h-full bg-white/[0.03] backdrop-blur-sm border border-white/10 rounded-lg overflow-hidden">
      <div className="px-3 py-2 border-b border-white/10 flex items-center justify-between shrink-0">
        <span className="text-xs font-medium text-white/70">Watches</span>
        <div className="flex items-center gap-2">
          {!loading && (
            <span className="text-[10px] text-white/30">
              {watches.filter(w => w.cron_active).length} active
            </span>
          )}
          {onNavigate && (
            <button
              onClick={() => onNavigate('/crons?tab=watches')}
              className="text-[10px] text-blue-400/70 hover:text-blue-400 transition-colors"
            >
              View all
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
        {loading ? (
          <div className="flex items-center justify-center h-16">
            <span className="text-[10px] text-white/30">Loading...</span>
          </div>
        ) : visible.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-16 gap-1">
            <Eye className="w-4 h-4 text-white/20" />
            <span className="text-[10px] text-white/30">No watches yet</span>
          </div>
        ) : (
          visible.map(watch => (
            <div key={watch.id} className="flex items-center gap-2 px-2 py-1.5 rounded bg-white/[0.02] border border-white/5">
              {/* Status dot */}
              <div className={cn('w-1.5 h-1.5 rounded-full shrink-0', watch.cron_active ? 'bg-emerald-400' : 'bg-white/20')} />

              {/* Name + schedule */}
              <div className="flex-1 min-w-0">
                <p className="text-[11px] text-white/70 font-medium truncate">{watch.name}</p>
                <div className="flex items-center gap-2 text-[9px] text-white/30">
                  <span>{prettyCron(watch.cron_expression)}</span>
                  <span>{watch.totalRuns} runs</span>
                  {watch.lastRunAt && <span>{timeAgo(watch.lastRunAt)}</span>}
                </div>
              </div>

              {/* Next run */}
              {watch.next_run_at && watch.cron_active && (
                <span className="text-[9px] text-white/25 shrink-0">{timeUntil(watch.next_run_at)}</span>
              )}

              {/* Model tier */}
              <span className={cn(
                'text-[9px] px-1 py-0.5 rounded shrink-0',
                watch.modelTier === 'opus' ? 'bg-purple-500/20 text-purple-400' :
                watch.modelTier === 'sonnet' ? 'bg-blue-500/20 text-blue-400' :
                'bg-white/5 text-white/30'
              )}>
                {watch.modelTier}
              </span>

              {/* Toggle */}
              <Switch
                checked={watch.cron_active}
                onCheckedChange={(checked) => handleToggle(watch.id, checked)}
                className="scale-[0.6] shrink-0"
              />
            </div>
          ))
        )}
      </div>
    </div>
  );
}
