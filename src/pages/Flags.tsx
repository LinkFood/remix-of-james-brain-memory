/**
 * /flags — Live stream of specialist flags (Co-Trader v2).
 *
 * Reads ct_flags joined with ct_flag_grades. Every row = one specialist
 * prediction with direction, horizon, score, thesis, invalidation. Filter
 * by specialist / status / direction / score / slacked. Sorted newest first.
 *
 * Scoring: >= 80 conviction, 60-79 flag, <60 watching. Grader closes at
 * horizon; outcome (win/partial/loss/invalidated) writes back.
 */

import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import {
  Activity, RefreshCw, ArrowUp, ArrowDown, Minus, Send, ChevronDown, ChevronUp,
} from 'lucide-react';

const TICKERS = ['SPY','QQQ','IWM','AAPL','MSFT','GOOGL','AMZN','META','NVDA','TSLA'];

type Status = 'active' | 'conviction' | 'graded' | 'invalidated';
type Direction = 'bullish' | 'bearish' | 'neutral';

interface FlagGrade {
  outcome: string;
  alpha_pct: number | null;
  price_change_pct: number | null;
  graded_at: string;
}

interface Flag {
  id: string;
  specialist_ticker: string;
  instrument: string;
  option_symbol: string | null;
  strike: number | null;
  expiry: string | null;
  side: 'call' | 'put' | null;
  direction: Direction;
  score: number;
  score_breakdown: unknown;
  tags: string[];
  thesis: string;
  invalidation: string;
  horizon_hours: number;
  horizon_ts: string;
  entry_price: number | null;
  target_price: number | null;
  status: Status;
  confirmed_t1: boolean;
  slacked_at: string | null;
  created_at: string;
  ct_flag_grades: FlagGrade[] | null;
}

interface Filters {
  specialists: Set<string>;
  status: 'all' | Status;
  direction: 'all' | Direction;
  minScore: number;
  onlySlacked: boolean;
}

function relativeTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function timeToHorizon(horizonTs: string, status: Status, grade: FlagGrade | null): string {
  if (status === 'graded' || status === 'invalidated') {
    if (grade?.graded_at) return `graded ${relativeTime(grade.graded_at)}`;
    return 'graded';
  }
  const ms = Date.parse(horizonTs) - Date.now();
  if (ms < 0) return 'awaiting grader';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (h === 0) return `expires in ${m}m`;
  return `expires in ${h}h ${m}m`;
}

function scoreColor(score: number): string {
  if (score >= 80) return 'text-emerald-400';
  if (score >= 60) return 'text-amber-400';
  return 'text-slate-400';
}

function directionColor(d: Direction): string {
  if (d === 'bullish') return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40';
  if (d === 'bearish') return 'bg-red-500/15 text-red-300 border-red-500/40';
  return 'bg-slate-500/15 text-slate-300 border-slate-500/40';
}

function DirectionIcon({ d }: { d: Direction }) {
  if (d === 'bullish') return <ArrowUp className="w-3 h-3" />;
  if (d === 'bearish') return <ArrowDown className="w-3 h-3" />;
  return <Minus className="w-3 h-3" />;
}

function outcomeColor(outcome: string): string {
  if (outcome === 'win') return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40';
  if (outcome === 'partial') return 'bg-amber-500/15 text-amber-300 border-amber-500/40';
  if (outcome === 'loss') return 'bg-red-500/15 text-red-300 border-red-500/40';
  return 'bg-slate-500/15 text-slate-300 border-slate-500/40';
}

