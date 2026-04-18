/**
 * TickerCandleChart — OHLC candles for ONE ticker, with Claude's alerts
 * overlaid as annotations (same marker + expected-move band language as
 * TickerChartWithAlerts).
 *
 * WHAT IT ANSWERS: "What did price actually do around the alert?"
 * — but with candle body / wick detail instead of a smoothed line.
 *
 * DATA
 *   Price: ct_price_ticks (~2-min RTH resolution) → aggregateToOhlc(5min).
 *   Alerts/flags/grades: same shape as TickerChartWithAlerts (ct_alerts,
 *   ct_flags, ct_grades keyed by subject_id).
 *
 * RENDER
 *   Recharts has no first-class candle. We use a ComposedChart to get the
 *   number-axis time scale and YAxis domain handling, then draw each candle
 *   ourselves inside a <Customized> child (SVG rect for body + line for wick).
 *   Same approach used for the MarkerOverlay in the line variant — gives us
 *   exact pixel control without a second charting dep.
 *
 * COLORS
 *   close > open → green body  (#00C853)
 *   close < open → red body    (#FF1744)
 *   close == open → neutral outline (doji)
 *   Wick always same color as body.
 *
 * FALLBACK
 *   Ticks < 3 bars worth of data → show "warming up" message and defer to the
 *   caller (TickerTerminal auto-selects the Line variant in this case).
 */
import { memo, useMemo, useState, useCallback } from 'react';
import {
  ComposedChart,
  ResponsiveContainer,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceArea,
  Customized,
} from 'recharts';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { ChartSafe } from '@/components/ChartSafe';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { aggregateToOhlc, type OhlcBar, type PriceTick } from '@/lib/ohlcAggregate';
import type { ExpectedMove } from '@/hooks/useCoTraderData';

// ─── palette (matches TickerChartWithAlerts) ───────────────────────────
const COLOR_BULL = '#00C853';
const COLOR_BEAR = '#FF1744';
const COLOR_NEUTRAL = '#F59E0B';
const COLOR_DOJI = '#94a3b8';
const COLOR_GRADE_RIGHT = '#00FF88';
const COLOR_GRADE_WRONG = '#FF3B3B';
const COLOR_GRADE_PARTIAL = '#FFB020';
const COLOR_BAND_HIT = '#4ADE80';
const COLOR_BAND_EXCEED = '#F59E0B';
const COLOR_BAND_UNDER = '#FF6B6B';
const COLOR_MUTED = '#64748B';

// ─── types ─────────────────────────────────────────────────────────────

type AlertKind = 'alert' | 'flag';

interface AlertMarker {
  id: string;
  kind: AlertKind;
  t: number;
  iso: string;
  direction: string | null;
  conviction: number | null;
  horizon: string | null;
  glance: string[] | null;
  alert_trigger: string | null;
  expected_move: ExpectedMove | null;
  entry_price: number | null;
  verdict: 'right' | 'wrong' | 'partial' | 'ambiguous' | null;
  actual_return_pct: number | null;
}

interface GradeRow {
  subject_type: string;
  subject_id: string;
  verdict: 'right' | 'wrong' | 'partial' | 'ambiguous';
  actual_return_pct: number | null;
}

export interface TickerCandleChartProps {
  ticker: string;
  sessionDate?: string;
  standalone?: boolean;
  intervalMin?: number;
}

