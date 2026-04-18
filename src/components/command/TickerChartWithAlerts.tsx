/**
 * TickerChartWithAlerts — session price chart with Claude's alerts/flags
 * overlaid as annotations at their creation timestamps.
 *
 * WHAT IT ANSWERS: "Did the alert at 14:30 actually precede the move?"
 *
 * DATA SHAPE
 *   - Price series (preferred): ct_price_ticks, ~2-minute resolution, populated
 *     by ct-price-tick-capture during RTH. True intraday shape.
 *   - Price series (fallback): ct_heartbeats.current_reads._snapshot.per_ticker[T].price
 *     sorted by created_at. Granularity is ~15 minutes (the heartbeat cron cadence).
 *     Used when ct_price_ticks has no rows for the session — e.g. first deploy
 *     day, outside RTH, or if the capture cron was disabled.
 *   - Alerts/flags: ct_alerts + ct_flags where `instruments` contains the ticker
 *     within the same session window (UTC day for sessionDate, else today).
 *   - Grades: ct_grades joined by subject_id ⇒ id match. Each alert/flag may or
 *     may not have a grade yet (ungraded = still pending outcome).
 *
 * MARKER VISUAL LANGUAGE
 *   Direction/sentiment drives SHAPE + BASE COLOR (before grade):
 *     bullish  ▲  green
 *     bearish  ▼  red
 *     vol/neutral  ●  amber
 *   Size encodes kind:
 *     FLAG (conv < 5)   — small (r=5)
 *     ALERT (conv = 5)  — large (r=8) + conviction label right of marker
 *   Grade overlays (bright outline on top of marker):
 *     right    ✓ bright green ring
 *     wrong    ✗ bright red ring
 *     partial  ◐ amber ring
 *     (ungraded) muted — no ring
 *
 * EXPECTED-MOVE BAND
 *   For alerts/flags with `expected_move: { low_pct, high_pct, horizon_hrs }`
 *   and a known entry price (entry_prices[ticker] OR the heartbeat price at
 *   created_at), draw a horizontal ReferenceArea from created_at to
 *   created_at + horizon_hrs at price × (1 + low_pct/100) … × (1 + high_pct/100).
 *   Fill opacity 0.15. Stroke color indicates hit/exceed/undershoot using the
 *   actual price range inside the band window:
 *     hit         (price entered band) → light-green solid stroke
 *     exceeded    (price went past high end) → amber dashed stroke
 *     undershot   (price never reached low end) → red dashed stroke
 *     pending     (band extends past last sample) → muted dashed stroke
 *
 * CLICK BEHAVIOUR
 *   Click a marker → Popover anchored to marker shows:
 *     - glance[0]
 *     - direction · conviction/5 · horizon
 *     - expected_move summary ([low, high]% over N hr)
 *     - outcome verdict + actual return if graded; else "pending"
 *
 * MOBILE
 *   Chart is wrapped in an overflow-x-auto container with a minimum chart
 *   width that scales with marker count, so dense sessions can be scrolled.
 *
 * NO NEW UW CALLS — only reads existing ct_* Postgres tables.
 */
import { memo, useMemo, useState, useCallback } from 'react';
import {
  Line,
  LineChart,
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
import type { Heartbeat, ExpectedMove } from '@/hooks/useCoTraderData';

// ─── palette ───────────────────────────────────────────────────────────
const COLOR_BULL = '#00C853';
const COLOR_BEAR = '#FF1744';
const COLOR_NEUTRAL = '#F59E0B';
const COLOR_LINE = '#00E6B4';
const COLOR_GRADE_RIGHT = '#00FF88';
const COLOR_GRADE_WRONG = '#FF3B3B';
const COLOR_GRADE_PARTIAL = '#FFB020';
const COLOR_BAND_HIT = '#4ADE80';
const COLOR_BAND_EXCEED = '#F59E0B';
const COLOR_BAND_UNDER = '#FF6B6B';
const COLOR_MUTED = '#64748B';

// ─── types ─────────────────────────────────────────────────────────────

interface PricePoint {
  t: number;          // epoch ms
  price: number;
  iso: string;
}

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
  entry_price: number | null;         // resolved from entry_prices[ticker] or price@t
  // resolved grade (if present)
  verdict: 'right' | 'wrong' | 'partial' | 'ambiguous' | null;
  actual_return_pct: number | null;
}

