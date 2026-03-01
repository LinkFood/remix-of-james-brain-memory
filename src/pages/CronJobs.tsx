/**
 * CronJobs — View and manage pg_cron jobs.
 *
 * Lists all cron jobs with schedule, last run status, and enable/disable toggle.
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { cn } from '@/lib/utils';
import { useCronJobs, type CronJob } from '@/hooks/useCronJobs';
import { useWatches, type Watch } from '@/hooks/useWatches';
import {
  Timer,
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  RefreshCw,
  AlertCircle,
  Eye,
  Trash2,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { Switch } from '@/components/ui/switch';

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

/** Parse the command column to extract the function name or a short description */
function parseTarget(command: string): string {
  // Match invoke_edge_function('function-name', ...) or similar
  const edgeFnMatch = command.match(/invoke_edge_function\s*\(\s*'([^']+)'/);
  if (edgeFnMatch) return edgeFnMatch[1];

  // Match net.http_post with edge function URL
  const httpMatch = command.match(/functions\/v1\/([a-z0-9-]+)/);
  if (httpMatch) return httpMatch[1];

  // Match SELECT ... FROM or CALL ...
  const sqlMatch = command.match(/(?:SELECT|CALL)\s+(\w+)/i);
  if (sqlMatch) return sqlMatch[1];

  // Fallback: truncate
  return command.slice(0, 40) + (command.length > 40 ? '...' : '');
}

/** Convert cron schedule to human-readable */
function prettyCron(schedule: string): string {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return schedule;

  const [min, hour, , , dow] = parts;

  // Every N minutes
  const everyMinMatch = min.match(/^\*\/(\d+)$/);
  if (everyMinMatch && hour === '*') return `Every ${everyMinMatch[1]} min`;

  // Specific time
  if (min.match(/^\d+$/) && hour.match(/^\d+$/)) {
    const h = parseInt(hour);
    const m = parseInt(min);
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    const time = `${h12}:${m.toString().padStart(2, '0')} ${ampm} UTC`;

    if (dow === '0') return `Sun ${time}`;
    if (dow !== '*') return `${time} (dow=${dow})`;
    return `Daily ${time}`;
  }

  return schedule;
}

function formatDuration(interval: string | null): string {
  if (!interval) return '--';
  // Postgres interval format: "00:00:01.234567" or "1 day 02:03:04"
  const match = interval.match(/(\d+):(\d+):(\d+)/);
  if (match) {
    const [, h, m, s] = match;
    if (h !== '00') return `${parseInt(h)}h ${parseInt(m)}m`;
    if (m !== '00') return `${parseInt(m)}m ${parseInt(s)}s`;
    return `${parseInt(s)}s`;
  }
  return interval;
}

function WatchCard({ watch, onToggle, onDelete, onModelChange }: {
  watch: Watch;
  onToggle: (id: string, active: boolean) => void;
  onDelete: (id: string) => void;
  onModelChange: (id: string, tier: string) => void;
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

  return (
    <div className="border border-white/10 rounded-lg overflow-hidden">
      <div className="px-4 py-3 flex items-center gap-3">
        {/* Status dot */}
        <div className={cn('w-2 h-2 rounded-full', watch.cron_active ? 'bg-emerald-400' : 'bg-white/20')} />

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
        <select
          value={watch.input.modelTier || 'haiku'}
          onChange={(e) => onModelChange(watch.id, e.target.value)}
          className="text-[10px] bg-white/5 border border-white/10 rounded px-1.5 py-0.5 text-white/50 outline-none"
        >
          <option value="haiku">Haiku</option>
          <option value="sonnet">Sonnet</option>
          <option value="opus">Opus</option>
        </select>

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

        {/* Delete */}
        <button
          onClick={() => { if (confirm('Delete this watch?')) onDelete(watch.id); }}
          className="p-1 rounded hover:bg-red-500/20"
        >
          <Trash2 className="w-3.5 h-3.5 text-white/30 hover:text-red-400" />
        </button>
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

/** Time until a future date, human-readable */
function timeUntil(dateStr: string): string {
  const diffMs = new Date(dateStr).getTime() - Date.now();
  if (diffMs < 0) return 'due';
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 60) return `in ${diffMin}m`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `in ${diffH}h`;
  return `in ${Math.floor(diffH / 24)}d`;
}

const CronJobs = () => {
  const navigate = useNavigate();
  const [userId, setUserId] = useState('');
  const [activeTab, setActiveTab] = useState<'system' | 'watches'>('system');

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
  const { watches, loading: watchesLoading, fetchWatches, toggleWatch, deleteWatch, updateModelTier } = useWatches();

  const handleToggle = async (job: CronJob) => {
    await toggleJob(job.jobname, !job.active);
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
                  {/* Table header */}
                  <div className="grid grid-cols-[1fr_140px_120px_100px_80px_60px] gap-2 px-4 py-2 border-b border-white/10 bg-white/[0.02]">
                    <span className="text-[10px] text-white/40 uppercase tracking-wide font-medium">Job</span>
                    <span className="text-[10px] text-white/40 uppercase tracking-wide font-medium">Schedule</span>
                    <span className="text-[10px] text-white/40 uppercase tracking-wide font-medium">Last Run</span>
                    <span className="text-[10px] text-white/40 uppercase tracking-wide font-medium">Status</span>
                    <span className="text-[10px] text-white/40 uppercase tracking-wide font-medium">Duration</span>
                    <span className="text-[10px] text-white/40 uppercase tracking-wide font-medium text-right">Active</span>
                  </div>

                  {/* Rows */}
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
                        {/* Job name + target */}
                        <div className="min-w-0">
                          <p className="text-xs text-white/70 font-medium truncate">{job.jobname}</p>
                          <p className="text-[10px] text-white/30 truncate">{parseTarget(job.command)}</p>
                        </div>

                        {/* Schedule */}
                        <div>
                          <p className="text-[11px] text-white/50">{prettyCron(job.schedule)}</p>
                          <p className="text-[9px] text-white/20 font-mono">{job.schedule}</p>
                        </div>

                        {/* Last run time */}
                        <div>
                          <p className="text-[11px] text-white/50">
                            {job.last_run_at ? timeAgo(job.last_run_at) : 'Never'}
                          </p>
                        </div>

                        {/* Status */}
                        <div className="flex items-center gap-1.5">
                          <StatusIcon className={cn('w-3.5 h-3.5', statusCfg.color, job.last_run_status === 'starting' && 'animate-spin')} />
                          <span className={cn('text-[11px]', statusCfg.color)}>{statusCfg.label}</span>
                        </div>

                        {/* Duration */}
                        <div>
                          <span className="text-[11px] text-white/40 font-mono">
                            {formatDuration(job.last_run_duration)}
                          </span>
                        </div>

                        {/* Toggle */}
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
            <div className="flex flex-col items-center justify-center h-32 gap-2">
              <Eye className="w-6 h-6 text-white/20" />
              <span className="text-sm text-white/30">No watches yet</span>
              <span className="text-[10px] text-white/20 max-w-sm text-center">
                Tell JAC to watch something: &quot;Watch Zillow every morning for 3bed houses in Austin under $400k&quot;
              </span>
            </div>
          ) : (
            <div className="max-w-4xl mx-auto p-4 space-y-2">
              {watches.map(w => (
                <WatchCard key={w.id} watch={w} onToggle={toggleWatch} onDelete={deleteWatch} onModelChange={updateModelTier} />
              ))}
            </div>
          )
        )}
      </div>
    </div>
  );
};

export default CronJobs;
