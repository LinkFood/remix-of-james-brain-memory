/**
 * GenerationStatusCard — top-of-dashboard pressure gauge.
 *
 * Tenet 14 (generational pressure) made glanceable. Renders above the
 * existing StatusStrip on /workspace so the first thing James sees is:
 *
 *   GEN N · balance of target progress · survival headroom · days left · pace
 *
 * When there is no active generation (system dormant) we render an empty
 * state rather than fabricating numbers. Everything degrades gracefully.
 */
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skull, Target, Timer, TrendingUp, TrendingDown, CalendarClock } from 'lucide-react';
import {
  useGenerationProgress,
  usePastGenerations,
  type GenerationStatus,
} from '@/hooks/useClaudeGeneration';

function fmtUsd(n: number | null | undefined, digits = 0): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `$${Math.round(n).toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

function progressBarColor(pct: number | null, pnl: number | null): string {
  if (pct == null || pnl == null) return 'bg-muted-foreground/40';
  if (pnl < 0) return 'bg-red-500';
  if (pnl === 0) return 'bg-amber-400';
  return 'bg-green-500';
}

function genStatusChipClass(s: GenerationStatus | undefined): string {
  switch (s) {
    case 'succeeded': return 'bg-green-500/15 text-green-400 border-green-500/40';
    case 'fired': return 'bg-red-500/15 text-red-400 border-red-500/40';
    case 'abandoned': return 'bg-amber-500/15 text-amber-400 border-amber-500/40';
    case 'active':
    default: return 'bg-blue-500/15 text-blue-400 border-blue-500/40';
  }
}

export function GenerationStatusCard() {
  const progress = useGenerationProgress();
  const { data: pastGens = [] } = usePastGenerations(5);
  const { generation: gen } = progress;

  // ---------- EMPTY STATE ----------
  if (progress.isLoading) {
    return (
      <Card className="p-4">
        <div className="text-xs text-muted-foreground">Loading generation state…</div>
      </Card>
    );
  }

  if (!gen) {
    return (
      <Card className="p-4 border-dashed">
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
          <Skull className="w-3 h-3" />
          <span>Generational pressure</span>
        </div>
        <div className="text-sm text-muted-foreground mt-1">
          No active generation — system dormant. Seed one via ct_claude_generations.
        </div>
      </Card>
    );
  }

  // ---------- NORMAL RENDER ----------
  const pnl = progress.pnlAbsolute ?? 0;
  const pct = progress.targetProgressPct;
  const displayPct = pct != null ? Math.max(0, Math.min(1, pct)) * 100 : 0;
  const barColor = progressBarColor(pct, pnl);

  const daysElapsed = Math.max(0, gen.days_elapsed);
  const daysRemaining = Math.max(0, gen.days_remaining);
  const daysTotal = gen.target_days;

  const survivalLow =
    progress.distanceToSurvival != null && progress.distanceToSurvival < 5_000;
  const survivalBreached =
    progress.distanceToSurvival != null && progress.distanceToSurvival < 0;

  return (
    <Card className="p-4 space-y-3 border-primary/40">
      {/* Header row — GEN number + status + lineage */}
      <div className="flex items-start gap-4 flex-wrap">
        <div className="flex items-center gap-2.5">
          <div className="text-2xl font-bold tracking-tight text-primary leading-none">
            GEN {gen.generation_number}
          </div>
          <Badge
            variant="outline"
            className={`text-[10px] px-1.5 py-0.5 ${genStatusChipClass(gen.status)}`}
          >
            {gen.status ?? 'active'}
          </Badge>
        </div>

        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground ml-auto">
          <Timer className="w-3 h-3" />
          <span className="font-mono">
            Day {daysElapsed} of {daysTotal}
          </span>
          <span>·</span>
          <span className="font-mono">{daysRemaining} left</span>
        </div>
      </div>

      {/* Target progress bar */}
      <div className="space-y-1">
        <div className="flex items-center justify-between text-[11px]">
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <Target className="w-3 h-3" />
            <span className="uppercase tracking-wider">Target progress</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-foreground font-mono font-semibold">
              {fmtUsd(progress.currentBalance)}
            </span>
            <span className="text-muted-foreground">of</span>
            <span className="text-muted-foreground font-mono">
              {fmtUsd(gen.target_balance_usd)}
            </span>
            {pnl !== 0 && (
              <Badge
                variant="outline"
                className={`text-[9px] px-1 py-0 h-4 font-mono ${
                  pnl > 0
                    ? 'text-green-400 border-green-500/40 bg-green-500/15'
                    : 'text-red-400 border-red-500/40 bg-red-500/15'
                }`}
              >
                {pnl > 0 ? <TrendingUp className="w-2.5 h-2.5 mr-0.5" /> : <TrendingDown className="w-2.5 h-2.5 mr-0.5" />}
                {pnl > 0 ? '+' : ''}
                {fmtUsd(pnl)}
              </Badge>
            )}
          </div>
        </div>
        {/* Custom-bar — we avoid the shadcn Progress primitive's indicator color
            so we can swap bar color by P&L sign. */}
        <div className="h-2 rounded-full bg-muted overflow-hidden">
          <div
            className={`h-full transition-all ${barColor}`}
            style={{ width: `${displayPct}%` }}
          />
        </div>
        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
          <span>{fmtUsd(gen.starting_balance_usd)} start</span>
          <span className="font-mono">
            {pct != null ? `${(pct * 100).toFixed(1)}%` : '—'} of the way
          </span>
          <span>
            {progress.distanceToTarget != null && progress.distanceToTarget > 0
              ? `${fmtUsd(progress.distanceToTarget)} to go`
              : 'target hit'}
          </span>
        </div>
      </div>

      {/* Survival + pace row */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2 pt-1">
        {/* Survival */}
        <div
          className={`rounded-md border p-2 space-y-1 ${
            survivalBreached
              ? 'border-red-500/40 bg-red-500/5'
              : survivalLow
              ? 'border-amber-500/40 bg-amber-500/5'
              : 'border-border bg-card/50'
          }`}
        >
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
            <Skull className="w-3 h-3" />
            <span>Survival floor</span>
            <span className="font-mono ml-auto">
              {fmtUsd(gen.survival_floor_usd)}
            </span>
          </div>
          <div className="text-xs">
            {progress.distanceToSurvival != null ? (
              <span
                className={
                  survivalBreached
                    ? 'text-red-400 font-semibold'
                    : survivalLow
                    ? 'text-amber-400 font-semibold'
                    : 'text-foreground'
                }
              >
                {fmtUsd(progress.distanceToSurvival)} of cushion
              </span>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </div>
          {progress.survivalCushionPct != null && (
            <div className="h-1 rounded-full bg-muted overflow-hidden">
              <div
                className={`h-full transition-all ${
                  survivalBreached
                    ? 'bg-red-500'
                    : survivalLow
                    ? 'bg-amber-400'
                    : 'bg-muted-foreground/60'
                }`}
                style={{
                  width: `${progress.survivalCushionPct * 100}%`,
                }}
              />
            </div>
          )}
        </div>

        {/* Pace */}
        <div className="rounded-md border border-border bg-card/50 p-2 space-y-1">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
            <TrendingUp className="w-3 h-3" />
            <span>Pace</span>
          </div>
          <div className="text-xs">
            {progress.paceUsdPerDay != null ? (
              <span
                className={
                  progress.paceUsdPerDay >= 0 ? 'text-green-400' : 'text-red-400'
                }
              >
                {progress.paceUsdPerDay >= 0 ? '+' : ''}
                {fmtUsd(progress.paceUsdPerDay)}/day
              </span>
            ) : (
              <span className="text-muted-foreground">day 0 — no pace yet</span>
            )}
          </div>
          {progress.projectedEndingBalance != null && (
            <div className="text-[10px] text-muted-foreground">
              projects to{' '}
              <span className="font-mono">{fmtUsd(progress.projectedEndingBalance)}</span> by day {daysTotal}
            </div>
          )}
        </div>

        {/* ETA */}
        <div className="rounded-md border border-border bg-card/50 p-2 space-y-1">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
            <CalendarClock className="w-3 h-3" />
            <span>On pace</span>
          </div>
          <div className="text-xs">
            {progress.onPaceForTarget === true && (
              <span className="text-green-400">yes — target reachable</span>
            )}
            {progress.onPaceForTarget === false && (
              <span className="text-amber-400">no — pace too slow</span>
            )}
            {progress.onPaceForTarget == null && (
              <span className="text-muted-foreground">
                need more data to project
              </span>
            )}
          </div>
          <div className="text-[10px] text-muted-foreground">
            {progress.distanceToTarget != null && progress.distanceToTarget > 0
              ? `${fmtUsd(progress.distanceToTarget)} remaining · ${daysRemaining}d`
              : 'target already hit'}
          </div>
        </div>
      </div>

      {/* Lineage footer */}
      <div className="flex items-center gap-2 pt-1 border-t border-border/50 text-[10px] text-muted-foreground">
        {pastGens.length === 0 ? (
          <span className="italic">Preceded by 0 prior generations — this is the first.</span>
        ) : (
          <>
            <span>Preceded by {pastGens.length} generation{pastGens.length === 1 ? '' : 's'}:</span>
            <div className="flex items-center gap-1">
              {pastGens.map((g) => (
                <Badge
                  key={g.id}
                  variant="outline"
                  className={`text-[9px] px-1 py-0 h-4 font-mono ${genStatusChipClass(g.status)}`}
                  title={`Gen ${g.generation_number} · ${g.status}${g.fire_reason ? ` · ${g.fire_reason}` : ''}`}
                >
                  G{g.generation_number}
                </Badge>
              ))}
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

