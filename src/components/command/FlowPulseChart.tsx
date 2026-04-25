/**
 * FlowPulseChart — Butterfly.
 *
 * Two cumulative areas diverging from a $0 centerline since RTH open. Top
 * (emerald) climbs up; bottom (rose) climbs down. The shape preserves
 * information that any single "calls − puts" net would average away —
 * options markets carry a structural call-bias, so a single ribbon drifts
 * positive regardless of regime. Two halves keeps the slopes honest.
 *
 * Two modes (tabs):
 *   1. Calls vs Puts        — top = cum call premium, bottom = cum put premium
 *   2. Bullish vs Bearish   — top = bought calls + sold puts (aggressive bull)
 *                             bottom = bought puts + sold calls (aggressive bear)
 *
 * DTE filter (preserved): All / 0-7 / 30+ → maps to *_all / *_short / *_long.
 *
 * The headline above the chart reports the latest-bucket spread between the
 * two halves, e.g. "Calls leading $185M today" or "Tape balanced, $5M apart".
 *
 * Cumulatives are computed client-side from per-bucket RPC values via useMemo.
 *
 * Empty-state: when the requested time-window returns zero rows (e.g. picking
 * "30m" on a Friday evening with the market closed), the chart renders a
 * friendly empty message instead of blanking the screen. Window-selector bug
 * fix lives here, not in the parent.
 */

import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import {
  ChevronDown,
  LineChart as LineChartIcon,
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
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  useFlowPulseChart,
  formatPulseDollars,
  type FlowPulseChartPoint,
} from '@/hooks/useFlowPulse';

