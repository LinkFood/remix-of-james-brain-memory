/**
 * Agents — View and monitor the 5 JAC agents.
 *
 * Cards per agent showing status, stats, and recent task history.
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { cn } from '@/lib/utils';
import { AGENT_DEFS } from '@/lib/agents';
import { useAgentStats } from '@/hooks/useAgentStats';
import {
  Users,
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  ChevronDown,
  ChevronUp,
  DollarSign,
  Zap,
} from 'lucide-react';

const STATUS_DOT: Record<string, string> = {
  idle: 'bg-white/20',
  working: 'bg-emerald-400 animate-pulse',
  done: 'bg-blue-400',
  failed: 'bg-red-400',
};

const STATUS_LABEL: Record<string, string> = {
  idle: 'Idle',
  working: 'Working',
  done: 'Done',
  failed: 'Failed',
};

const TASK_STATUS_ICON: Record<string, { icon: typeof CheckCircle2; color: string }> = {
  completed: { icon: CheckCircle2, color: 'text-emerald-400' },
  failed: { icon: XCircle, color: 'text-red-400' },
  running: { icon: Loader2, color: 'text-blue-400' },
  pending: { icon: Clock, color: 'text-white/30' },
  queued: { icon: Clock, color: 'text-white/30' },
  cancelled: { icon: XCircle, color: 'text-white/20' },
};

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function formatCost(usd: number): string {
  if (usd < 0.01) return '$0.00';
  return `$${usd.toFixed(2)}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

const Agents = () => {
  const navigate = useNavigate();
  const [userId, setUserId] = useState('');
  const [expandedAgents, setExpandedAgents] = useState<Set<string>>(new Set());

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session?.user) {
        navigate('/auth');
        return;
      }
      setUserId(session.user.id);
    });
  }, [navigate]);

  const { agentStatsMap, agentStates, loading } = useAgentStats(userId);

  const toggleExpanded = (agentId: string) => {
    setExpandedAgents(prev => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  };

  if (!userId) return null;

  return (
    <div className="h-[calc(100vh-3.5rem)] bg-background flex flex-col overflow-hidden">
      {/* Header */}
      <div className="shrink-0 border-b border-white/10 px-4 py-3 flex items-center gap-3">
        <Users className="w-4 h-4 text-white/40" />
        <span className="text-sm font-medium text-white/70">Agents</span>
        <span className="text-[10px] text-white/30 font-mono ml-auto">
          {AGENT_DEFS.length} agents
        </span>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {loading ? (
          <div className="flex items-center justify-center h-32">
            <Loader2 className="w-5 h-5 text-white/30 animate-spin" />
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 max-w-6xl mx-auto">
            {AGENT_DEFS.map((agent) => {
              const state = agentStates.get(agent.id);
              const stats = agentStatsMap.get(agent.id);
              const isExpanded = expandedAgents.has(agent.id);
              const status = state?.status ?? 'idle';

              return (
                <div
                  key={agent.id}
                  className={cn(
                    'rounded-lg border border-white/10 bg-white/[0.02] overflow-hidden',
                    status === 'working' && 'border-emerald-500/30',
                  )}
                >
                  {/* Agent header */}
                  <div className="px-4 py-3 flex items-center gap-3">
                    <div className={cn('w-8 h-8 rounded-full flex items-center justify-center shrink-0', agent.activeClasses)}>
                      <span className="text-xs font-bold">{agent.name[0]}</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-white/80">{agent.name}</span>
                        <div className={cn('w-2 h-2 rounded-full shrink-0', STATUS_DOT[status])} />
                        <span className="text-[10px] text-white/40">{STATUS_LABEL[status]}</span>
                      </div>
                      <p className="text-[10px] text-white/30">{agent.role}</p>
                    </div>
                  </div>

                  {/* Current task */}
                  {state?.currentTask && (
                    <div className="px-4 pb-2">
                      <p className="text-[10px] text-emerald-400/80 truncate">
                        {state.currentTask}
                      </p>
                    </div>
                  )}

                  {/* Stats row */}
                  {stats && (
                    <div className="px-4 py-2 border-t border-white/5 flex items-center gap-4">
                      <div className="flex items-center gap-1">
                        <CheckCircle2 className="w-3 h-3 text-emerald-400/50" />
                        <span className="text-[10px] text-white/50">{stats.completedTasks}</span>
                      </div>
                      {stats.failedTasks > 0 && (
                        <div className="flex items-center gap-1">
                          <XCircle className="w-3 h-3 text-red-400/50" />
                          <span className="text-[10px] text-white/50">{stats.failedTasks}</span>
                        </div>
                      )}
                      <div className="flex items-center gap-1">
                        <DollarSign className="w-3 h-3 text-white/30" />
                        <span className="text-[10px] text-white/50">{formatCost(stats.totalCost)}</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <Zap className="w-3 h-3 text-white/30" />
                        <span className="text-[10px] text-white/50">{formatTokens(stats.totalTokens)}</span>
                      </div>
                      {stats.totalTasks > 0 && (
                        <span className="text-[10px] text-white/30 ml-auto font-mono">
                          {Math.round(stats.successRate * 100)}%
                        </span>
                      )}
                    </div>
                  )}

                  {/* Expand toggle */}
                  <button
                    onClick={() => toggleExpanded(agent.id)}
                    className="w-full px-4 py-1.5 border-t border-white/5 flex items-center justify-center gap-1 text-[10px] text-white/30 hover:text-white/50 hover:bg-white/[0.02] transition-colors"
                  >
                    {isExpanded ? (
                      <>
                        <ChevronUp className="w-3 h-3" />
                        Hide history
                      </>
                    ) : (
                      <>
                        <ChevronDown className="w-3 h-3" />
                        Recent tasks ({stats?.recentTasks.length ?? 0})
                      </>
                    )}
                  </button>

                  {/* Task history (collapsible) */}
                  {isExpanded && stats && (
                    <div className="border-t border-white/5 max-h-64 overflow-y-auto">
                      {stats.recentTasks.length === 0 ? (
                        <p className="px-4 py-3 text-[10px] text-white/20 italic">No tasks yet</p>
                      ) : (
                        stats.recentTasks.map((task) => {
                          const cfg = TASK_STATUS_ICON[task.status] ?? TASK_STATUS_ICON.pending;
                          const Icon = cfg.icon;
                          return (
                            <div
                              key={task.id}
                              className="px-4 py-2 border-b border-white/5 flex items-start gap-2"
                            >
                              <Icon className={cn('w-3.5 h-3.5 shrink-0 mt-0.5', cfg.color, task.status === 'running' && 'animate-spin')} />
                              <div className="flex-1 min-w-0">
                                <p className="text-[11px] text-white/60 truncate">
                                  {task.intent || task.type}
                                </p>
                                <div className="flex items-center gap-2 mt-0.5">
                                  <span className="text-[9px] text-white/25">{timeAgo(task.created_at)}</span>
                                  {task.cost_usd != null && task.cost_usd > 0 && (
                                    <span className="text-[9px] text-white/25 font-mono">{formatCost(task.cost_usd)}</span>
                                  )}
                                </div>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

export default Agents;