function FlagTile({ flag }: { flag: Flag }) {
  const [expanded, setExpanded] = useState(false);
  const grade = flag.ct_flag_grades?.[0] ?? null;
  const isGraded = flag.status === 'graded' || flag.status === 'invalidated';

  return (
    <Card className="p-3 flex flex-col gap-2 hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge
            variant="outline"
            className={cn('font-mono text-[11px] px-1.5 py-0', directionColor(flag.direction))}
          >
            <DirectionIcon d={flag.direction} />
            <span className="ml-1">{flag.specialist_ticker}</span>
          </Badge>
          <Badge
            variant="outline"
            className={cn(
              'text-[10px] px-1.5 py-0 font-mono',
              flag.status === 'conviction' && 'border-emerald-500/40 text-emerald-300',
              flag.status === 'active' && 'border-blue-500/40 text-blue-300',
              flag.status === 'graded' && 'border-slate-500/40 text-slate-300',
              flag.status === 'invalidated' && 'border-red-500/40 text-red-300',
            )}
          >
            {flag.status}
          </Badge>
          {flag.slacked_at && (
            <span
              title={`Slacked ${relativeTime(flag.slacked_at)}`}
              className="text-[11px] text-muted-foreground inline-flex items-center gap-0.5"
            >
              <Send className="w-3 h-3" />
            </span>
          )}
          {isGraded && grade && (
            <Badge
              variant="outline"
              className={cn('text-[10px] px-1.5 py-0 font-mono uppercase', outcomeColor(grade.outcome))}
            >
              {grade.outcome}
              {grade.alpha_pct != null && (
                <span className="ml-1 tabular-nums">
                  {grade.alpha_pct >= 0 ? '+' : ''}{grade.alpha_pct.toFixed(2)}%α
                </span>
              )}
            </Badge>
          )}
        </div>
        <div className={cn('text-2xl font-bold tabular-nums leading-none', scoreColor(flag.score))}>
          {Math.round(flag.score)}
        </div>
      </div>

      {/* Contract + horizon */}
      <div className="flex items-center justify-between text-[11px] text-muted-foreground gap-2">
        <div className="font-mono truncate">
          {flag.option_symbol ?? (
            <>
              {flag.instrument}
              {flag.strike != null && flag.side && (
                <span> {flag.strike}{flag.side === 'call' ? 'C' : 'P'}</span>
              )}
              {flag.expiry && <span> {flag.expiry.slice(5)}</span>}
            </>
          )}
        </div>
        <div className="shrink-0 text-[10px] tabular-nums">
          {timeToHorizon(flag.horizon_ts, flag.status, grade)}
        </div>
      </div>

      {/* Entry / target */}
      {(flag.entry_price != null || flag.target_price != null) && (
        <div className="flex gap-3 text-[10px] text-muted-foreground tabular-nums">
          {flag.entry_price != null && (
            <span>entry <span className="text-foreground font-mono">${flag.entry_price.toFixed(2)}</span></span>
          )}
          {flag.target_price != null && (
            <span>target <span className="text-foreground font-mono">${flag.target_price.toFixed(2)}</span></span>
          )}
        </div>
      )}

      {/* Thesis — 2 lines truncated, expand on click */}
      <button
        onClick={() => setExpanded((x) => !x)}
        className="text-left text-[12px] leading-snug text-foreground/90 hover:text-foreground transition-colors"
      >
        <span className={cn(!expanded && 'line-clamp-2')}>{flag.thesis}</span>
        {flag.thesis.length > 120 && (
          <span className="ml-1 inline-flex items-center text-muted-foreground">
            {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </span>
        )}
      </button>

      {/* Invalidation */}
      {flag.invalidation && (
        <div className="text-[10px] text-muted-foreground leading-snug">
          <span className="uppercase tracking-wider mr-1">invalidates:</span>
          {flag.invalidation}
        </div>
      )}

      {/* Tags */}
      {flag.tags && flag.tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {flag.tags.map((tag) => (
            <span
              key={tag}
              className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-muted/40 text-muted-foreground"
            >
              {tag}
            </span>
          ))}
        </div>
      )}

      <div className="text-[9px] text-muted-foreground/60 tabular-nums">
        {relativeTime(flag.created_at)}
      </div>
    </Card>
  );
}