const WATCHLIST = ['SPY', 'QQQ', 'IWM', 'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'TSLA'];

type RangeKey = 'today' | '1h' | '30m';
type ModeKey = 'cp' | 'bb';        // Calls/Puts vs Bullish/Bearish
type DteKey = 'all' | 'short' | 'long';

interface ButterflyPoint {
  time: string;
  bucket_time: string;
  // Top series — always positive (or 0)
  top_cp: number;
  top_bb: number;
  // Bottom series — emitted as negative numbers so the area renders below 0
  bottom_cp: number;
  bottom_bb: number;
  // Absolute magnitudes (for tooltip + headline)
  top_cp_abs: number;
  top_bb_abs: number;
  bottom_cp_abs: number;
  bottom_bb_abs: number;
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

function pickField(p: FlowPulseChartPoint, side: 'calls' | 'puts' | 'bullish' | 'bearish', dte: DteKey): number {
  const key = `${side}_${dte}` as keyof FlowPulseChartPoint;
  const v = p[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function buildButterfly(points: FlowPulseChartPoint[], dte: DteKey): ButterflyPoint[] {
  let cumCalls = 0;
  let cumPuts = 0;
  let cumBull = 0;
  let cumBear = 0;
  return points.map((p) => {
    cumCalls += pickField(p, 'calls', dte);
    cumPuts += pickField(p, 'puts', dte);
    cumBull += pickField(p, 'bullish', dte);
    cumBear += pickField(p, 'bearish', dte);
    return {
      time: fmtTime(p.bucket_time),
      bucket_time: p.bucket_time,
      top_cp: cumCalls,
      top_bb: cumBull,
      bottom_cp: -cumPuts,
      bottom_bb: -cumBear,
      top_cp_abs: cumCalls,
      top_bb_abs: cumBull,
      bottom_cp_abs: cumPuts,
      bottom_bb_abs: cumBear,
    };
  });
}

interface ButterflyProps {
  data: ButterflyPoint[];
  mode: ModeKey;
  height?: number;
}

function Butterfly({ data, mode, height = 280 }: ButterflyProps) {
  const topKey = mode === 'cp' ? 'top_cp' : 'top_bb';
  const bottomKey = mode === 'cp' ? 'bottom_cp' : 'bottom_bb';
  const topLabel = mode === 'cp' ? 'Calls' : 'Bulls';
  const bottomLabel = mode === 'cp' ? 'Puts' : 'Bears';
  const fillTopId = `butterfly-top-${mode}`;
  const fillBottomId = `butterfly-bottom-${mode}`;

  // Symmetric Y-domain so the centerline reads as the true midpoint. We pick
  // the larger of the two halves' magnitudes so both areas have proportional
  // breathing room — never asymmetric scaling, that hides the asymmetry which
  // IS the signal.
  const domain = useMemo<[number, number]>(() => {
    if (data.length === 0) return [-1, 1];
    let max = 0;
    for (const d of data) {
      const t = mode === 'cp' ? d.top_cp_abs : d.top_bb_abs;
      const b = mode === 'cp' ? d.bottom_cp_abs : d.bottom_bb_abs;
      if (t > max) max = t;
      if (b > max) max = b;
    }
    if (max === 0) return [-1, 1];
    const padded = max * 1.08;
    return [-padded, padded];
  }, [data, mode]);

  return (
    <div style={{ width: '100%', height }}>
      <ResponsiveContainer>
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
          <defs>
            <linearGradient id={fillTopId} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="#10b981" stopOpacity={0.55} />
              <stop offset="100%" stopColor="#10b981" stopOpacity={0.05} />
            </linearGradient>
            <linearGradient id={fillBottomId} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="#f43f5e" stopOpacity={0.05} />
              <stop offset="100%" stopColor="#f43f5e" stopOpacity={0.55} />
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
            tickFormatter={(v: number) => formatPulseDollars(Math.abs(v))}
            domain={domain}
            width={64}
          />
          <ReferenceLine y={0} stroke="#a1a1aa" strokeOpacity={0.6} strokeDasharray="1 3" />
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
              const isTop = name === topKey;
              const label = isTop ? topLabel : bottomLabel;
              return [formatPulseDollars(Math.abs(value)), label];
            }}
          />
          <Area
            type="monotone"
            dataKey={topKey}
            stroke="#34d399"
            strokeWidth={1.6}
            fill={`url(#${fillTopId})`}
            isAnimationActive={false}
            dot={false}
            activeDot={{ r: 3 }}
          />
          <Area
            type="monotone"
            dataKey={bottomKey}
            stroke="#fb7185"
            strokeWidth={1.6}
            fill={`url(#${fillBottomId})`}
            isAnimationActive={false}
            dot={false}
            activeDot={{ r: 3 }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function buildHeadline(
  data: ButterflyPoint[],
  mode: ModeKey,
): { text: string; tone: 'top' | 'bottom' | 'flat' } {
  if (data.length === 0) return { text: '', tone: 'flat' };
  const last = data[data.length - 1];
  const top = mode === 'cp' ? last.top_cp_abs : last.top_bb_abs;
  const bottom = mode === 'cp' ? last.bottom_cp_abs : last.bottom_bb_abs;
  const spread = Math.abs(top - bottom);
  const total = top + bottom;
  // "Balanced" if the two halves are within 5% of total (and total > 0).
  if (total > 0 && spread / total < 0.05) {
    return {
      text: `Tape balanced, ${formatPulseDollars(spread)} apart`,
      tone: 'flat',
    };
  }
  if (top >= bottom) {
    const lead = mode === 'cp' ? 'Calls leading' : 'Bulls leading';
    return { text: `${lead} ${formatPulseDollars(spread)} today`, tone: 'top' };
  }
  const lead = mode === 'cp' ? 'Puts leading' : 'Bears leading';
  return { text: `${lead} ${formatPulseDollars(spread)} today`, tone: 'bottom' };
}

function dteLabel(d: DteKey): string {
  if (d === 'short') return '0-7 DTE';
  if (d === 'long') return '30+ DTE';
  return 'All DTE';
}

export function FlowPulseChart({ ticker, onTickerChange }: Props) {
  const [range, setRange] = useState<RangeKey>('today');
  const [mode, setMode] = useState<ModeKey>('cp');
  const [dte, setDte] = useState<DteKey>('all');

  const { points, isLoading, isError } = useFlowPulseChart(ticker, rangeToMin(range));
  const data = useMemo(() => buildButterfly(points, dte), [points, dte]);
  const headline = useMemo(() => buildHeadline(data, mode), [data, mode]);

  // Detect whether the backend filled in directional fields. If every bucket
  // has bullish_*/bearish_* === 0 AND there's any flow at all on the C/P side,
  // we treat directional as unavailable (the parallel agent said this can
  // happen if `side` doesn't exist on ct_flow_alerts yet).
  const hasDirectional = useMemo(() => {
    if (points.length === 0) return true;   // empty state handles itself
    let cpFlow = 0;
    let dirFlow = 0;
    for (const p of points) {
      cpFlow += pickField(p, 'calls', 'all') + pickField(p, 'puts', 'all');
      dirFlow += pickField(p, 'bullish', 'all') + pickField(p, 'bearish', 'all');
    }
    if (cpFlow === 0) return true;   // no flow at all — don't pre-disable mode
    return dirFlow > 0;
  }, [points]);

  const hasData = data.length > 0;
  const showDirectionalEmpty = mode === 'bb' && hasData && !hasDirectional;

  return (
    <Card className="mt-1 p-3 bg-card/70 border-border/60">
      {/* Header: section label + ticker + range pills + DTE filter */}
      <div className="flex items-center gap-3 flex-wrap mb-2">
        <div className="flex items-center gap-2">
          <LineChartIcon className="w-3.5 h-3.5 text-primary" />
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
            Flow Butterfly
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
          {(['all', 'short', 'long'] as const).map((d) => (
            <button
              key={d}
              onClick={() => setDte(d)}
              className={cn(
                'text-[10px] font-mono px-2 py-0.5 rounded transition-colors',
                dte === d
                  ? 'bg-primary/10 text-primary border border-primary/30'
                  : 'bg-muted/20 text-muted-foreground hover:text-foreground border border-transparent',
              )}
              title={`Filter to ${dteLabel(d)}`}
            >
              {dteLabel(d)}
            </button>
          ))}
        </div>
      </div>

      {/* Mode tabs (Calls/Puts vs Bulls/Bears) */}
      <Tabs value={mode} onValueChange={(v) => setMode(v as ModeKey)} className="mb-2">
        <TabsList className="h-7 p-0.5 bg-muted/30 border border-border/40">
          <TabsTrigger
            value="cp"
            className="text-[10px] font-mono uppercase tracking-wider px-3 py-1 h-6 data-[state=active]:bg-background data-[state=active]:text-primary"
          >
            Calls vs Puts
          </TabsTrigger>
          <TabsTrigger
            value="bb"
            className="text-[10px] font-mono uppercase tracking-wider px-3 py-1 h-6 data-[state=active]:bg-background data-[state=active]:text-primary"
          >
            Bulls vs Bears
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {/* Headline */}
      {hasData && headline.text && !showDirectionalEmpty && (
        <div className="mb-2">
          <span
            className={cn(
              'text-[12px] font-mono font-semibold',
              headline.tone === 'top' && 'text-emerald-300',
              headline.tone === 'bottom' && 'text-rose-300',
              headline.tone === 'flat' && 'text-muted-foreground',
            )}
          >
            {headline.text}
          </span>
        </div>
      )}

      {/* Chart / states */}
      {isLoading && !hasData ? (
        <div className="w-full h-[280px] flex items-center justify-center text-[11px] text-muted-foreground">
          Loading chart…
        </div>
      ) : isError ? (
        <div className="w-full h-[280px] flex items-center justify-center text-[11px] text-muted-foreground italic">
          Chart unavailable — retrying
        </div>
      ) : !hasData ? (
        <div className="w-full h-[280px] flex flex-col items-center justify-center gap-1 text-center px-4">
          <span className="text-[12px] text-muted-foreground italic">
            No flow in {range === '30m' ? 'last 30 min' : range === '1h' ? 'last hour' : 'today’s session'}
          </span>
          <span className="text-[10px] text-muted-foreground/70">
            Market may be closed — try the &ldquo;Today&rdquo; window for the most recent RTH session.
          </span>
        </div>
      ) : showDirectionalEmpty ? (
        <div className="w-full h-[280px] flex flex-col items-center justify-center gap-1 text-center px-4">
          <span className="text-[12px] text-muted-foreground italic">
            Bullish/Bearish detection not yet available
          </span>
          <span className="text-[10px] text-muted-foreground/70">
            Flow alerts need a directional <span className="font-mono">side</span> field. Until then, use Calls vs Puts.
          </span>
        </div>
      ) : (
        <Butterfly data={data} mode={mode} height={280} />
      )}

      <div className="mt-1 text-[9.5px] text-muted-foreground/70">
        {mode === 'cp'
          ? 'Cumulative call premium climbs up; cumulative put premium climbs down. The asymmetry between the two halves is the signal — calls naturally outflow puts, so watch the ratio of slopes, not just the side that’s leading.'
          : 'Aggressive bull bets (bought calls + sold puts) climb up; aggressive bear bets (bought puts + sold calls) climb down. Refreshes every 60s.'}
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
        <span className="font-semibold uppercase tracking-wider">Flow Butterfly</span>
        <span className="text-muted-foreground/60 normal-case">
          ({ticker ?? 'MARKET'} · cumulative both sides)
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
