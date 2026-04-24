/**
 * OvernightPositioning — per-ticker overnight OI positioning at a glance.
 *
 * The 2-second test: which ticker positioned biggest and which direction?
 * Layout: one row per ticker, sorted by total dollars at risk descending.
 * Each row leads with a directional lean pill (BULL/BEAR/MIXED) computed from
 * the call:put accumulation balance, then top 3 contract shifts inline as
 * compact pills. Expand a row to see all shifts; expand the section to view.
 */

import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import {
  TrendingUp,
  TrendingDown,
  Activity,
  ChevronDown,
  ChevronUp,
  ChevronRight,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  useOvernightPositioning,
  normalizeSide,
  formatDollarsCompact,
  formatDeltaContracts,
  formatExpiryShort,
  formatMoneyness,
  type OiShiftRow,
} from '@/hooks/useOvernightPositioning';

const WATCHLIST = ['SPY', 'QQQ', 'IWM', 'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'TSLA'];

const PER_TICKER_LIMIT = 10;
const TOP_INLINE = 3;
const FETCH_LIMIT = 100;

type Lean = 'bullish' | 'bearish' | 'mixed' | 'flat';

interface TickerStats {
  ticker: string;
  shifts: OiShiftRow[];
  bullDollars: number;
  bearDollars: number;
  netDollars: number;
  totalDollars: number;
  lean: Lean;
}

interface Props {
  onContractClick?: (optionSymbol: string, ticker: string) => void;
  onTickerClick?: (ticker: string) => void;
}

function computeStats(ticker: string, shifts: OiShiftRow[]): TickerStats {
  let bullDollars = 0;
  let bearDollars = 0;
  for (const r of shifts) {
    const side = normalizeSide(r.side);
    const dollars = Math.abs(r.dollars_at_risk ?? 0);
    const isAccum = (r.delta_contracts ?? 0) > 0;
    if (!side || dollars === 0) continue;
    // Bullish positioning: calls building up OR puts being closed.
    // Bearish positioning: puts building up OR calls being closed.
    if ((side === 'call' && isAccum) || (side === 'put' && !isAccum)) {
      bullDollars += dollars;
    } else {
      bearDollars += dollars;
    }
  }
  const totalDollars = bullDollars + bearDollars;
  const netDollars = bullDollars - bearDollars;
  const lean: Lean =
    totalDollars < 1_000_000
      ? 'flat'
      : Math.abs(netDollars) / totalDollars >= 0.4
      ? netDollars > 0
        ? 'bullish'
        : 'bearish'
      : 'mixed';
  return { ticker, shifts, bullDollars, bearDollars, netDollars, totalDollars, lean };
}

function LeanPill({ stats }: { stats: TickerStats }) {
  const { lean, netDollars, totalDollars } = stats;
  if (lean === 'flat') {
    return (
      <span className="text-[10px] font-mono text-muted-foreground/50 italic shrink-0 w-28">
        no positioning
      </span>
    );
  }
  const cls =
    lean === 'bullish'
      ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
      : lean === 'bearish'
      ? 'bg-rose-500/15 border-rose-500/40 text-rose-300'
      : 'bg-amber-500/10 border-amber-500/30 text-amber-300';
  const label = lean === 'bullish' ? 'BULL' : lean === 'bearish' ? 'BEAR' : 'MIX';
  const dollarLabel =
    lean === 'mixed'
      ? `±${formatDollarsCompact(totalDollars).replace('$', '$')}`
      : `${netDollars >= 0 ? '+' : ''}${formatDollarsCompact(netDollars)}`;
  return (
    <span
      className={cn(
        'shrink-0 w-28 inline-flex items-center justify-between gap-1 rounded-md border px-2 py-1',
        'text-[10px] font-mono font-semibold tabular-nums',
        cls,
      )}
      title={`bull $${(stats.bullDollars / 1_000_000).toFixed(1)}M / bear $${(stats.bearDollars / 1_000_000).toFixed(1)}M`}
    >
      <span>{label}</span>
      <span className="opacity-90">{dollarLabel}</span>
    </span>
  );
}

function MiniShiftPill({
  r,
  onContractClick,
}: {
  r: OiShiftRow;
  onContractClick?: (optionSymbol: string, ticker: string) => void;
}) {
  const side = normalizeSide(r.side);
  const isAccum = (r.delta_contracts ?? 0) > 0;
  const sideClass =
    side === 'call'
      ? 'border-emerald-500/30 hover:border-emerald-500/60'
      : side === 'put'
      ? 'border-rose-500/30 hover:border-rose-500/60'
      : 'border-border';
  const strikeColor =
    side === 'call' ? 'text-emerald-300' : side === 'put' ? 'text-rose-300' : 'text-foreground/80';
  return (
    <button
      onClick={() => onContractClick?.(r.option_symbol, r.ticker)}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border bg-card/60 hover:bg-muted/40 transition-colors',
        'px-2 py-1 text-[11px] font-mono leading-none whitespace-nowrap shrink-0',
        sideClass,
      )}
      title={`${r.option_symbol} · ${formatExpiryShort(r.expiry)} · ${formatDeltaContracts(r.delta_contracts)} OI · ${formatMoneyness(r.distance_from_spot_pct, side).label}`}
    >
      <span className={cn('font-semibold tabular-nums', strikeColor)}>
        {r.strike != null ? Math.round(r.strike) : '?'}
        {side === 'call' ? 'C' : side === 'put' ? 'P' : ''}
      </span>
      <span
        className={cn(
          'tabular-nums inline-flex items-center gap-0.5',
          isAccum ? 'text-emerald-400' : 'text-rose-400',
        )}
      >
        {isAccum ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
        {formatDollarsCompact(r.dollars_at_risk)}
      </span>
    </button>
  );
}

