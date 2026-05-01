/**
 * SystemWardenCard — top-of-page status surface so James can glance and know
 * if the OS is supervising itself.
 *
 * Healthy: one tight row — green dot, "All clear · 12 invariants passing",
 *          last-fired relative time, next-fire countdown.
 * Unhealthy: expands to list each failing invariant with severity emoji,
 *            value vs expected, consecutive-fails, runbook path.
 *
 * Refreshes every 30s via useWardenHealth. Warden cron runs every 30 min,
 * so we're always within one cycle of fresh state.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CircleCheck, TriangleAlert, ShieldAlert, Activity, ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useWardenHealth, computeNextWardenRun, type WardenFailure } from '@/hooks/useWardenHealth';
import { useQueryClient } from '@tanstack/react-query';

function relTime(iso: string | null, nowMs: number): string {
  if (!iso) return 'never';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return 'never';
  const sec = Math.max(0, Math.round((nowMs - t) / 1000));
  if (sec < 45) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.round(hr / 24);
  return `${d}d ago`;
}

function relCountdown(target: Date, nowMs: number): string {
  const ms = target.getTime() - nowMs;
  if (ms <= 0) return 'now';
  const sec = Math.round(ms / 1000);
  if (sec < 90) return `in ${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `in ${min}m`;
  const hr = Math.round(min / 60);
  return `in ${hr}h`;
}

function severityIcon(sev: WardenFailure['severity']) {
  if (sev === 'critical') return <ShieldAlert className="w-3 h-3 text-red-400" />;
  if (sev === 'warn') return <TriangleAlert className="w-3 h-3 text-orange-400" />;
  return <Activity className="w-3 h-3 text-amber-400/70" />;
}

function severityLabelClass(sev: WardenFailure['severity']) {
  if (sev === 'critical') return 'text-red-400 bg-red-500/10';
  if (sev === 'warn') return 'text-orange-300 bg-orange-500/10';
  return 'text-amber-300/80 bg-amber-500/5';
}

function GitHubRunbookLink({ path }: { path: string }) {
  const url = `https://github.com/LinkFood/remix-of-james-brain-memory/blob/main/${path}`;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="text-[10px] text-muted-foreground hover:text-foreground underline-offset-2 hover:underline truncate max-w-[260px]"
      title={`Open ${path}`}
    >
      {path}
    </a>
  );
}

export function SystemWardenCard() {
  const { data, isLoading, error } = useWardenHealth();
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // Local 1-Hz tick so "last fired" + countdown feel live without re-fetching.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (isLoading) {
    return (
      <Card className="px-3 py-2 flex items-center gap-2 text-xs text-muted-foreground">
        <Activity className="w-3 h-3 animate-pulse" />
        <span>System Warden — loading…</span>
      </Card>
    );
  }

  if (error || !data) {
    return (
      <Card className="px-3 py-2 flex items-center gap-2 text-xs text-orange-300 bg-orange-500/5 border-orange-500/30">
        <TriangleAlert className="w-3 h-3" />
        <span>System Warden — health RPC unreachable. Cron may still be firing; surface is bypassed.</span>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto h-6 px-2 text-[11px]"
          onClick={() => qc.invalidateQueries({ queryKey: ['warden-health'] })}
        >
          <RefreshCw className="w-3 h-3 mr-1" /> retry
        </Button>
      </Card>
    );
  }

  const { health, latest } = data;
  const t = health.totals;
  const failureCount = t.failing + t.errored;
  const isCritical = t.critical_failing > 0;
  const isHealthy = failureCount === 0 && t.never_ran === 0;

  // Tone the strip by worst severity.
  const toneClass = isCritical
    ? 'border-red-500/40 bg-red-500/5'
    : failureCount > 0
    ? 'border-orange-500/30 bg-orange-500/5'
    : t.never_ran > 0
    ? 'border-amber-500/30 bg-amber-500/5'
    : 'border-emerald-500/20 bg-emerald-500/5';

  const dotClass = isCritical
    ? 'bg-red-400 shadow-red-500/50'
    : failureCount > 0
    ? 'bg-orange-400 shadow-orange-500/50'
    : t.never_ran > 0
    ? 'bg-amber-400 shadow-amber-500/40'
    : 'bg-emerald-400 shadow-emerald-500/40';

  const next = computeNextWardenRun(new Date(now));
  const lastFiredText = relTime(latest.last_run_at, now);
  const nextFiredText = relCountdown(next, now);

  const headlineText = isHealthy
    ? `All clear · ${t.passing}/${t.total_enabled} invariants passing`
    : `${failureCount} failing · ${t.passing}/${t.total_enabled} passing` +
      (t.critical_failing > 0 ? ` · ${t.critical_failing} critical` : '');

  return (
    <Card className={`border ${toneClass} px-3 py-2 transition-colors`}>
      <div className="flex items-center gap-3 flex-wrap">
        {/* status dot */}
        <span className={`relative inline-flex h-2 w-2 rounded-full ${dotClass} shadow-[0_0_8px_var(--tw-shadow-color)]`} />

        {/* headline */}
        <div className="flex items-center gap-1.5 text-xs font-medium">
          {isHealthy ? (
            <CircleCheck className="w-3.5 h-3.5 text-emerald-400" />
          ) : isCritical ? (
            <ShieldAlert className="w-3.5 h-3.5 text-red-400" />
          ) : (
            <TriangleAlert className="w-3.5 h-3.5 text-orange-400" />
          )}
          <span>System Warden</span>
          <span className="text-muted-foreground font-normal">— {headlineText}</span>
        </div>

        {/* timing strip */}
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground tabular-nums ml-auto">
          <span title={latest.last_run_at ?? 'no log row yet'}>
            last fired <span className="text-foreground/80">{lastFiredText}</span>
          </span>
          <span className="text-muted-foreground/40">·</span>
          <span title={next.toISOString()}>
            next <span className="text-foreground/80">{nextFiredText}</span>
          </span>
        </div>

        {/* expand toggle */}
        {!isHealthy && (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-1.5 text-[11px]"
            onClick={() => setExpanded((v) => !v)}
            title={expanded ? 'collapse' : 'expand failures'}
          >
            {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          </Button>
        )}

        {/* manual refresh */}
        <Button
          size="sm"
          variant="ghost"
          className="h-6 w-6 p-0"
          onClick={() => qc.invalidateQueries({ queryKey: ['warden-health'] })}
          title="refresh now"
        >
          <RefreshCw className="w-3 h-3" />
        </Button>
      </div>

      {/* per-category compact row when healthy — small affordance so James sees what's covered */}
      {isHealthy && health.by_category.length > 0 && (
        <div className="flex items-center gap-3 mt-1 ml-5 flex-wrap text-[10px] text-muted-foreground tabular-nums">
          {health.by_category.map((c) => (
            <span key={c.category} className="inline-flex items-center gap-1">
              <span className="opacity-60">{c.category}</span>
              <span className="text-emerald-400/80">{c.passing}/{c.total}</span>
            </span>
          ))}
        </div>
      )}

      {/* failure detail block */}
      {!isHealthy && expanded && (
        <ul className="mt-2 ml-5 space-y-1.5">
          {health.failures.map((f) => (
            <li key={f.name} className="flex items-center gap-2 text-[11px] flex-wrap">
              {severityIcon(f.severity)}
              <span className={`px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wider ${severityLabelClass(f.severity)}`}>
                {f.severity}
              </span>
              <span className="font-mono text-foreground/90">{f.name}</span>
              <span className="text-muted-foreground">value: <span className="text-foreground/80 tabular-nums">{f.last_value ?? '—'}</span></span>
              {f.consecutive_fails > 1 && (
                <span className="text-muted-foreground">· {f.consecutive_fails} runs</span>
              )}
              {f.runbook_path && (
                <>
                  <span className="text-muted-foreground/40">·</span>
                  <GitHubRunbookLink path={f.runbook_path} />
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* one-line summary when not expanded but failing */}
      {!isHealthy && !expanded && health.failures.length > 0 && (
        <div className="mt-1 ml-5 text-[11px] text-muted-foreground truncate">
          {health.failures.slice(0, 3).map((f) => f.name).join(' · ')}
          {health.failures.length > 3 && ` · +${health.failures.length - 3} more`}
        </div>
      )}
    </Card>
  );
}
