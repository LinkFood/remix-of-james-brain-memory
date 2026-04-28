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
  invalidation_price: number | null;
  horizon_hours: number;
  horizon_ts: string;
  entry_price: number | null;
  target_price: number | null;
  status: Status;
  confirmed_t1: boolean;
  slacked_at: string | null;
  created_at: string;
  ct_flag_grades: FlagGrade[] | FlagGrade | null;
}

/** PostgREST returns a 1:1 FK join as a single object, not an array.
 *  ct_flag_grades has a UNIQUE constraint on flag_id, so the runtime shape is
 *  the object form even though older code assumed array. Normalize here. */
function pickGrade(flag: { ct_flag_grades: FlagGrade[] | FlagGrade | null }): FlagGrade | null {
  const g = flag.ct_flag_grades;
  if (!g) return null;
  if (Array.isArray(g)) return g[0] ?? null;
  return g;
}

type OutcomeFilter = 'active' | 'won' | 'lost' | 'neutral' | 'all';

type DateRangeFilter = 'today' | '7d' | '30d' | 'all';

/** Convert a date-range filter to an ISO cutoff for `created_at >=` queries.
 *  'today' = NY-tz midnight today; '7d' / '30d' = N days ago; 'all' = null. */
function dateRangeCutoff(range: DateRangeFilter): string | null {
  if (range === 'all') return null;
  const now = new Date();
  if (range === 'today') {
    // NY-tz midnight to align with the trader's calendar day.
    const nyParts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(now).reduce<Record<string, string>>((acc, p) => {
      if (p.type !== 'literal') acc[p.type] = p.value;
      return acc;
    }, {});
    // Construct an ISO that represents NY-midnight today.
    return new Date(`${nyParts.year}-${nyParts.month}-${nyParts.day}T00:00:00-04:00`).toISOString();
  }
  const days = range === '7d' ? 7 : 30;
  return new Date(now.getTime() - days * 24 * 60 * 60_000).toISOString();
}

interface Filters {
  specialists: Set<string>;
  status: 'all' | Status;
  direction: 'all' | Direction;
  outcome: OutcomeFilter;
  minScore: number;
  onlySlacked: boolean;
  dateRange: DateRangeFilter;
}

interface JamesFlagGrade {
  outcome: string;
  price_change_pct: number | null;
  graded_at: string | null;
}

// James stars are now ct_flags rows with source='james_star'. Same row shape
// as Flag, plus a slimmer view here for the star tile. Keep separate type so
// the tile renderer doesn't try to access score / thesis / target the way the
// FlagTile does — stars carry NULL on most of those.
interface JamesFlag {
  id: string;
  option_symbol: string | null;
  instrument: string;
  direction: Direction;
  thesis: string | null;
  source_flow_ids: number[] | null;
  created_at: string;
  ct_flag_grades: JamesFlagGrade[] | JamesFlagGrade | null;
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
  // WIN → emerald, LOSS → rose, NEUTRAL (partial) → slate,
  // INVALIDATED_EARLY → amber. Maps the 4 grader buckets to the chip palette
  // spec'd in the Tier 2 plan.
  if (outcome === 'win') return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40';
  if (outcome === 'loss') return 'bg-rose-500/15 text-rose-300 border-rose-500/40';
  if (outcome === 'invalidated_early') return 'bg-amber-500/15 text-amber-300 border-amber-500/40';
  // 'partial' and any unknown → neutral
  return 'bg-slate-500/15 text-slate-300 border-slate-500/40';
}

function outcomeLabel(outcome: string): string {
  if (outcome === 'win') return 'WIN';
  if (outcome === 'loss') return 'LOSS';
  if (outcome === 'invalidated_early') return 'INVALIDATED_EARLY';
  if (outcome === 'partial') return 'NEUTRAL';
  return outcome.toUpperCase();
}

type ProgressBucket = 'won' | 'on_track' | 'drifting' | 'underwater';

function computeProgress(
  direction: Direction,
  entry: number | null,
  target: number | null,
  spot: number | null | undefined,
): { pct: number; bucket: ProgressBucket } | null {
  if (entry == null || target == null || spot == null) return null;
  if (!Number.isFinite(entry) || !Number.isFinite(target) || !Number.isFinite(spot)) return null;
  const denom = direction === 'bearish' ? entry - target : target - entry;
  if (denom === 0) return null;
  const numer = direction === 'bearish' ? entry - spot : spot - entry;
  const pct = (numer / denom) * 100;
  let bucket: ProgressBucket;
  if (pct >= 100) bucket = 'won';
  else if (pct >= 25) bucket = 'on_track';
  else if (pct >= 0) bucket = 'drifting';
  else bucket = 'underwater';
  return { pct, bucket };
}

