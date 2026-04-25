/**
 * FlowPulseChart — Butterfly.
 *
 * Two modes (tabs):
 *
 *   1. Calls vs Puts (LIVE, mode 'cp')
 *      Plots SIGNED net call premium (top) and SIGNED net put premium (bottom),
 *      raw — no cumsum, no mirror. Reads ct_net_premium_ticks via the
 *      ct_net_premium_series RPC + Supabase Realtime INSERT subscription, with
 *      a 30s fallback poll. Lines cross naturally when the tape flips:
 *        calls > 0 + puts < 0  → bullish (calls being bought, puts sold)
 *        calls < 0 + puts > 0  → bearish (calls being sold, puts bought)
 *      The DTE filter is a no-op in this mode (ticks are all-DTE aggregates).
 *
 *   2. Bullish vs Bearish (CUMULATIVE, mode 'bb')
 *      Two cumulative areas diverging from $0 since RTH open. Top (emerald) =
 *      bought calls + sold puts. Bottom (rose, mirrored negative for layout) =
 *      bought puts + sold calls. Reads ct_flow_pulse_chart with the legacy
 *      bucketed RPC. DTE filter (All / 0-7 / 30+) applies.
 *
 * Headline above the chart:
 *   - Mode 'cp' reports CURRENT bias from the last tick.
 *   - Mode 'bb' reports the cumulative spread.
 *
 * Empty-state: when the requested window returns zero rows, the chart renders
 * a friendly empty message instead of blanking the screen.
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
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  useFlowPulseChart,
  useNetPremiumExpirySplit,
  formatPulseDollars,
  type FlowPulseChartPoint,
  type NetPremiumExpirySplitPoint,
} from '@/hooks/useFlowPulse';

const WATCHLIST = ['SPY', 'QQQ', 'IWM', 'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'TSLA'];

type RangeKey = 'today' | '1h' | '30m';
type ModeKey = 'cp' | 'bb';        // Calls/Puts vs Bullish/Bearish
type DteKey = 'all' | 'short' | 'long';

interface ButterflyPoint {
  time: string;
  bucket_time: string;
  // Mode 'bb' (cumulative): top_bb >= 0 (cum bull), bottom_bb <= 0 (cum bear, mirrored).
  top_bb: number;
  bottom_bb: number;
  // Absolute magnitudes (for tooltip + headline)
  top_bb_abs: number;
  bottom_bb_abs: number;
}

/**
 * 4-series point for mode 'cp'. Cumulative running sums of signed net premium,
 * split by expiry slice:
 *   cum_all_call  → all expiries combined, calls leg
 *   cum_all_put   → all expiries combined, puts leg
 *   cum_next_call → 0-7 DTE only, calls leg
 *   cum_next_put  → 0-7 DTE only, puts leg
 * All four are signed running sums — they can rise above zero, fall below it,
 * and cross each other when the regime flips.
 */
