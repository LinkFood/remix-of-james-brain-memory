/**
 * /specialists — Dashboard of the 10 per-ticker Claude specialists.
 *
 * One tile per ticker. Each specialist is a dedicated Claude context watching
 * its own ticker's flow, self-learning from graded flags. Tiles show status
 * dot, totals, hit rate (when n >= 5 graded), avg alpha, top tags, mini
 * 7-day sparkline. Click a tile to expand and see the last 10 flags.
 */

import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import {
  Tooltip as UiTooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { Target, RefreshCw, ArrowUp, ArrowDown, Minus } from 'lucide-react';
import { Area, AreaChart, ResponsiveContainer, Tooltip } from 'recharts';
import { ChartSafe } from '@/components/ChartSafe';
import { useSpecialistScoreboard, SpecialistScoreboardRow } from '@/hooks/useSpecialistScoreboard';
import {
  useSpecialistScoreboardV2,
  buildConvictionView,
  topRegimes,
  CONVICTION_BUCKETS,
  type SpecialistScoreboardV2Row,
  type PromptLifecycleRow,
  type ConvictionBucketView,
} from '@/hooks/useSpecialistScoreboardV2';

const TICKERS = ['SPY','QQQ','IWM','AAPL','MSFT','GOOGL','AMZN','META','NVDA','TSLA'];

type Status = 'active' | 'conviction' | 'graded' | 'invalidated';
type Direction = 'bullish' | 'bearish' | 'neutral';

interface FlagGrade {
  outcome: string;
  alpha_pct: number | null;
}

interface FlagLite {
  id?: string;
  specialist_ticker: string;
  status: Status;
  created_at: string;
  tags: string[] | null;
  direction?: Direction;
  score?: number;
  thesis?: string;
  instrument?: string;
  option_symbol?: string | null;
  horizon_ts?: string;
  ct_flag_grades: FlagGrade[] | null;
}

interface SpecialistStats {
  ticker: string;
  total: number;
  graded: number;
  wins: number;
  partials: number;
  losses: number;
  hitRate: number | null;
  avgAlpha: number | null;
  topTags: { tag: string; n: number }[];
  lastFlagAt: string | null;
  dailyCounts: { day: string; n: number }[];
}

function relativeTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function statusDotColor(lastFlagAt: string | null): string {
  if (!lastFlagAt) return 'bg-slate-500';
  const ms = Date.now() - Date.parse(lastFlagAt);
  if (ms < 3_600_000) return 'bg-emerald-400';
  if (ms < 4 * 3_600_000) return 'bg-amber-400';
  return 'bg-slate-500';
}

function dayKey(iso: string): string {
  const d = new Date(iso);
  d.setHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

function computeStats(flags: FlagLite[]): Record<string, SpecialistStats> {
  const out: Record<string, SpecialistStats> = {};
  // Seed 7-day bucket keys per ticker
  const days: string[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }

  for (const t of TICKERS) {
    out[t] = {
      ticker: t,
      total: 0,
      graded: 0,
      wins: 0,
      partials: 0,
      losses: 0,
      hitRate: null,
      avgAlpha: null,
      topTags: [],
      lastFlagAt: null,
      dailyCounts: days.map((day) => ({ day, n: 0 })),
    };
  }

  const tagCounts: Record<string, Record<string, number>> = {};
  const alphaSums: Record<string, { sum: number; n: number }> = {};

  for (const f of flags) {
    const t = f.specialist_ticker;
    const s = out[t];
    if (!s) continue;
    s.total++;
    if (!s.lastFlagAt || Date.parse(f.created_at) > Date.parse(s.lastFlagAt)) {
      s.lastFlagAt = f.created_at;
    }
    const g = f.ct_flag_grades?.[0];
    if (g) {
      s.graded++;
      if (g.outcome === 'win') s.wins++;
      else if (g.outcome === 'partial') s.partials++;
      else if (g.outcome === 'loss') s.losses++;
      if (g.alpha_pct != null) {
        alphaSums[t] ??= { sum: 0, n: 0 };
        alphaSums[t].sum += g.alpha_pct;
        alphaSums[t].n++;
      }
    }
    // Tag tally
    for (const tag of f.tags ?? []) {
      tagCounts[t] ??= {};
      tagCounts[t][tag] = (tagCounts[t][tag] ?? 0) + 1;
    }
    // Daily bucket
    const dk = dayKey(f.created_at);
    const bucket = s.dailyCounts.find((b) => b.day === dk);
    if (bucket) bucket.n++;
  }

  for (const t of TICKERS) {
    const s = out[t];
    if (s.graded >= 5) {
      s.hitRate = (s.wins + 0.5 * s.partials) / s.graded;
    }
    const a = alphaSums[t];
    if (a && a.n > 0) s.avgAlpha = a.sum / a.n;
    const tags = tagCounts[t] ?? {};
    s.topTags = Object.entries(tags)
      .map(([tag, n]) => ({ tag, n }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 3);
  }

  return out;
}

function Sparkline({ data, color }: { data: { day: string; n: number }[]; color: string }) {
  const chartData = data.map((d) => ({ t: d.day.slice(5), n: d.n }));
  return (
    <div className="h-[32px] -mx-1">
      <ChartSafe>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData} margin={{ top: 2, right: 2, left: 2, bottom: 2 }}>
            <defs>
              <linearGradient id={`sg-${color.replace('#', '')}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={color} stopOpacity={0.6} />
                <stop offset="95%" stopColor={color} stopOpacity={0.05} />
              </linearGradient>
            </defs>
            <Area
              type="monotone"
              dataKey="n"
              stroke={color}
              strokeWidth={1.5}
              fill={`url(#sg-${color.replace('#', '')})`}
              isAnimationActive={false}
            />
            <Tooltip
              contentStyle={{ fontSize: 10, padding: '2px 6px' }}
              labelFormatter={(l) => String(l)}
              formatter={(value: number) => [value, 'flags']}
            />
          </AreaChart>
        </ResponsiveContainer>
      </ChartSafe>
    </div>
  );
}

// ---------- V2 sub-panels (multi-axis, regime, calibration, streaks, lifecycle) ----------

function hitRateClass(hr: number | null): string {
  if (hr == null) return 'text-muted-foreground/60';
  if (hr >= 0.55) return 'text-emerald-300';
  if (hr < 0.45) return 'text-red-300';
  return 'text-foreground';
}

function fmtPct(hr: number | null, digits = 0): string {
  if (hr == null) return '—';
  return `${(hr * 100).toFixed(digits)}%`;
}

function StreakGlyph({ value }: { value: number }) {
  if (value >= 2) return <span className="text-emerald-300" aria-label={`${value} streak`}>▲▲</span>;
  if (value === 1) return <span className="text-emerald-300" aria-label="1 streak">▲</span>;
  if (value === 0) return <span className="text-muted-foreground/60" aria-label="flat">▬</span>;
  if (value === -1) return <span className="text-red-300" aria-label="-1 streak">▼</span>;
  return <span className="text-red-300" aria-label={`${value} streak`}>▼▼</span>;
}

function MultiAxisPanel({ row }: { row: SpecialistScoreboardV2Row | undefined }) {
  if (!row) {
    return (
      <div className="text-[10px] text-muted-foreground/60 border-t border-border/40 pt-1.5">
        no v2 grades yet
      </div>
    );
  }
  const cells: Array<{ key: string; label: string; value: number | null; title: string }> = [
    { key: 'prem', label: 'prem', value: row.hit_rate_premium, title: 'Premium-axis hit rate (option premium win/loss)' },
    { key: '4h', label: '4h', value: row.hit_rate_underlying_4h, title: 'Underlying directional hit rate, 4h window' },
    { key: '1d', label: '1d', value: row.hit_rate_underlying_1d, title: 'Underlying directional hit rate, 1d window' },
    { key: '3d', label: '3d', value: row.hit_rate_underlying_3d, title: 'Underlying directional hit rate, 3d window' },
  ];
  return (
    <div className="border-t border-border/40 pt-1.5 space-y-1">
      <div className="grid grid-cols-4 gap-1 text-[10px]">
        {cells.map((c) => (
          <UiTooltip key={c.key}>
            <TooltipTrigger asChild>
              <div className="flex flex-col items-center bg-muted/30 rounded px-1 py-0.5 cursor-help">
                <span className="text-muted-foreground/70">{c.label}</span>
                <span className={cn('font-mono tabular-nums font-bold', hitRateClass(c.value))}>
                  {fmtPct(c.value)}
                </span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-[10px]">{c.title}</TooltipContent>
          </UiTooltip>
        ))}
      </div>
      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
        <span>blended <span className={cn('font-mono tabular-nums', hitRateClass(row.hit_rate_blended))}>{fmtPct(row.hit_rate_blended)}</span></span>
        <span className="font-mono tabular-nums">n={row.n_graded}</span>
      </div>
    </div>
  );
}

function RegimePanel({ rows }: { rows: SpecialistScoreboardV2Row[] }) {
  if (rows.length === 0) {
    return (
      <div className="border-t border-border/40 pt-1.5">
        <div className="text-[9px] text-muted-foreground/70 mb-0.5">regime conditional</div>
        <div className="text-[10px] text-muted-foreground/60">no regime grades yet</div>
      </div>
    );
  }
  return (
    <div className="border-t border-border/40 pt-1.5">
      <div className="text-[9px] text-muted-foreground/70 mb-0.5">regime conditional</div>
      <div className="space-y-0.5">
        {rows.map((r) => (
          <div key={r.regime} className="flex items-center justify-between text-[10px] font-mono tabular-nums">
            <span className="truncate text-muted-foreground" title={r.regime}>{r.regime}</span>
            <span className="flex items-center gap-2">
              <span className={hitRateClass(r.hit_rate_blended)}>{fmtPct(r.hit_rate_blended)}</span>
              <span className="text-muted-foreground/60">n={r.n_graded}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ConvictionMicroCurve({ view }: { view: ConvictionBucketView[] }) {
  const hasAny = view.some((v) => v.hitRate != null);
  if (!hasAny) {
    return (
      <div className="border-t border-border/40 pt-1.5">
        <div className="text-[9px] text-muted-foreground/70 mb-0.5">conviction calibration</div>
        <div className="text-[10px] text-muted-foreground/60">no calibration yet</div>
      </div>
    );
  }
  return (
    <div className="border-t border-border/40 pt-1.5">
      <div className="text-[9px] text-muted-foreground/70 mb-1">conviction calibration</div>
      <div className="grid grid-cols-5 gap-1">
        {view.map((b) => {
          const heightPct = b.hitRate != null ? Math.max(8, Math.round(b.hitRate * 100)) : 0;
          const fill =
            b.hitRate == null ? 'bg-muted/30'
              : b.hitRate >= 0.55 ? 'bg-emerald-400/60'
              : b.hitRate < 0.45 ? 'bg-red-400/60'
              : 'bg-blue-400/60';
          const ringClass =
            b.source === 'specialist' ? 'ring-1 ring-emerald-400/40'
              : b.source === 'baseline' ? 'ring-1 ring-muted-foreground/20 ring-dashed'
              : '';
          return (
            <UiTooltip key={b.bucket}>
              <TooltipTrigger asChild>
                <div className={cn('flex flex-col items-center cursor-help')}>
                  <div className="relative h-[20px] w-full bg-muted/20 rounded-sm overflow-hidden">
                    {b.hitRate != null && (
                      <div
                        className={cn('absolute bottom-0 left-0 right-0', fill, ringClass)}
                        style={{ height: `${heightPct}%` }}
                      />
                    )}
                  </div>
                  <div className="text-[8px] font-mono text-muted-foreground/70 mt-0.5">{b.bucket}</div>
                </div>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-[10px]">
                {b.hitRate == null ? 'no data' : (
                  <span>
                    {b.bucket} conv: {fmtPct(b.hitRate, 1)} (n={b.n})
                    <br />
                    source: {b.source === 'specialist' ? 'per-specialist (N≥30)' : 'cross-specialist baseline'}
                  </span>
                )}
              </TooltipContent>
            </UiTooltip>
          );
        })}
      </div>
      <div className="text-[8px] text-muted-foreground/50 mt-0.5 leading-tight">
        per-specialist when N≥30; '__ALL__' baseline otherwise
      </div>
    </div>
  );
}

function StreakDriftRow({ row }: { row: SpecialistScoreboardV2Row | undefined }) {
  if (!row) return null;
  const driftPctPerWk = row.drift_slope_7d;
  const driftClass =
    driftPctPerWk == null ? 'text-muted-foreground/60'
      : driftPctPerWk > 0.005 ? 'text-emerald-300'
      : driftPctPerWk < -0.005 ? 'text-red-300'
      : 'text-muted-foreground';
  const driftLabel = driftPctPerWk == null
    ? '—'
    : `${driftPctPerWk >= 0 ? '+' : ''}${(driftPctPerWk * 100).toFixed(1)}pp/wk`;
  return (
    <div className="border-t border-border/40 pt-1.5">
      <div className="grid grid-cols-3 gap-1 text-[10px]">
        <UiTooltip>
          <TooltipTrigger asChild>
            <div className="flex flex-col items-center cursor-help">
              <span className="text-[9px] text-muted-foreground/70">read</span>
              <span className="font-mono tabular-nums flex items-center gap-1">
                <StreakGlyph value={row.read_streak_signed} />
                <span className="text-foreground">{row.read_streak_signed >= 0 ? '+' : ''}{row.read_streak_signed}</span>
              </span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-[10px]">
            Consecutive same-direction reads (positive=bullish, negative=bearish)
          </TooltipContent>
        </UiTooltip>
        <UiTooltip>
          <TooltipTrigger asChild>
            <div className="flex flex-col items-center cursor-help">
              <span className="text-[9px] text-muted-foreground/70">graded</span>
              <span className="font-mono tabular-nums flex items-center gap-1">
                <StreakGlyph value={row.graded_streak_signed} />
                <span className="text-foreground">{row.graded_streak_signed >= 0 ? '+' : ''}{row.graded_streak_signed}</span>
              </span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-[10px]">
            Consecutive graded outcomes (positive=wins, negative=losses)
          </TooltipContent>
        </UiTooltip>
        <UiTooltip>
          <TooltipTrigger asChild>
            <div className="flex flex-col items-center cursor-help">
              <span className="text-[9px] text-muted-foreground/70">drift</span>
              <span className={cn('font-mono tabular-nums', driftClass)}>{driftLabel}</span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-[10px]">
            7-day rolling slope of blended hit rate (pp = percentage points)
          </TooltipContent>
        </UiTooltip>
      </div>
    </div>
  );
}

function lifecycleStatusBadge(status: string): { label: string; cls: string } {
  switch (status) {
    case 'live': return { label: 'LIVE', cls: 'border-emerald-500/50 text-emerald-300 bg-emerald-500/10' };
    case 'trial': return { label: 'TRIAL', cls: 'border-blue-500/50 text-blue-300 bg-blue-500/10' };
    case 'shadow': return { label: 'SHADOW', cls: 'border-slate-500/50 text-slate-300 bg-slate-500/10' };
    case 'decay': return { label: 'DECAY', cls: 'border-amber-500/50 text-amber-300 bg-amber-500/10' };
    case 'retired': return { label: 'RETIRED', cls: 'border-red-500/50 text-red-300 bg-red-500/10 line-through' };
    default: return { label: status.toUpperCase(), cls: 'border-muted-foreground/40 text-muted-foreground' };
  }
}

const STABLE_RUNS_GATE = 4;

function LifecyclePanel({ row }: { row: PromptLifecycleRow | undefined }) {
  if (!row) {
    return (
      <div className="border-t border-border/40 pt-1.5">
        <div className="text-[10px] text-muted-foreground/60">no lifecycle row</div>
      </div>
    );
  }
  const badge = lifecycleStatusBadge(row.status);
  const proposedDifferent = row.proposed_status && row.proposed_status !== row.status;
  const stableProgress = Math.min(100, Math.round((row.consecutive_stable_runs / STABLE_RUNS_GATE) * 100));
  return (
    <div className="border-t border-border/40 pt-1.5 space-y-1">
      <div className="flex items-center justify-between gap-1 flex-wrap">
        <Badge variant="outline" className={cn('text-[9px] px-1.5 py-0 font-mono', badge.cls)}>
          {badge.label}
        </Badge>
        <span className="text-[9px] font-mono text-muted-foreground">v{row.prompt_version}</span>
        {proposedDifferent && (
          <UiTooltip>
            <TooltipTrigger asChild>
              <Badge variant="outline" className="text-[9px] px-1 py-0 font-mono border-amber-500/40 text-amber-300 cursor-help">
                → {row.proposed_status}
              </Badge>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-[10px]">
              Lifecycle proposing transition to {row.proposed_status}; needs {STABLE_RUNS_GATE} consecutive stable runs to flip.
            </TooltipContent>
          </UiTooltip>
        )}
      </div>
      <div className="space-y-0.5">
        <div className="flex items-center justify-between text-[9px] text-muted-foreground">
          <span>stable</span>
          <span className="font-mono tabular-nums">{row.consecutive_stable_runs}/{STABLE_RUNS_GATE}</span>
        </div>
        <Progress value={stableProgress} className="h-1" />
      </div>
    </div>
  );
}

interface V2TileProps {
  scoreboardAllRow?: SpecialistScoreboardV2Row;
  scoreboardRegimeRows: SpecialistScoreboardV2Row[];
  calibrationView: ConvictionBucketView[];
  lifecycleRow?: PromptLifecycleRow;
}

// ---------- end v2 sub-panels ----------

function SpecialistTile({
  stats,
  outcome,
  v2,
  onClick,
}: {
  stats: SpecialistStats;
  outcome?: SpecialistScoreboardRow;
  v2: V2TileProps;
  onClick: () => void;
}) {
  const color = stats.hitRate != null && stats.hitRate >= 0.55
    ? '#10b981'
    : stats.hitRate != null && stats.hitRate < 0.45
    ? '#f87171'
    : '#60a5fa';

  return (
    <Card
      onClick={onClick}
      className="p-3 flex flex-col gap-2 cursor-pointer hover:shadow-md hover:border-primary/40 transition-all"
    >
      <div className="flex items-start justify-between">
        <div className="font-mono font-bold text-lg tabular-nums">{stats.ticker}</div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span className={cn('w-2 h-2 rounded-full', statusDotColor(stats.lastFlagAt))} />
          {stats.lastFlagAt ? relativeTime(stats.lastFlagAt) : '—'}
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-1 text-[11px]">
        <div className="text-muted-foreground">
          flags <span className="text-foreground font-mono tabular-nums">{stats.total}</span>
        </div>
        <div className="text-muted-foreground text-right">
          graded <span className="text-foreground font-mono tabular-nums">{stats.graded}</span>
        </div>
        <div className="text-muted-foreground">
          hit{' '}
          {stats.hitRate != null ? (
            <span className="text-foreground font-mono tabular-nums">
              {(stats.hitRate * 100).toFixed(0)}%
            </span>
          ) : (
            <span className="text-muted-foreground/60 text-[10px]">n&lt;5</span>
          )}
        </div>
        <div className="text-muted-foreground text-right">
          α{' '}
          {stats.avgAlpha != null ? (
            <span
              className={cn(
                'font-mono tabular-nums',
                stats.avgAlpha >= 0 ? 'text-emerald-300' : 'text-red-300',
              )}
            >
              {stats.avgAlpha >= 0 ? '+' : ''}{stats.avgAlpha.toFixed(2)}%
            </span>
          ) : (
            <span className="text-muted-foreground/60">—</span>
          )}
        </div>
      </div>

      {/* Outcome-Elo row — derived from ct_contract_tracks (truth), not flag volume */}
      <div className="grid grid-cols-3 gap-1 text-[10px] border-t border-border/40 pt-1.5">
        <div className="text-muted-foreground" title="Hit rate over last 7d, from ct_contract_tracks">
          hit 7d{' '}
          {outcome && outcome.hit_rate != null ? (
            <span className={cn(
              'font-mono tabular-nums',
              outcome.hit_rate >= 0.55 ? 'text-emerald-300'
                : outcome.hit_rate < 0.45 ? 'text-red-300'
                : 'text-foreground',
            )}>
              {Math.round(outcome.hit_rate * 100)}%
            </span>
          ) : (
            <span className="text-muted-foreground/60">—</span>
          )}
        </div>
        <div className="text-muted-foreground text-right" title="Median peak contract % across joined tracks">
          peak{' '}
          {outcome && outcome.median_peak_pct != null ? (
            <span className="font-mono tabular-nums text-foreground">
              {(outcome.median_peak_pct * 100).toFixed(0)}%
            </span>
          ) : (
            <span className="text-muted-foreground/60">—</span>
          )}
        </div>
        <div
          className="text-muted-foreground text-right truncate"
          title={outcome?.top_pick ?? 'no joined picks yet'}
        >
          top{' '}
          <span className="font-mono tabular-nums text-foreground">
            {outcome?.top_pick ? outcome.top_pick.replace(/^[A-Z]+/, '') : '—'}
          </span>
        </div>
      </div>

      {/* Sparkline of 7-day counts */}
      <Sparkline data={stats.dailyCounts} color={color} />

      {/* Top tags */}
      <div className="flex flex-wrap gap-1 min-h-[18px]">
        {stats.topTags.length === 0 ? (
          <span className="text-[9px] text-muted-foreground/60">no tags yet</span>
        ) : (
          stats.topTags.map((t) => (
            <span
              key={t.tag}
              className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-muted/40 text-muted-foreground"
              title={`${t.n} flag${t.n > 1 ? 's' : ''} with tag "${t.tag}"`}
            >
              {t.tag}
              <span className="ml-1 opacity-60">{t.n}</span>
            </span>
          ))
        )}
      </div>

      {/* ---- V2 panels: multi-axis, regime, conviction, streak/drift, lifecycle ---- */}
      <MultiAxisPanel row={v2.scoreboardAllRow} />
      <RegimePanel rows={v2.scoreboardRegimeRows} />
      <ConvictionMicroCurve view={v2.calibrationView} />
      <StreakDriftRow row={v2.scoreboardAllRow} />
      <LifecyclePanel row={v2.lifecycleRow} />
    </Card>
  );
}

function DirectionIcon({ d }: { d?: Direction }) {
  if (d === 'bullish') return <ArrowUp className="w-3 h-3 text-emerald-300" />;
  if (d === 'bearish') return <ArrowDown className="w-3 h-3 text-red-300" />;
  return <Minus className="w-3 h-3 text-slate-300" />;
}

function SpecialistDrawer({
  ticker,
  open,
  onOpenChange,
}: {
  ticker: string | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { data: recent, isLoading } = useQuery<FlagLite[]>({
    queryKey: ['ct_specialist_recent_flags', ticker],
    enabled: !!ticker && open,
    queryFn: async () => {
      if (!ticker) return [];
      const { data, error } = await supabase
        .from('ct_flags' as never)
        .select('id, specialist_ticker, instrument, option_symbol, direction, score, status, thesis, tags, horizon_ts, created_at, ct_flag_grades(outcome, alpha_pct)')
        .eq('specialist_ticker', ticker)
        .order('created_at', { ascending: false })
        .limit(10);
      if (error) throw error;
      return (data ?? []) as unknown as FlagLite[];
    },
  });

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-lg overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="font-mono text-xl">{ticker}</SheetTitle>
          <SheetDescription>Last 10 flags from this specialist.</SheetDescription>
        </SheetHeader>

        <div className="mt-4 space-y-2">
          {isLoading && <div className="text-xs text-muted-foreground">Loading…</div>}
          {!isLoading && (!recent || recent.length === 0) && (
            <div className="text-xs text-muted-foreground">No flags from {ticker} yet.</div>
          )}
          {recent?.map((f) => {
            const g = f.ct_flag_grades?.[0];
            return (
              <Card key={f.id} className="p-2.5 space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <DirectionIcon d={f.direction} />
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-mono capitalize">
                      {f.status}
                    </Badge>
                    {g && (
                      <Badge
                        variant="outline"
                        className={cn(
                          'text-[10px] px-1.5 py-0 font-mono uppercase',
                          g.outcome === 'win' && 'border-emerald-500/40 text-emerald-300',
                          g.outcome === 'partial' && 'border-amber-500/40 text-amber-300',
                          g.outcome === 'loss' && 'border-red-500/40 text-red-300',
                        )}
                      >
                        {g.outcome}
                      </Badge>
                    )}
                  </div>
                  <div className="text-sm font-mono tabular-nums font-bold">
                    {f.score != null ? Math.round(f.score) : '—'}
                  </div>
                </div>
                <div className="text-[11px] text-muted-foreground font-mono">
                  {f.option_symbol ?? f.instrument ?? '—'}
                </div>
                {f.thesis && (
                  <div className="text-[12px] text-foreground/90 leading-snug line-clamp-3">
                    {f.thesis}
                  </div>
                )}
                <div className="text-[9px] text-muted-foreground/60 tabular-nums">
                  {relativeTime(f.created_at)}
                </div>
              </Card>
            );
          })}
        </div>
      </SheetContent>
    </Sheet>
  );
}

export default function Specialists() {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);

  const { data: flags, isLoading } = useQuery<FlagLite[]>({
    queryKey: ['ct_specialists_stats'],
    queryFn: async () => {
      const since = new Date(Date.now() - 7 * 86400_000).toISOString();
      const { data, error } = await supabase
        .from('ct_flags' as never)
        .select('specialist_ticker, status, created_at, tags, ct_flag_grades(outcome, alpha_pct)')
        .in('specialist_ticker', TICKERS)
        .gte('created_at', since);
      if (error) throw error;
      return (data ?? []) as unknown as FlagLite[];
    },
    refetchInterval: 60_000,
  });

  const statsByTicker = useMemo(() => computeStats(flags ?? []), [flags]);

  const { data: scoreboard } = useSpecialistScoreboard();
  const outcomeByName = useMemo(() => {
    const m: Record<string, SpecialistScoreboardRow> = {};
    for (const row of scoreboard ?? []) m[row.specialist_name] = row;
    return m;
  }, [scoreboard]);

  // V2 scoreboard — multi-axis, regime, calibration, lifecycle.
  // Coexists with v1 (parallel-run discipline per the v2 build brief).
  const { data: v2Bundle } = useSpecialistScoreboardV2();
  const v2ByTicker = useMemo(() => {
    const out: Record<string, V2TileProps> = {};
    const allByTicker = new Map<string, SpecialistScoreboardV2Row>();
    for (const r of v2Bundle?.scoreboardAll ?? []) {
      // Prefer the latest snapshot per ticker; window already filtered to 'lifetime' in hook.
      const prev = allByTicker.get(r.specialist_ticker);
      if (!prev || Date.parse(r.computed_at) > Date.parse(prev.computed_at)) {
        allByTicker.set(r.specialist_ticker, r);
      }
    }
    const lifecycleByTicker = new Map<string, PromptLifecycleRow>();
    for (const r of v2Bundle?.lifecycleLive ?? []) {
      lifecycleByTicker.set(r.specialist_ticker, r);
    }
    for (const t of TICKERS) {
      out[t] = {
        scoreboardAllRow: allByTicker.get(t),
        scoreboardRegimeRows: topRegimes(t, v2Bundle?.scoreboardRegime ?? [], 5),
        calibrationView: buildConvictionView(
          t,
          v2Bundle?.calibrationPerSpecialist ?? [],
          v2Bundle?.calibrationBaseline ?? [],
        ),
        lifecycleRow: lifecycleByTicker.get(t),
      };
    }
    return out;
  }, [v2Bundle]);

  // Default tile order: hit_rate DESC (specialists with no outcome row sort last).
  const orderedTickers = useMemo(() => {
    return [...TICKERS].sort((a, b) => {
      const ra = outcomeByName[a]?.hit_rate;
      const rb = outcomeByName[b]?.hit_rate;
      if (ra == null && rb == null) return 0;
      if (ra == null) return 1;
      if (rb == null) return -1;
      return rb - ra;
    });
  }, [outcomeByName]);

  return (
    <TooltipProvider delayDuration={200}>
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-[1600px] mx-auto p-4 space-y-4">
        {/* TooltipProvider wraps the page so per-tile UiTooltip components mount cleanly. */}
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Target className="w-5 h-5 text-primary" />
              <span>Specialists</span>
            </h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              10 per-ticker Claudes, self-learning from graded flags.
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => qc.invalidateQueries({ queryKey: ['ct_specialists_stats'] })}
            className="text-xs"
          >
            <RefreshCw className="w-3 h-3 mr-1" />
            Refresh
          </Button>
        </header>

        {isLoading && !flags ? (
          <Card className="p-8 text-center text-sm text-muted-foreground">
            Loading specialists…
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-3">
            {orderedTickers.map((t) => (
              <SpecialistTile
                key={t}
                stats={statsByTicker[t]}
                outcome={outcomeByName[t]}
                v2={v2ByTicker[t] ?? {
                  scoreboardAllRow: undefined,
                  scoreboardRegimeRows: [],
                  calibrationView: CONVICTION_BUCKETS.map((b) => ({ bucket: b, hitRate: null, n: 0, source: 'empty' as const })),
                  lifecycleRow: undefined,
                }}
                onClick={() => setSelected(t)}
              />
            ))}
          </div>
        )}

        <SpecialistDrawer
          ticker={selected}
          open={!!selected}
          onOpenChange={(v) => !v && setSelected(null)}
        />

        <div className="text-[10px] text-muted-foreground leading-relaxed space-y-1">
          <div>
            Stats computed over last 7 days of flags. Hit rate = (wins + 0.5×partials) / graded,
            shown only when graded ≥ 5. α = mean alpha vs SPY at horizon.
          </div>
          <div>
            Status dot: <span className="text-emerald-300">green</span> = last flag &lt; 1h,{' '}
            <span className="text-amber-300">amber</span> = 1-4h,{' '}
            <span className="text-slate-300">slate</span> = longer or none.
            Sparkline tints green when hit rate ≥ 55%, red when &lt; 45%.
          </div>
          <div>
            <span className="text-foreground">Outcome row</span> (hit 7d / peak / top): from{' '}
            <span className="font-mono">ct_specialist_scoreboard</span> — derived from{' '}
            <span className="font-mono">ct_contract_tracks.track_status</span>, not flag volume.
            Tiles sorted by 7d hit rate. Snap fires nightly 23:00 UTC weekdays.
          </div>
          <div>Refreshes every 60s. Click a tile to see its last 10 flags.</div>
          <div>
            <span className="text-foreground">V2 scoreboard</span> (multi-axis / regime / conviction / streak / lifecycle):
            from <span className="font-mono">ct_specialist_scoreboard_v2</span>,{' '}
            <span className="font-mono">ct_specialist_conviction_calibration</span>,{' '}
            <span className="font-mono">ct_specialist_prompt_lifecycle</span>. Filtered to{' '}
            <span className="font-mono">window_label='lifetime'</span>. Updated by{' '}
            <span className="font-mono">ct-specialist-prompt-lifecycle-v2</span> (K=4 stable gate).
            Refresh: 5m. Calibration falls back to <span className="font-mono">'__ALL__'</span> baseline when
            per-specialist N&lt;30 in a bucket.
          </div>
        </div>
      </div>
    </div>
    </TooltipProvider>
  );
}
