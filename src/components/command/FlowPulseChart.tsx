/**
 * FlowPulseChart — task #109. The multi-line chart from James's reference:
 * Calls All / Calls 0-7 / Calls 30+ vs Puts All / Puts 0-7 / Puts 30+ over
 * the trading day. Crossings between paired series are the value — bullish
 * flips when calls cross above puts, bearish when puts cross above calls.
 *
 * Sits below the per-ticker FlowPulse table, behind its own collapse toggle.
 * Existing inline sparklines + table are unchanged.
 */

import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { ChevronDown, LineChart as LineChartIcon, TrendingUp, TrendingDown } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  useFlowPulseChart,
  formatPulseDollarsSigned,
  type FlowPulseChartPoint,
} from '@/hooks/useFlowPulse';

const WATCHLIST = ['SPY', 'QQQ', 'IWM', 'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'TSLA'];

type SeriesKey = 'calls_all' | 'calls_short' | 'calls_long' | 'puts_all' | 'puts_short' | 'puts_long';
type RangeKey = 'today' | '1h' | '30m';

const SERIES: { key: SeriesKey; label: string; color: string; group: 'call' | 'put' }[] = [
  { key: 'calls_all',   label: 'Calls All',  color: '#ef4444', group: 'call' },
  { key: 'calls_short', label: 'Calls 0-7',  color: '#22c55e', group: 'call' },
  { key: 'calls_long',  label: 'Calls 30+',  color: '#f59e0b', group: 'call' },
  { key: 'puts_all',    label: 'Puts All',   color: '#d946ef', group: 'put'  },
  { key: 'puts_short',  label: 'Puts 0-7',   color: '#8b5cf6', group: 'put'  },
  { key: 'puts_long',   label: 'Puts 30+',   color: '#6366f1', group: 'put'  },
];

interface Props {
  ticker?: string;
  onTickerChange?: (t: string | null) => void;
}

interface Crossing {
  pair: string;
  bucket_time: string;
  direction: 'bullish' | 'bearish';
}

function rangeToMin(r: RangeKey): number | undefined {
  if (r === '1h') return 60;
  if (r === '30m') return 30;
  return undefined; // 'today' → server-side NY midnight
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/New_York',
    hour12: false,
  });
}

// Find the most recent crossing for a pair (sign-flip in callsKey - putsKey).
function findLastCrossing(
  points: FlowPulseChartPoint[],
  callsKey: SeriesKey,
  putsKey: SeriesKey,
  pairLabel: string,
): Crossing | null {
  let last: Crossing | null = null;
  for (let i = 1; i < points.length; i++) {
    const prev = (points[i - 1][callsKey] as number) - (points[i - 1][putsKey] as number);
    const cur = (points[i][callsKey] as number) - (points[i][putsKey] as number);
    if (prev === 0 && cur === 0) continue;
    const prevSign = prev >= 0 ? 1 : -1;
    const curSign = cur >= 0 ? 1 : -1;
    if (prevSign !== curSign) {
      last = {
        pair: pairLabel,
        bucket_time: points[i].bucket_time,
        direction: curSign > 0 ? 'bullish' : 'bearish',
      };
    }
  }
  return last;
}

