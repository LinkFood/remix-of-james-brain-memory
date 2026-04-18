/**
 * Preflight — Monday 6:45 AM ET readiness glance.
 *
 * One page, eight cards, one banner. Green/yellow/red per check. Click a
 * non-green card to expand the detail rows (which cron failed, which config
 * key is out of bounds, which news window is empty). Auto-refresh every 60s,
 * manual re-run button.
 *
 * Read-only. No fixes, no auto-repair. Just visibility.
 */

import { useState } from 'react';
import { RefreshCw, CheckCircle2, AlertTriangle, XCircle, ChevronDown, ChevronUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FreshnessChip } from '@/components/FreshnessChip';
import {
  usePreflightChecks,
  type CheckStatus,
  type PreflightCheck,
} from '@/hooks/usePreflightChecks';

const STATUS_STYLES: Record<CheckStatus, { border: string; bg: string; fg: string; dot: string }> = {
  green: {
    border: 'border-emerald-500/30',
    bg: 'bg-emerald-500/5',
    fg: 'text-emerald-400',
    dot: 'bg-emerald-500',
  },
  yellow: {
    border: 'border-yellow-500/30',
    bg: 'bg-yellow-500/5',
    fg: 'text-yellow-400',
    dot: 'bg-yellow-500',
  },
  red: {
    border: 'border-red-500/40',
    bg: 'bg-red-500/10',
    fg: 'text-red-400',
    dot: 'bg-red-500',
  },
};

function StatusIcon({ status }: { status: CheckStatus }) {
  const Icon = status === 'green' ? CheckCircle2 : status === 'yellow' ? AlertTriangle : XCircle;
  return <Icon className={`w-4 h-4 ${STATUS_STYLES[status].fg}`} />;
}

function timeAgoShort(iso: string | null): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}

function CheckCard({ check }: { check: PreflightCheck }) {
  const [expanded, setExpanded] = useState(false);
  const style = STATUS_STYLES[check.status];
  const canExpand = check.status !== 'green' || check.details.length > 0;

  return (
    <div className={`rounded-lg border ${style.border} ${style.bg} p-4 transition-colors`}>
      <button
        className="w-full flex items-start justify-between gap-3 text-left"
        onClick={() => canExpand && setExpanded((e) => !e)}
        disabled={!canExpand}
      >
        <div className="flex items-start gap-3 min-w-0">
          <div className="mt-0.5">
            <StatusIcon status={check.status} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-medium text-foreground">{check.name}</span>
              <span className={`text-[10px] uppercase tracking-wider font-bold ${style.fg}`}>
                {check.status}
              </span>
              <FreshnessChip timestamp={check.lastCheckedAt} />
            </div>
            <div className="text-xs text-muted-foreground mt-1">{check.explanation}</div>
            <div className="text-[10px] text-muted-foreground/60 mt-1">
              checked {timeAgoShort(check.lastCheckedAt)}
            </div>
          </div>
        </div>
        {canExpand && (
          <div className="shrink-0 text-muted-foreground">
            {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </div>
        )}
      </button>

      {expanded && (
        <div className="mt-3 pt-3 border-t border-white/5 space-y-1.5">
          {check.error && (
            <div className="text-xs text-red-400 font-mono">{check.error}</div>
          )}
          {check.details.length === 0 && !check.error && (
            <div className="text-xs text-muted-foreground italic">No additional details.</div>
          )}
          {check.details.map((d, i) => (
            <div
              key={`${d.label}-${i}`}
              className="flex items-start justify-between gap-3 text-xs"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_STYLES[d.status].dot}`} />
                <span className="text-foreground/80 truncate">{d.label}</span>
              </div>
              {d.note && (
                <span className="text-muted-foreground font-mono text-[11px] shrink-0">
                  {d.note}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Preflight() {
  const { checks, summary, loading, refetch, lastRun } = usePreflightChecks();
  const [manualRefreshing, setManualRefreshing] = useState(false);

  const handleRefresh = async () => {
    setManualRefreshing(true);
    try {
      await refetch();
    } finally {
      setManualRefreshing(false);
    }
  };

  const bannerStyle = STATUS_STYLES[summary.overall];

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-5xl mx-auto p-4 md:p-6 space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold">Preflight</h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              Ready for open? One-glance system check.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={manualRefreshing || loading}
            className="gap-2"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${manualRefreshing ? 'animate-spin' : ''}`} />
            Re-run all checks
          </Button>
        </div>

        {/* Summary banner */}
        <div className={`rounded-lg border ${bannerStyle.border} ${bannerStyle.bg} p-4`}>
          <div className="flex items-center gap-3">
            <div className={`w-3 h-3 rounded-full ${bannerStyle.dot} ${summary.overall !== 'green' ? 'animate-pulse' : ''}`} />
            <div className="flex-1 min-w-0">
              <div className={`text-lg font-bold ${bannerStyle.fg}`}>
                {loading ? 'Running checks...' : summary.headline}
              </div>
              {!loading && (
                <div className="text-xs text-muted-foreground mt-0.5">
                  {summary.subline}
                  {lastRun && <> · last run {timeAgoShort(lastRun)}</>}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Grid of check cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {loading && checks.length === 0 ? (
            <div className="col-span-full text-center text-xs text-muted-foreground py-12">
              Running preflight checks...
            </div>
          ) : (
            checks.map((check) => <CheckCard key={check.key} check={check} />)
          )}
        </div>

        {/* Footer hint */}
        <div className="text-[11px] text-muted-foreground/60 text-center pt-2">
          Auto-refreshes every 60s · read-only · no auto-repair
        </div>
      </div>
    </div>
  );
}