export default function Flags() {
  const qc = useQueryClient();
  const [filters, setFilters] = useState<Filters>({
    specialists: new Set(),
    status: 'all',
    direction: 'all',
    minScore: 70,
    onlySlacked: false,
  });

  const { data: flags, isLoading } = useQuery<Flag[]>({
    queryKey: ['ct_flags_live', {
      specialists: Array.from(filters.specialists).sort(),
      status: filters.status,
      direction: filters.direction,
      minScore: filters.minScore,
      onlySlacked: filters.onlySlacked,
    }],
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let q: any = supabase
        .from('ct_flags' as never)
        .select('*, ct_flag_grades(outcome, alpha_pct, price_change_pct, graded_at)')
        .order('created_at', { ascending: false })
        .limit(200);
      if (filters.specialists.size > 0) {
        q = q.in('specialist_ticker', Array.from(filters.specialists));
      }
      if (filters.status !== 'all') q = q.eq('status', filters.status);
      if (filters.direction !== 'all') q = q.eq('direction', filters.direction);
      if (filters.onlySlacked) q = q.not('slacked_at', 'is', null);
      q = q.gte('score', filters.minScore);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as Flag[];
    },
    refetchInterval: 30_000,
  });

  const toggleSpecialist = (t: string) => {
    setFilters((prev) => {
      const next = new Set(prev.specialists);
      if (next.has(t)) next.delete(t); else next.add(t);
      return { ...prev, specialists: next };
    });
  };

  const counts = useMemo(() => {
    if (!flags) return { active: 0, conviction: 0, gradedToday: 0 };
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todayMs = todayStart.getTime();
    let active = 0, conviction = 0, gradedToday = 0;
    for (const f of flags) {
      if (f.status === 'active') active++;
      if (f.status === 'conviction') conviction++;
      const g = f.ct_flag_grades?.[0];
      if (g?.graded_at && Date.parse(g.graded_at) >= todayMs) gradedToday++;
    }
    return { active, conviction, gradedToday };
  }, [flags]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-[1600px] mx-auto p-4 space-y-4">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Activity className="w-5 h-5 text-primary" />
              <span>Flags</span>
            </h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              Live specialist predictions, graded by outcome at horizon.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-[11px] text-muted-foreground tabular-nums flex items-center gap-3">
              <span>
                <span className="text-blue-300 font-semibold">{counts.active}</span> active
              </span>
              <span>
                <span className="text-emerald-300 font-semibold">{counts.conviction}</span> conviction
              </span>
              <span>
                <span className="text-foreground font-semibold">{counts.gradedToday}</span> graded today
              </span>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => qc.invalidateQueries({ queryKey: ['ct_flags_live'] })}
              className="text-xs"
            >
              <RefreshCw className="w-3 h-3 mr-1" />
              Refresh
            </Button>
          </div>
        </header>

        {/* Filter strip */}
        <Card className="p-3 space-y-3">
          {/* Specialist chips */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-muted-foreground mr-1">Specialist:</span>
            {TICKERS.map((t) => {
              const on = filters.specialists.has(t);
              return (
                <button
                  key={t}
                  onClick={() => toggleSpecialist(t)}
                  className={cn(
                    'text-[11px] font-mono px-2 py-1 rounded border transition-colors',
                    on
                      ? 'border-primary/40 bg-primary/10 text-primary'
                      : 'border-muted bg-muted/20 text-muted-foreground hover:text-foreground',
                  )}
                >
                  {t}
                </button>
              );
            })}
            {filters.specialists.size > 0 && (
              <button
                onClick={() => setFilters((p) => ({ ...p, specialists: new Set() }))}
                className="text-[10px] text-muted-foreground underline ml-1"
              >
                clear
              </button>
            )}
          </div>

          <div className="flex items-center gap-4 flex-wrap">
            {/* Status toggle */}
            <div className="flex items-center gap-1">
              <span className="text-xs text-muted-foreground mr-1">Status:</span>
              {(['all', 'active', 'conviction', 'graded'] as const).map((s) => (
                <Button
                  key={s}
                  size="sm"
                  variant={filters.status === s ? 'default' : 'outline'}
                  onClick={() => setFilters((p) => ({ ...p, status: s }))}
                  className="h-7 px-2 text-[11px] capitalize"
                >
                  {s}
                </Button>
              ))}
            </div>

            {/* Direction toggle */}
            <div className="flex items-center gap-1">
              <span className="text-xs text-muted-foreground mr-1">Direction:</span>
              {(['all', 'bullish', 'bearish'] as const).map((d) => (
                <Button
                  key={d}
                  size="sm"
                  variant={filters.direction === d ? 'default' : 'outline'}
                  onClick={() => setFilters((p) => ({ ...p, direction: d }))}
                  className="h-7 px-2 text-[11px] capitalize"
                >
                  {d}
                </Button>
              ))}
            </div>

            {/* Slacked toggle */}
            <div className="flex items-center gap-2 ml-auto">
              <span className="text-xs text-muted-foreground">Only Slacked</span>
              <Switch
                checked={filters.onlySlacked}
                onCheckedChange={(v) => setFilters((p) => ({ ...p, onlySlacked: v }))}
              />
            </div>
          </div>

          {/* Min score slider */}
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground shrink-0">Min score: {filters.minScore}</span>
            <div className="flex-1 max-w-sm">
              <Slider
                min={60}
                max={100}
                step={1}
                value={[filters.minScore]}
                onValueChange={(v) => setFilters((p) => ({ ...p, minScore: v[0] }))}
              />
            </div>
            <div className="flex gap-1">
              {[60, 70, 80, 90].map((n) => (
                <button
                  key={n}
                  onClick={() => setFilters((p) => ({ ...p, minScore: n }))}
                  className={cn(
                    'text-[10px] font-mono px-1.5 py-0.5 rounded transition-colors',
                    filters.minScore === n
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
        </Card>

        {/* Flags list */}
        {isLoading && !flags ? (
          <Card className="p-8 text-center text-sm text-muted-foreground">
            Loading flags…
          </Card>
        ) : !flags || flags.length === 0 ? (
          <Card className="p-8 text-center text-sm text-muted-foreground">
            No flags issued yet. Specialists wake up on scheduled cadence or when flow exceeds score 70.
            First flag will appear here.
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {flags.map((f) => (
              <FlagTile key={f.id} flag={f} />
            ))}
          </div>
        )}

        <div className="text-[10px] text-muted-foreground leading-relaxed space-y-1">
          <div>
            Sorted newest first. Refreshes every 30s. Limit 200 flags — older flags archived
            to /edge attribution view.
          </div>
          <div>
            <span className="font-semibold">Score bands:</span>{' '}
            <span className="text-emerald-300">≥80 conviction</span>{' '}
            · <span className="text-amber-300">60-79 flag</span>{' '}
            · <span className="text-slate-300">&lt;60 watching</span> (filtered out by default).
          </div>
        </div>
      </div>
    </div>
  );
}
