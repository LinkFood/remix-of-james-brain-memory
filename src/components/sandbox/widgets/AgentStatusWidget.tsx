/**
 * AgentStatusWidget — Live agent status pills.
 */

import { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';
import { useDashboardActivity } from '@/hooks/useDashboardActivity';
import { AGENT_DEFS, deriveAgentStates } from '@/lib/agents';
import type { AgentTask } from '@/types/agent';
import type { WidgetProps } from '@/types/widget';

export default function AgentStatusWidget({ onNavigate }: WidgetProps) {
  const [userId, setUserId] = useState('');

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) setUserId(session.user.id);
    });
  }, []);

  const { tasks, loading } = useDashboardActivity(userId);
  const agentStates = deriveAgentStates(tasks as unknown as AgentTask[]);

  // Exclude dispatcher from display
  const displayAgents = AGENT_DEFS.filter(a => a.id !== 'jac-dispatcher');

  return (
    <div className="flex flex-col h-full bg-white/[0.03] backdrop-blur-sm border border-white/10 rounded-lg overflow-hidden">
      <div className="px-3 py-2 border-b border-white/10 shrink-0">
        <span className="text-xs font-medium text-white/70">Agent Status</span>
      </div>

      <div className="flex-1 flex flex-col gap-1.5 p-2 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center h-16">
            <span className="text-[10px] text-white/30">Loading...</span>
          </div>
        ) : (
          displayAgents.map(agent => {
            const state = agentStates.get(agent.id);
            const isWorking = state?.status === 'working';
            const isFailed = state?.status === 'failed';

            return (
              <button
                key={agent.id}
                onClick={() => onNavigate('/jac')}
                className={cn(
                  'flex items-center gap-2.5 px-2.5 py-2 rounded-md border transition-all text-left',
                  isWorking
                    ? 'bg-white/[0.06] border-white/15'
                    : 'bg-white/[0.02] border-white/5 opacity-60 hover:opacity-80'
                )}
              >
                <span className="relative flex items-center shrink-0">
                  <span
                    className={cn(
                      'w-2 h-2 rounded-full',
                      agent.dotColor,
                      isWorking && 'animate-pulse'
                    )}
                  />
                </span>
                <span className="text-xs text-white/80 font-medium w-12 shrink-0">
                  {agent.name}
                </span>
                <span
                  className={cn(
                    'text-[10px] flex-1 truncate',
                    isWorking ? 'text-white/60' : isFailed ? 'text-red-400/70' : 'text-white/30'
                  )}
                >
                  {isWorking
                    ? (state?.currentTask ?? 'Working...')
                    : isFailed
                    ? 'Failed'
                    : state?.status === 'done'
                    ? (state.lastResult ?? 'Done')
                    : 'Idle'}
                </span>
                {state && state.taskCount > 0 && (
                  <span className="text-[10px] text-white/25 shrink-0">
                    {state.taskCount}
                  </span>
                )}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
