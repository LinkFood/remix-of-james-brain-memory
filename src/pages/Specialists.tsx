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
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { Target, RefreshCw, ArrowUp, ArrowDown, Minus } from 'lucide-react';
import { Area, AreaChart, ResponsiveContainer, Tooltip } from 'recharts';
import { ChartSafe } from '@/components/ChartSafe';

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

function SpecialistTile({
  stats,
  onClick,
}: {
  stats: SpecialistStats;
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

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-[1600px] mx-auto p-4 space-y-4">
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
            {TICKERS.map((t) => (
              <SpecialistTile
                key={t}
                stats={statsByTicker[t]}
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
          <div>Refreshes every 60s. Click a tile to see its last 10 flags.</div>
        </div>
      </div>
    </div>
  );
}
