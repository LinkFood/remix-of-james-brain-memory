/**
 * CostDashboard — one page to answer "what is this system costing me?"
 *
 * Route: /cost. Read-only. Wraps every chart in <ChartSafe>. Graceful when
 * history is thin (first day / empty ct_grades).
 *
 * Pulls from useCostDashboard:
 *   - Claude usage (ct_claude_usage) last 30d → today / week / month / forecast
 *   - Per-source breakdown (distinct by source+model) sorted by month $ desc
 *   - 30-day stacked bar chart, $ per day, stacked by source
 *   - UW calls per day (separate chart — $ vs calls scale mismatch)
 *   - Closed-trades + graded-alerts denominators → cost-per-outcome stats
 *   - ct_config `cost.monthly_alert_threshold` → banner when forecast > threshold
 *   - Untracked row for ct-* functions that call Claude but don't log usage
 *
 * Source color palette (consistent across all chart stacks):
 *   see SOURCE_COLORS below. Palette chosen to have strong hue separation
 *   at 10-12 bands — anything beyond that falls back to a hashed hue.
 */

import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  DollarSign,
  Gauge,
  Info,
  LineChart as LineChartIcon,
  Sparkles,
  Table as TableIcon,
  Zap,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { ChartSafe } from '@/components/ChartSafe';
import {
  FORECAST_NOTE,
  UW_ADVANCED_DAILY,
  UW_ADVANCED_PRICE_USD,
  useCostDashboard,
  type BySourceRow,
  type CostDashboardData,
  type TimelineRow,
} from '@/hooks/useCostDashboard';

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

/**
 * Consistent color palette for per-source stacked bars. Order matters:
 * the top spenders (ct-watcher, ct-chat) land on the high-contrast colors
 * first. Untracked sources fall back to a hashed hue.
 */
const SOURCE_COLORS: Record<string, string> = {
  'ct-watcher':          '#00E6B4', // teal — the biggest spender, most recognizable
  'ct-chat':             '#60A5FA', // blue — chat is the user-facing one
  'ct-morning-brief':    '#F59E0B', // amber — morning = amber/gold
  'ct-midday-recap':     '#FBBF24', // lighter amber — midday
  'ct-eod-recap':        '#F97316', // orange — EOD
  'ct-replay':           '#A78BFA', // purple — replay/historical
  'ct-curiosity':        '#EC4899', // pink — curiosity
  'ct-news-ingester':    '#34D399', // green — news
  'ct-news-sentiment-backfill': '#6EE7B7', // lighter green
  'ct-lessons-curator':  '#FCD34D', // yellow — learning
  'ct-playbook-curator': '#F472B6', // rose — playbooks
  'ct-weekly-reflection':'#C084FC', // light purple
  'ct-book-manager':     '#38BDF8', // sky — book mgmt
  'ct-book-eod-close':   '#0EA5E9', // darker sky
  'ct-alert-post-mortem':'#FB7185', // rose-red — post-mortem
  'ct-trade-advisories': '#FACC15', // gold — advisories
  'ct-premarket-scan':   '#22D3EE', // cyan — premarket
};

const FALLBACK_PALETTE = ['#10B981', '#8B5CF6', '#EF4444', '#F472B6', '#64748B', '#D946EF'];

function hashHue(source: string): string {
  let h = 0;
  for (let i = 0; i < source.length; i++) h = (h * 31 + source.charCodeAt(i)) | 0;
  return FALLBACK_PALETTE[Math.abs(h) % FALLBACK_PALETTE.length];
}

function colorFor(source: string): string {
  return SOURCE_COLORS[source] ?? hashHue(source);
}

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

