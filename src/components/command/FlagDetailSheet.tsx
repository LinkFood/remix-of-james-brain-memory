/**
 * FlagDetailSheet — right-side drill-down for a single ct_flags row.
 *
 * Opened from the /flags page when a tile is clicked. Shows:
 *   - Header: specialist + option_symbol + direction/score/status badges + horizon
 *   - Full thesis + invalidation
 *   - Score breakdown (labeled bars) from score_breakdown + penalty_breakdown
 *   - Source flow events: ct_scored_flow rows whose id is in source_flow_ids
 *   - OI history: last 5 ct_oi_snapshots rows for the contract
 *   - Underlying snapshot: first + latest ct_price_bars for the ticker today
 *
 * All data fetched on-demand when the sheet opens; polls every 30s while open.
 */

import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { Activity, ArrowUp, ArrowDown, Minus, Send } from 'lucide-react';

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
  // Columns not on the Flags page interface but present in DB — optional here:
  source_flow_ids?: number[] | null;
  penalty_breakdown?: Record<string, number> | null;
}

interface SourceFlow {
  id: number;
  event_ts: string;
  premium: number | null;
  volume: number | null;
  open_interest: number | null;
  ask_side_perc: number | null;
  classification: string | null;
  score: number | null;
}

interface OiSnap {
  id: number;
  snap_date: string;
  snap_slot: 'open' | 'mid' | 'close';
  oi: number | null;
  oi_delta_1d: number | null;
}

interface PriceBar {
  ts: string;
  open: number | null;
  close: number | null;
  last: number | null;
}

