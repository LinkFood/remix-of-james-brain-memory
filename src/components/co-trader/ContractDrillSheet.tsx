/**
 * ContractDrillSheet — right-side Sheet that opens when you click the
 * ContractPnLChip on a tape row. Shows the lifecycle of a single tracked
 * option contract: header (ticker/strike/side/expiry/status), big P&L
 * card (entry → current with peak/drawdown chips), Recharts line of mid
 * price over time with markers (entry, peak, +50% reached), and a
 * "time-to" footer table.
 *
 * Empty-state policy: if Phase B's poller hasn't filled ct_contract_quotes
 * yet, the chart slot renders a friendly placeholder telling James the
 * next sweep will populate it. The header / P&L card still renders from
 * ct_contract_tracks (Phase A populates it on grader pass).
 */

import { useMemo } from 'react';
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import {
  TrendingUp, TrendingDown, Target, Clock, Hourglass, AlertCircle,
} from 'lucide-react';
import {
  LineChart, Line, XAxis, YAxis, ResponsiveContainer, Tooltip,
  ReferenceLine, ReferenceDot,
} from 'recharts';
import {
  useContractTrack,
  useContractTrackBySymbol,
  fmtPctFromFraction, fmtPctMagnitude, fmtInterval, addInterval,
  type ContractTrackRow, type ContractTrackStatus,
} from '@/hooks/useContractTracks';
import { useContractQuotes } from '@/hooks/useContractQuotes';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Preferred — resolves the canonical track directly by symbol so re-prints
   * (which all share an option_symbol but differ on alert_id) surface the
   * aggregated print_count / last_print_at without depending on the
   * alert_id → ledger chain.
   */
  optionSymbol?: string | null;
  /** Fallback — used when the caller only has the alert_id (e.g. legacy chip clicks). */
  alertId?: string | null;
}

// ---------- helpers ----------