interface FourSeriesPoint {
  time: string;
  bucket_time: string;
  cum_all_call: number;
  cum_all_put: number;
  cum_next_call: number;
  cum_next_put: number;
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

/**
 * True if an ISO timestamp is pre-market in NY time (< 09:30 ET). Used to
 * clip raw ticks so the chart doesn't start its cumsum from 06:00 ET noise
 * before the bell. Weekend data (rare — ingester is weekday-only) also falls
 * on the non-RTH side and gets dropped.
 */
function isPreMarketET(iso: string): boolean {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const h = parseInt(parts.find(p => p.type === 'hour')!.value, 10);
  const m = parseInt(parts.find(p => p.type === 'minute')!.value, 10);
  const minsOfDay = h * 60 + m;
  return minsOfDay < (9 * 60 + 30);
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
  let cumBull = 0;
  let cumBear = 0;
  return points.map((p) => {
    cumBull += pickField(p, 'bullish', dte);
    cumBear += pickField(p, 'bearish', dte);
    return {
      time: fmtTime(p.bucket_time),
      bucket_time: p.bucket_time,
      top_bb: cumBull,
      bottom_bb: -cumBear,
      top_bb_abs: cumBull,
      bottom_bb_abs: cumBear,
    };
  });
}

/**
 * Live 4-series builder. Running sum of SIGNED net premium for four legs:
 * (calls all-expiry, puts all-expiry, calls 0-7 DTE, puts 0-7 DTE).
 *
 * Why cumsum across all four: raw per-minute signed ticks are noisy and the
 * actual information sits in the drift. Cumsum on signed values is NOT
 * monotonic — each line rises when its leg is being bought, falls when sold,
 * and crosses zero when the regime flips on that leg. With 4 lines you read
 * regime AND term-structure at once: NextExpiry diverging from All means the
 * short-dated tape is leading or lagging the broader positioning.
 *
 * Aggregation: single ticker → one row per ts; MARKET → defensive group-by-ts.
 * Sort by timestamp first, then integrate forward.
 */
function buildLiveCp4Series(
  points: NetPremiumExpirySplitPoint[],
  skipPreMarket: boolean,
): FourSeriesPoint[] {
  if (points.length === 0) return [];

  const byTime = new Map<string, {
    allCall: number; allPut: number; nextCall: number; nextPut: number;
  }>();
  for (const p of points) {
    if (skipPreMarket && isPreMarketET(p.tick_timestamp)) continue;
    const ts = p.tick_timestamp;
    const allCall = Number.isFinite(p.all_net_call) ? p.all_net_call : 0;
    const allPut = Number.isFinite(p.all_net_put) ? p.all_net_put : 0;
    const nextCall = Number.isFinite(p.next_net_call) ? p.next_net_call : 0;
    const nextPut = Number.isFinite(p.next_net_put) ? p.next_net_put : 0;
    const cur = byTime.get(ts);
    if (cur) {
      cur.allCall += allCall;
      cur.allPut += allPut;
      cur.nextCall += nextCall;
      cur.nextPut += nextPut;
    } else {
      byTime.set(ts, { allCall, allPut, nextCall, nextPut });
    }
  }

  const sorted = Array.from(byTime.entries()).sort(
    (a, b) => Date.parse(a[0]) - Date.parse(b[0]),
  );

  let cumAllCall = 0;
  let cumAllPut = 0;
  let cumNextCall = 0;
  let cumNextPut = 0;
  const out: FourSeriesPoint[] = [];
  for (const [ts, v] of sorted) {
    cumAllCall += v.allCall;
    cumAllPut += v.allPut;
    cumNextCall += v.nextCall;
    cumNextPut += v.nextPut;
    out.push({
      time: fmtTime(ts),
      bucket_time: ts,
      cum_all_call: cumAllCall,
      cum_all_put: cumAllPut,
      cum_next_call: cumNextCall,
      cum_next_put: cumNextPut,
    });
  }
  return out;
}

interface ButterflyBbProps {
  data: ButterflyPoint[];
  height?: number;
}

/**
 * Mode 'bb' renderer — cumulative bull/bear areas mirrored around 0.
 * Untouched from the original implementation modulo the trimmed point shape.
 */
function ButterflyBb({ data, height = 280 }: ButterflyBbProps) {
  const fillTopId = 'butterfly-top-bb';
  const fillBottomId = 'butterfly-bottom-bb';

  const domain = useMemo<[number, number]>(() => {
    if (data.length === 0) return [-1, 1];
    let max = 0;
    for (const d of data) {
      const t = d.top_bb_abs;
      const b = d.bottom_bb_abs;
      if (t > max) max = t;
      if (b > max) max = b;
    }
    if (max === 0) return [-1, 1];
    const padded = max * 1.10;
    return [-padded, padded];
  }, [data]);

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
            width={72}
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
              const isTop = name === 'top_bb';
              const label = isTop ? 'Bulls' : 'Bears';
              const display = formatPulseDollars(Math.abs(value));
              return [display, label];
            }}
          />
          <Area
            type="monotone"
            dataKey="top_bb"
            stroke="#34d399"
            strokeWidth={1.6}
            fill={`url(#${fillTopId})`}
            isAnimationActive={false}
            dot={false}
            activeDot={{ r: 3 }}
          />
          <Area
            type="monotone"
            dataKey="bottom_bb"
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

interface ButterflyCpProps {
  data: FourSeriesPoint[];
  height?: number;
}

/**
 * Mode 'cp' renderer — 4 cumulative SIGNED lines, no fills.
 *   Calls All        → emerald  #34d399  solid
 *   Calls NextExpiry → green    #22c55e  dashed
 *   Puts All         → light rose #fda4af solid
 *   Puts NextExpiry  → vivid rose #f43f5e dashed
 *
 * Y-domain is symmetric ± max magnitude across all 4 series so the zero line
 * stays the visual midpoint and crossovers read cleanly.
 */
