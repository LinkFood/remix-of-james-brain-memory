/**
 * PnLByTheme — horizontal bar chart: where is Claude's book making (or
 * losing) money, grouped by thesis theme.
 *
 * Reads the ct_pnl_by_theme view (SQL side handles the aggregation).
 * One bar per theme, width proportional to |total P&L|, green if positive
 * red if negative, with count / win-rate / avg-per-trade shown next to it.
 * Sorted by |P&L| descending so the biggest P&L movers float to the top.
 */
import { ChartSafe } from '@/components/ChartSafe';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Layers } from 'lucide-react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  ResponsiveContainer,
  Tooltip,
  ReferenceLine,
  Cell,
} from 'recharts';

const GREEN = '#00C853';
const RED = '#FF1744';

export interface ThemePnlRow {
  thesis_theme: string;
  trade_count: number;
  total_pnl_usd: number | null;
  avg_pnl_pct: number | null;
  avg_pnl_usd: number | null;
  wins: number;
  losses: number;
  win_rate: number | null;
}

const THEME_LABELS: Record<string, string> = {
  convergence: 'Convergence',
  structural_tightness: 'Structural tightness',
  gap: 'Gap',
  news_driven: 'News-driven',
  regime_flip: 'Regime flip',
  thesis_invalidation: 'Invalidation',
  other: 'Other',
};

function themeLabel(t: string): string {
  return THEME_LABELS[t] ?? t;
}

function fmtUsd(n: number | null | undefined, signed = false): string {
  if (n == null) return '—';
  const v = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (!signed) return `$${v}`;
  return n >= 0 ? `+$${v}` : `-$${v}`;
}

function fmtPct(n: number | null | undefined, signed = true, digits = 1): string {
  if (n == null) return '—';
  const v = n.toFixed(digits);
  if (!signed) return `${v}%`;
  return n >= 0 ? `+${v}%` : `${v}%`;
}

export function usePnlByTheme(window: 'all' | '7d' = 'all') {
  return useQuery<ThemePnlRow[]>({
    queryKey: ['ct_pnl_by_theme', window],
    refetchInterval: 60_000,
    queryFn: async () => {
      const view = window === '7d' ? 'ct_pnl_by_theme_7d' : 'ct_pnl_by_theme';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase as any).from(view).select('*');
      if (error) throw error;
      return (data ?? []) as ThemePnlRow[];
    },
  });
}

export function bestWorstTheme(rows: ThemePnlRow[] | undefined): {
  best: ThemePnlRow | null;
  worst: ThemePnlRow | null;
} {
  const eligible = (rows ?? []).filter(r => r.trade_count > 0 && r.total_pnl_usd != null);
  if (eligible.length === 0) return { best: null, worst: null };
  const sorted = [...eligible].sort((a, b) => (b.total_pnl_usd ?? 0) - (a.total_pnl_usd ?? 0));
  return {
    best: sorted[0]?.total_pnl_usd != null && sorted[0].total_pnl_usd > 0 ? sorted[0] : null,
    worst: sorted[sorted.length - 1]?.total_pnl_usd != null && sorted[sorted.length - 1].total_pnl_usd < 0
      ? sorted[sorted.length - 1]
      : null,
  };
}

export function formatBestWorstLine(rows: ThemePnlRow[] | undefined): string | null {
  const { best, worst } = bestWorstTheme(rows);
  if (!best && !worst) return null;
  const parts: string[] = [];
  if (best) {
    const wr = best.win_rate != null ? ` , ${Math.round(best.win_rate * 100)}% WR` : '';
    parts.push(`Best theme: ${themeLabel(best.thesis_theme)} (${fmtUsd(best.total_pnl_usd, true)}${wr})`);
  }
  if (worst) {
    const wr = worst.win_rate != null ? ` , ${Math.round(worst.win_rate * 100)}% WR` : '';
    parts.push(`Worst: ${themeLabel(worst.thesis_theme)} (${fmtUsd(worst.total_pnl_usd, true)}${wr})`);
  }
  return parts.join(' · ');
}

