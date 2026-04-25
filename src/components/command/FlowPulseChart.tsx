/**
 * FlowPulseChart — Divergence Ribbon ("Net-Premium River").
 *
 * Replaces the prior multi-line spaghetti. Single filled area showing the
 * cumulative net premium (calls − puts) accumulated since RTH open. Green
 * above zero = calls winning, red below = puts winning. Zero-crossings of
 * the ribbon are regime flips, surfaced as chips above the chart.
 *
 * Toggle "Split by DTE" → three stacked ribbons (0-7 / 8-29 / 30+) so the
 * trader can see WHICH expiry stratum drove the flip. That stratification
 * is the part nobody else's flow chart has.
 *
 * Cumulative is computed client-side from the per-bucket RPC; we don't need
 * to change ct_flow_pulse_chart for v1.
 */

import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import {
  ChevronDown,
  LineChart as LineChartIcon,
  TrendingUp,
  TrendingDown,
  Layers,
  Activity,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
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

type RangeKey = 'today' | '1h' | '30m';
type ViewMode = 'net' | 'dte';

interface RibbonPoint {
  time: string;
  bucket_time: string;
  net_all: number;     // cum(calls_all) − cum(puts_all)
  net_short: number;   // cum(calls_0-7) − cum(puts_0-7)
  net_mid: number;     // cum(calls_8-29) − cum(puts_8-29)
  net_long: number;    // cum(calls_30+) − cum(puts_30+)
}

interface Crossing {
  bucket_time: string;
  direction: 'bullish' | 'bearish';
  source: 'all' | 'short' | 'mid' | 'long';
}

interface Props {
  ticker?: string;
  onTickerChange?: (t: string | null) => void;
}

function rangeToMin(r: RangeKey): number | undefined {
  if (r === '1h') return 60;
  if (r === '30m') return 30;
  return undefined;
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

function buildRibbonData(points: FlowPulseChartPoint[]): RibbonPoint[] {
  let cAll = 0, cShort = 0, cLong = 0;
  let pAll = 0, pShort = 0, pLong = 0;
  return points.map((p) => {
    const callAll = Number(p.calls_all) || 0;
    const callShort = Number(p.calls_short) || 0;
    const callLong = Number(p.calls_long) || 0;
    const putAll = Number(p.puts_all) || 0;
    const putShort = Number(p.puts_short) || 0;
    const putLong = Number(p.puts_long) || 0;
    cAll += callAll;
    cShort += callShort;
    cLong += callLong;
    pAll += putAll;
    pShort += putShort;
    pLong += putLong;
    const cMid = cAll - cShort - cLong;
    const pMid = pAll - pShort - pLong;
    return {
      time: fmtTime(p.bucket_time),
      bucket_time: p.bucket_time,
      net_all: cAll - pAll,
      net_short: cShort - pShort,
      net_mid: cMid - pMid,
      net_long: cLong - pLong,
    };
  });
}

function findLastCrossing(
  data: RibbonPoint[],
  key: 'net_all' | 'net_short' | 'net_mid' | 'net_long',
  source: Crossing['source'],
): Crossing | null {
  let last: Crossing | null = null;
  for (let i = 1; i < data.length; i++) {
    const prev = data[i - 1][key];
    const cur = data[i][key];
    if (prev === 0 && cur === 0) continue;
    const prevSign = prev >= 0 ? 1 : -1;
    const curSign = cur >= 0 ? 1 : -1;
    if (prevSign !== curSign) {
      last = {
        bucket_time: data[i].bucket_time,
        direction: curSign > 0 ? 'bullish' : 'bearish',
        source,
      };
    }
  }
  return last;
}

function gradientStop(values: number[]): number {
  if (values.length === 0) return 0;
  let max = -Infinity;
  let min = Infinity;
  for (const v of values) {
    if (v > max) max = v;
    if (v < min) min = v;
  }
  if (max <= 0) return 0;
  if (min >= 0) return 1;
  return max / (max - min);
}

function Ribbon({
  data,
  dataKey,
  height = 220,
  gradientId,
}: {
  data: RibbonPoint[];
  dataKey: 'net_all' | 'net_short' | 'net_mid' | 'net_long';
  height?: number;
  gradientId: string;
}) {
  const stop = useMemo(
    () => gradientStop(data.map((d) => d[dataKey])),
    [data, dataKey],
  );
  const fillId = `${gradientId}-fill`;
  return (
    <div style={{ width: '100%', height }}>
      <ResponsiveContainer>
        <AreaChart data={data} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
          <defs>
            <linearGradient id={fillId} x1="0" x2="0" y1="0" y2="1">
              <stop offset={0} stopColor="#10b981" stopOpacity={0.45} />
              <stop offset={stop} stopColor="#10b981" stopOpacity={0.05} />
              <stop offset={stop} stopColor="#ef4444" stopOpacity={0.05} />
              <stop offset={1} stopColor="#ef4444" stopOpacity={0.45} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="#ffffff08" strokeDasharray="2 4" />
          <XAxis
            dataKey="time"
            stroke="#71717a"
            tick={{ fontSize: 10, fontFamily: 'monospace' }}
            minTickGap={36}
          />
          <YAxis
            stroke="#71717a"
            tick={{ fontSize: 10, fontFamily: 'monospace' }}
            tickFormatter={(v: number) => formatPulseDollarsSigned(v)}
            width={64}
          />
          <ReferenceLine y={0} stroke="#a1a1aa" strokeDasharray="1 3" />
          <Tooltip
            contentStyle={{
              background: '#0a0a0a',
              border: '1px solid #27272a',
              borderRadius: 6,
              fontSize: 11,
              fontFamily: 'monospace',
            }}
            labelStyle={{ color: '#a1a1aa' }}
            formatter={(value: number) => [
              formatPulseDollarsSigned(value),
              value >= 0 ? 'Calls leading by' : 'Puts leading by',
            ]}
          />
          <Area
            type="monotone"
            dataKey={dataKey}
            stroke="#e4e4e7"
            strokeWidth={1.4}
            fill={`url(#${fillId})`}
            isAnimationActive={false}
            dot={false}
            activeDot={{ r: 3 }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function FlowPulseChart({ ticker, onTickerChange }: Props) {
  const [range, setRange] = useState<RangeKey>('today');
  const [view, setView] = useState<ViewMode>('net');

  const { points, isLoading, isError } = useFlowPulseChart(ticker, rangeToMin(range));
  const ribbonData = useMemo(() => buildRibbonData(points), [points]);

  const crossings = useMemo<Crossing[]>(() => {
    if (ribbonData.length < 2) return [];
    const out: Crossing[] = [];
    if (view === 'net') {
      const c = findLastCrossing(ribbonData, 'net_all', 'all');
      if (c) out.push(c);
    } else {
      for (const [key, src] of [
        ['net_short', 'short'],
        ['net_mid', 'mid'],
        ['net_long', 'long'],
      ] as const) {
        const c = findLastCrossing(ribbonData, key, src);
        if (c) out.push(c);
      }
    }
    return out;
  }, [ribbonData, view]);

  const hasData = ribbonData.length > 0;

  const headlineNet = ribbonData.length > 0 ? ribbonData[ribbonData.length - 1].net_all : 0;
  const headlineLabel =
    headlineNet >= 0 ? 'Calls leading' : 'Puts leading';
  const headlineColor =
    headlineNet >= 0 ? 'text-emerald-300' : 'text-rose-300';

  return (
    <Card className="mt-1 p-3 bg-card/70 border-border/60">
      {/* Header: ticker selector + range pills + view toggle */}
      <div className="flex items-center gap-3 flex-wrap mb-2">
        <div className="flex items-center gap-2">
          <LineChartIcon className="w-3.5 h-3.5 text-primary" />
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
            Net Premium River
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

        <div className="flex items-center gap-1 ml-auto">
          <button
            onClick={() => setView('net')}
            className={cn(
              'text-[10px] font-mono px-2 py-0.5 rounded transition-colors inline-flex items-center gap-1.5',
              view === 'net'
                ? 'bg-primary/10 text-primary border border-primary/30'
                : 'bg-muted/20 text-muted-foreground hover:text-foreground border border-transparent',
            )}
            title="Single ribbon — calls vs puts net premium"
          >
            <Activity className="w-3 h-3" />
            Net
          </button>
          <button
            onClick={() => setView('dte')}
            className={cn(
              'text-[10px] font-mono px-2 py-0.5 rounded transition-colors inline-flex items-center gap-1.5',
              view === 'dte'
                ? 'bg-primary/10 text-primary border border-primary/30'
                : 'bg-muted/20 text-muted-foreground hover:text-foreground border border-transparent',
            )}
            title="Stack by DTE — see which expiry stratum drove the flip"
          >
            <Layers className="w-3 h-3" />
            Split by DTE
          </button>
        </div>
      </div>

      {/* Headline + crossings chips */}
      {hasData && (
        <div className="flex items-center gap-2 flex-wrap mb-2">
          <span className={cn('text-[12px] font-mono font-semibold', headlineColor)}>
            {headlineLabel} {formatPulseDollarsSigned(Math.abs(headlineNet))}
          </span>
          {crossings.map((c) => {
            const sourceLabel =
              c.source === 'all' ? 'All' :
              c.source === 'short' ? '0-7 DTE' :
              c.source === 'mid' ? '8-29 DTE' : '30+ DTE';
            return (
              <span
                key={c.source}
                className={cn(
                  'inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded border',
                  c.direction === 'bullish'
                    ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
                    : 'bg-rose-500/10 text-rose-300 border-rose-500/30',
                )}
                title={`Most recent regime flip in ${sourceLabel} today`}
              >
                {c.direction === 'bullish' ? (
                  <TrendingUp className="w-3 h-3" />
                ) : (
                  <TrendingDown className="w-3 h-3" />
                )}
                {sourceLabel} flipped {c.direction} at {fmtTime(c.bucket_time)}
              </span>
            );
          })}
        </div>
      )}

      {/* Chart(s) */}
      {isLoading && !hasData ? (
        <div className="w-full h-[220px] flex items-center justify-center text-[11px] text-muted-foreground">
          Loading chart…
        </div>
      ) : isError ? (
        <div className="w-full h-[220px] flex items-center justify-center text-[11px] text-muted-foreground italic">
          Chart unavailable — retrying
        </div>
      ) : !hasData ? (
        <div className="w-full h-[220px] flex items-center justify-center text-[11px] text-muted-foreground italic">
          No flow in selected range
        </div>
      ) : view === 'net' ? (
        <Ribbon data={ribbonData} dataKey="net_all" height={240} gradientId="net-all" />
      ) : (
        <div className="space-y-1">
          <div className="text-[10px] font-mono text-muted-foreground/80 px-1">0-7 DTE (gamma traders)</div>
          <Ribbon data={ribbonData} dataKey="net_short" height={92} gradientId="net-short" />
          <div className="text-[10px] font-mono text-muted-foreground/80 px-1">8-29 DTE (swing flow)</div>
          <Ribbon data={ribbonData} dataKey="net_mid" height={92} gradientId="net-mid" />
          <div className="text-[10px] font-mono text-muted-foreground/80 px-1">30+ DTE (vol / hedge desks)</div>
          <Ribbon data={ribbonData} dataKey="net_long" height={92} gradientId="net-long" />
        </div>
      )}

      <div className="mt-1 text-[9.5px] text-muted-foreground/70">
        Cumulative call premium minus cumulative put premium since RTH open. Above zero = calls winning, below = puts winning. Crossings flag the most recent regime flip per series. Refreshes every 60s.
      </div>
    </Card>
  );
}

interface CollapsibleProps {
  ticker?: string;
  onTickerChange?: (t: string | null) => void;
}

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
        <span className="font-semibold uppercase tracking-wider">Net Premium River</span>
        <span className="text-muted-foreground/60 normal-case">
          ({ticker ?? 'MARKET'} · who's winning the day)
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