function ProgressChip({
  flag,
  spot,
}: {
  flag: Flag;
  spot: number | null | undefined;
}) {
  // TODO(flags): ct_flags.invalidation is prose not a price — when we add
  // invalidation_price column (tier 2 grader work), expand this chip to show
  // stop-buffer state ('at_risk' / 'invalidated').
  const { entry_price, target_price, direction } = flag;
  if (entry_price == null || target_price == null || spot == null) {
    return (
      <div className="text-[10px] text-muted-foreground tabular-nums italic">
        no progress yet — {target_price == null ? 'target not set' : spot == null ? 'spot loading' : 'awaiting entry'}
      </div>
    );
  }
  const prog = computeProgress(direction, entry_price, target_price, spot);
  if (!prog) return null;
  const { pct, bucket } = prog;
  const clamped = Math.max(0, Math.min(100, pct));
  const targetMovePct = entry_price !== 0 ? ((target_price - entry_price) / entry_price) * 100 : 0;

  const barColor =
    bucket === 'won' || bucket === 'on_track'
      ? 'bg-emerald-500'
      : bucket === 'underwater'
      ? 'bg-rose-500'
      : 'bg-slate-500';

  const labelColor =
    bucket === 'won' || bucket === 'on_track'
      ? 'text-emerald-300'
      : bucket === 'underwater'
      ? 'text-rose-300'
      : 'text-slate-400';

  return (
    <div className="flex flex-col gap-1">
      <div className="text-[10px] text-muted-foreground tabular-nums">
        spot <span className="text-foreground font-mono">${spot.toFixed(2)}</span>
        {' · '}
        target <span className="text-foreground font-mono">${target_price.toFixed(2)}</span>
        {' '}
        <span className="text-muted-foreground">
          ({targetMovePct >= 0 ? '+' : ''}{targetMovePct.toFixed(1)}%)
        </span>
      </div>
      <div className="flex items-center gap-2">
        <div className="relative h-1.5 flex-1 rounded bg-muted/40 overflow-hidden">
          <div
            className={cn('h-full transition-all', barColor)}
            style={{ width: `${clamped}%` }}
          />
        </div>
        <span className={cn('text-[10px] font-mono tabular-nums shrink-0', labelColor)}>
          {Math.round(pct)}% toward target
        </span>
      </div>
    </div>
  );
}

