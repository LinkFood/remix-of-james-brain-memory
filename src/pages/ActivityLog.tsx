/**
 * ActivityLog -- The firehose. A reverse-chronological feed of everything
 * that happens in JAC: tasks, activity steps, and reflections.
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Activity,
  Bot,
  CheckCircle2,
  XCircle,
  Clock,
  Ban,
  Lightbulb,
  Footprints,
  Loader2,
  ChevronDown,
} from 'lucide-react';
import {
  useActivityLog,
  type ActivityItem,
  type ActivityFilters,
  type AgentTypeFilter,
  type StatusFilter,
} from '@/hooks/useActivityLog';

// --------------- Agent display map ---------------

const AGENT_LABELS: Record<string, string> = {
  'jac-dispatcher': 'Dispatcher',
  'jac-research-agent': 'Research',
  'jac-save-agent': 'Save',
  'jac-search-agent': 'Search',
  'jac-code-agent': 'Code',
};

const AGENT_COLORS: Record<string, string> = {
  'jac-dispatcher': 'bg-violet-500/20 text-violet-400 border-violet-500/30',
  'jac-research-agent': 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  'jac-save-agent': 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
  'jac-search-agent': 'bg-amber-500/20 text-amber-400 border-amber-500/30',
  'jac-code-agent': 'bg-indigo-500/20 text-indigo-400 border-indigo-500/30',
};

const STATUS_CONFIG: Record<
  string,
  { icon: typeof CheckCircle2; color: string; label: string }
> = {
  completed: {
    icon: CheckCircle2,
    color: 'text-emerald-400',
    label: 'Completed',
  },
  running: { icon: Loader2, color: 'text-yellow-400', label: 'Running' },
  queued: { icon: Clock, color: 'text-yellow-400', label: 'Queued' },
  failed: { icon: XCircle, color: 'text-red-400', label: 'Failed' },
  cancelled: { icon: Ban, color: 'text-red-400', label: 'Cancelled' },
  started: { icon: Clock, color: 'text-yellow-400', label: 'Started' },
  skipped: { icon: Ban, color: 'text-white/30', label: 'Skipped' },
};

const TASK_TYPE_COLORS: Record<string, string> = {
  research: 'bg-cyan-500/20 text-cyan-400',
  save: 'bg-emerald-500/20 text-emerald-400',
  search: 'bg-blue-500/20 text-blue-400',
  code: 'bg-indigo-500/20 text-indigo-400',
  general: 'bg-white/10 text-white/50',
  report: 'bg-purple-500/20 text-purple-400',
};

// --------------- Helpers ---------------

function timeAgo(dateStr: string): string {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  const diffD = Math.floor(diffH / 24);
  return `${diffD}d ago`;
}

function formatDuration(startStr: string, endStr: string | null): string {
  if (!endStr) return '';
  const ms = new Date(endStr).getTime() - new Date(startStr).getTime();
  if (ms < 1000) return `${ms}ms`;
  const sec = (ms / 1000).toFixed(1);
  return `${sec}s`;
}

function formatTokens(
  tokensIn: number | null,
  tokensOut: number | null,
): string {
  if (tokensIn == null && tokensOut == null) return '';
  const inK = tokensIn ? (tokensIn / 1000).toFixed(1) : '0';
  const outK = tokensOut ? (tokensOut / 1000).toFixed(1) : '0';
  return `${inK}k in / ${outK}k out`;
}

function formatCost(cost: number | null): string {
  if (cost == null || cost === 0) return '';
  return `$${cost.toFixed(4)}`;
}

// --------------- Item renderers ---------------

function TaskRow({ item }: { item: ActivityItem & { kind: 'task' } }) {
  const statusCfg = STATUS_CONFIG[item.status] ?? STATUS_CONFIG.completed;
  const StatusIcon = statusCfg.icon;
  const agentColor =
    AGENT_COLORS[item.agent ?? ''] ??
    'bg-white/10 text-white/50 border-white/10';
  const agentLabel = AGENT_LABELS[item.agent ?? ''] ?? item.agent ?? 'Unknown';
  const tokenStr = formatTokens(item.tokens_in, item.tokens_out);
  const costStr = formatCost(item.cost_usd);
  const duration = formatDuration(item.created_at, item.completed_at);

  return (
    <div className="flex items-start gap-3 px-4 py-3 hover:bg-white/[0.02] transition-colors">
      <div className="mt-0.5 shrink-0">
        <Bot className="w-4 h-4 text-white/40" />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className={cn(
              'text-[10px] px-1.5 py-0.5 rounded font-medium uppercase tracking-wide border',
              agentColor,
            )}
          >
            {agentLabel}
          </span>
          <StatusIcon
            className={cn(
              'w-3.5 h-3.5',
              statusCfg.color,
              item.status === 'running' && 'animate-spin',
            )}
          />
          <span className={cn('text-[10px] font-medium', statusCfg.color)}>
            {statusCfg.label}
          </span>
        </div>
        <p className="text-xs text-white/70 mt-1 line-clamp-2">
          {item.intent || item.type}
        </p>
        {item.type === 'code' && item.status === 'completed' && (
          <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
            validated
          </span>
        )}
        <div className="flex items-center gap-3 mt-1 flex-wrap">
          {duration && (
            <span className="text-[10px] text-white/30 font-mono">
              {duration}
            </span>
          )}
          {tokenStr && (
            <span className="text-[10px] text-white/30 font-mono">
              {tokenStr}
            </span>
          )}
          {costStr && (
            <span className="text-[10px] text-white/30 font-mono">
              {costStr}
            </span>
          )}
        </div>
      </div>

      <span className="text-[10px] text-white/30 font-mono shrink-0 mt-0.5">
        {timeAgo(item.created_at)}
      </span>
    </div>
  );
}

function ActivityStepRow({
  item,
}: {
  item: ActivityItem & { kind: 'activity' };
}) {
  const statusCfg = STATUS_CONFIG[item.status] ?? STATUS_CONFIG.started;
  const StatusIcon = statusCfg.icon;
  const agentLabel = AGENT_LABELS[item.agent] ?? item.agent;
  const detailMsg =
    item.detail && typeof item.detail === 'object'
      ? (item.detail as Record<string, unknown>).message ??
        (item.detail as Record<string, unknown>).msg ??
        null
      : null;

  return (
    <div className="flex items-start gap-3 px-4 py-2.5 hover:bg-white/[0.02] transition-colors">
      <div className="mt-0.5 shrink-0">
        <Footprints className="w-4 h-4 text-white/20" />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-white/40 font-mono">
            {agentLabel}
          </span>
          <span className="text-[10px] text-white/20">/</span>
          <span className="text-xs text-white/60 font-mono">{item.step}</span>
          <StatusIcon className={cn('w-3 h-3', statusCfg.color)} />
        </div>
        {detailMsg && (
          <p className="text-[11px] text-white/40 mt-0.5 line-clamp-1">
            {String(detailMsg)}
          </p>
        )}
        {item.duration_ms != null && (
          <span className="text-[10px] text-white/20 font-mono">
            {item.duration_ms}ms
          </span>
        )}
      </div>

      <span className="text-[10px] text-white/30 font-mono shrink-0 mt-0.5">
        {timeAgo(item.created_at)}
      </span>
    </div>
  );
}

function ReflectionRow({
  item,
}: {
  item: ActivityItem & { kind: 'reflection' };
}) {
  const typeBadge =
    TASK_TYPE_COLORS[item.task_type] ?? 'bg-white/10 text-white/50';
  const connectionCount = item.connections?.length ?? 0;

  return (
    <div className="flex items-start gap-3 px-4 py-3 hover:bg-white/[0.02] transition-colors border-l-2 border-blue-500/30">
      <div className="mt-0.5 shrink-0">
        <Lightbulb className="w-4 h-4 text-blue-400/60" />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-blue-400 font-medium">
            JAC reflected:
          </span>
          <span
            className={cn(
              'text-[9px] px-1.5 py-0.5 rounded font-medium uppercase tracking-wide',
              typeBadge,
            )}
          >
            {item.task_type}
          </span>
        </div>
        <p className="text-xs text-white/70 mt-1 line-clamp-2">
          {item.summary}
        </p>
        {connectionCount > 0 && (
          <span className="text-[10px] text-white/30 mt-0.5 block">
            {connectionCount} connection{connectionCount !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      <span className="text-[10px] text-white/30 font-mono shrink-0 mt-0.5">
        {timeAgo(item.created_at)}
      </span>
    </div>
  );
}

function ActivityItemRow({ item }: { item: ActivityItem }) {
  switch (item.kind) {
    case 'task':
      return <TaskRow item={item} />;
    case 'activity':
      return <ActivityStepRow item={item} />;
    case 'reflection':
      return <ReflectionRow item={item} />;
  }
}

// --------------- Page ---------------

const ActivityLog = () => {
  const navigate = useNavigate();
  const [userId, setUserId] = useState('');

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session?.user) {
        navigate('/auth');
        return;
      }
      setUserId(session.user.id);
    });
  }, [navigate]);

  const { items, isLoading, loadMore, hasMore, filters, setFilters } =
    useActivityLog(userId);

  if (!userId) return null;

  return (
    <div className="h-[calc(100vh-3.5rem)] bg-background flex flex-col overflow-hidden">
      {/* Filter bar */}
      <div className="shrink-0 border-b border-white/10 px-4 py-3 flex items-center gap-3 flex-wrap">
        <Activity className="w-4 h-4 text-white/40 shrink-0" />
        <span className="text-sm font-medium text-white/70 mr-2">
          Activity Log
        </span>

        <Select
          value={filters.type}
          onValueChange={(v) =>
            setFilters({
              ...filters,
              type: v as ActivityFilters['type'],
            })
          }
        >
          <SelectTrigger className="w-[130px] h-8 text-xs bg-white/5 border-white/10">
            <SelectValue placeholder="Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            <SelectItem value="task">Tasks</SelectItem>
            <SelectItem value="activity">Steps</SelectItem>
            <SelectItem value="reflection">Reflections</SelectItem>
          </SelectContent>
        </Select>

        <Select
          value={filters.agentType}
          onValueChange={(v) =>
            setFilters({
              ...filters,
              agentType: v as AgentTypeFilter,
            })
          }
        >
          <SelectTrigger className="w-[130px] h-8 text-xs bg-white/5 border-white/10">
            <SelectValue placeholder="Agent" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All agents</SelectItem>
            <SelectItem value="research">Research</SelectItem>
            <SelectItem value="save">Save</SelectItem>
            <SelectItem value="search">Search</SelectItem>
            <SelectItem value="code">Code</SelectItem>
            <SelectItem value="general">General</SelectItem>
          </SelectContent>
        </Select>

        <Select
          value={filters.status}
          onValueChange={(v) =>
            setFilters({ ...filters, status: v as StatusFilter })
          }
        >
          <SelectTrigger className="w-[130px] h-8 text-xs bg-white/5 border-white/10">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="completed">Completed</SelectItem>
            <SelectItem value="running">Running</SelectItem>
            <SelectItem value="failed">Failed</SelectItem>
            <SelectItem value="cancelled">Cancelled</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Feed */}
      <div className="flex-1 overflow-y-auto">
        {isLoading && items.length === 0 ? (
          <div className="flex items-center justify-center h-32">
            <Loader2 className="w-5 h-5 text-white/30 animate-spin" />
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 gap-2">
            <Activity className="w-6 h-6 text-white/20" />
            <span className="text-sm text-white/30">No activity yet</span>
          </div>
        ) : (
          <>
            <div className="divide-y divide-white/5">
              {items.map((item) => (
                <ActivityItemRow key={`${item.kind}-${item.id}`} item={item} />
              ))}
            </div>

            {hasMore && (
              <div className="flex justify-center py-4">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs text-white/40 hover:text-white/60"
                  onClick={loadMore}
                  disabled={isLoading}
                >
                  {isLoading ? (
                    <Loader2 className="w-3 h-3 animate-spin mr-1" />
                  ) : (
                    <ChevronDown className="w-3 h-3 mr-1" />
                  )}
                  Load more
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default ActivityLog;