function TickerRow({
  stats,
  onContractClick,
  onTickerClick,
}: {
  stats: TickerStats;
  onContractClick?: (optionSymbol: string, ticker: string) => void;
  onTickerClick?: (ticker: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const top = stats.shifts.slice(0, TOP_INLINE);
  const rest = stats.shifts.slice(TOP_INLINE);
  const hasShifts = stats.shifts.length > 0;
  return (
    <div className="rounded-md bg-card/40 border border-border/40">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <button
          onClick={() => onTickerClick?.(stats.ticker)}
          className={cn(
            'shrink-0 w-12 text-left font-mono font-bold text-sm',
            'text-foreground hover:text-primary transition-colors',
            'underline decoration-dotted underline-offset-2',
          )}
          title={`Open ${stats.ticker} briefing`}
        >
          {stats.ticker}
        </button>

        <LeanPill stats={stats} />

        {hasShifts ? (
          <div className="flex flex-wrap items-center gap-1.5 flex-1 min-w-0">
            {top.map((r) => (
              <MiniShiftPill
                key={r.option_symbol + (r.snap_date ?? '') + (r.snap_slot ?? '')}
                r={r}
                onContractClick={onContractClick}
              />
            ))}
            {rest.length > 0 && (
              <button
                onClick={() => setExpanded((e) => !e)}
                className={cn(
                  'inline-flex items-center gap-0.5 rounded-md px-2 py-1 shrink-0',
                  'text-[11px] font-mono text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors',
                )}
                title={expanded ? 'Hide other shifts' : 'Show all shifts'}
              >
                <ChevronRight
                  className={cn('w-3 h-3 transition-transform', expanded && 'rotate-90')}
                />
                +{rest.length} more
              </button>
            )}
          </div>
        ) : (
          <div className="text-[11px] text-muted-foreground/70 italic">
            no significant overnight positioning
          </div>
        )}
      </div>
      {expanded && rest.length > 0 && (
        <div className="px-2 pb-2 pt-0 flex flex-wrap gap-1.5 pl-[5.5rem]">
          {rest.map((r) => (
            <MiniShiftPill
              key={r.option_symbol + (r.snap_date ?? '') + (r.snap_slot ?? '') + '-rest'}
              r={r}
              onContractClick={onContractClick}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function OvernightPositioning({ onContractClick, onTickerClick }: Props) {
  const { data, isLoading, isError, error } = useOvernightPositioning(undefined, FETCH_LIMIT);

  const rows = data ?? [];
  const first = rows[0];
  const headerSuffix =
    first && (first.snap_date || first.snap_slot)
      ? ` — ${first.snap_date ?? ''}${first.snap_slot ? ` ${first.snap_slot}` : ''}`.trim()
      : '';

  const stats = useMemo(() => {
    const map = new Map<string, OiShiftRow[]>();
    for (const r of rows) {
      const arr = map.get(r.ticker) ?? [];
      if (arr.length < PER_TICKER_LIMIT) arr.push(r);
      map.set(r.ticker, arr);
    }
    for (const [, arr] of map) {
      arr.sort(
        (a, b) =>
          Math.abs(b.dollars_at_risk ?? 0) - Math.abs(a.dollars_at_risk ?? 0),
      );
    }
    const all: TickerStats[] = WATCHLIST.map((t) => computeStats(t, map.get(t) ?? []));
    all.sort((a, b) => b.totalDollars - a.totalDollars);
    return all;
  }, [rows]);

  const totalShown = useMemo(
    () => stats.reduce((acc, s) => acc + s.shifts.length, 0),
    [stats],
  );
  const summary = useMemo(() => {
    let bull = 0;
    let bear = 0;
    let mixed = 0;
    for (const s of stats) {
      if (s.lean === 'bullish') bull += 1;
      else if (s.lean === 'bearish') bear += 1;
      else if (s.lean === 'mixed') mixed += 1;
    }
    return { bull, bear, mixed };
  }, [stats]);

  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    const stored = window.localStorage.getItem('ct_overnight_positioning_collapsed');
    return stored === null ? true : stored === '1';
  });
  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(
        'ct_overnight_positioning_collapsed',
        collapsed ? '1' : '0',
      );
    }
  }, [collapsed]);

  return (
    <div>
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="w-full flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground mb-2 hover:text-foreground transition-colors"
        title={collapsed ? 'Expand overnight positioning' : 'Collapse overnight positioning'}
      >
        {collapsed ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
        <Activity className="w-3.5 h-3.5" />
        Overnight Positioning{headerSuffix}
        {!isLoading && !isError && totalShown > 0 && (
          <span className="text-[10px] normal-case text-muted-foreground/70 ml-auto tabular-nums">
            {summary.bull > 0 && (
              <span className="text-emerald-400/80">{summary.bull} bullish</span>
            )}
            {summary.bull > 0 && (summary.bear > 0 || summary.mixed > 0) && (
              <span className="text-muted-foreground/50"> · </span>
            )}
            {summary.bear > 0 && (
              <span className="text-rose-400/80">{summary.bear} bearish</span>
            )}
            {(summary.bull > 0 || summary.bear > 0) && summary.mixed > 0 && (
              <span className="text-muted-foreground/50"> · </span>
            )}
            {summary.mixed > 0 && (
              <span className="text-amber-400/80">{summary.mixed} mixed</span>
            )}
            {collapsed && (
              <span className="text-muted-foreground/50"> · click to expand</span>
            )}
          </span>
        )}
      </button>

      {collapsed ? null : isError ? (
        <div className="text-[11px] text-red-300 px-1 py-2">
          Couldn't load overnight positioning:{' '}
          {error instanceof Error ? error.message : 'unknown error'}
        </div>
      ) : isLoading && rows.length === 0 ? (
        <div className="space-y-1">
          {[0, 1, 2].map((i) => (
            <Card key={i} className="h-10 animate-pulse bg-muted/20" />
          ))}
        </div>
      ) : (
        <div className="space-y-1">
          {stats.map((s) => (
            <TickerRow
              key={s.ticker}
              stats={s}
              onContractClick={onContractClick}
              onTickerClick={onTickerClick}
            />
          ))}
        </div>
      )}
    </div>
  );
}
