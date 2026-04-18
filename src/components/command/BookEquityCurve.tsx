/**
 * BookEquityCurve — Claude's $10k paper book as one visual.
 *
 * Equity line + high-water-mark band (teal fill from starting_balance to HWM)
 * + drawdown shade (red fill when current < HWM) + today's intraday tick.
 *
 * Pulls full ct_book history (asc) via useBookEquityCurve. Per-trade
 * unrealized isn't stored on ct_trades; book-level unrealized comes from
 * ct_book.unrealized_pnl and is rolled into the "current" equity point.
 *
 * ~300px tall. Header carries the stats that answer: "is this book winning,
 * and by how much, and when was the best/worst day?"
 */
import { ChartSafe } from '@/components/ChartSafe';
import { Link } from 'react-router-dom';
import { Card } from '@/components/ui/card';
import { TrendingUp, TrendingDown, ArrowRight, AlertTriangle } from 'lucide-react';
import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  ResponsiveContainer,
  Tooltip,
  ReferenceLine,
} from 'recharts';
import { useBookEquityCurve } from '@/hooks/useBookEquityCurve';
import { useDrawdownAlerts } from '@/hooks/useDrawdownAlerts';
import { usePnlByTheme, formatBestWorstLine } from '@/components/command/PnLByTheme';
import { FreshnessChip } from '@/components/FreshnessChip';
import { finiteDomain } from '@/lib/chartSanitize';
import { useMemo } from 'react';

const GREEN = '#00C853';
const RED = '#FF1744';
const TEAL = '#00E6B4';

function fmtUsd(n: number, signed = false): string {
  const v = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (!signed) return `$${v}`;
  return n >= 0 ? `+$${v}` : `-$${v}`;
}

