/**
 * FlowPulse — one-line read of "what's the floor doing?" per ticker.
 *
 * Always-visible market aggregate summary row: total calls vs puts, premium
 * totals, premium-weighted C:P ratio, and net premium bias. That's the whole
 * value prop — James glances, gets the tape mood, moves on.
 *
 * The per-ticker table is the collapsible part. Expand to see which ticker
 * is driving the aggregate, OTM/ITM breakdown, ratio vs 30d baseline, and
 * "unusual" chips where today's C:P is >=2x or <=0.5x the 30d average.
 *
 * Window toggle: Today (RTH-open-to-now, dynamic) / 1h / 30m. Defaults to
 * Today since pre-open James still wants yesterday's signature on the row.
 *
 * Mounts above OvernightPositioning on /tape. Ticker label → TickerSheet via
 * onTickerClick prop (same pattern as Tape's existing flow).
 */

import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import {
  Activity,
  ChevronDown,
  ChevronUp,
  TrendingUp,
  TrendingDown,
  AlertTriangle,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  useFlowPulse,
  formatPulseDollars,
  formatPulseDollarsSigned,
  formatPulseInt,
  computeTodayWindowMin,
  type FlowPulseRow,
} from '@/hooks/useFlowPulse';
import { FlowPulseSparkline } from './FlowPulseSparkline';
import { FlowPulseChartPanel } from './FlowPulseChart';

// Watchlist order mirrors Tape.tsx TICKERS / OvernightPositioning WATCHLIST.
const WATCHLIST = ['SPY', 'QQQ', 'IWM', 'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'TSLA'];

interface Props {
  onTickerClick?: (ticker: string) => void;
}

type WindowKey = 'today' | '1h' | '30m';

function ratioColor(r: number | null | undefined): string {
  if (r == null || !Number.isFinite(r)) return 'text-muted-foreground';
  if (r >= 1.5) return 'text-emerald-300 font-bold';
  if (r <= 0.67) return 'text-rose-300 font-bold';
  return 'text-foreground/80';
}

function netColor(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n === 0) return 'text-muted-foreground';
  return n > 0 ? 'text-emerald-400 font-semibold' : 'text-rose-400 font-semibold';
}

function formatRatio(r: number | null | undefined): string {
  if (r == null || !Number.isFinite(r)) return '-';
  if (r >= 100) return '∞';
  return `${r.toFixed(1)}x`;
}

function windowLabel(k: WindowKey): string {
  if (k === 'today') return 'today';
  if (k === '1h') return 'last 1h';
  return 'last 30m';
}

