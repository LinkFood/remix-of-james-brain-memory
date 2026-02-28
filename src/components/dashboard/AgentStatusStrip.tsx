/**
 * AgentStatusStrip — Compact row of agent pills with live status dots
 *
 * Shows all 5 agents as small pills. Working agents pulse.
 * Click navigates to /jac for the full nerve center.
 */

import { AGENT_DEFS, deriveAgentStates } from '@/lib/agents';
import { cn } from '@/lib/utils';
import type { DashboardActivityTask } from '@/hooks/useDashboardActivity';
import type { AgentTask } from '@/types/agent';

interface AgentStatusStripProps {
  tasks: DashboardActivityTask[];
  onNavigateToJac: () => void;
}

const AgentStatusStrip = ({ tasks, onNavigateToJac }: AgentStatusStripProps) => {
  // deriveAgentStates expects AgentTask[] — our lightweight tasks have the fields it needs
  const states = deriveAgentStates(tasks as unknown as AgentTask[]);

  return (
    <div>
      <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-2">
        Agent Status
      </p>
      <div
        className="flex flex-wrap gap-2 cursor-pointer"
        onClick={onNavigateToJac}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter') onNavigateToJac(); }}
      >
        {AGENT_DEFS.map((agent) => {
          const state = states.get(agent.id);
          const status = state?.status ?? 'idle';
          const isWorking = status === 'working';
          const isDone = status === 'done';
          const isFailed = status === 'failed';

          return (
            <div
              key={agent.id}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-all',
                isWorking && 'border-blue-500/40 bg-blue-500/10',
                isDone && 'border-green-500/30 bg-green-500/5',
                isFailed && 'border-red-500/30 bg-red-500/5',
                !isWorking && !isDone && !isFailed && 'opacity-50 border-border',
              )}
            >
              <div className={cn(
                'w-1.5 h-1.5 rounded-full',
                agent.dotColor,
                isWorking && 'animate-pulse',
                !isWorking && !isDone && !isFailed && 'opacity-40',
              )} />
              <span className={cn(
                'font-medium',
                isWorking && 'text-foreground',
                isDone && 'text-foreground/80',
                !isWorking && !isDone && 'text-muted-foreground',
              )}>
                {agent.name}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default AgentStatusStrip;
