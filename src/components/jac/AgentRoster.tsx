/**
 * AgentRoster — Visual HQ showing all agent types and their current status
 *
 * Each agent is a "desk" in the office. When working, they pulse.
 * When idle, they're dim. When done, they show their last result.
 */

import { useMemo, useState } from 'react';
import {
  FileText, Brain,
  Loader2, Zap, Globe, Code2,
} from 'lucide-react';
import type { AgentTask, ActivityLogEntry } from '@/types/agent';
import { AGENT_DEFS, deriveAgentStates, type AgentStatus } from '@/lib/agents';
import { AgentDeskDrawer } from './AgentDeskDrawer';

/** Icons live here (JSX, not extractable to pure data module) */
const AGENT_ICONS: Record<string, React.ReactNode> = {
  'jac-dispatcher': <Zap className="w-5 h-5" />,
  'jac-research-agent': <Globe className="w-5 h-5" />,
  'jac-save-agent': <FileText className="w-5 h-5" />,
  'jac-search-agent': <Brain className="w-5 h-5" />,
  'jac-code-agent': <Code2 className="w-5 h-5" />,
};

const STATUS_STYLES: Record<AgentStatus, string> = {
  idle: 'opacity-40 border-border',
  working: 'opacity-100 border-blue-500/50 shadow-lg shadow-blue-500/10',
  done: 'opacity-90 border-green-500/30',
  failed: 'opacity-70 border-red-500/30',
};

interface AgentRosterProps {
  tasks: AgentTask[];
  activityLogs?: Map<string, ActivityLogEntry[]>;
}

export function AgentRoster({ tasks, activityLogs = new Map() }: AgentRosterProps) {
  const states = useMemo(() => deriveAgentStates(tasks), [tasks]);
  const activeCount = Array.from(states.values()).filter(s => s.status === 'working').length;
  const [selectedAgent, setSelectedAgent] = useState<AgentDef | null>(null);

  return (
    <div className="space-y-3">
      {/* Agent Desk Drawer */}
      {selectedAgent && (
        <AgentDeskDrawer
          open={!!selectedAgent}
          onOpenChange={(open) => { if (!open) setSelectedAgent(null); }}
          agentId={selectedAgent.id}
          agentName={selectedAgent.name}
          agentRole={selectedAgent.role}
          agentIcon={AGENT_ICONS[selectedAgent.id]}
          tasks={tasks}
          activityLogs={activityLogs}
        />
      )}

      {/* HQ Status Bar */}
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${activeCount > 0 ? 'bg-green-500 animate-pulse' : 'bg-muted-foreground/30'}`} />
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            {activeCount > 0 ? `${activeCount} agent${activeCount > 1 ? 's' : ''} active` : 'All agents standing by'}
          </span>
        </div>
        <span className="text-xs text-muted-foreground">
          {tasks.filter(t => t.status === 'completed').length} ops completed
        </span>
      </div>

      {/* Agent Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        {AGENT_DEFS.map((agent) => {
          const state = states.get(agent.id) || { status: 'idle' as AgentStatus, taskCount: 0 };
          return (
            <div
              key={agent.id}
              className={`relative rounded-lg border bg-card/50 p-3 transition-all duration-500 cursor-pointer hover:bg-muted/30 ${STATUS_STYLES[state.status]}`}
              onClick={() => setSelectedAgent(agent)}
            >
              {/* Working pulse ring */}
              {state.status === 'working' && (
                <div className="absolute inset-0 rounded-lg border-2 border-blue-500/30 animate-ping pointer-events-none" style={{ animationDuration: '2s' }} />
              )}

              <div className="relative flex items-start gap-2.5">
                {/* Agent icon with status indicator */}
                <div className={`relative shrink-0 w-9 h-9 rounded-lg flex items-center justify-center ${
                  state.status === 'working' ? agent.activeClasses :
                  state.status === 'done' ? agent.doneClasses :
                  'bg-muted/50 text-muted-foreground'
                }`}>
                  {state.status === 'working' ? (
                    <Loader2 className="w-5 h-5 animate-spin" />
                  ) : (
                    AGENT_ICONS[agent.id]
                  )}
                  <div className={`absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-card ${
                    state.status === 'working' ? 'bg-blue-500' :
                    state.status === 'done' ? 'bg-green-500' :
                    state.status === 'failed' ? 'bg-red-500' :
                    'bg-muted-foreground/30'
                  }`} />
                </div>

                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold leading-tight truncate">{agent.name}</p>
                  <p className="text-[10px] text-muted-foreground leading-tight mt-0.5 truncate">{agent.role}</p>
                </div>
              </div>

              {/* Current task / last result */}
              {state.status === 'working' && state.currentTask && (
                <p className="mt-2 text-[10px] text-blue-400 truncate leading-tight">
                  {state.currentTask}
                </p>
              )}
              {state.status === 'done' && state.lastResult && (
                <p className="mt-2 text-[10px] text-muted-foreground truncate leading-tight">
                  {state.lastResult}
                </p>
              )}
              {state.status === 'idle' && state.taskCount > 0 && (
                <p className="mt-2 text-[10px] text-muted-foreground/50 leading-tight">
                  {state.taskCount} ops done
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
