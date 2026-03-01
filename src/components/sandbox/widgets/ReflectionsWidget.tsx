/**
 * ReflectionsWidget — JAC's recent reflections on completed tasks.
 */

import { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';
import type { WidgetProps } from '@/types/widget';

const TASK_TYPE_BADGES: Record<string, string> = {
  research: 'bg-cyan-500/20 text-cyan-400',
  save: 'bg-emerald-500/20 text-emerald-400',
  search: 'bg-blue-500/20 text-blue-400',
  code: 'bg-indigo-500/20 text-indigo-400',
  general: 'bg-white/10 text-white/50',
};

interface Reflection {
  id: string;
  task_type: string;
  summary: string;
  connections: string[] | null;
  created_at: string;
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

export default function ReflectionsWidget({ compact }: WidgetProps) {
  const [userId, setUserId] = useState('');
  const [reflections, setReflections] = useState<Reflection[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) setUserId(session.user.id);
    });
  }, []);

  // Fetch reflections
  useEffect(() => {
    if (!userId) return;

    async function fetchReflections() {
      setLoading(true);
      const { data, error } = await supabase
        .from('jac_reflections' as any)
        .select('id, task_type, summary, connections, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(10);

      if (!error && data) {
        setReflections(data as unknown as Reflection[]);
      }
      setLoading(false);
    }

    fetchReflections();
  }, [userId]);

  // Realtime subscription
  useEffect(() => {
    if (!userId) return;

    const channel = supabase
      .channel('reflections-widget')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'jac_reflections',
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          const newReflection = payload.new as unknown as Reflection;
          setReflections(prev => [newReflection, ...prev].slice(0, 10));
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId]);

  const visible = reflections.slice(0, compact ? 4 : 10);

  return (
    <div className="flex flex-col h-full bg-white/[0.03] backdrop-blur-sm border border-white/10 rounded-lg overflow-hidden">
      <div className="px-3 py-2 border-b border-white/10 shrink-0 flex items-center justify-between">
        <span className="text-xs font-medium text-white/70">Reflections</span>
        {!loading && reflections.length > 0 && (
          <span className="text-[10px] text-white/30">{reflections.length}</span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center h-16">
            <span className="text-[10px] text-white/30">Loading...</span>
          </div>
        ) : visible.length === 0 ? (
          <div className="flex items-center justify-center h-16">
            <span className="text-[10px] text-white/30">JAC hasn't reflected yet</span>
          </div>
        ) : (
          <div className="divide-y divide-white/5">
            {visible.map(ref => (
              <div
                key={ref.id}
                className="flex items-start gap-2 px-3 py-2"
              >
                <span
                  className={cn(
                    'text-[9px] px-1.5 py-0.5 rounded font-medium uppercase tracking-wide shrink-0 mt-0.5',
                    TASK_TYPE_BADGES[ref.task_type] ?? 'bg-white/10 text-white/50'
                  )}
                >
                  {ref.task_type}
                </span>
                <div className="flex-1 min-w-0">
                  <span className="text-xs text-white/70 line-clamp-2">
                    {ref.summary}
                  </span>
                  {ref.connections && ref.connections.length > 0 && (
                    <span className="text-[10px] text-white/30 mt-0.5 block">
                      {ref.connections.length} connection{ref.connections.length !== 1 ? 's' : ''}
                    </span>
                  )}
                </div>
                <span className="text-[10px] text-white/30 shrink-0">
                  {timeAgo(ref.created_at)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
