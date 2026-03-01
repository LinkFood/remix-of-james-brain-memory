/**
 * CronJobs — System Jobs + Watches control panel.
 *
 * System Jobs tab: pg_cron infrastructure (toggle only).
 * Watches tab: full CRUD — create, edit, run now, skip next, delete.
 */

import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { cn } from '@/lib/utils';
import { useCronJobs, type CronJob } from '@/hooks/useCronJobs';
import { useWatches, type Watch } from '@/hooks/useWatches';
import { CreateWatchDialog } from '@/components/watches/CreateWatchDialog';
import {
  Timer,
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  RefreshCw,
  AlertCircle,
  Eye,
  Plus,
  MoreVertical,
  Play,
  SkipForward,
  Pencil,
  Trash2,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

const STATUS_CONFIG: Record<string, { icon: typeof CheckCircle2; color: string; label: string }> = {
  succeeded: { icon: CheckCircle2, color: 'text-emerald-400', label: 'Success' },
  failed: { icon: XCircle, color: 'text-red-400', label: 'Failed' },
  starting: { icon: Loader2, color: 'text-blue-400', label: 'Running' },
};

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function parseTarget(command: string): string {
  const edgeFnMatch = command.match(/invoke_edge_function\s*\(\s*'([^']+)'/);
  if (edgeFnMatch) return edgeFnMatch[1];
  const httpMatch = command.match(/functions\/v1\/([a-z0-9-]+)/);
  if (httpMatch) return httpMatch[1];
  const sqlMatch = command.match(/(?:SELECT|CALL)\s+(\w+)/i);
  if (sqlMatch) return sqlMatch[1];
  return command.slice(0, 40) + (command.length > 40 ? '...' : '');
}

function prettyCron(schedule: string): string {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return schedule;
  const [min, hour, , , dow] = parts;

  const everyMinMatch = min.match(/^\*\/(\d+)$/);
  if (everyMinMatch && hour === '*') return `Every ${everyMinMatch[1]} min`;

  if (min.match(/^\d+$/) && hour.match(/^\d+$/)) {
    const h = parseInt(hour);
    const m = parseInt(min);
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    const time = `${h12}:${m.toString().padStart(2, '0')} ${ampm} CT`;
    if (dow === '0') return `Sun ${time}`;
    if (dow === '1-5') return `Weekdays ${time}`;
    if (dow !== '*') return `${time} (dow=${dow})`;
    return `Daily ${time}`;
  }
  return schedule;
}

function formatDuration(interval: string | null): string {
  if (!interval) return '--';
  const match = interval.match(/(\d+):(\d+):(\d+)/);
  if (match) {
    const [, h, m, s] = match;
    if (h !== '00') return `${parseInt(h)}h ${parseInt(m)}m`;
    if (m !== '00') return `${parseInt(m)}m ${parseInt(s)}s`;
    return `${parseInt(s)}s`;
  }
  return interval;
}

function timeUntil(dateStr: string): string {
  const diffMs = new Date(dateStr).getTime() - Date.now();
  if (diffMs < 0) return 'due';
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 60) return `in ${diffMin}m`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `in ${diffH}h`;
  return `in ${Math.floor(diffH / 24)}d`;
}

const MODEL_BADGE: Record<string, string> = {
  opus: 'bg-purple-500/20 text-purple-400',
  sonnet: 'bg-blue-500/20 text-blue-400',
  haiku: 'bg-white/5 text-white/40',
};