interface GradeRow {
  subject_type: string;
  subject_id: string;
  verdict: 'right' | 'wrong' | 'partial' | 'ambiguous';
  actual_return_pct: number | null;
}

export interface TickerChartWithAlertsProps {
  ticker: string;
  /** Session date (UTC YYYY-MM-DD). Defaults to today (UTC). */
  sessionDate?: string;
  /** Full-width standalone variant — taller chart, no card chrome. */
  standalone?: boolean;
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

// ─── data hook ─────────────────────────────────────────────────────────

type PriceSource = 'ticks' | 'heartbeat';

interface ChartData {
  series: PricePoint[];
  markers: AlertMarker[];
  sessionStartIso: string;
  sessionEndIso: string;
  priceSource: PriceSource;
}

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

function extractPrice(hb: Heartbeat, T: string): number | null {
  const snap = (hb.current_reads as Record<string, unknown> | undefined)?._snapshot as
    | Record<string, unknown>
    | undefined;
  const perTicker = (snap?.per_ticker as Record<string, Record<string, unknown>> | undefined) ?? {};
  const state = perTicker[T] ?? perTicker[T.toLowerCase()];
  const price = state?.price;
  return typeof price === 'number' && Number.isFinite(price) ? price : null;
}

function useTickerChartWithAlerts(ticker: string, sessionDate?: string) {
  const { startIso, endIso } = useMemo(() => dayBoundsUtc(sessionDate), [sessionDate]);

  return useQuery<ChartData>({
    queryKey: ['ticker_chart_with_alerts', ticker, startIso, endIso],
    enabled: !!ticker,
    refetchInterval: 30_000,
    staleTime: 15_000,
    queryFn: async () => {
      // Fetch ct_price_ticks (2-min resolution) in parallel with heartbeats
      // (15-min fallback). If no ticks exist for the session, heartbeats
      // provide a coarse shape so first-deploy days still render.
      const [tickQ, hbQ, alertsQ, flagsQ] = await Promise.all([
        supabase
          .from('ct_price_ticks')
          .select('ticker, tick_time, price')
          .eq('ticker', ticker)
          .gte('tick_time', startIso)
          .lte('tick_time', endIso)
          .order('tick_time', { ascending: true })
          .limit(1000),
        supabase
          .from('ct_heartbeats')
          .select('id, current_reads, created_at')
          .neq('prompt_version', 'mcp-verify')
          .gte('created_at', startIso)
          .lte('created_at', endIso)
          .order('created_at', { ascending: true })
          .limit(500),
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
      // tickQ errors are non-fatal — fall back to heartbeats silently.
      if (hbQ.error) throw hbQ.error;
      if (alertsQ.error) throw alertsQ.error;
      if (flagsQ.error) throw flagsQ.error;

      // ── price series (prefer ticks, fall back to heartbeat) ─────
      const tickRows = (tickQ.error || !tickQ.data ? [] : tickQ.data) as Array<{
        tick_time: string;
        price: number;
      }>;
      const series: PricePoint[] = [];
      let priceSource: PriceSource = 'heartbeat';
      if (tickRows.length > 0) {
        priceSource = 'ticks';
        for (const r of tickRows) {
          const p = typeof r.price === 'number' ? r.price : Number(r.price);
          if (!Number.isFinite(p)) continue;
          series.push({ t: Date.parse(r.tick_time), price: p, iso: r.tick_time });
        }
      } else {
        for (const hb of (hbQ.data ?? []) as Heartbeat[]) {
          const p = extractPrice(hb, ticker);
          if (p === null) continue;
          series.push({ t: Date.parse(hb.created_at), price: p, iso: hb.created_at });
        }
      }

      // ── fetch grades for these alert/flag ids ──────────────────
      const alertRows = (alertsQ.data ?? []) as Array<Record<string, unknown>>;
      const flagRows = (flagsQ.data ?? []) as Array<Record<string, unknown>>;
      const subjectIds = [
        ...alertRows.map(r => r.id as string),
        ...flagRows.map(r => r.id as string),
      ];

      let gradesByKey = new Map<string, GradeRow>();
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

      // ── build markers ───────────────────────────────────────────
      const priceAt = (iso: string): number | null => {
        if (series.length === 0) return null;
        const t = Date.parse(iso);
        // Find nearest heartbeat (before or after; markers may land between hbs)
        let best: PricePoint | null = null;
        let bestDelta = Infinity;
        for (const p of series) {
          const d = Math.abs(p.t - t);
          if (d < bestDelta) {
            bestDelta = d;
            best = p;
          }
        }
        return best?.price ?? null;
      };

      const toMarker = (row: Record<string, unknown>, kind: AlertKind): AlertMarker => {
        const iso = row.created_at as string;
        const t = Date.parse(iso);
        const entryPrices = (row.entry_prices as Record<string, number | null> | null) ?? null;
        const entryFromRow = entryPrices ? entryPrices[ticker] ?? entryPrices[ticker.toLowerCase()] : null;
        const entry_price =
          typeof entryFromRow === 'number' && Number.isFinite(entryFromRow)
            ? entryFromRow
            : priceAt(iso);
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
        series,
        markers,
        sessionStartIso: startIso,
        sessionEndIso: endIso,
        priceSource,
      };
    },
  });
}

// ─── marker classification ─────────────────────────────────────────────

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

// ─── expected-move band evaluation ─────────────────────────────────────

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
  series: PricePoint[],
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

  // Evaluate outcome over price samples inside [x1, x2]
  const inside = series.filter(p => p.t >= x1 && p.t <= x2);
  const lastSample = series.length > 0 ? series[series.length - 1].t : 0;
  if (inside.length === 0 || lastSample < x2) {
    return { id: m.id, x1, x2, y1: yLow, y2: yHigh, outcome: 'pending' };
  }
  const minP = Math.min(...inside.map(p => p.price));
  const maxP = Math.max(...inside.map(p => p.price));
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

// ─── marker overlay (Customized child) ─────────────────────────────────

interface CustomChartState {
  xAxisMap?: Record<string, { scale: (v: number) => number }>;
  yAxisMap?: Record<string, { scale: (v: number) => number }>;
}

interface MarkerOverlayProps {
  markers: AlertMarker[];
  series: PricePoint[];
  onMarkerClick: (m: AlertMarker, screenX: number, screenY: number) => void;
}

const MarkerOverlay = (props: MarkerOverlayProps & Record<string, unknown>) => {
  const { markers, series, onMarkerClick } = props;
  const state = props as CustomChartState;
  const xScale = state.xAxisMap?.[Object.keys(state.xAxisMap ?? {})[0]]?.scale;
  const yScale = state.yAxisMap?.[Object.keys(state.yAxisMap ?? {})[0]]?.scale;
  if (!xScale || !yScale) return null;

  // Resolve y-price for each marker from the nearest price sample
  const priceFor = (t: number): number | null => {
    if (series.length === 0) return null;
    let best: PricePoint | null = null;
    let bestDelta = Infinity;
    for (const p of series) {
      const d = Math.abs(p.t - t);
      if (d < bestDelta) {
        bestDelta = d;
        best = p;
      }
    }
    return best?.price ?? null;
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
          // triangle up
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
              const rect = (e.currentTarget.ownerSVGElement?.getBoundingClientRect());
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

// ─── marker detail popover content ─────────────────────────────────────

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
                  color:
                    marker.actual_return_pct >= 0 ? COLOR_BULL : COLOR_BEAR,
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

export function TickerChartWithAlerts({
  ticker,
  sessionDate,
  standalone = false,
}: TickerChartWithAlertsProps) {
  const { data, isLoading, error } = useTickerChartWithAlerts(ticker, sessionDate);
  const [activeMarker, setActiveMarker] = useState<AlertMarker | null>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  const series = data?.series ?? [];
  const markers = data?.markers ?? [];
  const priceSource: PriceSource = data?.priceSource ?? 'heartbeat';

  const sessionEndMs = useMemo(
    () => (data?.sessionEndIso ? Date.parse(data.sessionEndIso) : Date.now()),
    [data?.sessionEndIso],
  );

  const bands: BandSpec[] = useMemo(
    () =>
      markers
        .map(m => computeBandSpec(m, series, sessionEndMs))
        .filter((b): b is BandSpec => b !== null),
    [markers, series, sessionEndMs],
  );

  const handleMarkerClick = useCallback(
    (m: AlertMarker, sx: number, sy: number) => {
      setActiveMarker(m);
      setAnchor({ x: sx, y: sy });
    },
    [],
  );

  // compute y-domain with padding for the bands
  const yDomain = useMemo<[number | 'auto', number | 'auto']>(() => {
    if (series.length === 0) return ['auto', 'auto'];
    let lo = Math.min(...series.map(p => p.price));
    let hi = Math.max(...series.map(p => p.price));
    for (const b of bands) {
      lo = Math.min(lo, b.y1);
      hi = Math.max(hi, b.y2);
    }
    const span = hi - lo || 1;
    return [lo - span * 0.05, hi + span * 0.05];
  }, [series, bands]);

  const chartHeight = standalone ? 520 : 320;
  const minWidth = Math.max(640, markers.length * 18);

  const Wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) =>
    standalone ? (
      <div className="w-full">{children}</div>
    ) : (
      <Card className="p-3 bg-black/60 border-white/10">{children}</Card>
    );

  const empty = !isLoading && !error && series.length === 0 && markers.length === 0;

  return (
    <Wrapper>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-baseline gap-2">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
            {ticker} · session chart · alerts overlaid
          </span>
          <span className="text-[10px] text-muted-foreground/70">
            {priceSource === 'ticks' ? '2-min tick resolution' : '15-min heartbeat resolution'}
          </span>
        </div>
        <div className="flex items-center gap-3 text-[9px] text-muted-foreground">
          <LegendDot color={COLOR_BULL} label="bullish ▲" />
          <LegendDot color={COLOR_BEAR} label="bearish ▼" />
          <LegendDot color={COLOR_NEUTRAL} label="neutral ●" />
          <span className="text-muted-foreground/60">· large = ALERT · small = flag</span>
        </div>
      </div>

      {error && (
        <div className="px-2 py-6 text-center text-xs text-red-400">
          chart fetch failed: {(error as Error).message}
        </div>
      )}

      {empty && (
        <div className="px-2 py-10 text-center text-xs text-muted-foreground">
          no price data for this session
        </div>
      )}

      {!empty && !error && (
        <div className="overflow-x-auto">
          <div style={{ minWidth, height: chartHeight }}>
            <ChartSafe label={`ticker-chart-${ticker}`}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={series}
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
                    formatter={(v: number) => [`$${v.toFixed(2)}`, 'price']}
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
                  <Line
                    type="monotone"
                    dataKey="price"
                    stroke={COLOR_LINE}
                    strokeWidth={1.5}
                    dot={false}
                    isAnimationActive={false}
                  />
                  <Customized
                    component={(cProps: Record<string, unknown>) => (
                      <MarkerOverlay
                        {...cProps}
                        markers={markers}
                        series={series}
                        onMarkerClick={handleMarkerClick}
                      />
                    )}
                  />
                </LineChart>
              </ResponsiveContainer>
            </ChartSafe>
          </div>
        </div>
      )}

      {/* Popover positioned at the click coordinates */}
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
        {priceSource === 'ticks'
          ? '2-min tick cadence — click a marker for detail.'
          : 'heartbeat cadence ~15 min — session shape, not tick-level. click a marker for detail.'}
      </div>
    </Wrapper>
  );
}

// ─── legend dot helper ─────────────────────────────────────────────────
function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span
        className="inline-block"
        style={{ width: 8, height: 8, background: color, borderRadius: 999 }}
      />
      <span>{label}</span>
    </span>
  );
}

export default TickerChartWithAlerts;