function fmtUsd(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  return `${n < 0 ? '-' : ''}$${abs.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

function fmtInt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return Math.round(n).toLocaleString();
}

function pct(n: number): string {
  return `${n.toFixed(1)}%`;
}

function shortModel(model: string): string {
  // claude-sonnet-4-20250514 → sonnet-4 · claude-haiku-4-5-20251001 → haiku-4.5
  if (!model) return '—';
  if (/haiku-4-5/.test(model)) return 'haiku-4.5';
  if (/haiku/.test(model)) return 'haiku';
  if (/sonnet-4/.test(model)) return 'sonnet-4';
  if (/sonnet/.test(model)) return 'sonnet';
  if (/opus/.test(model)) return 'opus';
  return model.length > 18 ? `${model.slice(0, 16)}…` : model;
}

function monthTrendArrow(forecast: number | null, lastMonth: number): {
  Icon: typeof ArrowUpRight;
  label: string;
  colorClass: string;
} {
  if (forecast == null || lastMonth <= 0) {
    return { Icon: ArrowRight, label: '—', colorClass: 'text-muted-foreground' };
  }
  const delta = (forecast - lastMonth) / lastMonth;
  if (delta > 0.1) {
    return {
      Icon: ArrowUpRight,
      label: `+${(delta * 100).toFixed(0)}% vs last month`,
      colorClass: 'text-red-400',
    };
  }
  if (delta < -0.1) {
    return {
      Icon: ArrowDownRight,
      label: `${(delta * 100).toFixed(0)}% vs last month`,
      colorClass: 'text-emerald-400',
    };
  }
  return {
    Icon: ArrowRight,
    label: `~flat vs last month (${lastMonth.toFixed(2)})`,
    colorClass: 'text-muted-foreground',
  };
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ThresholdBanner({ data }: { data: CostDashboardData }) {
  if (!data.forecastExceedsThreshold || data.totals.forecast_month == null) return null;
  return (
    <div className="rounded-md border border-red-500/40 bg-red-500/10 px-4 py-3 flex items-start gap-3">
      <AlertTriangle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
      <div className="flex-1">
        <div className="text-sm font-semibold text-red-300">
          Forecast exceeds monthly alert threshold
        </div>
        <div className="text-xs text-red-200/80 mt-1">
          On pace for <strong>{fmtUsd(data.totals.forecast_month)}</strong> this month —
          threshold is <strong>{fmtUsd(data.monthlyAlertThresholdUsd)}</strong>
          {' '}(<Link to="/ct-settings" className="underline">cost.monthly_alert_threshold</Link>).
        </div>
      </div>
    </div>
  );
}

function HeaderStats({ data }: { data: CostDashboardData }) {
  const trend = monthTrendArrow(data.totals.forecast_month, data.totals.last_month_total);
  const TrendIcon = trend.Icon;
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <Card className="p-4">
        <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Today</div>
        <div className="text-3xl font-bold tabular-nums mt-1">{fmtUsd(data.totals.claude_today)}</div>
        <div className="text-[11px] text-muted-foreground mt-1">Claude API across all ct-*</div>
      </Card>
      <Card className="p-4">
        <div className="text-[10px] text-muted-foreground uppercase tracking-wider">This week</div>
        <div className="text-3xl font-bold tabular-nums mt-1">{fmtUsd(data.totals.claude_week)}</div>
        <div className="text-[11px] text-muted-foreground mt-1">Mon → today</div>
      </Card>
      <Card className="p-4">
        <div className="text-[10px] text-muted-foreground uppercase tracking-wider">This month</div>
        <div className="text-3xl font-bold tabular-nums mt-1">{fmtUsd(data.totals.claude_month)}</div>
        <div className="text-[11px] text-muted-foreground mt-1">
          Last month: {fmtUsd(data.totals.last_month_total)}
        </div>
      </Card>
      <Card className="p-4">
        <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Forecast (month)</div>
        <div className="text-3xl font-bold tabular-nums mt-1">
          {data.totals.forecast_month == null ? '—' : fmtUsd(data.totals.forecast_month)}
        </div>
        <div className={`text-[11px] mt-1 inline-flex items-center gap-1 ${trend.colorClass}`}>
          <TrendIcon className="w-3 h-3" />
          <span>{trend.label}</span>
        </div>
      </Card>
    </div>
  );
}

function PerSourceTable({ rows, untracked }: { rows: BySourceRow[]; untracked: string[] }) {
  const monthTotal = rows.reduce((acc, r) => acc + r.cost_month, 0);
  const todayTotal = rows.reduce((acc, r) => acc + r.cost_today, 0);
  return (
    <Card className="overflow-hidden">
      <div className="px-4 py-3 border-b bg-muted/30 flex items-center gap-2">
        <TableIcon className="w-4 h-4 text-primary" />
        <span className="text-sm font-semibold">Per-function breakdown</span>
        <span className="text-[11px] text-muted-foreground ml-2">
          {rows.length} source·model row{rows.length === 1 ? '' : 's'} · sorted by month $
        </span>
      </div>
      <div className="p-0">
        {rows.length === 0 ? (
          <div className="px-4 py-8 text-xs text-muted-foreground text-center">
            No Claude calls in the last 30 days yet.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="h-8 text-[10px] uppercase tracking-wider">Function</TableHead>
                <TableHead className="h-8 text-[10px] uppercase tracking-wider">Model</TableHead>
                <TableHead className="h-8 text-[10px] uppercase tracking-wider text-right">Calls today</TableHead>
                <TableHead className="h-8 text-[10px] uppercase tracking-wider text-right">Tokens in</TableHead>
                <TableHead className="h-8 text-[10px] uppercase tracking-wider text-right">Tokens out</TableHead>
                <TableHead className="h-8 text-[10px] uppercase tracking-wider text-right">$ today</TableHead>
                <TableHead className="h-8 text-[10px] uppercase tracking-wider text-right">$ month</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.key}>
                  <TableCell className="py-1.5 text-[11px] font-mono">
                    <span className="inline-flex items-center gap-2">
                      <span
                        className="w-2 h-2 rounded-sm shrink-0"
                        style={{ background: colorFor(r.source) }}
                      />
                      {r.source}
                    </span>
                  </TableCell>
                  <TableCell className="py-1.5 text-[11px] text-muted-foreground">
                    {shortModel(r.model)}
                  </TableCell>
                  <TableCell className="py-1.5 text-[11px] text-right tabular-nums">{fmtInt(r.calls_today)}</TableCell>
                  <TableCell className="py-1.5 text-[11px] text-right tabular-nums text-muted-foreground">
                    {fmtInt(r.tokens_in_today)}
                  </TableCell>
                  <TableCell className="py-1.5 text-[11px] text-right tabular-nums text-muted-foreground">
                    {fmtInt(r.tokens_out_today)}
                  </TableCell>
                  <TableCell className="py-1.5 text-[11px] text-right tabular-nums">
                    {r.cost_today > 0 ? fmtUsd(r.cost_today, 4) : '—'}
                  </TableCell>
                  <TableCell className="py-1.5 text-[11px] text-right tabular-nums font-medium">
                    {fmtUsd(r.cost_month, 4)}
                  </TableCell>
                </TableRow>
              ))}
              {untracked.length > 0 && (
                <TableRow className="border-t-2 border-dashed border-border/60">
                  <TableCell className="py-1.5 text-[11px] font-mono text-amber-400/90">
                    <span className="inline-flex items-center gap-2">
                      <span className="w-2 h-2 rounded-sm shrink-0 bg-amber-500/70" />
                      untracked · {untracked.length}
                    </span>
                  </TableCell>
                  <TableCell className="py-1.5 text-[11px] text-muted-foreground italic" colSpan={4}>
                    {untracked.join(', ')} — call Claude but don't log to ct_claude_usage yet
                  </TableCell>
                  <TableCell className="py-1.5 text-[11px] text-right text-muted-foreground italic">est.</TableCell>
                  <TableCell className="py-1.5 text-[11px] text-right text-muted-foreground italic">est.</TableCell>
                </TableRow>
              )}
              <TableRow className="bg-muted/40 font-semibold">
                <TableCell className="py-1.5 text-[11px] font-mono">total</TableCell>
                <TableCell className="py-1.5 text-[11px] text-muted-foreground">all models</TableCell>
                <TableCell className="py-1.5 text-[11px] text-right tabular-nums">
                  {fmtInt(rows.reduce((a, r) => a + r.calls_today, 0))}
                </TableCell>
                <TableCell className="py-1.5 text-[11px] text-right tabular-nums">
                  {fmtInt(rows.reduce((a, r) => a + r.tokens_in_today, 0))}
                </TableCell>
                <TableCell className="py-1.5 text-[11px] text-right tabular-nums">
                  {fmtInt(rows.reduce((a, r) => a + r.tokens_out_today, 0))}
                </TableCell>
                <TableCell className="py-1.5 text-[11px] text-right tabular-nums">
                  {fmtUsd(todayTotal, 4)}
                </TableCell>
                <TableCell className="py-1.5 text-[11px] text-right tabular-nums">
                  {fmtUsd(monthTotal, 4)}
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        )}
      </div>
    </Card>
  );
}

function StackedCostChart({
  timeline,
  sources,
}: {
  timeline: TimelineRow[];
  sources: string[];
}) {
  // Recharts wants flat objects: { date, total, <source1>, <source2>, ... }
  const chartData = useMemo(
    () =>
      timeline.map((t) => ({
        date: t.date.slice(5),       // MM-DD
        total: Number(t.total.toFixed(4)),
        ...Object.fromEntries(
          sources.map((s) => [s, Number((t.bySource[s] ?? 0).toFixed(4))]),
        ),
      })),
    [timeline, sources],
  );

  const hasAny = timeline.some((t) => t.total > 0);

  return (
    <Card className="overflow-hidden">
      <div className="px-4 py-3 border-b bg-muted/30 flex items-center gap-2">
        <LineChartIcon className="w-4 h-4 text-primary" />
        <span className="text-sm font-semibold">Claude $ per day · 30d · stacked by source</span>
      </div>
      <div className="p-4">
        {!hasAny ? (
          <div className="h-[220px] flex items-center justify-center text-xs text-muted-foreground">
            No Claude cost in the last 30 days.
          </div>
        ) : (
          <div className="h-[220px]">
            <ChartSafe label="cost stacked">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="2 2" vertical={false} />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 10 }}
                    stroke="hsl(var(--muted-foreground))"
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fontSize: 10 }}
                    stroke="hsl(var(--muted-foreground))"
                    axisLine={false}
                    tickLine={false}
                    width={44}
                    tickFormatter={(v: number) => `$${v.toFixed(v >= 10 ? 0 : 2)}`}
                  />
                  <Tooltip
                    contentStyle={{ fontSize: 11, padding: '6px 10px', background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))' }}
                    labelStyle={{ fontSize: 10, color: 'hsl(var(--muted-foreground))' }}
                    formatter={(value: number, name: string) => [fmtUsd(value, 4), name]}
                  />
                  <Legend
                    wrapperStyle={{ fontSize: 10, paddingTop: 8 }}
                    iconSize={8}
                    iconType="square"
                  />
                  {sources.map((s) => (
                    <Bar
                      key={s}
                      dataKey={s}
                      stackId="cost"
                      fill={colorFor(s)}
                      isAnimationActive={false}
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </ChartSafe>
          </div>
        )}
      </div>
    </Card>
  );
}

function UwTimeline({ data }: { data: CostDashboardData }) {
  const chartData = data.timeline.map((t) => ({
    date: t.date.slice(5),
    calls: t.uw_calls,
    limit: data.uw.today_limit || null,
  }));
  const hasAny = chartData.some((r) => r.calls > 0);

  return (
    <Card className="overflow-hidden">
      <div className="px-4 py-3 border-b bg-muted/30 flex items-center gap-2">
        <Zap className="w-4 h-4 text-primary" />
        <span className="text-sm font-semibold">UW calls per day · 30d</span>
        <span className="text-[11px] text-muted-foreground ml-2">flat monthly pricing — watch the ceiling</span>
      </div>
      <div className="p-4 space-y-3">
        <div className="grid grid-cols-3 gap-3">
          <div>
            <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Today</div>
            <div className="text-2xl font-bold tabular-nums">{fmtInt(data.uw.today_count)}</div>
            <div className="text-[10px] text-muted-foreground">
              {data.uw.today_limit > 0 ? `of ${fmtInt(data.uw.today_limit)} · ${pct(data.uw.today_pct)}` : 'no limit observed'}
            </div>
          </div>
          <div>
            <div className="text-[10px] text-muted-foreground uppercase tracking-wider">30d avg</div>
            <div className="text-2xl font-bold tabular-nums">{fmtInt(data.uw.rolling_avg_30d)}</div>
            <div className="text-[10px] text-muted-foreground">calls/day, end-of-day max</div>
          </div>
          <div>
            <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Status</div>
            {data.uw.suggest_upgrade ? (
              <div className="text-amber-300 text-xs mt-1">
                <Badge variant="outline" className="border-amber-400/50 text-amber-300">
                  Consider Advanced
                </Badge>
                <div className="text-[10px] text-muted-foreground mt-1">
                  {UW_ADVANCED_DAILY.toLocaleString()}/day for ${UW_ADVANCED_PRICE_USD}/mo
                </div>
              </div>
            ) : (
              <div className="text-emerald-300 text-xs mt-1">
                <Badge variant="outline" className="border-emerald-400/40 text-emerald-300">
                  Within budget
                </Badge>
              </div>
            )}
          </div>
        </div>

        {!hasAny ? (
          <div className="h-[140px] flex items-center justify-center text-xs text-muted-foreground">
            No UW usage recorded in the last 30 days.
          </div>
        ) : (
          <div className="h-[140px]">
            <ChartSafe label="uw calls">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="2 2" vertical={false} />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 9 }}
                    stroke="hsl(var(--muted-foreground))"
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fontSize: 9 }}
                    stroke="hsl(var(--muted-foreground))"
                    axisLine={false}
                    tickLine={false}
                    width={40}
                    tickFormatter={(v: number) => v.toLocaleString()}
                  />
                  <Tooltip
                    contentStyle={{ fontSize: 11, padding: '4px 8px', background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))' }}
                    labelStyle={{ fontSize: 10 }}
                    formatter={(value: number) => [`${fmtInt(value)} calls`, 'UW']}
                  />
                  <Bar dataKey="calls" isAnimationActive={false}>
                    {chartData.map((row, i) => {
                      const ratio = data.uw.today_limit > 0 ? row.calls / data.uw.today_limit : 0;
                      const color = ratio >= 0.95 ? '#EF4444' : ratio >= 0.7 ? '#F59E0B' : '#60A5FA';
                      return <Cell key={i} fill={color} />;
                    })}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </ChartSafe>
          </div>
        )}
      </div>
    </Card>
  );
}

function CostPerOutcomeStats({ data }: { data: CostDashboardData }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
      <Card className="p-4">
        <div className="text-[10px] text-muted-foreground uppercase tracking-wider inline-flex items-center gap-1">
          <Gauge className="w-3 h-3" /> Cost per closed trade (MTD)
        </div>
        <div className="text-2xl font-bold tabular-nums mt-1">
          {data.costPerClosedTrade == null ? '—' : fmtUsd(data.costPerClosedTrade, 3)}
        </div>
        <div className="text-[11px] text-muted-foreground mt-1">
          {fmtUsd(data.totals.claude_month)} / {fmtInt(data.closedTradesThisMonth)} closed
        </div>
      </Card>
      <Card className="p-4">
        <div className="text-[10px] text-muted-foreground uppercase tracking-wider inline-flex items-center gap-1">
          <Sparkles className="w-3 h-3" /> Cost per graded alert (MTD)
        </div>
        <div className="text-2xl font-bold tabular-nums mt-1">
          {data.costPerGradedAlert == null ? '—' : fmtUsd(data.costPerGradedAlert, 4)}
        </div>
        <div className="text-[11px] text-muted-foreground mt-1">
          {fmtUsd(data.totals.claude_month)} / {fmtInt(data.gradedAlertsThisMonth)} ct_grades
        </div>
      </Card>
      <Card className="p-4">
        <div className="text-[10px] text-muted-foreground uppercase tracking-wider inline-flex items-center gap-1">
          <Info className="w-3 h-3" /> Legacy chat sanity
        </div>
        <div className="text-2xl font-bold tabular-nums mt-1">
          {fmtUsd(data.legacyChat.total_30d, 3)}
        </div>
        <div className="text-[11px] text-muted-foreground mt-1">
          ct_chat_tokens 30d ·{' '}
          <span className={data.legacyChat.drift_usd > 0.01 ? 'text-amber-400' : 'text-muted-foreground'}>
            Δ {fmtUsd(data.legacyChat.drift_usd, 3)} vs ct_claude_usage
          </span>
        </div>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function CostDashboard() {
  const { data, isLoading, error } = useCostDashboard();

  if (isLoading) {
    return (
      <div className="p-6 text-sm text-muted-foreground">Loading cost dashboard…</div>
    );
  }
  if (error || !data) {
    return (
      <div className="p-6">
        <div className="rounded-md border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          Failed to load cost dashboard: {error instanceof Error ? error.message : 'unknown error'}
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-7xl mx-auto">
      <header className="flex items-center gap-2">
        <DollarSign className="w-5 h-5 text-primary" />
        <h1 className="text-xl font-semibold">Cost</h1>
        <span className="text-xs text-muted-foreground ml-2">
          Co-Trader API spend · Claude + UW · last 30 days
        </span>
      </header>

      <ThresholdBanner data={data} />
      <HeaderStats data={data} />
      <CostPerOutcomeStats data={data} />
      <StackedCostChart timeline={data.timeline} sources={data.timelineSources} />
      <UwTimeline data={data} />
      <PerSourceTable rows={data.bySource} untracked={data.untrackedSources} />

      <footer className="text-[11px] text-muted-foreground px-1 pb-4">
        {FORECAST_NOTE}
        {' · '}
        Threshold: <Link to="/ct-settings" className="underline">cost.monthly_alert_threshold</Link> = {fmtUsd(data.monthlyAlertThresholdUsd)}
        {' · '}
        Data: ct_claude_usage (30d) · ct_uw_usage · ct_chat_tokens · ct_trades · ct_grades.
      </footer>
    </div>
  );
}