function statusBadge(status: ContractTrackStatus | null): { label: string; cls: string; Icon: React.ComponentType<{ className?: string }> } {
  switch (status) {
    case 'WIN':
      return { label: 'WIN', cls: 'bg-emerald-500/30 text-emerald-200 border-emerald-500/60', Icon: Target };
    case 'LOSS':
      return { label: 'LOSS', cls: 'bg-rose-500/30 text-rose-200 border-rose-500/60', Icon: TrendingDown };
    case 'EXPIRED_WIN':
      return { label: 'EXPIRED WIN', cls: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40', Icon: Clock };
    case 'EXPIRED_LOSS':
      return { label: 'EXPIRED LOSS', cls: 'bg-rose-500/20 text-rose-300 border-rose-500/40', Icon: Clock };
    case 'EXPIRED_FLAT':
      return { label: 'EXPIRED FLAT', cls: 'bg-slate-500/20 text-slate-300 border-slate-500/40', Icon: Clock };
    case 'STALE':
      return { label: 'STALE', cls: 'bg-slate-500/15 text-slate-400 border-slate-500/30', Icon: Hourglass };
    case 'WORKING':
      return { label: 'WORKING', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30', Icon: TrendingUp };
    default:
      return { label: '—', cls: 'bg-muted/40 text-muted-foreground border-border/50', Icon: AlertCircle };
  }
}

function fmtPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n >= 100) return `$${n.toFixed(2)}`;
  if (n >= 10) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(2)}`;
}

function fmtClock(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleTimeString('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return iso;
  }
}

function fmtDateShort(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' });
  } catch {
    return iso;
  }
}

function dteLabel(dte: number | null): string {
  if (dte == null) return '';
  if (dte === 0) return '0DTE';
  if (dte === 1) return '1DTE';
  return `${dte}DTE`;
}

// ---------- header ----------

function HeaderRow({ track }: { track: ContractTrackRow }) {
  const sb = statusBadge(track.track_status);
  const Icon = sb.Icon;
  const sideCls =
    track.side === 'call'
      ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40'
      : 'bg-rose-500/15 text-rose-300 border-rose-500/40';
  const dte = dteLabel(track.dte_at_print);
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="font-mono text-xl font-bold tracking-tight">{track.ticker}</span>
          <span className="font-mono text-lg text-foreground/90">
            {track.strike != null ? `$${track.strike}` : '—'}
          </span>
          <Badge variant="outline" className={cn('text-[10px] font-mono px-1.5 py-0 font-bold', sideCls)}>
            {track.side?.toUpperCase()}
          </Badge>
          <span className="font-mono text-xs text-muted-foreground">
            {fmtDateShort(track.expiry)}
          </span>
          {dte && (
            <span className="font-mono text-[10px] text-muted-foreground">({dte})</span>
          )}
        </div>
        <div className="text-[11px] text-muted-foreground mt-0.5 font-mono">
          print {fmtClock(track.print_time)} · {track.predicted_direction} via {track.predicted_source}
        </div>
      </div>
      <Badge variant="outline" className={cn('inline-flex items-center gap-1 text-xs font-bold tracking-wide px-2 py-0.5', sb.cls)}>
        <Icon className="w-3 h-3" />
        <span>{sb.label}</span>
      </Badge>
    </div>
  );
}

// ---------- big P&L card ----------

function PnLCard({ track }: { track: ContractTrackRow }) {
  const cur = track.current_contract_pct;
  const isPos = cur != null && cur >= 0;
  const colorPnL = isPos ? 'text-emerald-400' : 'text-rose-400';
  const peak = track.peak_contract_pct;
  const dd = track.max_drawdown_pct;

  return (
    <Card className="p-4">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <div className={cn('font-mono font-bold tabular-nums tracking-tight text-4xl', colorPnL)}>
            {cur != null ? fmtPctFromFraction(cur, 0) : '—'}
          </div>
          <div className="text-xs text-muted-foreground mt-1 font-mono">
            entry {fmtPrice(track.entry_contract_price)} → current {fmtPrice(track.current_contract_price)}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          {peak > 0 && (
            <Badge variant="outline" className="bg-emerald-500/10 text-emerald-300 border-emerald-500/30 font-mono text-[11px]">
              peak {fmtPctMagnitude(peak)}
              {track.peak_contract_at && (
                <span className="opacity-60 ml-1">@ {fmtClock(track.peak_contract_at)}</span>
              )}
            </Badge>
          )}
          {dd > 0.01 && (
            <Badge variant="outline" className="bg-rose-500/10 text-rose-300 border-rose-500/30 font-mono text-[11px]">
              drawdown −{(dd * 100).toFixed(0)}%
              {track.trough_contract_at && (
                <span className="opacity-60 ml-1">@ {fmtClock(track.trough_contract_at)}</span>
              )}
            </Badge>
          )}
          {track.print_count > 1 && (
            <span className="text-[10px] text-amber-300 font-mono font-semibold">
              {track.print_count} prints
              {track.last_print_at && (
                <span className="opacity-70 ml-1">· last {fmtClock(track.last_print_at)}</span>
              )}
            </span>
          )}
          {track.sweep_count > 0 && (
            <span className="text-[10px] text-muted-foreground font-mono">
              {track.sweep_count} sweep{track.sweep_count === 1 ? '' : 's'} · last quote {fmtClock(track.last_quoted_at)}
            </span>
          )}
        </div>
      </div>
    </Card>
  );
}

// ---------- chart ----------

interface ChartPoint {
  ts: number;       // epoch ms
  mid: number;
}

function PriceChart({ track }: { track: ContractTrackRow }) {
  const { data: quotes, isLoading } = useContractQuotes(
    track.option_symbol,
    track.print_time,
  );

  const points = useMemo<ChartPoint[]>(() => {
    if (!quotes) return [];
    return quotes
      .filter((q) => q.mid != null && Number.isFinite(q.mid))
      .map((q) => ({ ts: Date.parse(q.ts), mid: q.mid as number }))
      .filter((p) => Number.isFinite(p.ts));
  }, [quotes]);

  if (isLoading) {
    return (
      <Card className="p-3">
        <Skeleton className="h-48 w-full" />
      </Card>
    );
  }

  if (points.length === 0) {
    return (
      <Card className="p-6 flex flex-col items-center justify-center text-center min-h-[200px] border-dashed">
        <Hourglass className="w-6 h-6 text-muted-foreground mb-2" />
        <div className="text-sm font-medium">Waiting for the next poller sweep</div>
        <div className="text-xs text-muted-foreground mt-1 max-w-sm">
          Quotes for <span className="font-mono">{track.option_symbol}</span> populate
          every ~5min during RTH. The chart will fill in as ct_contract_quotes builds.
        </div>
      </Card>
    );
  }

  const entryPrice = track.entry_contract_price;
  const peakAtMs = track.peak_contract_at ? Date.parse(track.peak_contract_at) : null;
  const peakPrice = track.peak_contract_price;
  const fiftyAt = addInterval(track.print_time, track.time_to_50pct);
  const fiftyAtMs = fiftyAt ? Date.parse(fiftyAt) : null;
  const printMs = Date.parse(track.print_time);

  return (
    <Card className="p-2">
      <div className="h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points} margin={{ top: 10, right: 12, bottom: 8, left: 8 }}>
            <XAxis
              dataKey="ts"
              type="number"
              domain={['dataMin', 'dataMax']}
              tickFormatter={(v) =>
                new Date(v).toLocaleTimeString('en-US', {
                  timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true,
                })
              }
              stroke="hsl(var(--muted-foreground))"
              fontSize={10}
              minTickGap={40}
            />
            <YAxis
              dataKey="mid"
              tickFormatter={(v) => `$${typeof v === 'number' ? v.toFixed(2) : v}`}
              stroke="hsl(var(--muted-foreground))"
              fontSize={10}
              width={48}
              domain={['auto', 'auto']}
            />
            <Tooltip
              contentStyle={{
                background: 'hsl(var(--background))',
                border: '1px solid hsl(var(--border))',
                fontSize: 11,
              }}
              labelFormatter={(v) =>
                new Date(typeof v === 'number' ? v : Date.parse(String(v))).toLocaleString('en-US', {
                  timeZone: 'America/New_York', month: 'numeric', day: 'numeric',
                  hour: 'numeric', minute: '2-digit', hour12: true,
                })
              }
              formatter={(value: number) => [`$${value.toFixed(2)}`, 'mid']}
            />
            {entryPrice != null && (
              <ReferenceLine
                y={entryPrice}
                stroke="hsl(var(--muted-foreground))"
                strokeDasharray="3 3"
                label={{
                  value: `entry ${fmtPrice(entryPrice)}`,
                  position: 'insideTopLeft',
                  fill: 'hsl(var(--muted-foreground))',
                  fontSize: 10,
                }}
              />
            )}
            {Number.isFinite(printMs) && (
              <ReferenceLine
                x={printMs}
                stroke="hsl(var(--primary))"
                strokeOpacity={0.6}
                strokeDasharray="2 2"
                label={{ value: 'print', position: 'top', fill: 'hsl(var(--primary))', fontSize: 10 }}
              />
            )}
            {peakAtMs && peakPrice != null && (
              <ReferenceDot
                x={peakAtMs}
                y={peakPrice}
                r={4}
                fill="hsl(var(--background))"
                stroke="rgb(52 211 153)"
                strokeWidth={2}
                label={{
                  value: `peak ${fmtPrice(peakPrice)}`,
                  position: 'top',
                  fill: 'rgb(52 211 153)',
                  fontSize: 10,
                }}
              />
            )}
            {fiftyAtMs && (
              <ReferenceLine
                x={fiftyAtMs}
                stroke="rgb(251 191 36)"
                strokeOpacity={0.5}
                strokeDasharray="2 4"
                label={{ value: '+50%', position: 'top', fill: 'rgb(251 191 36)', fontSize: 10 }}
              />
            )}
            <Line
              type="monotone"
              dataKey="mid"
              stroke="hsl(var(--primary))"
              strokeWidth={1.75}
              dot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="text-[10px] text-muted-foreground font-mono pt-1 px-1 flex items-center justify-between">
        <span>{points.length} quotes since print</span>
        <span>mid ($/contract share)</span>
      </div>
    </Card>
  );
}

// ---------- time-to footer ----------

function TimeToTable({ track }: { track: ContractTrackRow }) {
  const rows: { label: string; value: string | null }[] = [
    { label: '+50%',  value: track.time_to_50pct },
    { label: '+100%', value: track.time_to_100pct },
    { label: '+200%', value: track.time_to_200pct },
  ];
  return (
    <Card className="p-3">
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2">Time to</div>
      <div className="grid grid-cols-3 gap-2">
        {rows.map((r) => (
          <div key={r.label} className="flex flex-col">
            <div className="text-[10px] font-mono text-muted-foreground">{r.label}</div>
            <div className={cn(
              'font-mono tabular-nums text-sm font-semibold',
              r.value ? 'text-emerald-300' : 'text-muted-foreground',
            )}>
              {fmtInterval(r.value)}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

// ---------- main ----------

export function ContractDrillSheet({ open, onOpenChange, optionSymbol = null, alertId = null }: Props) {
  // Prefer symbol-keyed lookup (canonical). Fall back to alert_id ledger
  // chain only when the caller didn't supply a symbol. Either lookup
  // returns the same ContractTrackRow shape, so the rest of the sheet
  // doesn't care which path resolved.
  const symbolQuery = useContractTrackBySymbol(optionSymbol);
  const alertQuery = useContractTrack(optionSymbol ? null : alertId);
  const isSymbolPath = optionSymbol !== null && optionSymbol !== '';
  const track = isSymbolPath ? symbolQuery.data : alertQuery.data;
  const isLoading = isSymbolPath ? symbolQuery.isLoading : alertQuery.isLoading;
  const isError = isSymbolPath ? symbolQuery.isError : alertQuery.isError;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-xl overflow-y-auto">
        <SheetHeader className="space-y-0">
          <SheetTitle className="text-base">Contract P&amp;L</SheetTitle>
          <SheetDescription className="text-xs">
            Lifetime contract-axis grading from ct_contract_tracks + ct_contract_quotes.
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 space-y-3">
          {isLoading ? (
            <>
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-56 w-full" />
              <Skeleton className="h-16 w-full" />
            </>
          ) : !track ? (
            <Card className="p-6 flex flex-col items-center justify-center text-center min-h-[200px] border-dashed">
              <AlertCircle className="w-6 h-6 text-muted-foreground mb-2" />
              <div className="text-sm font-medium">No contract track for this print</div>
              <div className="text-xs text-muted-foreground mt-1 max-w-sm">
                {isError
                  ? 'ct_contract_tracks lookup failed — table may not be deployed yet.'
                  : 'Tracks are created when the grader runs Pass 2 over a flagged print. If this print is missing strike or expiry, it gets skipped (no symbol synthesizable).'}
              </div>
            </Card>
          ) : (
            <>
              <HeaderRow track={track} />
              <PnLCard track={track} />
              <PriceChart track={track} />
              <TimeToTable track={track} />
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
