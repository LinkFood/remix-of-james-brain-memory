/**
 * GhostTradeTape — Claude's flagged calls as a paper-trading book.
 * Each FLAG (conviction >= 3) + each ALERT is treated as 1 unit; graded at
 * horizon close. Signed return respects direction. Running cumulative P&L
 * lights up as grades land.
 */
import { ChartSafe } from '@/components/ChartSafe';
import { useMemo } from 'react';
import { useGhostPnl, type GhostPnlRow } from '@/hooks/useCoTraderData';
import { finiteDomain, safeMin, safeMax } from '@/lib/chartSanitize';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { LineChart, TrendingUp, TrendingDown, Zap, Target } from 'lucide-react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceLine,
  CartesianGrid,
} from 'recharts';

function fmtPctSigned(n: number, digits = 2): string {
  if (!isFinite(n)) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`;
}

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

function fmtSharpe(n: number): string {
  if (!isFinite(n)) return '—';
  return n.toFixed(2);
}

export function GhostTradeTape({ days = 30 }: { days?: number }) {
  const { data, isLoading } = useGhostPnl(days);
  const rows = data?.rows ?? [];
  const series = data?.series ?? [];
  const agg = data?.aggregates;

  const cumulative = agg?.cumulative_pct ?? 0;
  const cumColor = cumulative >= 0 ? 'text-green-400' : 'text-red-400';
  const areaColor = cumulative >= 0 ? '#4ade80' : '#f87171';

  // Explicit YAxis domain — the cumulative P&L curve can run flat for long
  // stretches (no grades landing), collapsing the auto-domain and tripping
  // LN10. Values are percentages; nudge 1 when flat.
  const yDomain = useMemo<[number, number]>(() => {
    const all = series.map(p => p.cumulative_pct);
    return finiteDomain(safeMin(all), safeMax(all), [-1, 1], 1);
  }, [series]);

  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-center gap-2">
        <LineChart className="w-4 h-4 text-primary" />
        <h2 className="text-sm font-semibold uppercase tracking-wide text-foreground">
          Ghost Trade Tape
        </h2>
        <span className="text-[10px] text-muted-foreground">
          Claude's paper book · last {days}d · 1 unit per flag/alert
        </span>
      </div>

      {/* Aggregate tiles */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <div className="rounded-md border border-border bg-muted/20 px-3 py-2">
          <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
            <TrendingUp className="w-3 h-3" /> Cumulative
          </div>
          <div className={`text-xl font-bold ${cumColor}`}>{fmtPctSigned(cumulative)}</div>
          <div className="text-[10px] text-muted-foreground">paper P&L</div>
        </div>
        <div className="rounded-md border border-border bg-muted/20 px-3 py-2">
          <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
            <Zap className="w-3 h-3" /> Trades
          </div>
          <div className="text-xl font-bold text-foreground">{agg?.trades ?? 0}</div>
          <div className="text-[10px] text-muted-foreground">graded @ horizon</div>
        </div>
        <div className="rounded-md border border-border bg-muted/20 px-3 py-2">
          <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
            <Target className="w-3 h-3" /> Win Rate
          </div>
          <div className="text-xl font-bold text-foreground">
            {agg ? fmtPct(agg.win_rate) : '—'}
          </div>
          <div className="text-[10px] text-muted-foreground">
            {agg ? `${fmtPctSigned(agg.avg_win)} · ${fmtPctSigned(agg.avg_loss)}` : '—'}
          </div>
        </div>
        <div className="rounded-md border border-border bg-muted/20 px-3 py-2">
          <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
            <TrendingDown className="w-3 h-3" /> Sharpe Proxy
          </div>
          <div className="text-xl font-bold text-foreground">
            {agg ? fmtSharpe(agg.sharpe_proxy) : '—'}
          </div>
          <div className="text-[10px] text-muted-foreground">mean/σ · √n</div>
        </div>
      </div>

      {/* Chart */}
      {isLoading ? (
        <div className="h-48 flex items-center justify-center text-xs text-muted-foreground">
          loading ghost tape…
        </div>
      ) : series.length === 0 ? (
        <div className="h-48 flex items-center justify-center text-center text-xs text-muted-foreground px-4">
          No graded calls yet. Ghost Trade Tape lights up as flags reach horizon and get graded.
        </div>
      ) : (
        <div className="h-48 w-full">
          <ChartSafe><ResponsiveContainer width="100%" height="100%">
            <AreaChart data={series} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="ghostFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={areaColor} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={areaColor} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="2 4" stroke="hsl(var(--border))" vertical={false} />
              <XAxis
                dataKey="closed_at"
                tickFormatter={(v) =>
                  new Date(v).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                }
                stroke="hsl(var(--muted-foreground))"
                fontSize={10}
                minTickGap={32}
              />
              <YAxis
                domain={yDomain}
                allowDataOverflow={false}
                tickFormatter={(v) => `${v.toFixed(1)}%`}
                stroke="hsl(var(--muted-foreground))"
                fontSize={10}
                width={48}
              />
              <ReferenceLine y={0} stroke="hsl(var(--border))" />
              <Tooltip
                contentStyle={{
                  background: 'hsl(var(--popover))',
                  border: '1px solid hsl(var(--border))',
                  borderRadius: 6,
                  fontSize: 11,
                }}
                labelFormatter={(v) => new Date(v).toLocaleString()}
                formatter={(value: number, name: string) => {
                  if (name === 'cumulative_pct') return [fmtPctSigned(value), 'Cumulative'];
                  return [value, name];
                }}
              />
              <Area
                type="monotone"
                dataKey="cumulative_pct"
                stroke={areaColor}
                strokeWidth={2}
                fill="url(#ghostFill)"
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer></ChartSafe>
        </div>
      )}

      {/* Recent calls table */}
      {rows.length > 0 && (
        <div className="border border-border rounded-md overflow-hidden">
          <div className="px-3 py-1.5 bg-muted/30 text-[10px] uppercase tracking-wider text-muted-foreground">
            Recent Graded Calls
          </div>
          <div className="divide-y divide-border max-h-[40vh] overflow-y-auto">
            {[...rows].reverse().slice(0, 30).map((r) => (
              <GhostRow key={`${r.source_type}-${r.subject_id}`} row={r} />
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

function GhostRow({ row }: { row: GhostPnlRow }) {
  const verdictColor: Record<string, string> = {
    right: 'bg-green-500/15 text-green-400 border-green-500/30',
    partial: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
    wrong: 'bg-red-500/15 text-red-400 border-red-500/30',
    ambiguous: 'bg-muted/50 text-muted-foreground border-muted',
  };
  const dirColor: Record<string, string> = {
    bullish: 'text-green-400',
    bearish: 'text-red-400',
    volatility: 'text-amber-400',
    neutral: 'text-muted-foreground',
  };
  const retColor = (row.signed_return_pct ?? 0) >= 0 ? 'text-green-400' : 'text-red-400';

  return (
    <div className="px-3 py-2 flex items-center gap-2 text-xs hover:bg-muted/30 transition-colors">
      <span className="font-mono font-semibold text-foreground w-16">{row.instrument}</span>
      <span className={`font-medium w-20 ${dirColor[row.direction] ?? ''}`}>
        {row.direction}
      </span>
      <span className="text-[10px] text-muted-foreground w-14">
        c{row.conviction} · {row.horizon}
      </span>
      <span className="text-[10px] text-muted-foreground w-14 uppercase">{row.source_type}</span>
      <span className={`font-mono font-semibold ml-auto ${retColor}`}>
        {fmtPctSigned(row.signed_return_pct ?? 0)}
      </span>
      <Badge
        variant="outline"
        className={`text-[10px] px-1.5 py-0 ${verdictColor[row.verdict] ?? ''}`}
      >
        {row.verdict}
      </Badge>
      <span className="text-[10px] text-muted-foreground w-16 text-right">
        {new Date(row.closed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
      </span>
    </div>
  );
}

export default GhostTradeTape;
