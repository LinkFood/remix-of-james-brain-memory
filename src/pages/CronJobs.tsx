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
import {
  Timer,
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  RefreshCw,
  AlertCircle,
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

const CronJobs = () => {
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

  const { jobs, loading, error, refetch, toggleJob } = useCronJobs();

  const handleToggle = async (job: CronJob) => {
    await toggleJob(job.jobname, !job.active);
  };

  if (!userId) return null;

  return (
    <div className="h-[calc(100vh-3.5rem)] bg-background flex flex-col overflow-hidden">
      {/* Header */}
      <div className="shrink-0 border-b border-white/10 px-4 py-3 flex items-center gap-3">
        <Timer className="w-4 h-4 text-white/40" />
        <span className="text-sm font-medium text-white/70">Cron Jobs</span>
        <span className="text-[10px] text-white/30 font-mono ml-auto">
          {jobs.length} jobs
        </span>
        <button
          onClick={refetch}
          className="p-1 rounded hover:bg-white/10 transition-colors"
          title="Refresh"
        >
          <RefreshCw className="w-3.5 h-3.5 text-white/30" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
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
      </div>
    </div>
  );
};

export default CronJobs;
