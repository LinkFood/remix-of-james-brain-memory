/**
 * /detectors — read-only window into the detector lifecycle state machine.
 *
 * Surfaces ct_detector_scoreboard's latest snapshot per detector, plus
 * ct_detector_lifecycle_state's stability streak. Pending flips (where
 * proposed_status differs from current_status AND streak < K=4) get
 * highlighted with a "days_until_flip" countdown.
 *
 * Pure UI mode per Tenet 26. No actions. No mutations. Auto-refetch 30s.
 */

import { useDetectorScoreboard, STABILITY_K, type DetectorStatus } from '@/hooks/useDetectorScoreboard';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { Activity, ArrowRight, TrendingUp, TrendingDown, Minus, Clock } from 'lucide-react';

function statusStyle(s: DetectorStatus): { chip: string; label: string } {
  switch (s) {
    case 'live':    return { chip: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40', label: 'LIVE' };
    case 'trial':   return { chip: 'bg-amber-500/15 text-amber-300 border-amber-500/40',       label: 'TRIAL' };
    case 'shadow':  return { chip: 'bg-slate-500/15 text-slate-300 border-slate-500/40',       label: 'SHADOW' };
    case 'decay':   return { chip: 'bg-orange-500/15 text-orange-300 border-orange-500/40',    label: 'DECAY' };
    case 'retired': return { chip: 'bg-red-500/15 text-red-300 border-red-500/40',             label: 'RETIRED' };
    default:        return { chip: 'bg-muted/40 text-muted-foreground border-border',           label: String(s).toUpperCase() };
  }
}

function fmtPct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  return `${(Number(v) * 100).toFixed(0)}%`;
}

function fmtAge(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

function streakDirChip(streak: number) {
  if (streak > 0) return { Icon: TrendingUp, cls: 'text-emerald-400', label: `+${streak}` };
  if (streak < 0) return { Icon: TrendingDown, cls: 'text-red-400', label: `${streak}` };
  return { Icon: Minus, cls: 'text-muted-foreground', label: '0' };
}

export default function Detectors() {
  const { data, isLoading, error } = useDetectorScoreboard();
  const rows = data ?? [];
  const pendingFlips = rows.filter(r => r.current_status !== r.proposed_status);

  return (
    <div className="container mx-auto p-4 max-w-6xl space-y-4">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight inline-flex items-center gap-2">
          <Activity className="w-5 h-5 text-primary" />
          Detector Lifecycle
        </h1>
        <p className="text-sm text-muted-foreground">
          Read-only window into the detector state machine. Cron updates every 30 min RTH / hourly off-hours.
          Pending flips (proposed ≠ current) require K={STABILITY_K} consecutive stable runs before
          actual <code>ct_detectors.status</code> flips.
        </p>
        {pendingFlips.length > 0 && (
          <div className="rounded border border-amber-500/30 bg-amber-500/5 p-2 text-[12px] text-amber-200 inline-flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5" />
            {pendingFlips.length} pending flip{pendingFlips.length > 1 ? 's' : ''} — will execute when stability streak reaches K={STABILITY_K}
          </div>
        )}
      </header>

      {isLoading && <Card className="p-4 text-sm text-muted-foreground">loading…</Card>}
      {error instanceof Error && (
        <Card className="p-4 text-sm text-red-300 border-red-500/40">
          query failed: {error.message}
        </Card>
      )}
      {!isLoading && !error && rows.length === 0 && (
        <Card className="p-4 text-sm text-muted-foreground">
          No scoreboard rows yet. Wait for ct-detector-scoreboard-update to fire (every 30 min RTH).
        </Card>
      )}

      {rows.length > 0 && (
        <Card className="p-3 overflow-x-auto">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="text-[10.5px] uppercase tracking-wider text-muted-foreground border-b border-border/60">
                <th className="text-left py-1.5 px-2 font-medium">detector</th>
                <th className="text-left py-1.5 px-2 font-medium">status</th>
                <th className="text-left py-1.5 px-2 font-medium">proposed</th>
                <th className="text-right py-1.5 px-2 font-medium">stab. streak</th>
                <th className="text-right py-1.5 px-2 font-medium">until flip</th>
                <th className="text-right py-1.5 px-2 font-medium">n_graded</th>
                <th className="text-right py-1.5 px-2 font-medium">hr 30d</th>
                <th className="text-right py-1.5 px-2 font-medium">hr 7d</th>
                <th className="text-right py-1.5 px-2 font-medium">w/l streak</th>
                <th className="text-right py-1.5 px-2 font-medium">last refresh</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const cur = statusStyle(r.current_status);
                const pro = statusStyle(r.proposed_status);
                const pending = r.current_status !== r.proposed_status;
                const remaining = pending ? Math.max(0, STABILITY_K - r.proposed_streak) : 0;
                const dir = streakDirChip(r.current_streak);
                const Icon = dir.Icon;
                return (
                  <tr
                    key={r.detector_id}
                    className={cn('border-b border-border/30 last:border-0',
                      pending && 'bg-amber-500/5')}
                  >
                    <td className="py-1.5 px-2 font-mono text-foreground">{r.detector_id}</td>
                    <td className="py-1.5 px-2">
                      <span className={cn('text-[10px] font-mono px-1.5 py-0.5 rounded border', cur.chip)}>
                        {cur.label}
                      </span>
                    </td>
                    <td className="py-1.5 px-2">
                      {pending ? (
                        <span className="inline-flex items-center gap-1">
                          <ArrowRight className="w-3 h-3 text-amber-400" />
                          <span className={cn('text-[10px] font-mono px-1.5 py-0.5 rounded border', pro.chip)}>
                            {pro.label}
                          </span>
                        </span>
                      ) : (
                        <span className="text-[10px] text-muted-foreground">stable</span>
                      )}
                    </td>
                    <td className="py-1.5 px-2 text-right tabular-nums">
                      {pending ? `${r.proposed_streak}/${STABILITY_K}` : '—'}
                    </td>
                    <td className="py-1.5 px-2 text-right tabular-nums">
                      {pending ? `${remaining} run${remaining === 1 ? '' : 's'}` : '—'}
                    </td>
                    <td className="py-1.5 px-2 text-right tabular-nums text-muted-foreground">{r.n_graded}</td>
                    <td className="py-1.5 px-2 text-right tabular-nums">{fmtPct(r.hit_rate_30d)}</td>
                    <td className="py-1.5 px-2 text-right tabular-nums text-muted-foreground">{fmtPct(r.hit_rate_7d)}</td>
                    <td className={cn('py-1.5 px-2 text-right tabular-nums inline-flex items-center justify-end gap-1', dir.cls)}>
                      <Icon className="w-3 h-3" />{dir.label}
                    </td>
                    <td className="py-1.5 px-2 text-right text-muted-foreground text-[10.5px]">
                      {fmtAge(r.computed_at)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}

      <div className="text-[10.5px] text-muted-foreground">
        Source: <code>ct_detector_scoreboard</code> + <code>ct_detector_lifecycle_state</code>.
        Calibration: <code>docs/decisions/2026-05-02-detector-lifecycle-thresholds.md</code>.
        Per-detector docs: <code>docs/detectors/&lt;id&gt;.md</code>.
      </div>
    </div>
  );
}