export function FlowPulseChart({ ticker, onTickerChange }: Props) {
  const [range, setRange] = useState<RangeKey>('today');
  const [visible, setVisible] = useState<Record<SeriesKey, boolean>>({
    calls_all: true,
    calls_short: true,
    calls_long: true,
    puts_all: true,
    puts_short: true,
    puts_long: true,
  });

  const { points, isLoading, isError } = useFlowPulseChart(ticker, rangeToMin(range));

  const crossings = useMemo<Crossing[]>(() => {
    if (!points.length) return [];
    const out: Crossing[] = [];
    const cAll = findLastCrossing(points, 'calls_all', 'puts_all', 'All');
    const cShort = findLastCrossing(points, 'calls_short', 'puts_short', '0-7 DTE');
    if (cAll) out.push(cAll);
    if (cShort) out.push(cShort);
    return out;
  }, [points]);

  const chartData = useMemo(() => {
    return points.map((p) => ({
      time: fmtTime(p.bucket_time),
      bucket_time: p.bucket_time,
      calls_all: Number(p.calls_all) || 0,
      calls_short: Number(p.calls_short) || 0,
      calls_long: Number(p.calls_long) || 0,
      // Puts shown negative for visual separation — the chart's centerline
      // becomes the call/put dividing line. Tooltip restores the sign.
      puts_all: -(Number(p.puts_all) || 0),
      puts_short: -(Number(p.puts_short) || 0),
      puts_long: -(Number(p.puts_long) || 0),
    }));
  }, [points]);

  const hasData = chartData.length > 0;

  return (
    <Card className="mt-1 p-3 bg-card/70 border-border/60">
      {/* Header: ticker selector + range pills + series toggles */}
      <div className="flex items-center gap-3 flex-wrap mb-2">
        <div className="flex items-center gap-2">
          <LineChartIcon className="w-3.5 h-3.5 text-primary" />
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
            Flow Pulse Chart
          </span>
        </div>

        <select
          value={ticker ?? ''}
          onChange={(e) => onTickerChange?.(e.target.value === '' ? null : e.target.value)}
          className="bg-muted/30 border border-border/40 rounded text-[11px] font-mono px-2 py-0.5 text-foreground focus:outline-none focus:border-primary/60"
          title="Choose ticker (MARKET = watchlist sum)"
        >
          <option value="">MARKET</option>
          {WATCHLIST.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>

        <div className="flex items-center gap-1">
          {(['today', '1h', '30m'] as const).map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={cn(
                'text-[10px] font-mono px-2 py-0.5 rounded transition-colors',
                range === r
                  ? 'bg-primary/10 text-primary'
                  : 'bg-muted/20 text-muted-foreground hover:text-foreground',
              )}
            >
              {r === 'today' ? 'Today' : r === '1h' ? '1h' : '30m'}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1 flex-wrap ml-auto">
          {SERIES.map((s) => {
            const on = visible[s.key];
            return (
              <button
                key={s.key}
                onClick={() => setVisible((v) => ({ ...v, [s.key]: !v[s.key] }))}
                className={cn(
                  'text-[10px] font-mono px-2 py-0.5 rounded border transition-colors inline-flex items-center gap-1.5',
                  on
                    ? 'bg-foreground/[0.04] text-foreground border-border/50'
                    : 'bg-transparent text-muted-foreground/60 border-border/20 line-through',
                )}
                title={on ? `Hide ${s.label}` : `Show ${s.label}`}
              >
                <span
                  className="inline-block w-2 h-2 rounded-sm"
                  style={{ background: on ? s.color : 'transparent', border: `1px solid ${s.color}` }}
                />
                {s.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Crossings chips */}
      {crossings.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap mb-2">
          {crossings.map((c) => (
            <span
              key={c.pair}
              className={cn(
                'inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded border',
                c.direction === 'bullish'
                  ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
                  : 'bg-rose-500/10 text-rose-300 border-rose-500/30',
              )}
              title={`Most recent ${c.pair} crossing today`}
            >
              {c.direction === 'bullish' ? (
                <TrendingUp className="w-3 h-3" />
              ) : (
                <TrendingDown className="w-3 h-3" />
              )}
              {c.direction === 'bullish' ? 'Calls' : 'Puts'} crossed{' '}
              {c.direction === 'bullish' ? 'above' : 'above'} ({c.pair}) at {fmtTime(c.bucket_time)}
              {' → '}
              {c.direction} flip
            </span>
          ))}
        </div>
      )}

      {/* Chart */}
      <div style={{ width: '100%', height: 300 }}>
        {isLoading && !hasData ? (
          <div className="w-full h-full flex items-center justify-center text-[11px] text-muted-foreground">
            Loading chart…
          </div>
        ) : isError ? (
          <div className="w-full h-full flex items-center justify-center text-[11px] text-muted-foreground italic">
            Chart unavailable — retrying
          </div>
        ) : !hasData ? (
          <div className="w-full h-full flex items-center justify-center text-[11px] text-muted-foreground italic">
            No flow in selected range
          </div>
        ) : (
          <ResponsiveContainer>
            <LineChart data={chartData} margin={{ top: 8, right: 12, bottom: 8, left: 0 }}>
              <CartesianGrid stroke="#ffffff10" strokeDasharray="2 4" />
              <XAxis
                dataKey="time"
                stroke="#71717a"
                tick={{ fontSize: 10, fontFamily: 'monospace' }}
                minTickGap={32}
              />
              <YAxis
                stroke="#71717a"
                tick={{ fontSize: 10, fontFamily: 'monospace' }}
                tickFormatter={(v: number) => formatPulseDollarsSigned(v)}
                width={64}
              />
              <Tooltip
                contentStyle={{
                  background: '#0a0a0a',
                  border: '1px solid #27272a',
                  borderRadius: 6,
                  fontSize: 11,
                  fontFamily: 'monospace',
                }}
                labelStyle={{ color: '#a1a1aa' }}
                formatter={(value: number, name: string) => {
                  // Restore put sign for the tooltip readout.
                  const display = name.startsWith('puts_') ? -value : value;
                  const series = SERIES.find((s) => s.key === (name as SeriesKey));
                  return [formatPulseDollarsSigned(display), series?.label ?? name];
                }}
              />
              {SERIES.map((s) =>
                visible[s.key] ? (
                  <Line
                    key={s.key}
                    type="monotone"
                    dataKey={s.key}
                    stroke={s.color}
                    strokeWidth={1.6}
                    dot={false}
                    isAnimationActive={false}
                    name={s.key}
                  />
                ) : null,
              )}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="mt-1 text-[9.5px] text-muted-foreground/70">
        Puts plotted negative for visual separation (centerline = call/put divide). Crossings flag last sign-flip per pair today. Refreshes every 60s.
      </div>
    </Card>
  );
}

interface CollapsibleProps {
  ticker?: string;
  onTickerChange?: (t: string | null) => void;
}

/**
 * Self-contained collapsible wrapper so FlowPulse.tsx just mounts one
 * component. Persists open/close to localStorage independently from the
 * outer per-ticker table collapse state.
 */
export function FlowPulseChartPanel({ ticker, onTickerChange }: CollapsibleProps) {
  const [open, setOpen] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem('ct_flow_pulse_chart_collapsed') === '0';
  });

  const toggle = () => {
    setOpen((o) => {
      const next = !o;
      if (typeof window !== 'undefined') {
        window.localStorage.setItem('ct_flow_pulse_chart_collapsed', next ? '0' : '1');
      }
      return next;
    });
  };

  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={toggle}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors bg-card/40 border border-border/40 rounded"
      >
        <LineChartIcon className="w-3.5 h-3.5" />
        <span className="font-semibold uppercase tracking-wider">View chart</span>
        <span className="text-muted-foreground/60 normal-case">
          ({ticker ?? 'MARKET'} · 6 series · crossings)
        </span>
        <ChevronDown
          className={cn(
            'w-3.5 h-3.5 ml-auto transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>
      {open && <FlowPulseChart ticker={ticker} onTickerChange={onTickerChange} />}
    </div>
  );
}
