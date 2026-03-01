/**
 * AgentActivityWidget — Recent completed agent tasks in a vertical list.
 */

import { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';
import { useDashboardActivity } from '@/hooks/useDashboardActivity';
import { AGENT_DEFS } from '@/lib/agents';
import type { WidgetProps } from '@/types/widget';

function timeAgo(dateStr: string): string {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'now';
  if (diffMin < 60) return `${diffMin}m`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h`;
  return `${Math.floor(diffH / 24)}d`;
}

export default function AgentActivityWidget({ compact, onNavigate }: WidgetProps) {
  const [userId, setUserId] = useState('');

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) setUserId(session.user.id);
    });
  }, []);

  const { tasks, loading } = useDashboardActivity(userId);

  const visible = tasks
    .filter(t => t.status === 'completed' || t.status === 'failed')
    .slice(0, compact ? 4 : 8);

  return (
    <div className="flex flex-col h-full bg-white/[0.03] backdrop-blur-sm border border-white/10 rounded-lg overflow-hidden">
      <div className="px-3 py-2 border-b border-white/10 flex items-center justify-between shrink-0">
        <span className="text-xs font-medium text-white/70">Agent Activity</span>
        {!loading && (
          <span className="text-[10px] text-white/30">{tasks.length} tasks</span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center h-16">
            <span className="text-[10px] text-white/30">Loading...</span>
          </div>
        ) : visible.length === 0 ? (
          <div className="flex items-center justify-center h-16">
            <span className="text-[10px] text-white/30">No recent activity</span>
          </div>
        ) : (
          <div className="divide-y divide-white/5">
            {visible.map(task => {
              const def = AGENT_DEFS.find(a => a.id === task.agent);
              const intent = task.intent || (task.output as Record<string, unknown> | null)?.brief as string | undefined || task.agent;
              const failed = task.status === 'failed';
              return (
                <button
                  key={task.id}
                  onClick={() => onNavigate('/jac')}
                  className="w-full flex items-center gap-2 px-3 py-2 hover:bg-white/[0.04] transition-colors text-left"
                >
                  <span
                    className={cn(
                      'w-1.5 h-1.5 rounded-full shrink-0',
                      failed ? 'bg-red-500' : (def?.dotColor ?? 'bg-white/30')
                    )}
                  />
                  <span className="text-[10px] text-white/50 shrink-0 w-10">
                    {def?.name ?? 'Agent'}
                  </span>
                  <span className="text-xs text-white/70 flex-1 truncate">
                    {String(intent).slice(0, 60)}
                  </span>
                  <span className="text-[10px] text-white/30 shrink-0">
                    {timeAgo(task.updated_at)}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