export function FlowPulse({ onTickerClick }: Props) {
  // Window selector. "Today" = RTH-open-to-now dynamic minutes. 1h = 60. 30m = 30.
  const [windowKey, setWindowKey] = useState<WindowKey>('today');
  // Chart panel's selected ticker (separate from the table's onTickerClick
  // which opens TickerSheet). null = market aggregate.
  const [chartTicker, setChartTicker] = useState<string | null>(null);
  const windowMin = useMemo(() => {
    if (windowKey === '1h') return 60;
    if (windowKey === '30m') return 30;
    return computeTodayWindowMin();
  }, [windowKey]);

  const { rows, marketTotal, isLoading, isError } = useFlowPulse(windowMin);

  // Sort rows by total volume (calls + puts) desc so the biggest movers
  // sit at the top of the per-ticker table. Keep every row the RPC returns
  // — don't filter to WATCHLIST here; that's the RPC's job.
  const sortedRows = useMemo(() => {
    const rowsByTicker = new Map<string, FlowPulseRow>();
    for (const r of rows) rowsByTicker.set(r.ticker, r);
    // Render in WATCHLIST order so the layout is stable — same vertical order
    // as OvernightPositioning. Any non-watchlist tickers from the RPC go after.
    const ordered: FlowPulseRow[] = [];
    for (const t of WATCHLIST) {
      const r = rowsByTicker.get(t);
      if (r) ordered.push(r);
    }
    for (const r of rows) {
      if (!WATCHLIST.includes(r.ticker)) ordered.push(r);
    }
    return ordered;
  }, [rows]);

  // Persisted collapse state. Default collapsed — when collapsed, only the
  // per-ticker table hides; the market-aggregate summary row stays visible
  // because that's the whole value prop.
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    const stored = window.localStorage.getItem('ct_flow_pulse_collapsed');
    return stored === null ? true : stored === '1';
  });
  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('ct_flow_pulse_collapsed', collapsed ? '1' : '0');
    }
  }, [collapsed]);

  const hasData = rows.length > 0;
  const netBias = marketTotal.premium_net;
  const biasLabel = netBias > 0 ? 'bullish' : netBias < 0 ? 'bearish' : 'neutral';

  return (
    <div>
      {/* Always-visible aggregate row — the one-line read */}
      <Card
        className={cn(
          'px-3 py-2 flex items-center gap-3 flex-wrap',
          'bg-card/70 border-border/60',
        )}
      >
        {/* Section label + window chips */}
        <div className="flex items-center gap-2 shrink-0">
          <Activity className="w-3.5 h-3.5 text-primary" />
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
            Flow Pulse
          </span>
          <span className="text-[10px] text-muted-foreground/70 normal-case">
            · {windowLabel(windowKey)}
          </span>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {(['today', '1h', '30m'] as const).map((k) => (
            <button
              key={k}
              onClick={() => setWindowKey(k)}
              className={cn(
                'text-[10px] font-mono px-2 py-0.5 rounded transition-colors',
                windowKey === k
                  ? 'bg-primary/10 text-primary'
                  : 'bg-muted/20 text-muted-foreground hover:text-foreground',
              )}
            >
              {k === 'today' ? 'Today' : k === '1h' ? '1h' : '30m'}
            </button>
          ))}
        </div>

        {/* Skeleton / error / data */}
        {isLoading && !hasData ? (
          <div className="flex-1 flex items-center gap-3">
            <div className="h-3 w-48 rounded bg-muted/40 animate-pulse" />
            <div className="h-3 w-32 rounded bg-muted/40 animate-pulse" />
            <div className="h-3 w-24 rounded bg-muted/40 animate-pulse" />
          </div>
        ) : isError ? (
          <div className="flex-1 text-[11px] text-muted-foreground italic">
            FlowPulse unavailable — retrying
          </div>
        ) : !hasData ? (
          <div className="flex-1 text-[11px] text-muted-foreground italic">
            No flow in the last {windowLabel(windowKey)}
          </div>
        ) : (
          <div className="flex-1 flex items-center gap-3 flex-wrap text-[12px] font-mono tabular-nums">
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <span className="uppercase tracking-wider text-[10px]">Market:</span>
            </span>

            <span className="inline-flex items-center gap-1">
              <span className="text-emerald-300 font-bold">
                {formatPulseInt(marketTotal.calls_count)}C
              </span>
              <span className="text-muted-foreground">
                ({formatPulseDollars(marketTotal.calls_premium)})
              </span>
            </span>

            <span className="text-muted-foreground/60">·</span>

            <span className="inline-flex items-center gap-1">
              <span className="text-rose-300 font-bold">
                {formatPulseInt(marketTotal.puts_count)}P
              </span>
              <span className="text-muted-foreground">
                ({formatPulseDollars(marketTotal.puts_premium)})
              </span>
            </span>

            <span className="text-muted-foreground/60">·</span>

            <span className={cn('inline-flex items-center gap-1', ratioColor(marketTotal.call_put_ratio))}>
              {formatRatio(marketTotal.call_put_ratio)} call:put
            </span>

            <span className="text-muted-foreground/60">·</span>

            <span className={cn('inline-flex items-center gap-1', netColor(netBias))}>
              {netBias > 0 ? (
                <TrendingUp className="w-3 h-3" />
              ) : netBias < 0 ? (
                <TrendingDown className="w-3 h-3" />
              ) : null}
              net {formatPulseDollarsSigned(netBias)} {biasLabel}
            </span>

            <span className="text-muted-foreground/60">·</span>

            <span className="inline-flex items-center gap-1.5" title="Today's market net premium evolution">
              <FlowPulseSparkline ticker="MARKET" width={88} height={22} />
              <span className="text-[10px] text-muted-foreground">today</span>
            </span>
          </div>
        )}

        {/* Chevron — toggles per-ticker table. Sits in the row so the whole
            aggregate line functions as a header. */}
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="shrink-0 ml-auto inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
          title={collapsed ? 'Expand per-ticker breakdown' : 'Collapse per-ticker breakdown'}
          disabled={!hasData}
        >
          <span className="hidden sm:inline">
            {hasData ? `${sortedRows.length} tickers` : ''}
          </span>
          {collapsed ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
        </button>
      </Card>

      {/* Per-ticker table — only when expanded AND we have data */}
      {!collapsed && hasData && (
        <>
        <Card className="mt-1 p-0 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-[11px] font-mono tabular-nums">
              <thead>
                <tr className="border-b border-border/60 text-[10px] uppercase tracking-wider text-muted-foreground">
                  <th className="text-left py-1.5 px-3 font-semibold">Ticker</th>
                  <th className="text-left py-1.5 px-2 font-semibold">Calls ($prem)</th>
                  <th className="text-left py-1.5 px-2 font-semibold">Puts ($prem)</th>
                  <th className="text-right py-1.5 px-2 font-semibold">C:P</th>
                  <th className="text-right py-1.5 px-2 font-semibold">Net</th>
                  <th className="text-right py-1.5 px-3 font-semibold">vs 30d</th>
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((r) => {
                  const dev = r.cp_ratio_deviation;
                  const hasBaseline = dev != null && Number.isFinite(dev);
                  return (
                    <tr
                      key={r.ticker}
                      className={cn(
                        'border-b border-border/30 hover:bg-muted/30 transition-colors',
                        r.is_unusual && 'ring-1 ring-inset ring-amber-500/30 bg-amber-500/[0.03]',
                      )}
                    >
                      {/* Ticker label — clickable, opens TickerSheet */}
                      <td className="py-1.5 px-3">
                        <button
                          onClick={() => onTickerClick?.(r.ticker)}
                          className={cn(
                            'font-bold text-sm text-foreground hover:text-primary transition-colors',
                            'underline decoration-dotted underline-offset-2',
                          )}
                          title={`Open ${r.ticker} briefing`}
                        >
                          {r.ticker}
                        </button>
                      </td>

                      {/* Calls cell: count + premium + OTM/ITM breakdown */}
                      <td className="py-1.5 px-2">
                        <div className="flex items-baseline gap-1.5 flex-wrap">
                          <span className="text-emerald-300 font-bold">
                            {formatPulseInt(r.calls_count)}
                          </span>
                          <span className="text-muted-foreground">
                            ({formatPulseDollars(r.calls_premium)})
                          </span>
                          {(r.calls_otm_count > 0 || r.calls_itm_count > 0) && (
                            <span className="text-[9px] text-muted-foreground/70">
                              {formatPulseInt(r.calls_otm_count)}/{formatPulseInt(r.calls_itm_count)}
                            </span>
                          )}
                        </div>
                      </td>

                      {/* Puts cell */}
                      <td className="py-1.5 px-2">
                        <div className="flex items-baseline gap-1.5 flex-wrap">
                          <span className="text-rose-300 font-bold">
                            {formatPulseInt(r.puts_count)}
                          </span>
                          <span className="text-muted-foreground">
                            ({formatPulseDollars(r.puts_premium)})
                          </span>
                          {(r.puts_otm_count > 0 || r.puts_itm_count > 0) && (
                            <span className="text-[9px] text-muted-foreground/70">
                              {formatPulseInt(r.puts_otm_count)}/{formatPulseInt(r.puts_itm_count)}
                            </span>
                          )}
                        </div>
                      </td>

                      {/* C:P ratio */}
                      <td className={cn('py-1.5 px-2 text-right', ratioColor(r.call_put_ratio))}>
                        {formatRatio(r.call_put_ratio)}
                      </td>

                      {/* Net premium — signed, with intraday sparkline */}
                      <td className={cn('py-1.5 px-2 text-right', netColor(r.premium_net))}>
                        <span className="inline-flex items-center gap-1.5 justify-end">
                          <FlowPulseSparkline
                            ticker={r.ticker}
                            width={56}
                            height={18}
                          />
                          <span className="inline-flex items-center gap-1">
                            {r.premium_net > 0 ? '🟢' : r.premium_net < 0 ? '🔴' : ''}
                            {formatPulseDollarsSigned(r.premium_net)}
                          </span>
                        </span>
                      </td>

                      {/* vs 30d deviation */}
                      <td className="py-1.5 px-3 text-right">
                        {hasBaseline ? (
                          <span className="inline-flex items-center gap-1 justify-end">
                            <span
                              className={cn(
                                r.is_unusual && 'font-bold',
                                dev! >= 1.5 ? 'text-emerald-300'
                                  : dev! <= 0.67 ? 'text-rose-300'
                                  : 'text-muted-foreground',
                              )}
                            >
                              {formatRatio(dev)}
                            </span>
                            {r.is_unusual && (
                              <span
                                className="inline-flex items-center gap-0.5 text-[9px] px-1 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30"
                                title="C:P ratio is 2x+ or 0.5x- its 30d baseline"
                              >
                                <AlertTriangle className="w-2.5 h-2.5" />
                                unusual
                              </span>
                            )}
                          </span>
                        ) : (
                          <span className="text-muted-foreground/60">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="px-3 py-1.5 text-[10px] text-muted-foreground/70 border-t border-border/40">
            OTM/ITM counts under each side. "vs 30d" is today's C:P ratio relative to 30-day baseline. Refreshes every 30s.
          </div>
        </Card>
        <FlowPulseChartPanel
          ticker={chartTicker ?? undefined}
          onTickerChange={setChartTicker}
        />
        </>
      )}
    </div>
  );
}