function fmtBalance(n: number): string {
  return `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

function fmtPct(n: number, signed = true, digits = 2): string {
  const v = n.toFixed(digits);
  if (!signed) return `${v}%`;
  return n >= 0 ? `+${v}%` : `${v}%`;
}

function Stat({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <div className="text-[9px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div
        className="text-xs font-mono font-semibold truncate"
        style={color ? { color } : undefined}
      >
        {value}
      </div>
      {sub && <div className="text-[9px] text-muted-foreground font-mono truncate">{sub}</div>}
    </div>
  );
}

export function BookEquityCurve() {
  const { data, isLoading, dataUpdatedAt } = useBookEquityCurve();
  const { data: themeRows } = usePnlByTheme('all');
  const { data: drawdownAlerts } = useDrawdownAlerts();
  const bestWorstLine = formatBestWorstLine(themeRows);

  // Freshness anchor: max(closed_at, live_pnl_updated_at) across today's
  // trades — i.e. the most recent real write to ct_trades. Falls back to
  // the React Query dataUpdatedAt (last successful refetch) when there's
  // no trade activity yet today, which is still a truthful "last pulled".
  const bookTs = useMemo<string | null>(() => {
    let maxMs = 0;
    for (const t of data?.todayTrades ?? []) {
      const candidates = [t.closed_at, t.live_pnl_updated_at, t.opened_at];
      for (const c of candidates) {
        if (!c) continue;
        const m = Date.parse(c);
        if (Number.isFinite(m) && m > maxMs) maxMs = m;
      }
    }
    if (maxMs > 0) return new Date(maxMs).toISOString();
    if (dataUpdatedAt) return new Date(dataUpdatedAt).toISOString();
    return null;
  }, [data?.todayTrades, dataUpdatedAt]);

  // Worst tier wins for the chip display (urgent > warn). Alerts are today-only.
  const urgentAlert = drawdownAlerts?.find(a => a.tier === 'urgent');
  const warnAlert = drawdownAlerts?.find(a => a.tier === 'warn');
  const activeAlert = urgentAlert ?? warnAlert ?? null;

  const handleChipClick = () => {
    // On /book the trades table has id="trades-table". On CommandStation
    // there's no target — getElementById no-ops quietly.
    const el = document.getElementById('trades-table');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const points = data?.points ?? [];
  const stats = data?.stats;

  // Pre-compute chart series. Recharts Area needs pairs, so we emit:
  //   - hwmBand: starting..HWM shaded teal (always visible "ceiling" band)
  //   - drawdownShade: balance..HWM when balance < HWM (red delta)
  //   - balance: the line itself (green/red tip based on current vs $10k)
  const safeNum = (n: unknown, fallback: number): number =>
    typeof n === 'number' && Number.isFinite(n) ? n : fallback;
  const chartData = points
    .filter(p => Number.isFinite(p.balance) || Number.isFinite(p.hwm))
    .map(p => {
      const balance = safeNum(p.balance, safeNum(p.starting, 10_000));
      const hwm = safeNum(p.hwm, balance);
      const starting = safeNum(p.starting, 10_000);
      const drawdownLow = Math.min(balance, hwm);
      const drawdownHigh = Math.max(balance, hwm);
      return {
        label: p.label,
        date: p.date,
        balance,
        hwm,
        starting,
        // Area stacks: we pass [low, high] tuples for the shaded regions
        hwmBand: [starting, hwm] as [number, number],
        drawdownBand:
          balance < hwm
            ? ([drawdownLow, drawdownHigh] as [number, number])
            : ([hwm, hwm] as [number, number]), // zero-height if no drawdown
        isToday: p.isToday,
      };
    });

  const above = (stats?.current ?? 10_000) >= 10_000;
  const lineColor = above ? GREEN : RED;

  // Y-axis domain: tighten the range so small moves are visible but keep
  // $10k always in view as the "is this winning?" anchor.
  // Filter out anything non-finite — a null/NaN leaking into Recharts'
  // axis resolver triggers decimal.js LN10 precision overflow and blows
  // up the whole page.
  const allVals = chartData
    .flatMap(d => [d.balance, d.hwm, d.starting])
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  allVals.push(10_000); // always anchor the seed level
  const minY = Math.min(...allVals);
  const maxY = Math.max(...allVals);
  // finiteDomain guarantees min < max and finite on both ends — otherwise
  // Recharts' decimal.js throws LN10 precision on axis tick computation.
  const [safeMin, safeMax] = finiteDomain(minY, maxY, [9_800, 10_200], 100);
  const pad = Math.max((safeMax - safeMin) * 0.1, 50);
  const yDomain: [number, number] = [Math.floor(safeMin - pad), Math.ceil(safeMax + pad)];

  return (
    <Card className="divide-y divide-border">
      {/* Header — title + view-full link */}
      <div className="px-4 py-2.5 border-b border-border bg-muted/20 flex flex-col gap-0.5">
        <div className="flex items-center gap-2">
          {above ? (
            <TrendingUp className="w-4 h-4" style={{ color: GREEN }} />
          ) : (
            <TrendingDown className="w-4 h-4" style={{ color: RED }} />
          )}
          <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground">
            Book Equity
          </h3>
          <span className="text-[10px] text-muted-foreground">$10k paper · all sessions</span>
          {activeAlert && (
            <button
              type="button"
              onClick={handleChipClick}
              className={`text-[10px] font-mono px-1.5 py-0.5 rounded-sm border flex items-center gap-1 transition-colors hover:opacity-80 ${
                activeAlert.tier === 'urgent'
                  ? 'bg-red-500/10 border-red-500/40 text-red-500'
                  : 'bg-yellow-500/10 border-yellow-500/40 text-yellow-500'
              }`}
              title="Jump to trades table"
            >
              <AlertTriangle className="w-3 h-3" />
              drawdown alert triggered (tier: {activeAlert.tier}, at ${activeAlert.equity_at_trigger.toLocaleString('en-US', { maximumFractionDigits: 0 })}, {activeAlert.intraday_pnl_pct.toFixed(2)}%)
            </button>
          )}
          <Link
            to="/scorecard#calibration"
            className="ml-auto text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
          >
            calibration <ArrowRight className="w-3 h-3" />
          </Link>
          <Link
            to="/book"
            className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
          >
            full book <ArrowRight className="w-3 h-3" />
          </Link>
          <FreshnessChip timestamp={bookTs} />
        </div>
        {bestWorstLine && (
          <div className="text-[10px] text-muted-foreground font-mono pl-6 truncate">
            {bestWorstLine}
          </div>
        )}
      </div>

      {/* Stats strip */}
      {isLoading || !stats ? (
        <div className="p-3 text-[10px] text-muted-foreground">loading…</div>
      ) : (
        <div className="px-3 py-2 grid grid-cols-4 md:grid-cols-7 gap-3">
          <Stat
            label="Equity"
            value={fmtBalance(stats.current)}
            sub={`${fmtUsd(stats.currentDelta, true)} · ${fmtPct(stats.currentPct)}`}
            color={above ? GREEN : RED}
          />
          <Stat
            label="HWM"
            value={fmtBalance(stats.hwm)}
            color={TEAL}
          />
          <Stat
            label="Drawdown"
            value={stats.drawdownPct < 0 ? fmtPct(stats.drawdownPct) : '—'}
            color={stats.drawdownPct < 0 ? RED : undefined}
          />
          <Stat
            label="Sessions"
            value={`${stats.sessions}`}
            sub={`${stats.trades} trades`}
          />
          <Stat
            label="Win rate"
            value={stats.wins + stats.losses === 0 ? '—' : fmtPct(stats.winRate * 100, false, 1)}
            sub={`${stats.wins}W / ${stats.losses}L`}
          />
          <Stat
            label="Best / Worst"
            value={
              stats.bestSession
                ? `${fmtUsd(stats.bestSession.pnl, true)}`
                : '—'
            }
            sub={
              stats.worstSession
                ? `${fmtUsd(stats.worstSession.pnl, true)}`
                : undefined
            }
            color={stats.bestSession ? (stats.bestSession.pnl >= 0 ? GREEN : RED) : undefined}
          />
          <Stat
            label="Today"
            value={fmtUsd(stats.todayTotalUsd, true)}
            sub={`r ${fmtUsd(stats.todayRealizedUsd, true)} · u ${fmtUsd(stats.todayUnrealizedUsd, true)}`}
            color={stats.todayTotalUsd >= 0 ? GREEN : RED}
          />
        </div>
      )}

      {/* Chart */}
      {isLoading ? (
        <div className="p-4 text-xs text-muted-foreground">loading…</div>
      ) : points.length === 0 ? (
        <div className="p-4 text-xs text-muted-foreground">
          No sessions yet. First session opens at 9:26 AM ET.
        </div>
      ) : (
        <div className="p-2" style={{ height: 220 }}>
          <ChartSafe><ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              data={chartData}
              margin={{ top: 4, right: 10, left: 0, bottom: 4 }}
            >
              <defs>
                <linearGradient id="hwmBandFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={TEAL} stopOpacity={0.18} />
                  <stop offset="100%" stopColor={TEAL} stopOpacity={0.04} />
                </linearGradient>
                <linearGradient id="ddShadeFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={RED} stopOpacity={0.15} />
                  <stop offset="100%" stopColor={RED} stopOpacity={0.03} />
                </linearGradient>
              </defs>

              <XAxis
                dataKey="label"
                tick={{ fontSize: 9, fill: 'hsl(var(--muted-foreground))' }}
                axisLine={false}
                tickLine={false}
                interval="preserveStartEnd"
                minTickGap={18}
              />
              <YAxis
                domain={yDomain}
                tick={{ fontSize: 9, fill: 'hsl(var(--muted-foreground))' }}
                axisLine={false}
                tickLine={false}
                tickFormatter={v => `$${(v / 1000).toFixed(1)}k`}
                width={44}
              />
              <Tooltip
                contentStyle={{
                  background: 'hsl(var(--popover))',
                  border: '1px solid hsl(var(--border))',
                  fontSize: '10px',
                  padding: '4px 8px',
                }}
                formatter={(value: number | [number, number], name: string) => {
                  if (Array.isArray(value)) {
                    return [`${fmtBalance(value[0])} → ${fmtBalance(value[1])}`, name];
                  }
                  return [fmtBalance(value), name];
                }}
                labelFormatter={(_label, payload) => {
                  const p = payload?.[0]?.payload as { date?: string; isToday?: boolean } | undefined;
                  if (!p) return '';
                  return p.isToday ? `${p.date} (today · live)` : p.date ?? '';
                }}
              />

              <ReferenceLine
                y={10_000}
                stroke="hsl(var(--border))"
                strokeDasharray="3 3"
                label={{ value: '$10k seed', position: 'insideTopRight', fontSize: 9, fill: 'hsl(var(--muted-foreground))' }}
              />

              {/* HWM band — starting to all-time HWM, muted teal */}
              <Area
                type="monotone"
                dataKey="hwmBand"
                stroke="none"
                fill="url(#hwmBandFill)"
                isAnimationActive={false}
                name="HWM band"
              />

              {/* Drawdown shade — balance to HWM, muted red. Only visible when below HWM. */}
              <Area
                type="monotone"
                dataKey="drawdownBand"
                stroke="none"
                fill="url(#ddShadeFill)"
                isAnimationActive={false}
                name="Drawdown"
              />

              {/* HWM line itself — thin teal dashed */}
              <Line
                type="monotone"
                dataKey="hwm"
                stroke={TEAL}
                strokeWidth={1}
                strokeDasharray="4 3"
                dot={false}
                isAnimationActive={false}
                name="HWM"
              />

              {/* Equity line — the headline */}
              <Line
                type="monotone"
                dataKey="balance"
                stroke={lineColor}
                strokeWidth={2}
                dot={(props: { cx?: number; cy?: number; payload?: { isToday?: boolean } }) => {
                  const { cx, cy, payload } = props;
                  if (cx == null || cy == null) return <g />;
                  if (payload?.isToday) {
                    return (
                      <g>
                        <circle cx={cx} cy={cy} r={5} fill={lineColor} fillOpacity={0.25} />
                        <circle cx={cx} cy={cy} r={2.5} fill={lineColor} />
                      </g>
                    );
                  }
                  return <g />;
                }}
                isAnimationActive={false}
                name="Equity"
              />
            </ComposedChart>
          </ResponsiveContainer></ChartSafe>
        </div>
      )}
    </Card>
  );
}
