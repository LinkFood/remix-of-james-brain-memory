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
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  useFlowPulseChart,
  useNetPremiumSeries,
  formatPulseDollars,
  type FlowPulseChartPoint,
  type NetPremiumSeriesPoint,
} from '@/hooks/useFlowPulse';

const WATCHLIST = ['SPY', 'QQQ', 'IWM', 'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'TSLA'];

type RangeKey = 'today' | '1h' | '30m';
type ModeKey = 'cp' | 'bb';        // Calls/Puts vs Bullish/Bearish
type DteKey = 'all' | 'short' | 'long';

interface ButterflyPoint {
  time: string;
  bucket_time: string;
  // For mode 'cp' (LIVE signed): top_cp = raw net_call_premium (can be ±),
  // bottom_cp = raw net_put_premium (can be ±). NOT mirrored.
  // For mode 'bb' (cumulative): top_bb >= 0 (cum bull), bottom_bb <= 0 (cum bear, mirrored).
  top_cp: number;
  top_bb: number;
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

/**
 * Live Calls vs Puts builder. Running sum of SIGNED net_call_premium and
 * net_put_premium across the session. Integral of signed flow = smooth
 * directional-bias line that climbs when buyers dominate, falls when sellers
 * take over, and can cross zero (or cross each other) when the regime flips.
 *
 * Why cumsum: raw per-minute signed ticks are too noisy to read (hair-pattern
 * spikes). The information sits in the drift, not the minute-to-minute whip.
 * Since the data is SIGNED (unlike the legacy chart_rpc that fed strictly-
 * positive premium sums), cumsum is NOT monotonic — it rises, flattens, and
 * reverses with the tape. Exactly the shape James drew: morning calls climb,
 * 11am stall, afternoon selloff drags the call line down and puts cross above.
 *
 * Aggregation: single ticker → one row per ts; MARKET → many rows per ts,
 * summed to a single MARKET ribbon. Sort by time first, then integrate.
 */
function buildLiveCp(points: NetPremiumSeriesPoint[], skipPreMarket: boolean): ButterflyPoint[] {
  if (points.length === 0) return [];

  const byTime = new Map<string, { call: number; put: number }>();
  for (const p of points) {
    if (skipPreMarket && isPreMarketET(p.tick_timestamp)) continue;
    const ts = p.tick_timestamp;
    const call = Number.isFinite(p.net_call_premium) ? p.net_call_premium : 0;
    const put = Number.isFinite(p.net_put_premium) ? p.net_put_premium : 0;
    const cur = byTime.get(ts);
    if (cur) {
      cur.call += call;
      cur.put += put;
    } else {
      byTime.set(ts, { call, put });
    }
  }

  const sorted = Array.from(byTime.entries()).sort(
    (a, b) => Date.parse(a[0]) - Date.parse(b[0]),
  );

  let cumCall = 0;
  let cumPut = 0;
  const out: ButterflyPoint[] = [];
  for (const [ts, v] of sorted) {
    cumCall += v.call;
    cumPut += v.put;
    out.push({
      time: fmtTime(ts),
      bucket_time: ts,
      top_cp: cumCall,
      bottom_cp: cumPut,
      top_bb: 0,
      bottom_bb: 0,
      top_cp_abs: Math.abs(cumCall),
      bottom_cp_abs: Math.abs(cumPut),
      top_bb_abs: 0,
      bottom_bb_abs: 0,
    });
  }
  return out;
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

  // Symmetric Y-domain so the zero centerline reads as the true midpoint.
  // For mode 'cp' (live signed): both lines can be positive OR negative, so
  // we take the max magnitude across BOTH extremes of BOTH series — this lets
  // crossovers stay visually centered and the zero line always means "flip."
  // For mode 'bb' (cumulative mirrored): top is always ≥0, bottom is mirrored
  // ≤0; their magnitudes via *_abs are sufficient.
  const domain = useMemo<[number, number]>(() => {
    if (data.length === 0) return [-1, 1];
    let max = 0;
    for (const d of data) {
      if (mode === 'cp') {
        const t = Math.abs(d.top_cp);
        const b = Math.abs(d.bottom_cp);
        if (t > max) max = t;
        if (b > max) max = b;
      } else {
        const t = d.top_bb_abs;
        const b = d.bottom_bb_abs;
        if (t > max) max = t;
        if (b > max) max = b;
      }
    }
    if (max === 0) return [-1, 1];
    const padded = max * 1.10;
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
            tickFormatter={(v: number) => {
              // Mode 'cp' = signed running sum; labels must carry sign.
              // Mode 'bb' = mirrored magnitudes; absolute reads naturally.
              if (mode === 'cp') {
                if (Math.abs(v) < 1) return '$0';
                return `${v < 0 ? '−' : ''}${formatPulseDollars(Math.abs(v))}`;
              }
              return formatPulseDollars(Math.abs(v));
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
              const isTop = name === topKey;
              const label = isTop ? topLabel : bottomLabel;
              // Mode 'cp' lines are signed — preserve sign so negative reads
              // as "selling." Mode 'bb' lines are magnitudes (bottom mirrored
              // negative for layout); show absolute value so it reads naturally.
              const display = mode === 'cp'
                ? `${value < 0 ? '−' : '+'}${formatPulseDollars(Math.abs(value))}`
                : formatPulseDollars(Math.abs(value));
              return [display, label];
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

  if (mode === 'cp') {
    // Live signed mode. Read the CURRENT bias off last tick:
    //   call > 0 && put < 0  → tape bullish (calls being bought, puts being sold)
    //   call < 0 && put > 0  → tape bearish (calls being sold, puts being bought)
    //   mixed                 → show net = call − put
    const call = last.top_cp;
    const put = last.bottom_cp;
    if (call > 0 && put < 0) {
      return { text: `Tape bullish · calls +${formatPulseDollars(Math.abs(call))} · puts ${formatPulseDollars(put)}`, tone: 'top' };
    }
    if (call < 0 && put > 0) {
      return { text: `Tape bearish · calls ${formatPulseDollars(call)} · puts +${formatPulseDollars(Math.abs(put))}`, tone: 'bottom' };
    }
    const net = call - put;
    if (Math.abs(net) < 1) return { text: 'Tape flat', tone: 'flat' };
    if (net > 0) return { text: `Net bullish ${formatPulseDollars(net)}`, tone: 'top' };
    return { text: `Net bearish ${formatPulseDollars(Math.abs(net))}`, tone: 'bottom' };
  }

  // Mode 'bb' — cumulative magnitudes (unchanged behavior).
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

  // Mode 'cp' (live signed) reads ct_net_premium_ticks via the new RPC + Realtime.
  // Mode 'bb' (cumulative mirrored) reads ct_flow_alerts via the legacy RPC.
  // Both hooks always run (rules of hooks); we just feed the right one to the
  // builder based on mode.
  const cpQuery = useNetPremiumSeries(ticker, rangeToMin(range));
  const bbQuery = useFlowPulseChart(ticker, rangeToMin(range));

  const data = useMemo(() => {
    if (mode === 'cp') {
      // Only clip pre-market on the full-day view. 1h/30m windows are already
      // "last N minutes" so whatever they catch is what the user asked for.
      return buildLiveCp(cpQuery.points, range === 'today');
    }
    return buildButterfly(bbQuery.points, dte);
  }, [mode, cpQuery.points, bbQuery.points, dte, range]);

  const headline = useMemo(() => buildHeadline(data, mode), [data, mode]);

  const isLoading = mode === 'cp' ? cpQuery.isLoading : bbQuery.isLoading;
  const isError = mode === 'cp' ? cpQuery.isError : bbQuery.isError;

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
          ? 'Running sum of signed net premium over today — calls (green) climb when bought, fall when sold; puts (red) climb when bought, fall when sold. Lines can cross above or below zero when the tape flips. Live via Supabase Realtime.'
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