// ─── format helpers ────────────────────────────────────────────────────
function fmtHM(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'America/New_York',
  });
}
function fmtPct(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(digits)}%`;
}
function fmtPrice(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return n.toFixed(2);
}

// ─── date bounds (UTC, same semantics as TickerChartWithAlerts) ────────
function dayBoundsUtc(sessionDate?: string): { startIso: string; endIso: string } {
  if (sessionDate) {
    const start = new Date(`${sessionDate}T00:00:00Z`);
    const end = new Date(`${sessionDate}T23:59:59.999Z`);
    return { startIso: start.toISOString(), endIso: end.toISOString() };
  }
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

// ─── data hook ─────────────────────────────────────────────────────────

interface CandleChartData {
  bars: OhlcBar[];
  markers: AlertMarker[];
  sessionStartIso: string;
  sessionEndIso: string;
  tickCount: number;
}

function useTickerCandleChart(
  ticker: string,
  sessionDate: string | undefined,
  intervalMin: number,
) {
  const { startIso, endIso } = useMemo(() => dayBoundsUtc(sessionDate), [sessionDate]);

  return useQuery<CandleChartData>({
    queryKey: ['ticker_candle_chart', ticker, startIso, endIso, intervalMin],
    enabled: !!ticker,
    refetchInterval: 30_000,
    staleTime: 15_000,
    queryFn: async () => {
      const [tickQ, alertsQ, flagsQ] = await Promise.all([
        supabase
          .from('ct_price_ticks')
          .select('ticker, tick_time, price')
          .eq('ticker', ticker)
          .gte('tick_time', startIso)
          .lte('tick_time', endIso)
          .order('tick_time', { ascending: true })
          .limit(2000),
        supabase
          .from('ct_alerts')
          .select(
            'id, instruments, direction, conviction, horizon, glance, alert_trigger, expected_move, entry_prices, created_at',
          )
          .contains('instruments', [ticker])
          .gte('created_at', startIso)
          .lte('created_at', endIso)
          .order('created_at', { ascending: true })
          .limit(200),
        supabase
          .from('ct_flags')
          .select(
            'id, instruments, direction, conviction, horizon, glance, full_reasoning, expected_move, entry_prices, created_at',
          )
          .contains('instruments', [ticker])
          .gte('created_at', startIso)
          .lte('created_at', endIso)
          .order('created_at', { ascending: true })
          .limit(200),
      ]);
      if (alertsQ.error) throw alertsQ.error;
      if (flagsQ.error) throw flagsQ.error;

      const tickRows = (tickQ.error || !tickQ.data ? [] : tickQ.data) as Array<{
        tick_time: string;
        price: number;
      }>;
      const ticks: PriceTick[] = tickRows.map(r => ({
        tick_time: r.tick_time,
        price: typeof r.price === 'number' ? r.price : Number(r.price),
      }));
      const bars = aggregateToOhlc(ticks, intervalMin);

      // ── grades (keyed by kind:id) ──
      const alertRows = (alertsQ.data ?? []) as Array<Record<string, unknown>>;
      const flagRows = (flagsQ.data ?? []) as Array<Record<string, unknown>>;
      const subjectIds = [
        ...alertRows.map(r => r.id as string),
        ...flagRows.map(r => r.id as string),
      ];
      const gradesByKey = new Map<string, GradeRow>();
      if (subjectIds.length > 0) {
        const gradesQ = await supabase
          .from('ct_grades')
          .select('subject_type, subject_id, verdict, actual_return_pct')
          .in('subject_id', subjectIds);
        if (!gradesQ.error && gradesQ.data) {
          for (const g of gradesQ.data as GradeRow[]) {
            gradesByKey.set(`${g.subject_type}:${g.subject_id}`, g);
          }
        }
      }

      const priceAtFromBars = (iso: string): number | null => {
        if (bars.length === 0) return null;
        const t = Date.parse(iso);
        // Use close of the nearest bucket (or the bar that contains t).
        let best: OhlcBar | null = null;
        let bestDelta = Infinity;
        for (const b of bars) {
          const d = Math.abs(b.time_bucket - t);
          if (d < bestDelta) {
            bestDelta = d;
            best = b;
          }
        }
        return best?.close ?? null;
      };

      const toMarker = (row: Record<string, unknown>, kind: AlertKind): AlertMarker => {
        const iso = row.created_at as string;
        const t = Date.parse(iso);
        const entryPrices = (row.entry_prices as Record<string, number | null> | null) ?? null;
        const entryFromRow = entryPrices
          ? entryPrices[ticker] ?? entryPrices[ticker.toLowerCase()]
          : null;
        const entry_price =
          typeof entryFromRow === 'number' && Number.isFinite(entryFromRow)
            ? entryFromRow
            : priceAtFromBars(iso);
        const grade = gradesByKey.get(`${kind}:${row.id as string}`) ?? null;
        return {
          id: row.id as string,
          kind,
          t,
          iso,
          direction: (row.direction as string) ?? null,
          conviction: (row.conviction as number) ?? null,
          horizon: (row.horizon as string) ?? null,
          glance: (row.glance as string[]) ?? null,
          alert_trigger: (row.alert_trigger as string) ?? null,
          expected_move: (row.expected_move as ExpectedMove) ?? null,
          entry_price,
          verdict: grade?.verdict ?? null,
          actual_return_pct: grade?.actual_return_pct ?? null,
        };
      };

      const markers: AlertMarker[] = [
        ...alertRows.map(r => toMarker(r, 'alert')),
        ...flagRows.map(r => toMarker(r, 'flag')),
      ].sort((a, b) => a.t - b.t);

      return {
        bars,
        markers,
        sessionStartIso: startIso,
        sessionEndIso: endIso,
        tickCount: ticks.length,
      };
    },
  });
}

// ─── marker classification (same rules as line variant) ────────────────
function markerColor(dir: string | null): string {
  const d = (dir ?? '').toLowerCase();
  if (d.includes('bull') || d.includes('long') || d.includes('up')) return COLOR_BULL;
  if (d.includes('bear') || d.includes('short') || d.includes('down')) return COLOR_BEAR;
  return COLOR_NEUTRAL;
}
function markerShape(dir: string | null): 'up' | 'down' | 'dot' {
  const d = (dir ?? '').toLowerCase();
  if (d.includes('bull') || d.includes('long') || d.includes('up')) return 'up';
  if (d.includes('bear') || d.includes('short') || d.includes('down')) return 'down';
  return 'dot';
}
function verdictRing(v: AlertMarker['verdict']): string | null {
  if (v === 'right') return COLOR_GRADE_RIGHT;
  if (v === 'wrong') return COLOR_GRADE_WRONG;
  if (v === 'partial') return COLOR_GRADE_PARTIAL;
  return null;
}
function verdictGlyph(v: AlertMarker['verdict']): string {
  if (v === 'right') return '✓';
  if (v === 'wrong') return '✗';
  if (v === 'partial') return '◐';
  return '';
}

// ─── expected-move band eval (uses bar close as the sampled price) ─────
type BandOutcome = 'hit' | 'exceeded' | 'undershot' | 'pending';
interface BandSpec {
  id: string;
  x1: number;
  x2: number;
  y1: number;
  y2: number;
  outcome: BandOutcome;
}
function computeBandSpec(
  m: AlertMarker,
  bars: OhlcBar[],
  sessionEndMs: number,
): BandSpec | null {
  if (!m.expected_move || !m.entry_price || m.entry_price <= 0) return null;
  const { low_pct, high_pct, horizon_hrs } = m.expected_move;
  if (!Number.isFinite(low_pct) || !Number.isFinite(high_pct)) return null;
  const hrs = Number.isFinite(horizon_hrs) && horizon_hrs > 0 ? horizon_hrs : 4;
  const x1 = m.t;
  const x2 = Math.min(m.t + hrs * 3_600_000, sessionEndMs);
  const y1 = m.entry_price * (1 + low_pct / 100);
  const y2 = m.entry_price * (1 + high_pct / 100);
  const yLow = Math.min(y1, y2);
  const yHigh = Math.max(y1, y2);

  const inside = bars.filter(b => b.time_bucket >= x1 && b.time_bucket <= x2);
  const lastSample = bars.length > 0 ? bars[bars.length - 1].time_bucket : 0;
  if (inside.length === 0 || lastSample < x2) {
    return { id: m.id, x1, x2, y1: yLow, y2: yHigh, outcome: 'pending' };
  }
  // Use bar high/low for the tightest outcome judgment.
  const minP = Math.min(...inside.map(b => b.low));
  const maxP = Math.max(...inside.map(b => b.high));
  let outcome: BandOutcome;
  if (maxP > yHigh) outcome = 'exceeded';
  else if (maxP >= yLow && minP <= yHigh) outcome = 'hit';
  else outcome = 'undershot';
  return { id: m.id, x1, x2, y1: yLow, y2: yHigh, outcome };
}
function bandStroke(o: BandOutcome): { stroke: string; dash: string | undefined; fill: string } {
  switch (o) {
    case 'hit':
      return { stroke: COLOR_BAND_HIT, dash: undefined, fill: COLOR_BAND_HIT };
    case 'exceeded':
      return { stroke: COLOR_BAND_EXCEED, dash: '4 4', fill: COLOR_BAND_EXCEED };
    case 'undershot':
      return { stroke: COLOR_BAND_UNDER, dash: '4 4', fill: COLOR_BAND_UNDER };
    case 'pending':
      return { stroke: COLOR_MUTED, dash: '2 3', fill: COLOR_MUTED };
  }
}

// ─── custom SVG candle + marker overlays ───────────────────────────────

interface CustomChartState {
  xAxisMap?: Record<string, { scale: (v: number) => number }>;
  yAxisMap?: Record<string, { scale: (v: number) => number }>;
  offset?: { width?: number };
}

interface CandleOverlayProps {
  bars: OhlcBar[];
  intervalMs: number;
}

const CandleOverlay = (props: CandleOverlayProps & Record<string, unknown>) => {
  const { bars, intervalMs } = props;
  const state = props as CustomChartState;
  const xScale = state.xAxisMap?.[Object.keys(state.xAxisMap ?? {})[0]]?.scale;
  const yScale = state.yAxisMap?.[Object.keys(state.yAxisMap ?? {})[0]]?.scale;
  if (!xScale || !yScale || bars.length === 0) return null;

  // Compute on-screen body width from the interval, but cap it to keep
  // visual breathing room. 70% of slot width is the usual TradingView-ish feel.
  let bodyHalf = 4;
  if (bars.length >= 2) {
    const px0 = xScale(bars[0].time_bucket);
    const px1 = xScale(bars[1].time_bucket);
    const slot = Math.abs(px1 - px0);
    bodyHalf = Math.max(1.5, Math.min(14, slot * 0.35));
  } else {
    // Single-bar fallback: derive from intervalMs via any two scaled points.
    const px0 = xScale(bars[0].time_bucket);
    const px1 = xScale(bars[0].time_bucket + intervalMs);
    const slot = Math.abs(px1 - px0);
    bodyHalf = Math.max(1.5, Math.min(14, slot * 0.35));
  }

  return (
    <g>
      {bars.map(b => {
        const cx = xScale(b.time_bucket);
        const yHigh = yScale(b.high);
        const yLow = yScale(b.low);
        const yOpen = yScale(b.open);
        const yClose = yScale(b.close);
        if (
          !Number.isFinite(cx) ||
          !Number.isFinite(yHigh) ||
          !Number.isFinite(yLow) ||
          !Number.isFinite(yOpen) ||
          !Number.isFinite(yClose)
        ) {
          return null;
        }
        const up = b.close > b.open;
        const down = b.close < b.open;
        const color = up ? COLOR_BULL : down ? COLOR_BEAR : COLOR_DOJI;
        const bodyTop = Math.min(yOpen, yClose);
        const bodyBottom = Math.max(yOpen, yClose);
        const bodyHeight = Math.max(1, bodyBottom - bodyTop);

        return (
          <g key={b.time_bucket}>
            {/* wick */}
            <line
              x1={cx}
              x2={cx}
              y1={yHigh}
              y2={yLow}
              stroke={color}
              strokeWidth={1}
              strokeLinecap="butt"
            />
            {/* body (outlined doji if open === close) */}
            {up || down ? (
              <rect
                x={cx - bodyHalf}
                y={bodyTop}
                width={bodyHalf * 2}
                height={bodyHeight}
                fill={color}
                stroke={color}
                strokeWidth={0.75}
              />
            ) : (
              <line
                x1={cx - bodyHalf}
                x2={cx + bodyHalf}
                y1={yOpen}
                y2={yOpen}
                stroke={color}
                strokeWidth={1}
              />
            )}
          </g>
        );
      })}
    </g>
  );
};

interface MarkerOverlayProps {
  markers: AlertMarker[];
  bars: OhlcBar[];
  onMarkerClick: (m: AlertMarker, screenX: number, screenY: number) => void;
}

const MarkerOverlay = (props: MarkerOverlayProps & Record<string, unknown>) => {
  const { markers, bars, onMarkerClick } = props;
  const state = props as CustomChartState;
  const xScale = state.xAxisMap?.[Object.keys(state.xAxisMap ?? {})[0]]?.scale;
  const yScale = state.yAxisMap?.[Object.keys(state.yAxisMap ?? {})[0]]?.scale;
  if (!xScale || !yScale) return null;

  const priceFor = (t: number): number | null => {
    if (bars.length === 0) return null;
    let best: OhlcBar | null = null;
    let bestDelta = Infinity;
    for (const b of bars) {
      const d = Math.abs(b.time_bucket - t);
      if (d < bestDelta) {
        bestDelta = d;
        best = b;
      }
    }
    return best?.close ?? null;
  };

  return (
    <g>
      {markers.map(m => {
        const y = m.entry_price ?? priceFor(m.t);
        if (y === null) return null;
        const cx = xScale(m.t);
        const cy = yScale(y);
        if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null;

        const isAlert = m.kind === 'alert';
        const base = markerColor(m.direction);
        const ring = verdictRing(m.verdict);
        const muted = m.verdict === null;
        const shape = markerShape(m.direction);
        const r = isAlert ? 8 : 5;
        const fillOpacity = muted ? 0.55 : 1;

        let shapeEl: JSX.Element;
        if (shape === 'up') {
          const h = r * 1.2;
          shapeEl = (
            <polygon
              points={`${cx},${cy - h} ${cx - r},${cy + h * 0.6} ${cx + r},${cy + h * 0.6}`}
              fill={base}
              fillOpacity={fillOpacity}
              stroke={ring ?? 'rgba(0,0,0,0.6)'}
              strokeWidth={ring ? 2 : 0.8}
            />
          );
        } else if (shape === 'down') {
          const h = r * 1.2;
          shapeEl = (
            <polygon
              points={`${cx},${cy + h} ${cx - r},${cy - h * 0.6} ${cx + r},${cy - h * 0.6}`}
              fill={base}
              fillOpacity={fillOpacity}
              stroke={ring ?? 'rgba(0,0,0,0.6)'}
              strokeWidth={ring ? 2 : 0.8}
            />
          );
        } else {
          shapeEl = (
            <circle
              cx={cx}
              cy={cy}
              r={r}
              fill={base}
              fillOpacity={fillOpacity}
              stroke={ring ?? 'rgba(0,0,0,0.6)'}
              strokeWidth={ring ? 2 : 0.8}
            />
          );
        }

        return (
          <g
            key={m.id}
            style={{ cursor: 'pointer' }}
            onClick={e => {
              const rect = e.currentTarget.ownerSVGElement?.getBoundingClientRect();
              const sx = (rect?.left ?? 0) + cx;
              const sy = (rect?.top ?? 0) + cy;
              onMarkerClick(m, sx, sy);
            }}
          >
            {shapeEl}
            {isAlert && m.conviction !== null && (
              <text
                x={cx + r + 3}
                y={cy + 3}
                fontSize={10}
                fontFamily="ui-monospace, monospace"
                fill={base}
              >
                {m.conviction}/5
              </text>
            )}
            {ring && (
              <text
                x={cx - 3}
                y={cy - r - 4}
                fontSize={9}
                fontFamily="ui-monospace, monospace"
                fill={ring}
              >
                {verdictGlyph(m.verdict)}
              </text>
            )}
          </g>
        );
      })}
    </g>
  );
};

// ─── popover ───────────────────────────────────────────────────────────

const MarkerPopover = memo(function MarkerPopover({ marker }: { marker: AlertMarker }) {
  const color = markerColor(marker.direction);
  return (
    <div className="space-y-2 text-[11px]">
      <div className="flex items-center gap-2">
        <Badge
          variant="outline"
          className="text-[9px] uppercase tracking-wider"
          style={{ color, borderColor: `${color}66` }}
        >
          {marker.kind}
        </Badge>
        <span className="font-semibold" style={{ color }}>
          {marker.direction ?? '—'}
        </span>
        {marker.conviction !== null && (
          <span className="text-muted-foreground">conv {marker.conviction}/5</span>
        )}
        {marker.horizon && (
          <span className="text-muted-foreground">· {marker.horizon}</span>
        )}
        <span className="ml-auto text-muted-foreground tabular-nums">
          {fmtHM(marker.iso)} ET
        </span>
      </div>
      {marker.glance && marker.glance.length > 0 && (
        <div className="text-foreground/90 leading-snug">{marker.glance[0]}</div>
      )}
      {marker.alert_trigger && (
        <div className="text-amber-300/90 italic">trigger: {marker.alert_trigger}</div>
      )}
      {marker.entry_price !== null && (
        <div className="text-muted-foreground tabular-nums">
          entry ${fmtPrice(marker.entry_price)}
        </div>
      )}
      {marker.expected_move && (
        <div className="text-muted-foreground tabular-nums">
          expected move: {fmtPct(marker.expected_move.low_pct)} → {fmtPct(marker.expected_move.high_pct)}
          {' '}over {marker.expected_move.horizon_hrs}h
          {marker.expected_move.confidence_pct ? ` · ${marker.expected_move.confidence_pct}% conf` : ''}
        </div>
      )}
      <div className="pt-1 border-t border-white/5">
        {marker.verdict ? (
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">verdict:</span>
            <span
              className="font-semibold uppercase tracking-wider"
              style={{ color: verdictRing(marker.verdict) ?? COLOR_MUTED }}
            >
              {marker.verdict} {verdictGlyph(marker.verdict)}
            </span>
            {marker.actual_return_pct !== null && (
              <span
                className="tabular-nums ml-auto"
                style={{
                  color: marker.actual_return_pct >= 0 ? COLOR_BULL : COLOR_BEAR,
                }}
              >
                {fmtPct(marker.actual_return_pct)} actual
              </span>
            )}
          </div>
        ) : (
          <div className="text-muted-foreground italic">outcome pending</div>
        )}
      </div>
    </div>
  );
});

// ─── main component ────────────────────────────────────────────────────

export function TickerCandleChart({
  ticker,
  sessionDate,
  standalone = false,
  intervalMin = 5,
}: TickerCandleChartProps) {
  const { data, isLoading, error } = useTickerCandleChart(ticker, sessionDate, intervalMin);
  const [activeMarker, setActiveMarker] = useState<AlertMarker | null>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  const bars = data?.bars ?? [];
  const markers = data?.markers ?? [];
  const tickCount = data?.tickCount ?? 0;

  const sessionEndMs = useMemo(
    () => (data?.sessionEndIso ? Date.parse(data.sessionEndIso) : Date.now()),
    [data?.sessionEndIso],
  );
  const intervalMs = intervalMin * 60_000;

  const bands: BandSpec[] = useMemo(
    () =>
      markers
        .map(m => computeBandSpec(m, bars, sessionEndMs))
        .filter((b): b is BandSpec => b !== null),
    [markers, bars, sessionEndMs],
  );

  const handleMarkerClick = useCallback((m: AlertMarker, sx: number, sy: number) => {
    setActiveMarker(m);
    setAnchor({ x: sx, y: sy });
  }, []);

  // y-domain tight but with room for bands
  const yDomain = useMemo<[number | 'auto', number | 'auto']>(() => {
    if (bars.length === 0) return ['auto', 'auto'];
    let lo = Math.min(...bars.map(b => b.low));
    let hi = Math.max(...bars.map(b => b.high));
    for (const b of bands) {
      lo = Math.min(lo, b.y1);
      hi = Math.max(hi, b.y2);
    }
    const span = hi - lo || 1;
    return [lo - span * 0.05, hi + span * 0.05];
  }, [bars, bands]);

  // Feed ComposedChart a minimal data array so it builds axis scales.
  // We draw everything ourselves via <Customized>.
  const chartData = useMemo(
    () =>
      bars.map(b => ({
        t: b.time_bucket,
        c: b.close,
      })),
    [bars],
  );

  const chartHeight = standalone ? 520 : 320;
  const minWidth = Math.max(640, bars.length * 12 + markers.length * 12);

  const Wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) =>
    standalone ? (
      <div className="w-full">{children}</div>
    ) : (
      <Card className="p-3 bg-black/60 border-white/10">{children}</Card>
    );

  const warming = !isLoading && !error && bars.length > 0 && bars.length < 3;
  const empty = !isLoading && !error && bars.length === 0 && markers.length === 0;

  return (
    <Wrapper>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-baseline gap-2">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
            {ticker} · session candles · alerts overlaid
          </span>
          <span className="text-[10px] text-muted-foreground/70">
            {intervalMin}m candles · {bars.length} bars · {tickCount} ticks
          </span>
        </div>
        <div className="flex items-center gap-3 text-[9px] text-muted-foreground">
          <LegendDot color={COLOR_BULL} label="up close" />
          <LegendDot color={COLOR_BEAR} label="down close" />
          <LegendDot color={COLOR_DOJI} label="doji" />
        </div>
      </div>

      {error && (
        <div className="px-2 py-6 text-center text-xs text-red-400">
          chart fetch failed: {(error as Error).message}
        </div>
      )}

      {empty && (
        <div className="px-2 py-10 text-center text-xs text-muted-foreground">
          no tick data for this session yet — ct_price_ticks populates during RTH
        </div>
      )}

      {warming && (
        <div className="px-2 py-6 text-center text-xs text-muted-foreground">
          warming up — needs 15+ min of ticks for meaningful candles
          <span className="block text-[10px] text-muted-foreground/70 mt-1">
            ({bars.length} {intervalMin}m bar{bars.length === 1 ? '' : 's'} so far)
          </span>
        </div>
      )}

      {!empty && !warming && !error && (
        <div className="overflow-x-auto">
          <div style={{ minWidth, height: chartHeight }}>
            <ChartSafe label={`ticker-candle-${ticker}`}>
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart
                  data={chartData}
                  margin={{ top: 8, right: 16, bottom: 4, left: 4 }}
                >
                  <XAxis
                    dataKey="t"
                    type="number"
                    domain={['dataMin', 'dataMax']}
                    tickFormatter={v =>
                      new Date(v as number).toLocaleTimeString('en-US', {
                        hour: '2-digit',
                        minute: '2-digit',
                        hour12: false,
                        timeZone: 'America/New_York',
                      })
                    }
                    tick={{ fontSize: 10, fill: '#94a3b8' }}
                    stroke="#334155"
                    minTickGap={40}
                  />
                  <YAxis
                    domain={yDomain}
                    tick={{ fontSize: 10, fill: '#94a3b8' }}
                    stroke="#334155"
                    width={54}
                    tickFormatter={v => (typeof v === 'number' ? v.toFixed(2) : '')}
                  />
                  <Tooltip
                    contentStyle={{
                      background: 'rgba(0,0,0,0.92)',
                      border: '1px solid rgba(255,255,255,0.1)',
                      fontSize: 11,
                    }}
                    labelFormatter={v =>
                      new Date(v as number).toLocaleString('en-US', {
                        timeZone: 'America/New_York',
                      })
                    }
                    formatter={(v: number) => [`$${v.toFixed(2)}`, 'close']}
                  />
                  {bands.map(b => {
                    const s = bandStroke(b.outcome);
                    return (
                      <ReferenceArea
                        key={b.id}
                        x1={b.x1}
                        x2={b.x2}
                        y1={b.y1}
                        y2={b.y2}
                        stroke={s.stroke}
                        strokeOpacity={0.6}
                        strokeDasharray={s.dash}
                        fill={s.fill}
                        fillOpacity={0.15}
                        ifOverflow="extendDomain"
                      />
                    );
                  })}
                  {/* Candles drawn on top of bands, under markers */}
                  <Customized
                    component={(cProps: Record<string, unknown>) => (
                      <CandleOverlay {...cProps} bars={bars} intervalMs={intervalMs} />
                    )}
                  />
                  <Customized
                    component={(cProps: Record<string, unknown>) => (
                      <MarkerOverlay
                        {...cProps}
                        markers={markers}
                        bars={bars}
                        onMarkerClick={handleMarkerClick}
                      />
                    )}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </ChartSafe>
          </div>
        </div>
      )}

      {activeMarker && (
        <Popover open onOpenChange={open => !open && setActiveMarker(null)}>
          <PopoverTrigger asChild>
            <span
              aria-hidden
              style={{
                position: 'fixed',
                left: anchor.x,
                top: anchor.y,
                width: 1,
                height: 1,
                pointerEvents: 'none',
              }}
            />
          </PopoverTrigger>
          <PopoverContent
            side="top"
            className="w-[320px] bg-black/95 border-white/10 text-foreground"
          >
            <MarkerPopover marker={activeMarker} />
          </PopoverContent>
        </Popover>
      )}

      <div className="pt-2 text-[9px] text-muted-foreground/60 text-center">
        {intervalMin}m OHLC from ct_price_ticks · click a marker for detail
      </div>
    </Wrapper>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span
        className="inline-block"
        style={{ width: 8, height: 8, background: color, borderRadius: 2 }}
      />
      <span>{label}</span>
    </span>
  );
}

export default TickerCandleChart;