function ButterflyCp({ data, height = 280 }: ButterflyCpProps) {
  const domain = useMemo<[number, number]>(() => {
    if (data.length === 0) return [-1, 1];
    const padded = Math.max(
      ...data.flatMap((d) => [
        Math.abs(d.cum_all_call),
        Math.abs(d.cum_all_put),
        Math.abs(d.cum_next_call),
        Math.abs(d.cum_next_put),
      ]),
    ) * 1.10;
    if (!Number.isFinite(padded) || padded === 0) return [-1, 1];
    return [-padded, padded];
  }, [data]);

  const seriesLabel = (key: string): string => {
    switch (key) {
      case 'cum_all_call': return 'Calls All';
      case 'cum_next_call': return 'Calls Next';
      case 'cum_all_put': return 'Puts All';
      case 'cum_next_put': return 'Puts Next';
      default: return key;
    }
  };

  return (
    <div style={{ width: '100%', height }}>
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
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
            tickFormatter={(v: number) => {
              if (Math.abs(v) < 1) return '$0';
              return `${v < 0 ? '−' : ''}${formatPulseDollars(Math.abs(v))}`;
            }}
            domain={domain}
            width={72}
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
              const display = `${value < 0 ? '−' : '+'}${formatPulseDollars(Math.abs(value))}`;
              return [display, seriesLabel(name)];
            }}
          />
          <Line
            type="monotone"
            dataKey="cum_all_call"
            stroke="#34d399"
            strokeWidth={2}
            isAnimationActive={false}
            dot={false}
            activeDot={{ r: 3 }}
          />
          <Line
            type="monotone"
            dataKey="cum_next_call"
            stroke="#22c55e"
            strokeWidth={1.8}
            strokeDasharray="4 3"
            isAnimationActive={false}
            dot={false}
            activeDot={{ r: 3 }}
          />
          <Line
            type="monotone"
            dataKey="cum_all_put"
            stroke="#fda4af"
            strokeWidth={2}
            isAnimationActive={false}
            dot={false}
            activeDot={{ r: 3 }}
          />
          <Line
            type="monotone"
            dataKey="cum_next_put"
            stroke="#f43f5e"
            strokeWidth={1.8}
            strokeDasharray="4 3"
            isAnimationActive={false}
            dot={false}
            activeDot={{ r: 3 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * Compact 4-series legend for cp mode. Solid swatch = All; dashed swatch =
 * NextExpiry. Greens for calls, roses for puts. Renders inline above the chart.
 */
function CpLegend() {
  const items: { label: string; color: string; dashed: boolean }[] = [
    { label: 'Calls All', color: '#34d399', dashed: false },
    { label: 'Calls Next', color: '#22c55e', dashed: true },
    { label: 'Puts All', color: '#fda4af', dashed: false },
    { label: 'Puts Next', color: '#f43f5e', dashed: true },
  ];
  return (
    <div className="flex items-center gap-3 text-[10px] font-mono text-muted-foreground">
      {items.map((it) => (
        <div key={it.label} className="flex items-center gap-1.5">
          <svg width={18} height={6} aria-hidden>
            <line
              x1={0}
              y1={3}
              x2={18}
              y2={3}
              stroke={it.color}
              strokeWidth={2}
              strokeDasharray={it.dashed ? '4 3' : undefined}
            />
          </svg>
          <span>{it.label}</span>
        </div>
      ))}
    </div>
  );
}

type HeadlineTone = 'top' | 'bottom' | 'flat';

/**
 * Headline for mode 'cp' — drives off the LAST cumulative point of the
 * NextExpiry series. NextExpiry is more signal-rich for intraday read; All is
 * the fallback when next is mixed/flat.
 */
function buildHeadlineCp(data: FourSeriesPoint[]): { text: string; tone: HeadlineTone } {
  if (data.length === 0) return { text: '', tone: 'flat' };
  const last = data[data.length - 1];
  const nextCall = last.cum_next_call;
  const nextPut = last.cum_next_put;

  if (nextCall > 0 && nextPut < 0) {
    return {
      text: `Next-expiry bullish · calls +${formatPulseDollars(Math.abs(nextCall))} · puts ${formatPulseDollars(nextPut)}`,
      tone: 'top',
    };
  }
  if (nextCall < 0 && nextPut > 0) {
    return {
      text: `Next-expiry bearish · calls ${formatPulseDollars(nextCall)} · puts +${formatPulseDollars(Math.abs(nextPut))}`,
      tone: 'bottom',
    };
  }

  // Mixed / flat on next-expiry — fall back to all-expiry net read.
  const allNet = last.cum_all_call - last.cum_all_put;
  if (Math.abs(allNet) < 1) return { text: 'Tape flat', tone: 'flat' };
  if (allNet > 0) return { text: `All-expiry: net +${formatPulseDollars(allNet)}`, tone: 'top' };
  return { text: `All-expiry: net ${formatPulseDollars(allNet)}`, tone: 'bottom' };
}

/**
 * Headline for mode 'bb' — cumulative magnitudes spread (unchanged behavior).
 */
function buildHeadlineBb(data: ButterflyPoint[]): { text: string; tone: HeadlineTone } {
  if (data.length === 0) return { text: '', tone: 'flat' };
  const last = data[data.length - 1];
  const top = last.top_bb_abs;
  const bottom = last.bottom_bb_abs;
  const spread = Math.abs(top - bottom);
  const total = top + bottom;
  if (total > 0 && spread / total < 0.05) {
    return { text: `Tape balanced, ${formatPulseDollars(spread)} apart`, tone: 'flat' };
  }
  if (top >= bottom) {
    return { text: `Bulls leading ${formatPulseDollars(spread)} today`, tone: 'top' };
  }
  return { text: `Bears leading ${formatPulseDollars(spread)} today`, tone: 'bottom' };
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

  // Mode 'cp' (live signed, 4-series) reads ct_net_premium_expiry_split via the
  // new RPC + Realtime on ct_flow_alerts. Mode 'bb' (cumulative mirrored) reads
  // ct_flow_alerts via the legacy bucketed RPC. Both hooks always run (rules of
  // hooks); we just feed the right one to its builder based on mode.
  const cpQuery = useNetPremiumExpirySplit(ticker, rangeToMin(range));
  const bbQuery = useFlowPulseChart(ticker, rangeToMin(range));

  // Mode 'cp' produces FourSeriesPoint[]; mode 'bb' produces ButterflyPoint[].
  // Computing both unconditionally keeps the hook order stable across mode flips.
  const cpData = useMemo(
    // Only clip pre-market on the full-day view. 1h/30m windows are already
    // "last N minutes" so whatever they catch is what the user asked for.
    () => buildLiveCp4Series(cpQuery.points, range === 'today'),
    [cpQuery.points, range],
  );
  const bbData = useMemo(() => buildButterfly(bbQuery.points, dte), [bbQuery.points, dte]);

  const headline = useMemo(() => {
    return mode === 'cp' ? buildHeadlineCp(cpData) : buildHeadlineBb(bbData);
  }, [mode, cpData, bbData]);

  const isLoading = mode === 'cp' ? cpQuery.isLoading : bbQuery.isLoading;
  const isError = mode === 'cp' ? cpQuery.isError : bbQuery.isError;
  const hasDataForMode = mode === 'cp' ? cpData.length > 0 : bbData.length > 0;

  // Mode 'bb' only — detect whether the backend filled in directional fields.
  // (Live mode 'cp' doesn't have this concern; net premium ticks are signed by
  // construction.)
  const hasDirectional = useMemo(() => {
    if (mode !== 'bb') return true;
    const points = bbQuery.points;
    if (points.length === 0) return true;
    let cpFlow = 0;
    let dirFlow = 0;
    for (const p of points) {
      cpFlow += pickField(p, 'calls', 'all') + pickField(p, 'puts', 'all');
      dirFlow += pickField(p, 'bullish', 'all') + pickField(p, 'bearish', 'all');
    }
    if (cpFlow === 0) return true;
    return dirFlow > 0;
  }, [mode, bbQuery.points]);

  const showDirectionalEmpty = mode === 'bb' && hasDataForMode && !hasDirectional;

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

        {/* DTE filter only applies to the legacy 'bb' path. Hidden in live
            'cp' mode since net_premium_ticks doesn't split by expiry. */}
        {mode === 'bb' && (
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
        )}
      </div>

      {/* Mode tabs — Bulls vs Bears hidden until it's migrated to the live
          signed path. Showing a broken option produced noise in testing. */}

      {/* Headline + cp-mode legend on the same row when both apply */}
      {hasDataForMode && !showDirectionalEmpty && (headline.text || mode === 'cp') && (
        <div className="mb-2 flex items-center gap-3 flex-wrap">
          {headline.text && (
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
          )}
          {mode === 'cp' && <div className="ml-auto"><CpLegend /></div>}
        </div>
      )}

      {/* Chart / states */}
      {isLoading && !hasDataForMode ? (
        <div className="w-full h-[280px] flex items-center justify-center text-[11px] text-muted-foreground">
          Loading chart…
        </div>
      ) : isError ? (
        <div className="w-full h-[280px] flex items-center justify-center text-[11px] text-muted-foreground italic">
          Chart unavailable — retrying
        </div>
      ) : !hasDataForMode ? (
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
      ) : mode === 'cp' ? (
        <ButterflyCp data={cpData} height={280} />
      ) : (
        <ButterflyBb data={bbData} height={280} />
      )}

      <div className="mt-1 text-[9.5px] text-muted-foreground/70">
        {mode === 'cp'
          ? 'Running sum of signed net premium — 4 series split by expiry. All = every expiry combined; NextExpiry = contracts 0-7 DTE (shorter expiries). Solid = All; dashed = NextExpiry. Green = calls; rose = puts. Live via Supabase Realtime.'
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
          ({ticker ?? 'MARKET'} · live signed net premium)
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
