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
  Activity, RefreshCw, ArrowUp, ArrowDown, Minus, Send, ChevronDown, ChevronUp, Star,
} from 'lucide-react';
import { FlagDetailSheet } from '@/components/command/FlagDetailSheet';
import { ContractSheet } from '@/components/command/ContractSheet';

type Mode = 'specialists' | 'mine' | 'both';

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
  penalty_breakdown: Record<string, number> | null;
  source_flow_ids: number[] | null;
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

interface JamesFlagGrade {
  outcome: string;
  price_change_pct: number | null;
  move_to_strike_pct: number | null;
  crossed_strike: boolean | null;
  graded_at: string | null;
}

interface JamesFlag {
  id: number;
  option_symbol: string;
  ticker: string | null;
  source_flow_id: number | null;
  source_alert_id: string | null;
  direction_view: Direction | null;
  note: string | null;
  created_at: string;
  ct_james_flag_grades: JamesFlagGrade[] | null;
}

type MergedItem =
  | { origin: 'claude'; created_at: string; key: string; flag: Flag }
  | { origin: 'james'; created_at: string; key: string; flag: JamesFlag };

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

function FlagTile({ flag, onOpen }: { flag: Flag; onOpen: (flag: Flag) => void }) {
  const [expanded, setExpanded] = useState(false);
  const grade = flag.ct_flag_grades?.[0] ?? null;
  const isGraded = flag.status === 'graded' || flag.status === 'invalidated';

  return (
    <Card
      onClick={() => onOpen(flag)}
      className="p-3 flex flex-col gap-2 hover:shadow-md transition-shadow cursor-pointer"
    >
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

      {/* Thesis — 2 lines truncated, expand on click. stopPropagation so the
          tile-level click (which opens the detail sheet) doesn't fire here. */}
      <button
        onClick={(e) => { e.stopPropagation(); setExpanded((x) => !x); }}
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

function JamesFlagTile({
  flag,
  onOpen,
  showOriginBadge,
}: {
  flag: JamesFlag;
  onOpen: (optionSymbol: string) => void;
  showOriginBadge?: boolean;
}) {
  const grade = flag.ct_james_flag_grades?.[0] ?? null;
  const direction: Direction = flag.direction_view ?? 'neutral';
  const hasGrade = grade != null && grade.outcome && grade.outcome !== 'pending';

  return (
    <Card
      onClick={() => onOpen(flag.option_symbol)}
      className="p-3 flex flex-col gap-2 hover:shadow-md transition-shadow cursor-pointer"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge
            variant="outline"
            className={cn('font-mono text-[11px] px-1.5 py-0', directionColor(direction))}
          >
            <DirectionIcon d={direction} />
            <span className="ml-1">{flag.ticker ?? '—'}</span>
          </Badge>
          {showOriginBadge && (
            <Badge
              variant="outline"
              className="text-[10px] px-1.5 py-0 font-mono border-amber-500/40 text-amber-300"
            >
              <Star className="w-2.5 h-2.5 mr-1" />
              James
            </Badge>
          )}
          {hasGrade && (
            <Badge
              variant="outline"
              className={cn('text-[10px] px-1.5 py-0 font-mono uppercase', outcomeColor(grade!.outcome))}
            >
              {grade!.outcome}
            </Badge>
          )}
          {!hasGrade && (
            <Badge
              variant="outline"
              className="text-[10px] px-1.5 py-0 font-mono uppercase border-slate-500/40 text-slate-400"
            >
              pending
            </Badge>
          )}
          {hasGrade && grade!.move_to_strike_pct != null && (
            <span className="text-[10px] font-mono text-muted-foreground tabular-nums">
              {grade!.move_to_strike_pct >= 0 ? '+' : ''}
              {grade!.move_to_strike_pct.toFixed(1)}% to strike
              {grade!.crossed_strike && <span className="ml-1 text-emerald-300">✓</span>}
            </span>
          )}
        </div>
        <Star className="w-4 h-4 text-amber-400 shrink-0 fill-amber-400/40" />
      </div>

      {/* Contract */}
      <div className="flex items-center justify-between text-[11px] text-muted-foreground gap-2">
        <div className="font-mono truncate">{flag.option_symbol}</div>
        {hasGrade && grade!.price_change_pct != null && (
          <div className="shrink-0 text-[10px] tabular-nums">
            spot {grade!.price_change_pct >= 0 ? '+' : ''}
            {grade!.price_change_pct.toFixed(2)}%
          </div>
        )}
      </div>

      {/* Note */}
      <div className="text-[12px] leading-snug text-foreground/90">
        {flag.note?.trim() ? flag.note : <span className="text-muted-foreground italic">No note</span>}
      </div>

      <div className="text-[9px] text-muted-foreground/60 tabular-nums">
        starred {relativeTime(flag.created_at)}
      </div>
    </Card>
  );
}

export default function Flags() {
  const qc = useQueryClient();
  const [mode, setMode] = useState<Mode>('specialists');
  const [filters, setFilters] = useState<Filters>({
    specialists: new Set(),
    status: 'all',
    direction: 'all',
    minScore: 70,
    onlySlacked: false,
  });
  const [selectedFlag, setSelectedFlag] = useState<Flag | null>(null);
  const [selectedContract, setSelectedContract] = useState<string | null>(null);

  const specialistsActive = mode === 'specialists' || mode === 'both';
  const mineActive = mode === 'mine' || mode === 'both';

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
    enabled: specialistsActive,
  });

  const { data: jamesFlags, isLoading: jamesLoading } = useQuery<JamesFlag[]>({
    queryKey: ['ct_james_flags_live', {
      specialists: Array.from(filters.specialists).sort(),
      direction: filters.direction,
    }],
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let q: any = supabase
        .from('ct_james_flags' as never)
        .select('id, option_symbol, ticker, source_flow_id, source_alert_id, direction_view, note, created_at, ct_james_flag_grades(outcome, price_change_pct, move_to_strike_pct, crossed_strike, graded_at)')
        .order('created_at', { ascending: false })
        .limit(200);
      if (filters.specialists.size > 0) {
        q = q.in('ticker', Array.from(filters.specialists));
      }
      if (filters.direction !== 'all') q = q.eq('direction_view', filters.direction);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as JamesFlag[];
    },
    refetchInterval: 30_000,
    enabled: mineActive,
  });

  const toggleSpecialist = (t: string) => {
    setFilters((prev) => {
      const next = new Set(prev.specialists);
      if (next.has(t)) next.delete(t); else next.add(t);
      return { ...prev, specialists: next };
    });
  };

  const counts = useMemo(() => {
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todayMs = todayStart.getTime();
    let active = 0, conviction = 0, gradedToday = 0;
    if (flags) {
      for (const f of flags) {
        if (f.status === 'active') active++;
        if (f.status === 'conviction') conviction++;
        const g = f.ct_flag_grades?.[0];
        if (g?.graded_at && Date.parse(g.graded_at) >= todayMs) gradedToday++;
      }
    }
    const mine = jamesFlags?.length ?? 0;
    return { active, conviction, gradedToday, mine };
  }, [flags, jamesFlags]);

  // Merged, chronologically sorted feed honoring mode.
  const merged: MergedItem[] = useMemo(() => {
    const items: MergedItem[] = [];
    if (specialistsActive && flags) {
      for (const f of flags) {
        items.push({ origin: 'claude', created_at: f.created_at, key: `c-${f.id}`, flag: f });
      }
    }
    if (mineActive && jamesFlags) {
      for (const f of jamesFlags) {
        items.push({ origin: 'james', created_at: f.created_at, key: `j-${f.id}`, flag: f });
      }
    }
    items.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    return items;
  }, [flags, jamesFlags, specialistsActive, mineActive]);

  const listLoading = (specialistsActive && isLoading && !flags) || (mineActive && jamesLoading && !jamesFlags);

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
              {specialistsActive && (
                <>
                  <span>
                    <span className="text-blue-300 font-semibold">{counts.active}</span> active
                  </span>
                  <span>
                    <span className="text-emerald-300 font-semibold">{counts.conviction}</span> conviction
                  </span>
                  <span>
                    <span className="text-foreground font-semibold">{counts.gradedToday}</span> graded today
                  </span>
                </>
              )}
              {mineActive && (
                <span>
                  <span className="text-amber-300 font-semibold">{counts.mine}</span> mine
                </span>
              )}
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                qc.invalidateQueries({ queryKey: ['ct_flags_live'] });
                qc.invalidateQueries({ queryKey: ['ct_james_flags_live'] });
              }}
              className="text-xs"
            >
              <RefreshCw className="w-3 h-3 mr-1" />
              Refresh
            </Button>
          </div>
        </header>

        {/* Filter strip */}
        <Card className="p-3 space-y-3">
          {/* Mode segmented control */}
          <div className="flex items-center gap-1">
            <span className="text-xs text-muted-foreground mr-1">View:</span>
            {(['specialists', 'mine', 'both'] as const).map((m) => (
              <Button
                key={m}
                size="sm"
                variant={mode === m ? 'default' : 'outline'}
                onClick={() => setMode(m)}
                className="h-7 px-3 text-[11px] capitalize"
              >
                {m === 'mine' && <Star className="w-3 h-3 mr-1" />}
                {m}
              </Button>
            ))}
          </div>

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
            {/* Status toggle — specialist-only */}
            {specialistsActive && (
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
            )}

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

            {/* Slacked toggle — specialist-only */}
            {specialistsActive && (
              <div className="flex items-center gap-2 ml-auto">
                <span className="text-xs text-muted-foreground">Only Slacked</span>
                <Switch
                  checked={filters.onlySlacked}
                  onCheckedChange={(v) => setFilters((p) => ({ ...p, onlySlacked: v }))}
                />
              </div>
            )}
          </div>

          {/* Min score slider — specialist-only */}
          {specialistsActive && (
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
          )}
        </Card>

        {/* Flags list */}
        {listLoading ? (
          <Card className="p-8 text-center text-sm text-muted-foreground">
            Loading flags…
          </Card>
        ) : merged.length === 0 ? (
          <Card className="p-8 text-center text-sm text-muted-foreground">
            {mode === 'mine' ? (
              <>No stars yet. Flag a print from the /tape page and it will show up here.</>
            ) : mode === 'both' ? (
              <>Nothing to show. No specialist flags at this threshold and no stars yet.</>
            ) : (
              <>
                No flags issued yet. Specialists wake up on scheduled cadence or when flow exceeds score 70.
                First flag will appear here.
              </>
            )}
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {merged.map((item) =>
              item.origin === 'claude' ? (
                <FlagTile key={item.key} flag={item.flag} onOpen={setSelectedFlag} />
              ) : (
                <JamesFlagTile
                  key={item.key}
                  flag={item.flag}
                  onOpen={setSelectedContract}
                  showOriginBadge={mode === 'both'}
                />
              ),
            )}
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

      {/* Flag drill-down sheet */}
      <FlagDetailSheet
        flag={selectedFlag}
        open={selectedFlag !== null}
        onOpenChange={(o) => { if (!o) setSelectedFlag(null); }}
      />

      {/* Contract sheet for James's stars */}
      <ContractSheet
        optionSymbol={selectedContract}
        open={selectedContract !== null}
        onOpenChange={(o) => { if (!o) setSelectedContract(null); }}
      />
    </div>
  );
}