interface FlagDetailSheetProps {
  flag: Flag | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Bar labels must match the jsonb keys written by the scorer.
const POSITIVE_KEYS: [string, string, number][] = [
  ['opening_buy', 'Opening buy', 25],
  ['t1_oi_confirm', 'T1 OI confirm', 20],
  ['single_direction', 'Single direction', 15],
  ['dte', 'DTE', 15],
  ['delta', 'Delta', 10],
  ['iv_context', 'IV context', 10],
  ['size_vs_adv', 'Size vs ADV', 10],
];

const PENALTY_KEYS: [string, string][] = [
  ['hedge', 'Hedge'],
  ['earnings', 'Earnings'],
  ['expiration', 'Expiration'],
  ['dealer_hedge', 'Dealer hedge'],
];

function relativeTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function formatTimeET(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('en-US', {
      timeZone: 'America/New_York',
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return iso.slice(11, 19);
  }
}

function formatPremium(n: number | null): string {
  if (n == null) return '-';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function formatInt(n: number | null): string {
  if (n == null) return '-';
  return n.toLocaleString('en-US');
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

function ScoreBar({
  label, value, max, negative = false,
}: { label: string; value: number; max: number; negative?: boolean }) {
  const pct = max > 0 ? Math.min(Math.abs(value) / max, 1) * 100 : 0;
  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between text-[10px]">
        <span className="text-muted-foreground">{label}</span>
        <span className={cn('font-mono tabular-nums', negative ? 'text-red-400' : value > 0 ? 'text-emerald-400' : 'text-muted-foreground')}>
          {negative ? `-${value.toFixed(1)}` : value.toFixed(1)} / {max}
        </span>
      </div>
      <div className="h-1 bg-muted/40 rounded overflow-hidden">
        <div
          className={cn('h-full', negative ? 'bg-red-400/70' : 'bg-emerald-400/70')}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export function FlagDetailSheet({ flag, open, onOpenChange }: FlagDetailSheetProps) {
  const sourceIds = flag?.source_flow_ids ?? [];

  const { data: sourceFlow } = useQuery<SourceFlow[]>({
    queryKey: ['ct_flag_source_flow', flag?.id, sourceIds.join(',')],
    enabled: open && !!flag && sourceIds.length > 0,
    refetchInterval: 30_000,
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.from('ct_scored_flow' as never) as any)
        .select('id,event_ts,premium,volume,open_interest,ask_side_perc,classification,score')
        .in('id', sourceIds)
        .order('event_ts', { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as SourceFlow[];
    },
  });

  const { data: oiHistory } = useQuery<OiSnap[]>({
    queryKey: ['ct_flag_oi', flag?.option_symbol],
    enabled: open && !!flag?.option_symbol,
    refetchInterval: 60_000,
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.from('ct_oi_snapshots' as never) as any)
        .select('id,snap_date,snap_slot,oi,oi_delta_1d')
        .eq('option_symbol', flag!.option_symbol)
        .order('snap_date', { ascending: false })
        .order('captured_at', { ascending: false })
        .limit(5);
      if (error) throw error;
      return (data ?? []) as unknown as OiSnap[];
    },
  });

  // Underlying last-price + today's % change. Uses ct_price_bars: pulls last 24
  // bars (any bar size; the numbers ratio still works) and compares the oldest
  // in the series to the newest. If the table is empty, we simply hide the
  // ticker.
  const { data: underlying } = useQuery<{ last: number; pct: number } | null>({
    queryKey: ['ct_flag_underlying', flag?.specialist_ticker],
    enabled: open && !!flag?.specialist_ticker,
    refetchInterval: 60_000,
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.from('ct_price_bars' as never) as any)
        .select('ts,open,close,last')
        .eq('ticker', flag!.specialist_ticker)
        .order('ts', { ascending: false })
        .limit(24);
      if (error) return null;
      const bars = (data ?? []) as unknown as PriceBar[];
      if (bars.length === 0) return null;
      const latest = bars[0];
      const oldest = bars[bars.length - 1];
      const latestPx = latest.last ?? latest.close ?? null;
      const basePx = oldest.open ?? oldest.close ?? null;
      if (latestPx == null || basePx == null || basePx === 0) return null;
      return {
        last: latestPx,
        pct: ((latestPx - basePx) / basePx) * 100,
      };
    },
  });

  if (!flag) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" className="w-full sm:max-w-2xl overflow-y-auto" />
      </Sheet>
    );
  }

  const grade = flag.ct_flag_grades?.[0] ?? null;
  const breakdown = (flag.score_breakdown ?? {}) as Record<string, number>;
  const penalty = (flag.penalty_breakdown ?? {}) as Record<string, number>;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-2xl overflow-y-auto p-0"
      >
        <div className="p-6 space-y-5">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2 text-base font-mono break-all">
              <Activity className="w-4 h-4 text-primary shrink-0" />
              <span>{flag.option_symbol ?? flag.instrument}</span>
            </SheetTitle>
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant="outline" className="text-[10px] font-mono px-1.5 py-0">
                {flag.specialist_ticker}
              </Badge>
              <Badge
                variant="outline"
                className={cn(
                  'text-[10px] font-mono px-1.5 py-0 inline-flex items-center gap-1',
                  flag.direction === 'bullish' && 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40',
                  flag.direction === 'bearish' && 'bg-red-500/15 text-red-300 border-red-500/40',
                  flag.direction === 'neutral' && 'bg-slate-500/15 text-slate-300 border-slate-500/40',
                )}
              >
                {flag.direction === 'bullish' ? <ArrowUp className="w-2.5 h-2.5" /> : flag.direction === 'bearish' ? <ArrowDown className="w-2.5 h-2.5" /> : <Minus className="w-2.5 h-2.5" />}
                {flag.direction}
              </Badge>
              <Badge
                variant="outline"
                className={cn(
                  'text-[10px] font-mono px-1.5 py-0 capitalize',
                  flag.status === 'conviction' && 'border-emerald-500/40 text-emerald-300',
                  flag.status === 'active' && 'border-blue-500/40 text-blue-300',
                  flag.status === 'graded' && 'border-slate-500/40 text-slate-300',
                  flag.status === 'invalidated' && 'border-red-500/40 text-red-300',
                )}
              >
                {flag.status}
              </Badge>
              <span
                className={cn(
                  'ml-auto text-xl font-bold tabular-nums',
                  flag.score >= 80 ? 'text-emerald-400' : flag.score >= 60 ? 'text-amber-400' : 'text-muted-foreground',
                )}
              >
                {Math.round(flag.score)}
              </span>
            </div>
            <div className="flex items-center gap-3 text-[11px] text-muted-foreground tabular-nums">
              <span>{timeToHorizon(flag.horizon_ts, flag.status, grade)}</span>
              {flag.slacked_at && (
                <span className="inline-flex items-center gap-0.5">
                  <Send className="w-3 h-3" /> slacked {relativeTime(flag.slacked_at)}
                </span>
              )}
              <span>created {relativeTime(flag.created_at)}</span>
              {underlying && (
                <span className="ml-auto font-mono">
                  {flag.specialist_ticker} ${underlying.last.toFixed(2)}{' '}
                  <span className={underlying.pct >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                    ({underlying.pct >= 0 ? '+' : ''}{underlying.pct.toFixed(2)}% today)
                  </span>
                </span>
              )}
            </div>
          </SheetHeader>

          {/* Thesis */}
          <section>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Thesis</div>
            <div className="text-sm text-foreground/90 leading-relaxed whitespace-pre-wrap">{flag.thesis}</div>
          </section>

          {/* Invalidation */}
          {flag.invalidation && (
            <section>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Invalidation</div>
              <div className="text-xs text-foreground/80 leading-relaxed whitespace-pre-wrap">{flag.invalidation}</div>
            </section>
          )}

          {/* Entry / target */}
          {(flag.entry_price != null || flag.target_price != null) && (
            <section className="flex gap-6 text-xs tabular-nums">
              {flag.entry_price != null && (
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Entry</div>
                  <div className="text-sm font-mono">${flag.entry_price.toFixed(2)}</div>
                </div>
              )}
              {flag.target_price != null && (
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Target</div>
                  <div className="text-sm font-mono">${flag.target_price.toFixed(2)}</div>
                </div>
              )}
            </section>
          )}

          {/* Score breakdown */}
          <section>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Score breakdown</div>
            <div className="grid grid-cols-2 gap-x-6 gap-y-2">
              {POSITIVE_KEYS.map(([key, label, max]) => (
                <ScoreBar key={key} label={label} value={Number(breakdown[key] ?? 0)} max={max} />
              ))}
              {PENALTY_KEYS.map(([key, label]) => {
                const v = Number(penalty[key] ?? 0);
                if (v === 0) return null;
                return <ScoreBar key={key} label={label} value={v} max={25} negative />;
              })}
            </div>
          </section>

          {/* Grade */}
          {grade && (
            <section>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Grade</div>
              <div className="flex items-center gap-3 text-sm">
                <Badge
                  variant="outline"
                  className={cn(
                    'text-[10px] font-mono uppercase px-1.5 py-0',
                    grade.outcome === 'win' && 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40',
                    grade.outcome === 'partial' && 'bg-amber-500/15 text-amber-300 border-amber-500/40',
                    grade.outcome === 'loss' && 'bg-red-500/15 text-red-300 border-red-500/40',
                  )}
                >
                  {grade.outcome}
                </Badge>
                {grade.alpha_pct != null && (
                  <span className="text-xs tabular-nums">
                    α <span className="font-mono">{grade.alpha_pct >= 0 ? '+' : ''}{grade.alpha_pct.toFixed(2)}%</span>
                  </span>
                )}
                {grade.price_change_pct != null && (
                  <span className="text-xs tabular-nums text-muted-foreground">
                    Δprice <span className="font-mono">{grade.price_change_pct >= 0 ? '+' : ''}{grade.price_change_pct.toFixed(2)}%</span>
                  </span>
                )}
              </div>
            </section>
          )}

          {/* Source flow events */}
          <section>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">
              Source flow events {sourceIds.length > 0 && `(${sourceIds.length})`}
            </div>
            {sourceIds.length === 0 ? (
              <div className="text-xs text-muted-foreground">No source flow ids recorded on this flag.</div>
            ) : !sourceFlow ? (
              <div className="text-xs text-muted-foreground">Loading…</div>
            ) : sourceFlow.length === 0 ? (
              <div className="text-xs text-muted-foreground">Source rows not found (may have been purged).</div>
            ) : (
              <div className="overflow-x-auto rounded-md border border-border">
                <Table className="text-[11px]">
                  <TableHeader>
                    <TableRow className="border-b border-border hover:bg-transparent">
                      <TableHead className="h-7 px-2 text-[10px] uppercase tracking-wider">Time</TableHead>
                      <TableHead className="h-7 px-2 text-[10px] uppercase tracking-wider text-right">Prem</TableHead>
                      <TableHead className="h-7 px-2 text-[10px] uppercase tracking-wider text-right">Vol</TableHead>
                      <TableHead className="h-7 px-2 text-[10px] uppercase tracking-wider text-right">Ask%</TableHead>
                      <TableHead className="h-7 px-2 text-[10px] uppercase tracking-wider">Class</TableHead>
                      <TableHead className="h-7 px-2 text-[10px] uppercase tracking-wider text-right">Score</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sourceFlow.map((f) => (
                      <TableRow key={f.id} className="border-b border-border/50">
                        <TableCell className="py-1 px-2 font-mono tabular-nums text-muted-foreground">{formatTimeET(f.event_ts)}</TableCell>
                        <TableCell className="py-1 px-2 font-mono tabular-nums text-right">{formatPremium(f.premium)}</TableCell>
                        <TableCell className="py-1 px-2 font-mono tabular-nums text-right text-muted-foreground">{formatInt(f.volume)}</TableCell>
                        <TableCell className="py-1 px-2 font-mono tabular-nums text-right text-muted-foreground">
                          {f.ask_side_perc != null ? `${Math.round(f.ask_side_perc)}%` : '-'}
                        </TableCell>
                        <TableCell className="py-1 px-2 text-[10px] text-muted-foreground">{f.classification ?? '-'}</TableCell>
                        <TableCell className="py-1 px-2 font-mono tabular-nums text-right">{f.score != null ? Math.round(f.score) : '-'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </section>

          {/* OI change */}
          <section>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">OI change (last 5 snaps)</div>
            {!flag.option_symbol ? (
              <div className="text-xs text-muted-foreground">No option_symbol on this flag.</div>
            ) : !oiHistory ? (
              <div className="text-xs text-muted-foreground">Loading…</div>
            ) : oiHistory.length === 0 ? (
              <div className="text-xs text-muted-foreground">No OI snapshots yet for this contract.</div>
            ) : (
              <div className="overflow-x-auto rounded-md border border-border">
                <Table className="text-[11px]">
                  <TableHeader>
                    <TableRow className="border-b border-border hover:bg-transparent">
                      <TableHead className="h-7 px-2 text-[10px] uppercase tracking-wider">Date</TableHead>
                      <TableHead className="h-7 px-2 text-[10px] uppercase tracking-wider">Slot</TableHead>
                      <TableHead className="h-7 px-2 text-[10px] uppercase tracking-wider text-right">OI</TableHead>
                      <TableHead className="h-7 px-2 text-[10px] uppercase tracking-wider text-right">Δ1d</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {oiHistory.map((s) => (
                      <TableRow key={s.id} className="border-b border-border/50">
                        <TableCell className="py-1 px-2 font-mono tabular-nums text-muted-foreground">{s.snap_date}</TableCell>
                        <TableCell className="py-1 px-2 font-mono text-muted-foreground uppercase">{s.snap_slot}</TableCell>
                        <TableCell className="py-1 px-2 font-mono tabular-nums text-right">{formatInt(s.oi)}</TableCell>
                        <TableCell className="py-1 px-2 font-mono tabular-nums text-right">
                          {s.oi_delta_1d != null ? (
                            <span className={s.oi_delta_1d > 0 ? 'text-emerald-400' : s.oi_delta_1d < 0 ? 'text-red-400' : 'text-muted-foreground'}>
                              {s.oi_delta_1d > 0 ? '+' : ''}{formatInt(s.oi_delta_1d)}
                            </span>
                          ) : '-'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </section>

          {/* Tags */}
          {flag.tags && flag.tags.length > 0 && (
            <section>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Tags</div>
              <div className="flex flex-wrap gap-1">
                {flag.tags.map((t) => (
                  <span key={t} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-muted/40 text-muted-foreground">
                    {t}
                  </span>
                ))}
              </div>
            </section>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