export function PnLByTheme() {
  const { data: rows, isLoading } = usePnlByTheme('all');

  const chartData = (rows ?? [])
    .filter(r => r.trade_count > 0)
    .map(r => ({
      theme: themeLabel(r.thesis_theme),
      pnl: Number(r.total_pnl_usd ?? 0),
      count: r.trade_count,
      wins: r.wins,
      losses: r.losses,
      winRate: r.win_rate,
      avgPnlUsd: r.avg_pnl_usd,
      avgPnlPct: r.avg_pnl_pct,
    }))
    .sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl));

  const maxAbs = chartData.reduce((m, d) => Math.max(m, Math.abs(d.pnl)), 0);
  const domainPad = Math.max(maxAbs * 0.1, 25);
  const xDomain: [number, number] = [-(maxAbs + domainPad), maxAbs + domainPad];

  return (
    <Card className="divide-y divide-border">
      <div className="px-4 py-2.5 border-b border-border bg-muted/20 flex items-center gap-2">
        <Layers className="w-4 h-4 text-primary" />
        <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground">
          P&amp;L by thesis theme
        </h3>
        <span className="text-[10px] text-muted-foreground">
          closed trades · all-time
        </span>
      </div>

      {isLoading ? (
        <div className="p-4 text-xs text-muted-foreground">loading…</div>
      ) : chartData.length === 0 ? (
        <div className="p-4 text-xs text-muted-foreground">
          No closed trades yet. Themes populate as trades close.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-0 divide-y md:divide-y-0 md:divide-x divide-border">
          {/* Bar chart — 2/3 width on desktop */}
          <div className="md:col-span-2 p-3" style={{ height: Math.max(240, chartData.length * 42 + 40) }}>
            <ChartSafe><ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={chartData}
                layout="vertical"
                margin={{ top: 8, right: 24, left: 8, bottom: 8 }}
              >
                <XAxis
                  type="number"
                  domain={xDomain}
                  tick={{ fontSize: 9, fill: 'hsl(var(--muted-foreground))' }}
                  tickFormatter={v => (v >= 0 ? `+$${Math.round(v)}` : `-$${Math.round(Math.abs(v))}`)}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  type="category"
                  dataKey="theme"
                  tick={{ fontSize: 10, fill: 'hsl(var(--foreground))' }}
                  axisLine={false}
                  tickLine={false}
                  width={130}
                />
                <ReferenceLine x={0} stroke="hsl(var(--border))" />
                <Tooltip
                  cursor={{ fill: 'hsl(var(--muted) / 0.3)' }}
                  contentStyle={{
                    background: 'hsl(var(--popover))',
                    border: '1px solid hsl(var(--border))',
                    fontSize: '10px',
                    padding: '4px 8px',
                  }}
                  formatter={(value: number) => [fmtUsd(value, true), 'Total P&L']}
                />
                <Bar dataKey="pnl" radius={[2, 2, 2, 2]} isAnimationActive={false}>
                  {chartData.map((d, idx) => (
                    <Cell key={idx} fill={d.pnl >= 0 ? GREEN : RED} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer></ChartSafe>
          </div>

          {/* Adjacent stats — compact per-theme readout */}
          <div className="p-3 text-[11px] font-mono">
            <div className="grid grid-cols-4 gap-x-2 gap-y-1 text-[9px] uppercase tracking-wide text-muted-foreground pb-2 border-b border-border">
              <div>Theme</div>
              <div className="text-right">N</div>
              <div className="text-right">WR</div>
              <div className="text-right">Avg</div>
            </div>
            <div className="divide-y divide-border/60">
              {chartData.map(d => (
                <div key={d.theme} className="grid grid-cols-4 gap-x-2 py-1.5 items-center">
                  <div className="truncate">{d.theme}</div>
                  <div className="text-right">{d.count}</div>
                  <div className="text-right text-muted-foreground">
                    {d.winRate != null ? `${Math.round(d.winRate * 100)}%` : '—'}
                  </div>
                  <div
                    className="text-right"
                    style={{ color: (d.avgPnlUsd ?? 0) >= 0 ? GREEN : RED }}
                  >
                    {d.avgPnlUsd != null ? fmtUsd(d.avgPnlUsd, true) : '—'}
                    <div className="text-[9px] text-muted-foreground">
                      {d.avgPnlPct != null ? fmtPct(d.avgPnlPct) : ''}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