function WatchCard({ watch, onToggle, onEdit, onRunNow, onSkipNext, onDelete }: {
  watch: Watch;
  onToggle: (id: string, active: boolean) => void;
  onEdit: (watch: Watch) => void;
  onRunNow: (id: string) => void;
  onSkipNext: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [runs, setRuns] = useState<Array<{ id: string; status: string; completed_at: string | null; output: Record<string, unknown> | null; cost_usd: number | null }>>([]);

  const loadRuns = async () => {
    if (expanded) { setExpanded(false); return; }
    const { data } = await supabase
      .from('agent_tasks')
      .select('id, status, completed_at, output, cost_usd')
      .eq('parent_task_id', watch.id)
      .order('completed_at', { ascending: false })
      .limit(10);
    setRuns((data || []) as typeof runs);
    setExpanded(true);
  };

  const tier = watch.input.modelTier || 'haiku';

  return (
    <div className="border border-white/10 rounded-lg overflow-hidden">
      <div className="px-4 py-3 flex items-center gap-3">
        {/* Status dot */}
        <div className={cn('w-2 h-2 rounded-full shrink-0', watch.cron_active ? 'bg-emerald-400' : 'bg-white/20')} />

        {/* Name + query */}
        <div className="flex-1 min-w-0">
          <p className="text-xs text-white/80 font-medium truncate">{watch.input.watchName || watch.intent}</p>
          <p className="text-[10px] text-white/30 truncate">{watch.input.query}</p>
        </div>

        {/* Schedule */}
        <div className="text-right shrink-0">
          <p className="text-[11px] text-white/50">{prettyCron(watch.cron_expression)}</p>
          <p className="text-[9px] text-white/20 font-mono">{watch.cron_expression}</p>
        </div>

        {/* Model tier badge */}
        <span className={cn('text-[10px] px-1.5 py-0.5 rounded shrink-0', MODEL_BADGE[tier] || MODEL_BADGE.haiku)}>
          {tier}
        </span>

        {/* Stats */}
        <div className="text-right shrink-0">
          <p className="text-[10px] text-white/40">{watch.totalRuns} runs</p>
          <p className="text-[10px] text-white/30">${watch.totalCost.toFixed(3)}</p>
        </div>

        {/* Toggle */}
        <Switch
          checked={watch.cron_active}
          onCheckedChange={(checked) => onToggle(watch.id, checked)}
          className="scale-75"
        />

        {/* Expand */}
        <button onClick={loadRuns} className="p-1 rounded hover:bg-white/10">
          {expanded ? <ChevronUp className="w-3.5 h-3.5 text-white/30" /> : <ChevronDown className="w-3.5 h-3.5 text-white/30" />}
        </button>

        {/* Kebab menu */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="p-1 rounded hover:bg-white/10">
              <MoreVertical className="w-3.5 h-3.5 text-white/30" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="bg-zinc-900 border-white/10 min-w-[140px]">
            <DropdownMenuItem onClick={() => onEdit(watch)} className="text-xs text-white/70 focus:text-white focus:bg-white/10">
              <Pencil className="w-3 h-3 mr-2" />
              Edit
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onRunNow(watch.id)} className="text-xs text-white/70 focus:text-white focus:bg-white/10">
              <Play className="w-3 h-3 mr-2" />
              Run Now
            </DropdownMenuItem>
            {watch.cron_active && watch.next_run_at && (
              <DropdownMenuItem onClick={() => onSkipNext(watch.id)} className="text-xs text-white/70 focus:text-white focus:bg-white/10">
                <SkipForward className="w-3 h-3 mr-2" />
                Skip Next
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator className="bg-white/10" />
            <DropdownMenuItem
              onClick={() => { if (confirm('Delete this watch?')) onDelete(watch.id); }}
              className="text-xs text-red-400 focus:text-red-300 focus:bg-red-500/10"
            >
              <Trash2 className="w-3 h-3 mr-2" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Last run + next run info */}
      <div className="px-4 pb-2 flex items-center gap-4 text-[10px] text-white/30">
        {watch.lastRunAt && <span>Last: {timeAgo(watch.lastRunAt)}</span>}
        {watch.next_run_at && watch.cron_active && (
          <span>Next: {timeUntil(watch.next_run_at)}</span>
        )}
      </div>

      {/* Expanded run history */}
      {expanded && (
        <div className="border-t border-white/5 px-4 py-2 space-y-1.5">
          {runs.length === 0 ? (
            <p className="text-[10px] text-white/20">No runs yet</p>
          ) : runs.map(run => (
            <div key={run.id} className="flex items-center gap-2 text-[10px]">
              <div className={cn(
                'w-1.5 h-1.5 rounded-full',
                run.status === 'completed' ? 'bg-emerald-400' : run.status === 'failed' ? 'bg-red-400' : 'bg-yellow-400'
              )} />
              <span className="text-white/40">{run.completed_at ? timeAgo(run.completed_at) : 'running'}</span>
              <span className="text-white/20 truncate flex-1">
                {run.output?.brief ? String(run.output.brief).slice(0, 80) + '...' : '\u2014'}
              </span>
              {(run.cost_usd ?? 0) > 0 && <span className="text-white/20">${(run.cost_usd ?? 0).toFixed(3)}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const CronJobs = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [userId, setUserId] = useState('');

  // URL param-driven tab
  const tabParam = searchParams.get('tab');
  const activeTab = tabParam === 'watches' ? 'watches' : 'system';
  const setActiveTab = (tab: 'system' | 'watches') => {
    setSearchParams(tab === 'system' ? {} : { tab });
  };

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingWatch, setEditingWatch] = useState<Watch | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session?.user) {
        navigate('/auth');
        return;
      }
      setUserId(session.user.id);
    });
  }, [navigate]);

  const { jobs, loading, error, refetch, toggleJob } = useCronJobs();
  const {
    watches, loading: watchesLoading, fetchWatches,
    toggleWatch, deleteWatch, createWatch, updateWatch, triggerRun, skipNextRun,
  } = useWatches();

  const handleToggle = async (job: CronJob) => {
    await toggleJob(job.jobname, !job.active);
  };

  const handleSave = async (params: {
    watchName: string;
    query: string;
    cronExpression: string;
    modelTier: string;
    agentType: string;
  }): Promise<string | null> => {
    if (editingWatch) {
      await updateWatch(editingWatch.id, {
        watchName: params.watchName,
        query: params.query,
        cronExpression: params.cronExpression,
        modelTier: params.modelTier,
        agentType: params.agentType,
      });
      return editingWatch.id;
    }
    return createWatch(params);
  };

  const openCreate = () => {
    setEditingWatch(null);
    setDialogOpen(true);
  };

  const openEdit = (watch: Watch) => {
    setEditingWatch(watch);
    setDialogOpen(true);
  };

  if (!userId) return null;

  return (
    <div className="h-[calc(100vh-3.5rem)] bg-background flex flex-col overflow-hidden">
      {/* Header */}
      <div className="shrink-0 border-b border-white/10 px-4 py-3 flex items-center gap-3">
        <Timer className="w-4 h-4 text-white/40" />
        <div className="flex gap-1">
          <button
            onClick={() => setActiveTab('system')}
            className={cn(
              'px-3 py-1 rounded text-xs font-medium transition-colors',
              activeTab === 'system' ? 'bg-white/10 text-white/90' : 'text-white/40 hover:text-white/60'
            )}
          >
            System Jobs
          </button>
          <button
            onClick={() => setActiveTab('watches')}
            className={cn(
              'px-3 py-1 rounded text-xs font-medium transition-colors',
              activeTab === 'watches' ? 'bg-white/10 text-white/90' : 'text-white/40 hover:text-white/60'
            )}
          >
            Watches
            {watches.length > 0 && (
              <span className="ml-1.5 text-[10px] bg-emerald-500/20 text-emerald-400 px-1.5 py-0.5 rounded-full">
                {watches.filter(w => w.cron_active).length}
              </span>
            )}
          </button>
        </div>
        <span className="text-[10px] text-white/30 font-mono ml-auto">
          {activeTab === 'system' ? `${jobs.length} jobs` : `${watches.length} watches`}
        </span>

        {/* Add Watch button (watches tab only) */}
        {activeTab === 'watches' && (
          <button
            onClick={openCreate}
            className="flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white transition-colors"
          >
            <Plus className="w-3 h-3" />
            Add Watch
          </button>
        )}

        <button
          onClick={activeTab === 'system' ? refetch : fetchWatches}
          className="p-1 rounded hover:bg-white/10 transition-colors"
          title="Refresh"
        >
          <RefreshCw className="w-3.5 h-3.5 text-white/30" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {activeTab === 'system' && (
          <>
            {loading ? (
              <div className="flex items-center justify-center h-32">
                <Loader2 className="w-5 h-5 text-white/30 animate-spin" />
              </div>
            ) : error ? (
              <div className="flex flex-col items-center justify-center h-32 gap-2">
                <AlertCircle className="w-6 h-6 text-red-400/50" />
                <span className="text-sm text-red-400/70">{error}</span>
                <span className="text-[10px] text-white/30">
                  Migration may need to be applied (get_cron_status RPC)
                </span>
              </div>
            ) : jobs.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-32 gap-2">
                <Timer className="w-6 h-6 text-white/20" />
                <span className="text-sm text-white/30">No cron jobs found</span>
              </div>
            ) : (
              <div className="max-w-4xl mx-auto p-4">
                <div className="rounded-lg border border-white/10 overflow-hidden">
                  <div className="grid grid-cols-[1fr_140px_120px_100px_80px_60px] gap-2 px-4 py-2 border-b border-white/10 bg-white/[0.02]">
                    <span className="text-[10px] text-white/40 uppercase tracking-wide font-medium">Job</span>
                    <span className="text-[10px] text-white/40 uppercase tracking-wide font-medium">Schedule</span>
                    <span className="text-[10px] text-white/40 uppercase tracking-wide font-medium">Last Run</span>
                    <span className="text-[10px] text-white/40 uppercase tracking-wide font-medium">Status</span>
                    <span className="text-[10px] text-white/40 uppercase tracking-wide font-medium">Duration</span>
                    <span className="text-[10px] text-white/40 uppercase tracking-wide font-medium text-right">Active</span>
                  </div>

                  {jobs.map((job) => {
                    const statusCfg = job.last_run_status
                      ? STATUS_CONFIG[job.last_run_status] ?? { icon: Clock, color: 'text-white/30', label: job.last_run_status }
                      : { icon: Clock, color: 'text-white/20', label: 'Never' };
                    const StatusIcon = statusCfg.icon;

                    return (
                      <div
                        key={job.jobid}
                        className={cn(
                          'grid grid-cols-[1fr_140px_120px_100px_80px_60px] gap-2 px-4 py-2.5 border-b border-white/5 items-center',
                          !job.active && 'opacity-50',
                        )}
                      >
                        <div className="min-w-0">
                          <p className="text-xs text-white/70 font-medium truncate">{job.jobname}</p>
                          <p className="text-[10px] text-white/30 truncate">{parseTarget(job.command)}</p>
                        </div>
                        <div>
                          <p className="text-[11px] text-white/50">{prettyCron(job.schedule)}</p>
                          <p className="text-[9px] text-white/20 font-mono">{job.schedule}</p>
                        </div>
                        <div>
                          <p className="text-[11px] text-white/50">
                            {job.last_run_at ? timeAgo(job.last_run_at) : 'Never'}
                          </p>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <StatusIcon className={cn('w-3.5 h-3.5', statusCfg.color, job.last_run_status === 'starting' && 'animate-spin')} />
                          <span className={cn('text-[11px]', statusCfg.color)}>{statusCfg.label}</span>
                        </div>
                        <div>
                          <span className="text-[11px] text-white/40 font-mono">
                            {formatDuration(job.last_run_duration)}
                          </span>
                        </div>
                        <div className="flex justify-end">
                          <Switch
                            checked={job.active}
                            onCheckedChange={() => handleToggle(job)}
                            className="scale-75"
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>

                <p className="text-[10px] text-white/20 mt-3 text-center">
                  Auto-refreshes every 30 seconds
                </p>
              </div>
            )}
          </>
        )}

        {activeTab === 'watches' && (
          watchesLoading ? (
            <div className="flex items-center justify-center h-32">
              <Loader2 className="w-5 h-5 text-white/30 animate-spin" />
            </div>
          ) : watches.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 gap-3">
              <Eye className="w-8 h-8 text-white/15" />
              <div className="text-center">
                <p className="text-sm text-white/40">No watches yet</p>
                <p className="text-[11px] text-white/20 mt-1 max-w-sm">
                  Watches run recurring tasks on a schedule. Create one to monitor prices, track news, or automate research.
                </p>
              </div>
              <button
                onClick={openCreate}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white transition-colors mt-1"
              >
                <Plus className="w-3 h-3" />
                Create your first watch
              </button>
            </div>
          ) : (
            <div className="max-w-4xl mx-auto p-4 space-y-2">
              {watches.map(w => (
                <WatchCard
                  key={w.id}
                  watch={w}
                  onToggle={toggleWatch}
                  onEdit={openEdit}
                  onRunNow={triggerRun}
                  onSkipNext={skipNextRun}
                  onDelete={deleteWatch}
                />
              ))}
            </div>
          )
        )}
      </div>

      {/* Create/Edit Watch Dialog */}
      <CreateWatchDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editWatch={editingWatch}
        onSave={handleSave}
        onTriggerRun={triggerRun}
      />
    </div>
  );
};

export default CronJobs;