function FlagTile({
  flag,
  onOpen,
  spot,
}: {
  flag: Flag;
  onOpen: (flag: Flag) => void;
  spot: number | null | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const grade = pickGrade(flag);
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
              className={cn('text-[10px] px-1.5 py-0 font-mono', outcomeColor(grade.outcome))}
            >
              {outcomeLabel(grade.outcome)}
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

      {/* Live progress chip while active; outcome chip once graded.
          The graded chip replaces the progress bar in the same slot so the
          row keeps a consistent vertical rhythm whether or not the grader
          has fired. */}
      {!isGraded ? (
        <ProgressChip flag={flag} spot={spot} />
      ) : grade ? (
        <div className="flex items-center gap-2">
          <Badge
            variant="outline"
            className={cn('text-[11px] px-2 py-0.5 font-mono', outcomeColor(grade.outcome))}
          >
            {outcomeLabel(grade.outcome)}
          </Badge>
          {grade.price_change_pct != null && (
            <span className="text-[10px] text-muted-foreground tabular-nums">
              spot {grade.price_change_pct >= 0 ? '+' : ''}{grade.price_change_pct.toFixed(2)}%
            </span>
          )}
          {grade.alpha_pct != null && (
            <span className="text-[10px] text-muted-foreground tabular-nums">
              · α {grade.alpha_pct >= 0 ? '+' : ''}{grade.alpha_pct.toFixed(2)}%
            </span>
          )}
        </div>
      ) : null}

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

function JamesFlagTile({ flag, onOpen, showOriginBadge }: {
  flag: JamesFlag; onOpen: (s: string) => void; showOriginBadge?: boolean;
}) {
  const rawGrade = flag.ct_flag_grades;
  const grade: JamesFlagGrade | null = Array.isArray(rawGrade) ? (rawGrade[0] ?? null) : (rawGrade ?? null);
  const direction: Direction = flag.direction;
  const graded = !!(grade && grade.outcome && grade.outcome !== 'pending');
  const outcomeClass = graded
    ? outcomeColor(grade!.outcome)
    : 'border-slate-500/40 text-slate-400';

  return (
    <Card
      onClick={() => flag.option_symbol && onOpen(flag.option_symbol)}
      className="p-3 flex flex-col gap-2 hover:shadow-md transition-shadow cursor-pointer"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant="outline" className={cn('font-mono text-[11px] px-1.5 py-0', directionColor(direction))}>
            <DirectionIcon d={direction} />
            <span className="ml-1">{flag.instrument ?? '—'}</span>
          </Badge>
          {showOriginBadge && (
            <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-mono border-amber-500/40 text-amber-300">
              <Star className="w-2.5 h-2.5 mr-1" />James
            </Badge>
          )}
          <Badge variant="outline" className={cn('text-[10px] px-1.5 py-0 font-mono uppercase', outcomeClass)}>
            {graded ? outcomeLabel(grade!.outcome) : 'pending'}
          </Badge>
        </div>
        <Star className="w-4 h-4 text-amber-400 shrink-0 fill-amber-400/40" />
      </div>

      <div className="flex items-center justify-between text-[11px] text-muted-foreground gap-2">
        <div className="font-mono truncate">{flag.option_symbol ?? '—'}</div>
        {graded && grade!.price_change_pct != null && (
          <div className="shrink-0 text-[10px] tabular-nums">
            spot {grade!.price_change_pct >= 0 ? '+' : ''}{grade!.price_change_pct.toFixed(2)}%
          </div>
        )}
      </div>

      <div className="text-[12px] leading-snug text-foreground/90">
        {flag.thesis?.trim() ? flag.thesis : <span className="text-muted-foreground italic">No note</span>}
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
    outcome: 'active',
    minScore: 70,
    onlySlacked: false,
    dateRange: 'today',
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
      dateRange: filters.dateRange,
    }],
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let q: any = supabase
        .from('ct_flags' as never)
        .select('*, ct_flag_grades(outcome, alpha_pct, price_change_pct, graded_at)')
        .in('source', ['specialist', 'signature_alarm', 'detector_alarm'])
        .order('created_at', { ascending: false })
        .limit(200);
      if (filters.specialists.size > 0) {
        q = q.in('specialist_ticker', Array.from(filters.specialists));
      }
      if (filters.status !== 'all') q = q.eq('status', filters.status);
      if (filters.direction !== 'all') q = q.eq('direction', filters.direction);
      if (filters.onlySlacked) q = q.not('slacked_at', 'is', null);
      q = q.gte('score', filters.minScore);
      const cutoff = dateRangeCutoff(filters.dateRange);
      if (cutoff) q = q.gte('created_at', cutoff);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as Flag[];
    },
    refetchInterval: 30_000,
    enabled: specialistsActive,
  });

  // Apply outcome-bucket filter client-side. Active = ungraded (no grade row).
  // Won / Lost / Neutral map to grade.outcome buckets. All = passthrough.
  const filteredFlags = useMemo(() => {
    if (!flags) return flags;
    if (filters.outcome === 'all') return flags;
    return flags.filter((f) => {
      const grade = pickGrade(f);
      const outcome = grade?.outcome ?? null;
      switch (filters.outcome) {
        case 'active':
          return outcome === null;
        case 'won':
          return outcome === 'win';
        case 'lost':
          return outcome === 'loss';
        case 'neutral':
          return outcome === 'partial' || outcome === 'invalidated_early';
        default:
          return true;
      }
    });
  }, [flags, filters.outcome]);

  const { data: jamesFlags, isLoading: jamesLoading } = useQuery<JamesFlag[]>({
    queryKey: ['ct_james_flags_live', {
      specialists: Array.from(filters.specialists).sort(),
      direction: filters.direction,
      dateRange: filters.dateRange,
    }],
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let q: any = supabase
        .from('ct_flags' as never)
        .select('id, option_symbol, instrument, direction, thesis, source_flow_ids, created_at, ct_flag_grades(outcome, price_change_pct, graded_at)')
        .eq('source', 'james_star')
        .order('created_at', { ascending: false })
        .limit(200);
      if (filters.specialists.size > 0) {
        // Stars carry the underlying as `instrument`; reuse the specialist
        // chip group as a ticker filter rather than introduce a parallel set.
        q = q.in('instrument', Array.from(filters.specialists));
      }
      if (filters.direction !== 'all') q = q.eq('direction', filters.direction);
      const cutoff = dateRangeCutoff(filters.dateRange);
      if (cutoff) q = q.gte('created_at', cutoff);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as JamesFlag[];
    },
    refetchInterval: 30_000,
    enabled: mineActive,
  });

  // Unique tickers we need live spot for — only non-terminal specialist flags with entry+target.
  const tickersNeedingSpot = useMemo(() => {
    if (!filteredFlags) return [] as string[];
    const set = new Set<string>();
    for (const f of filteredFlags) {
      if (f.status === 'graded' || f.status === 'invalidated') continue;
      if (f.entry_price == null || f.target_price == null) continue;
      if (f.specialist_ticker) set.add(f.specialist_ticker);
    }
    return Array.from(set).sort();
  }, [filteredFlags]);

  const { data: spotMap } = useQuery<Map<string, number>>({
    queryKey: ['ct_flags_spot_map', tickersNeedingSpot],
    enabled: tickersNeedingSpot.length > 0,
    refetchInterval: 60_000,
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.from('ct_ticker_snapshots' as never) as any)
        .select('ticker, spot')
        .in('ticker', tickersNeedingSpot);
      if (error) throw error;
      const m = new Map<string, number>();
      for (const row of (data ?? []) as Array<{ ticker: string; spot: number | null }>) {
        if (row.spot != null) m.set(row.ticker, row.spot);
      }
      return m;
    },
  });

  const toggleSpecialist = (t: string) => {
    setFilters((prev) => {
      const next = new Set(prev.specialists);
      if (next.has(t)) next.delete(t); else next.add(t);
      return { ...prev, specialists: next };
    });
  };

  // Counts run against the unfiltered list so badge totals don't shift when
  // the user narrows the outcome filter — they're meant to read like fixed
  // status banners, not query-result counters.
  const counts = useMemo(() => {
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todayMs = todayStart.getTime();
    let active = 0, conviction = 0, gradedToday = 0;
    if (flags) {
      for (const f of flags) {
        if (f.status === 'active') active++;
        if (f.status === 'conviction') conviction++;
        const g = pickGrade(f);
        if (g?.graded_at && Date.parse(g.graded_at) >= todayMs) gradedToday++;
      }
    }
    const mine = jamesFlags?.length ?? 0;
    return { active, conviction, gradedToday, mine };
  }, [flags, jamesFlags]);

  // Merged, chronologically sorted feed honoring mode + outcome filter.
  const merged: MergedItem[] = useMemo(() => {
    const items: MergedItem[] = [];
    if (specialistsActive && filteredFlags) {
      for (const f of filteredFlags) {
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
  }, [filteredFlags, jamesFlags, specialistsActive, mineActive]);

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

          {/* Date range — Today is the default so /flags opens to fresh signal */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-muted-foreground mr-1">When:</span>
            {([
              { key: 'today', label: 'Today' },
              { key: '7d', label: '7d' },
              { key: '30d', label: '30d' },
              { key: 'all', label: 'All' },
            ] as const).map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setFilters((p) => ({ ...p, dateRange: key }))}
                className={cn(
                  'text-[11px] font-mono px-2 py-1 rounded border transition-colors',
                  filters.dateRange === key
                    ? 'border-primary/40 bg-primary/10 text-primary'
                    : 'border-muted bg-muted/20 text-muted-foreground hover:text-foreground',
                )}
              >
                {label}
              </button>
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

            {/* Outcome bucket toggle — specialist-only. Default 'active' so
                page opens to ungraded flags; switching to Won/Lost/Neutral
                surfaces grader output. */}
            {specialistsActive && (
              <div className="flex items-center gap-1">
                <span className="text-xs text-muted-foreground mr-1">Outcome:</span>
                {([
                  { key: 'active', label: 'Active' },
                  { key: 'won', label: 'Won' },
                  { key: 'lost', label: 'Lost' },
                  { key: 'neutral', label: 'Neutral' },
                  { key: 'all', label: 'All' },
                ] as const).map(({ key, label }) => (
                  <Button
                    key={key}
                    size="sm"
                    variant={filters.outcome === key ? 'default' : 'outline'}
                    onClick={() => setFilters((p) => ({ ...p, outcome: key }))}
                    className="h-7 px-2 text-[11px]"
                  >
                    {label}
                  </Button>
                ))}
              </div>
            )}

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
            ) : filters.outcome !== 'all' && filters.outcome !== 'active' ? (
              <>
                No <span className="lowercase">{filters.outcome}</span> flags yet at this threshold.
                Switch the Outcome filter to <span className="font-medium">All</span> to widen,
                or <span className="font-medium">Active</span> for ungraded flags.
              </>
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
                <FlagTile
                  key={item.key}
                  flag={item.flag}
                  onOpen={setSelectedFlag}
                  spot={spotMap?.get(item.flag.specialist_ticker)}
                />
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
