/**
 * Shared agent definitions, colors, and state derivation.
 * Used by AgentRoster (full grid) and dashboard components (strip, rail).
 */

import type { AgentTask } from '@/types/agent';

export interface AgentDef {
  id: string;
  name: string;
  role: string;
  /** Tailwind classes for text + bg when active */
  activeClasses: string;
  /** Tailwind classes for text + bg when done */
  doneClasses: string;
  /** Dot/border color class for dashboard strip */
  dotColor: string;
  /** Border color class for activity rail chips */
  borderColor: string;
}

export type AgentStatus = 'idle' | 'working' | 'done' | 'failed';

export interface AgentState {
  status: AgentStatus;
  currentTask?: string;
  lastResult?: string;
  taskCount: number;
}

export const AGENT_DEFS: AgentDef[] = [
  {
    id: 'jac-dispatcher', name: 'JAC', role: 'Boss · Routes commands',
    activeClasses: 'bg-violet-500/20 text-violet-400',
    doneClasses: 'bg-violet-500/10 text-violet-500/70',
    dotColor: 'bg-violet-500',
    borderColor: 'border-violet-500',
  },
  {
    id: 'jac-research-agent', name: 'Scout', role: 'Research · Web + Brain',
    activeClasses: 'bg-blue-500/20 text-blue-400',
    doneClasses: 'bg-blue-500/10 text-blue-500/70',
    dotColor: 'bg-blue-500',
    borderColor: 'border-blue-500',
  },
  {
    id: 'jac-save-agent', name: 'Scribe', role: 'Save · Classify · Store',
    activeClasses: 'bg-emerald-500/20 text-emerald-400',
    doneClasses: 'bg-emerald-500/10 text-emerald-500/70',
    dotColor: 'bg-emerald-500',
    borderColor: 'border-emerald-500',
  },
  {
    id: 'jac-search-agent', name: 'Oracle', role: 'Search · Find · Connect',
    activeClasses: 'bg-amber-500/20 text-amber-400',
    doneClasses: 'bg-amber-500/10 text-amber-500/70',
    dotColor: 'bg-amber-500',
    borderColor: 'border-amber-500',
  },
  {
    id: 'jac-code-agent', name: 'Coder', role: 'Code · Commit · PR',
    activeClasses: 'bg-indigo-500/20 text-indigo-400',
    doneClasses: 'bg-indigo-500/10 text-indigo-500/70',
    dotColor: 'bg-indigo-500',
    borderColor: 'border-indigo-500',
  },
];

/**
 * Derive agent states from a list of tasks.
 * working > done > failed > idle
 */
export function deriveAgentStates(tasks: AgentTask[]): Map<string, AgentState> {
  const states = new Map<string, AgentState>();

  for (const agent of AGENT_DEFS) {
    const agentTasks = tasks.filter(t => t.agent === agent.id);
    const running = agentTasks.find(t => t.status === 'running');
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
