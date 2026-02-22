/**
 * AgentRoster — Visual HQ showing all agent types and their current status
 *
 * Each agent is a "desk" in the office. When working, they pulse.
 * When idle, they're dim. When done, they show their last result.
 */

import { useMemo, useState } from 'react';
import {
  Search, FileText, Brain, BarChart3, MessageSquare, Eye,
  Loader2, CheckCircle2, XCircle, Zap, Globe, BookOpen,
} from 'lucide-react';
import type { AgentTask, ActivityLogEntry } from '@/types/agent';
import { AgentDeskDrawer } from './AgentDeskDrawer';
import { Badge } from '@/components/ui/badge';

interface AgentDef {
  id: string;
  name: string;
  role: string;
  icon: React.ReactNode;
  activeClasses: string;
  doneClasses: string;
}

const AGENTS: AgentDef[] = [
  {
    id: 'jac-dispatcher', name: 'JAC', role: 'Boss · Routes commands',
    icon: <Zap className="w-5 h-5" />,
    activeClasses: 'bg-violet-500/20 text-violet-400',
    doneClasses: 'bg-violet-500/10 text-violet-500/70',
  },
  {
    id: 'jac-research-agent', name: 'Scout', role: 'Research · Web + Brain',
    icon: <Globe className="w-5 h-5" />,
    activeClasses: 'bg-blue-500/20 text-blue-400',
    doneClasses: 'bg-blue-500/10 text-blue-500/70',
  },
  {
    id: 'jac-save-agent', name: 'Scribe', role: 'Save · Classify · Store',
    icon: <FileText className="w-5 h-5" />,
    activeClasses: 'bg-emerald-500/20 text-emerald-400',
    doneClasses: 'bg-emerald-500/10 text-emerald-500/70',
  },
  {
    id: 'jac-search-agent', name: 'Oracle', role: 'Search · Find · Connect',
    icon: <Brain className="w-5 h-5" />,
    activeClasses: 'bg-amber-500/20 text-amber-400',
    doneClasses: 'bg-amber-500/10 text-amber-500/70',
  },
  {
    id: 'jac-report-agent', name: 'Analyst', role: 'Reports · Summaries',
    icon: <BarChart3 className="w-5 h-5" />,
    activeClasses: 'bg-rose-500/20 text-rose-400',
    doneClasses: 'bg-rose-500/10 text-rose-500/70',
  },
  {
    id: 'jac-monitor-agent', name: 'Sentinel', role: 'Watch · Alert · Guard',
    icon: <Eye className="w-5 h-5" />,
    activeClasses: 'bg-cyan-500/20 text-cyan-400',
    doneClasses: 'bg-cyan-500/10 text-cyan-500/70',
  },
];

type AgentStatus = 'idle' | 'working' | 'done' | 'failed';

interface AgentState {
  status: AgentStatus;
  currentTask?: string;
  lastResult?: string;
  taskCount: number;
}

const STATUS_STYLES: Record<AgentStatus, string> = {
  idle: 'opacity-40 border-border',
  working: 'opacity-100 border-blue-500/50 shadow-lg shadow-blue-500/10',
  done: 'opacity-90 border-green-500/30',
  failed: 'opacity-70 border-red-500/30',
};

function getAgentStates(tasks: AgentTask[]): Map<string, AgentState> {
  const states = new Map<string, AgentState>();

  for (const agent of AGENTS) {
    const agentTasks = tasks.filter(t => t.agent === agent.id);
    const running = agentTasks.find(t => t.status === 'running');
    // Sort by updated_at desc to ensure we get the most recent, not just first in array
    const sortedByRecent = [...agentTasks].sort((a, b) =>
      new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
    );
    const lastCompleted = sortedByRecent.find(t => t.status === 'completed');
    const lastFailed = sortedByRecent.find(t => t.status === 'failed');

    let status: AgentStatus = 'idle';
    let currentTask: string | undefined;
    let lastResult: string | undefined;

    if (running) {
      status = 'working';
      currentTask = running.intent || running.type;
    } else if (lastCompleted) {
      status = 'done';
      const output = lastCompleted.output as Record<string, unknown> | null;
      lastResult = output?.brief
        ? String(output.brief).slice(0, 80)
        : lastCompleted.intent || 'Task completed';
    } else if (lastFailed && !lastCompleted) {
      status = 'failed';
    }

    states.set(agent.id, {
      status,
      currentTask,
      lastResult,
      taskCount: agentTasks.filter(t => t.status === 'completed').length,
    });
  }

  return states;
}

interface AgentRosterProps {
  tasks: AgentTask[];
  activityLogs?: Map<string, ActivityLogEntry[]>;
}

export function AgentRoster({ tasks, activityLogs = new Map() }: AgentRosterProps) {
  const states = useMemo(() => getAgentStates(tasks), [tasks]);
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
          agentIcon={selectedAgent.icon}
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
        {AGENTS.map((agent) => {
          const state = states.get(agent.id) || { status: 'idle' as AgentStatus, taskCount: 0 };
          const isComingSoon = agent.id === 'jac-report-agent' || agent.id === 'jac-monitor-agent';
          return (
            <div
              key={agent.id}
              className={`relative rounded-lg border bg-card/50 p-3 transition-all duration-500 ${
                isComingSoon
                  ? 'opacity-30 cursor-default'
                  : `cursor-pointer hover:bg-muted/30 ${STATUS_STYLES[state.status]}`
              }`}
              onClick={() => !isComingSoon && setSelectedAgent(agent)}
            >
              {/* Coming Soon badge */}
              {isComingSoon && (
                <Badge variant="secondary" className="absolute -top-1.5 -right-1.5 text-[8px] px-1.5 py-0 z-10">
                  Soon
                </Badge>
              )}

              {/* Working pulse ring */}
              {state.status === 'working' && !isComingSoon && (
                <div className="absolute inset-0 rounded-lg border-2 border-blue-500/30 animate-ping pointer-events-none" style={{ animationDuration: '2s' }} />
              )}

              <div className="relative flex items-start gap-2.5">
                {/* Agent icon with status indicator */}
                <div className={`relative shrink-0 w-9 h-9 rounded-lg flex items-center justify-center ${
                  state.status === 'working' && !isComingSoon ? agent.activeClasses :
                  state.status === 'done' && !isComingSoon ? agent.doneClasses :
                  'bg-muted/50 text-muted-foreground'
                }`}>
                  {state.status === 'working' && !isComingSoon ? (
                    <Loader2 className="w-5 h-5 animate-spin" />
                  ) : (
                    agent.icon
                  )}
                  {!isComingSoon && (
                    <div className={`absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-card ${
                      state.status === 'working' ? 'bg-blue-500' :
                      state.status === 'done' ? 'bg-green-500' :
                      state.status === 'failed' ? 'bg-red-500' :
                      'bg-muted-foreground/30'
                    }`} />
                  )}
                </div>

                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold leading-tight truncate">{agent.name}</p>
                  <p className="text-[10px] text-muted-foreground leading-tight mt-0.5 truncate">{agent.role}</p>
                </div>
              </div>

              {/* Current task / last result */}
              {!isComingSoon && state.status === 'working' && state.currentTask && (
                <p className="mt-2 text-[10px] text-blue-400 truncate leading-tight">
                  {state.currentTask}
                </p>
              )}
              {!isComingSoon && state.status === 'done' && state.lastResult && (
                <p className="mt-2 text-[10px] text-muted-foreground truncate leading-tight">
                  {state.lastResult}
                </p>
              )}
              {!isComingSoon && state.status === 'idle' && state.taskCount > 0 && (
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
