/**
 * TickerTerminal — Bloomberg-style drill-down for ONE ticker.
 *
 * Route: /ticker/:symbol  (symbol is upper-cased on mount).
 *
 * Layout (12-col grid):
 *   Row 1 (span 12):     price sparkline (today's session via heartbeats)
 *   Row 2 col 1-6:       attention history chart (7d)
 *   Row 2 col 7-12:      option chain snapshot (LinkGexDeep — 2 UW calls total)
 *   Row 3 col 1-4:       recent flow alerts (last 30)
 *   Row 3 col 5-8:       dark pool prints (last 30)
 *   Row 3 col 9-12:      recent news (last 10)
 *   Row 4 col 1-6:       graded-alerts timeline (verdict + actual return)
 *   Row 4 col 7-12:      open positions on this instrument + live P&L
 *   Row 5 (span 12):     Claude's last 5 obs/flags/alerts — full glance bullets
 *
 * Accepts ANY valid symbol. If the watcher doesn't cover it, sections render
 * with empty placeholders — the page still works. No extra UW calls beyond
 * the two LinkGexDeep makes.
 */
import { ChartSafe } from '@/components/ChartSafe';
import { memo, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  Line,
  LineChart,
  Area,
  AreaChart,
  ResponsiveContainer,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceLine,
  Bar,
  BarChart,
} from 'recharts';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { LinkGexDeep } from '@/components/command/LinkGexDeep';
import {
  useTickerTerminal,
  type TickerHeartbeatPoint,
  type AttentionPoint,
  type GradedEventRow,
} from '@/hooks/useTickerTerminal';
import type {
  FlowAlert,
  DarkPoolPrint,
  NewsItem,
  CtTradeRow,
  CtEvent,
} from '@/hooks/useCoTraderData';

// ─── palette (matches the rest of the co-trader surface) ───────────────
const COLOR_CALL = '#00C853';
const COLOR_PUT = '#FF1744';
const COLOR_SPOT = '#00E6B4';
const COLOR_HOT = '#FF5252';

// ─── format helpers ────────────────────────────────────────────────────
function fmtPrice(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtPct(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(digits)}%`;
}
function fmtMoney(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}
function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}
function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

// ─── Row 1: Price sparkline ────────────────────────────────────────────

const PriceSparklineRow = memo(function PriceSparklineRow({
  points,
  sessionOpen,
}: {
  points: TickerHeartbeatPoint[];
  sessionOpen: number | null;
}) {
  const series = useMemo(
    () =>
      points
        .filter(p => p.price !== null)
        .map(p => ({
          t: Date.parse(p.created_at),
          price: p.price as number,
          label: fmtTime(p.created_at),
        })),
    [points],
  );
  if (series.length === 0) {
    return (
      <Card className="p-4 bg-black/60 border-white/10 h-[140px] flex items-center justify-center text-xs text-muted-foreground">
        no session heartbeats yet — session sparkline unavailable
      </Card>
    );
  }
  const last = series[series.length - 1].price;
  const positive = sessionOpen !== null ? last >= sessionOpen : true;
  const color = positive ? COLOR_CALL : COLOR_PUT;

  return (
    <Card className="p-3 bg-black/60 border-white/10">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Session Price · today
        </span>
        <span className="text-[10px] text-muted-foreground tabular-nums">
          {series.length} samples · last {fmtTime(points[points.length - 1].created_at)}
        </span>
      </div>
      <div className="h-[110px]">
        <ChartSafe><ResponsiveContainer width="100%" height="100%">
          <AreaChart data={series} margin={{ top: 4, right: 8, bottom: 0, left: 4 }}>
            <defs>
              <linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.35} />
                <stop offset="100%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis
              dataKey="t"
              type="number"
              domain={['dataMin', 'dataMax']}
              tickFormatter={v => new Date(v as number).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}
              tick={{ fontSize: 10, fill: '#94a3b8' }}
              stroke="#334155"
              minTickGap={40}
            />
            <YAxis
              domain={['auto', 'auto']}
              tick={{ fontSize: 10, fill: '#94a3b8' }}
              stroke="#334155"
              width={50}
              tickFormatter={v => (typeof v === 'number' ? v.toFixed(2) : '')}
            />
            {sessionOpen !== null && (
              <ReferenceLine
                y={sessionOpen}
                stroke="#64748b"
                strokeDasharray="3 3"
                strokeOpacity={0.6}
                label={{
                  value: `open ${sessionOpen.toFixed(2)}`,
                  position: 'insideTopLeft',
                  fill: '#94a3b8',
                  fontSize: 9,
                }}
              />
            )}
            <Tooltip
              contentStyle={{
                background: 'rgba(0,0,0,0.9)',
                border: '1px solid rgba(255,255,255,0.1)',
                fontSize: 11,
              }}
              labelFormatter={v => new Date(v as number).toLocaleTimeString()}
              formatter={(v: number) => [`$${v.toFixed(2)}`, 'price']}
            />
            <Area
              type="monotone"
              dataKey="price"
              stroke={color}
              strokeWidth={1.5}
              fill="url(#sparkFill)"
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer></ChartSafe>
      </div>
    </Card>
  );
});

// ─── Row 2a: Attention history chart ───────────────────────────────────

const AttentionHistoryChart = memo(function AttentionHistoryChart({
  points,
}: {
  points: AttentionPoint[];
}) {
  const series = useMemo(
    () =>
      points.map(p => ({
        t: Date.parse(p.t),
        score: p.score,
        events: p.events,
        label: fmtDate(p.t),
      })),
    [points],
  );
  return (
    <Card className="p-3 bg-black/60 border-white/10 h-full">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Attention · 7d
        </span>
        <span className="text-[10px] text-muted-foreground">
          max score per 2hr bucket · obs + flags + alerts
        </span>
      </div>
      {series.length === 0 ? (
        <div className="h-[260px] flex items-center justify-center text-xs text-muted-foreground">
          no attention events on this ticker in the last 7 days
        </div>
      ) : (
        <div className="h-[260px]">
          <ChartSafe><ResponsiveContainer width="100%" height="100%">
            <LineChart data={series} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <XAxis
                dataKey="t"
                type="number"
                domain={['dataMin', 'dataMax']}
                tickFormatter={v => new Date(v as number).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' })}
                tick={{ fontSize: 10, fill: '#94a3b8' }}
                stroke="#334155"
                minTickGap={40}
              />
              <YAxis
                domain={[0, 100]}
                tick={{ fontSize: 10, fill: '#94a3b8' }}
                stroke="#334155"
                width={30}
              />
              <Tooltip
                contentStyle={{
                  background: 'rgba(0,0,0,0.9)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  fontSize: 11,
                }}
                labelFormatter={v => new Date(v as number).toLocaleString()}
                formatter={(v: number, name) => [v, name === 'score' ? 'max attention' : 'events']}
              />
              <ReferenceLine y={60} stroke="#FF9800" strokeDasharray="2 4" strokeOpacity={0.5} />
              <ReferenceLine y={80} stroke={COLOR_HOT} strokeDasharray="2 4" strokeOpacity={0.5} />
              <Line
                type="monotone"
                dataKey="score"
                stroke={COLOR_SPOT}
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer></ChartSafe>
        </div>
      )}
    </Card>
  );
});

// ─── Row 3a: Recent flow alerts ────────────────────────────────────────

function flowSideColor(side: string | null, isAsk: boolean | null): string {
  if (side === 'call') return COLOR_CALL;
  if (side === 'put') return COLOR_PUT;
  return isAsk ? COLOR_CALL : '#94a3b8';
}

const FlowAlertsList = memo(function FlowAlertsList({ rows }: { rows: FlowAlert[] }) {
  return (
    <Card className="p-0 bg-black/60 border-white/10 h-full flex flex-col">
      <div className="px-3 py-2 border-b border-white/10 flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Flow alerts · last 30
        </span>
        <span className="text-[10px] text-muted-foreground tabular-nums">{rows.length}</span>
      </div>
      <div className="flex-1 overflow-auto max-h-[360px]">
        {rows.length === 0 ? (
          <div className="text-xs text-muted-foreground px-3 py-6 text-center">
            no flow alerts captured for this ticker
          </div>
        ) : (
          <div className="divide-y divide-white/5 text-[11px] tabular-nums">
            {rows.map(r => (
              <div key={r.id} className="px-3 py-1.5 flex items-center gap-2">
                <span className="text-muted-foreground w-10 text-[10px]">{fmtTime(r.executed_at ?? r.ingested_at)}</span>
                <span className="font-semibold" style={{ color: flowSideColor(r.side, r.is_ask) }}>
                  {r.side ?? '?'}
                </span>
                <span className="text-foreground/80 w-14">{r.strike ?? '—'}</span>
                <span className="text-muted-foreground/80 w-16">{r.expiry ?? '—'}</span>
                <span className="ml-auto text-foreground font-medium">{fmtMoney(r.premium)}</span>
                {r.size_gt_oi && (
                  <span className="text-[9px] uppercase tracking-wider px-1 rounded bg-amber-500/20 text-amber-300">
                    &gt;OI
                  </span>
                )}
                {r.is_otm && (
                  <span className="text-[9px] uppercase tracking-wider px-1 rounded bg-white/5 text-white/60">
                    OTM
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
});

// ─── Row 3b: Dark pool prints ──────────────────────────────────────────

const DarkPoolList = memo(function DarkPoolList({ rows }: { rows: DarkPoolPrint[] }) {
  return (
    <Card className="p-0 bg-black/60 border-white/10 h-full flex flex-col">
      <div className="px-3 py-2 border-b border-white/10 flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Dark pool prints · last 30
        </span>
        <span className="text-[10px] text-muted-foreground tabular-nums">{rows.length}</span>
      </div>
      <div className="flex-1 overflow-auto max-h-[360px]">
        {rows.length === 0 ? (
          <div className="text-xs text-muted-foreground px-3 py-6 text-center">
            no dark-pool prints captured for this ticker
          </div>
        ) : (
          <div className="divide-y divide-white/5 text-[11px] tabular-nums">
            {rows.map(r => (
              <div key={r.id} className="px-3 py-1.5 flex items-center gap-2">
                <span className="text-muted-foreground w-10 text-[10px]">
                  {fmtTime(r.executed_at ?? r.ingested_at)}
                </span>
                <span className="text-foreground/80 w-16">${fmtPrice(r.price)}</span>
                <span className="text-muted-foreground w-16">{r.size.toLocaleString()}</span>
                <span className="ml-auto text-foreground font-medium">
                  {fmtMoney(r.notional_value)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
});

// ─── Row 3c: News ──────────────────────────────────────────────────────

function newsImpactColor(impact: string): string {
  switch (impact?.toLowerCase()) {
    case 'bullish': return COLOR_CALL;
    case 'bearish': return COLOR_PUT;
    case 'neutral': return '#94a3b8';
    default:        return '#94a3b8';
  }
}

const NewsList = memo(function NewsList({ rows }: { rows: NewsItem[] }) {
  return (
    <Card className="p-0 bg-black/60 border-white/10 h-full flex flex-col">
      <div className="px-3 py-2 border-b border-white/10 flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          News · last 10
        </span>
        <span className="text-[10px] text-muted-foreground tabular-nums">{rows.length}</span>
      </div>
      <div className="flex-1 overflow-auto max-h-[360px]">
        {rows.length === 0 ? (
          <div className="text-xs text-muted-foreground px-3 py-6 text-center">
            no news analyses for this ticker
          </div>
        ) : (
          <div className="divide-y divide-white/5 text-[11px]">
            {rows.map(r => (
              <div key={r.id} className="px-3 py-2 space-y-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground tabular-nums shrink-0">
                    {fmtDate(r.created_at)}
                  </span>
                  <span className="font-semibold uppercase text-[10px] tracking-wider" style={{ color: newsImpactColor(r.impact) }}>
                    {r.impact}
                  </span>
                  <span className="text-[10px] text-muted-foreground tabular-nums ml-auto">
                    sig {r.significance}
                  </span>
                </div>
                <div className="text-foreground/90 leading-snug">
                  {r.news_url ? (
                    <a
                      href={r.news_url}
                      target="_blank"
                      rel="noreferrer"
                      className="hover:underline inline-flex items-baseline gap-1"
                    >
                      {r.news_headline}
                      <ExternalLink className="w-3 h-3 opacity-60 shrink-0" />
                    </a>
                  ) : (
                    r.news_headline
                  )}
                </div>
                {r.claude_take && (
                  <div className="text-muted-foreground italic leading-snug">
                    {r.claude_take}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
});

// ─── Row 4a: Graded alerts timeline ────────────────────────────────────

function verdictBg(v: GradedEventRow['verdict']): string {
  switch (v) {
    case 'right':     return 'bg-green-500/15 text-green-400 border-green-500/30';
    case 'wrong':     return 'bg-red-500/15 text-red-400 border-red-500/30';
    case 'partial':   return 'bg-amber-500/15 text-amber-400 border-amber-500/30';
    case 'ambiguous': return 'bg-slate-500/15 text-slate-300 border-slate-500/30';
  }
}

const GradedTimeline = memo(function GradedTimeline({ rows }: { rows: GradedEventRow[] }) {
  const chartData = useMemo(
    () =>
      rows
        .slice()
        .sort((a, b) => a.graded_at.localeCompare(b.graded_at))
        .map(r => ({
          t: Date.parse(r.graded_at),
          ret: r.actual_return_pct,
          verdict: r.verdict,
        })),
    [rows],
  );

  return (
    <Card className="p-0 bg-black/60 border-white/10 h-full flex flex-col">
      <div className="px-3 py-2 border-b border-white/10 flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Graded alerts · past verdicts
        </span>
        <span className="text-[10px] text-muted-foreground tabular-nums">{rows.length}</span>
      </div>
      {rows.length === 0 ? (
        <div className="text-xs text-muted-foreground px-3 py-10 text-center">
          no graded alerts for this ticker
        </div>
      ) : (
        <>
          <div className="h-[120px] px-2 pt-2">
            <ChartSafe><ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <XAxis
                  dataKey="t"
                  type="number"
                  domain={['dataMin', 'dataMax']}
                  tickFormatter={v => new Date(v as number).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' })}
                  tick={{ fontSize: 10, fill: '#94a3b8' }}
                  stroke="#334155"
                  minTickGap={30}
                />
                <YAxis
                  tick={{ fontSize: 10, fill: '#94a3b8' }}
                  stroke="#334155"
                  width={36}
                  tickFormatter={v => `${v}%`}
                />
                <ReferenceLine y={0} stroke="#64748b" />
                <Tooltip
                  contentStyle={{
                    background: 'rgba(0,0,0,0.9)',
                    border: '1px solid rgba(255,255,255,0.1)',
                    fontSize: 11,
                  }}
                  labelFormatter={v => new Date(v as number).toLocaleString()}
                  formatter={(v: number) => [`${v.toFixed(2)}%`, 'actual return']}
                />
                <Bar dataKey="ret" isAnimationActive={false}>
                  {chartData.map((d, i) => (
                    <rect
                      key={i}
                      fill={d.ret >= 0 ? COLOR_CALL : COLOR_PUT}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer></ChartSafe>
          </div>
          <div className="flex-1 overflow-auto max-h-[240px] border-t border-white/5">
            <div className="divide-y divide-white/5 text-[11px] tabular-nums">
              {rows.map(g => (
                <div key={g.grade_id} className="px-3 py-1.5 flex items-center gap-2">
                  <span className="text-muted-foreground w-14 text-[10px]">{fmtDate(g.graded_at)}</span>
                  <Badge variant="outline" className={`text-[10px] ${verdictBg(g.verdict)}`}>
                    {g.verdict}
                  </Badge>
                  <span className="text-muted-foreground text-[10px]">{g.subject_type}</span>
                  <span className="text-foreground/70 text-[10px]">{g.claimed_direction}</span>
                  <span
                    className="ml-auto font-semibold"
                    style={{ color: g.actual_return_pct >= 0 ? COLOR_CALL : COLOR_PUT }}
                  >
                    {fmtPct(g.actual_return_pct)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </Card>
  );
});

// ─── Row 4b: Open positions + live P&L ─────────────────────────────────

function tradeSideBadge(side: 'long' | 'short'): string {
  return side === 'long'
    ? 'bg-green-500/15 text-green-400 border-green-500/30'
    : 'bg-red-500/15 text-red-400 border-red-500/30';
}

const OpenPositionsCard = memo(function OpenPositionsCard({ rows }: { rows: CtTradeRow[] }) {
  const totalUnrealized = rows.reduce((sum, r) => sum + (r.live_pnl_usd ?? 0), 0);

  return (
    <Card className="p-0 bg-black/60 border-white/10 h-full flex flex-col">
      <div className="px-3 py-2 border-b border-white/10 flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Open positions · live
        </span>
        <span
          className="text-[11px] font-semibold tabular-nums"
          style={{ color: totalUnrealized >= 0 ? COLOR_CALL : COLOR_PUT }}
        >
          {fmtMoney(totalUnrealized)}
        </span>
      </div>
      <div className="flex-1 overflow-auto max-h-[360px]">
        {rows.length === 0 ? (
          <div className="text-xs text-muted-foreground px-3 py-8 text-center">
            no open positions on this instrument
          </div>
        ) : (
          <div className="divide-y divide-white/5 text-[11px] tabular-nums">
            {rows.map(t => {
              const livePct = t.live_pnl_pct ?? null;
              const liveUsd = t.live_pnl_usd ?? null;
              return (
                <div key={t.id} className="px-3 py-2 space-y-1">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className={`text-[10px] ${tradeSideBadge(t.side)}`}>
                      {t.side}
                    </Badge>
                    <span className="text-foreground/80">${fmtPrice(t.entry_price)}</span>
                    <span className="text-muted-foreground text-[10px]">
                      {t.size_pct}% · {fmtMoney(t.size_usd)}
                    </span>
                    {t.contract_type && t.contract_type !== 'underlying' && (
                      <span className="text-[9px] uppercase tracking-wider px-1 rounded bg-white/5 text-white/60">
                        {t.contract_type}
                      </span>
                    )}
                    <div className="ml-auto flex items-center gap-2">
                      {livePct !== null && (
                        <span
                          className="font-semibold"
                          style={{ color: livePct >= 0 ? COLOR_CALL : COLOR_PUT }}
                        >
                          {fmtPct(livePct)}
                        </span>
                      )}
                      {liveUsd !== null && (
                        <span
                          className="text-[10px]"
                          style={{ color: liveUsd >= 0 ? COLOR_CALL : COLOR_PUT }}
                        >
                          {fmtMoney(liveUsd)}
                        </span>
                      )}
                    </div>
                  </div>
                  {t.thesis && (
                    <div className="text-muted-foreground italic text-[10px] leading-snug">
                      {t.thesis}
                    </div>
                  )}
                  <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                    {t.stop_price !== null && <span>stop ${fmtPrice(t.stop_price)}</span>}
                    {t.target_price !== null && <span>target ${fmtPrice(t.target_price)}</span>}
                    {t.opened_at && <span>opened {fmtTime(t.opened_at)}</span>}
                    {t.live_pnl_updated_at && (
                      <span className="ml-auto">live @ {fmtTime(t.live_pnl_updated_at)}</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Card>
  );
});

// ─── Row 5: Recent Claude reads ────────────────────────────────────────

function kindBadge(k: CtEvent['_type']): string {
  switch (k) {
    case 'alert':       return 'bg-red-500/20 text-red-300 border-red-500/40';
    case 'flag':        return 'bg-amber-500/15 text-amber-300 border-amber-500/30';
    case 'observation': return 'bg-slate-500/15 text-slate-300 border-slate-500/30';
  }
}

const RecentReadsCard = memo(function RecentReadsCard({ events }: { events: CtEvent[] }) {
  return (
    <Card className="p-0 bg-black/60 border-white/10">
      <div className="px-3 py-2 border-b border-white/10 flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Claude on this ticker · last 5 reads
        </span>
      </div>
      {events.length === 0 ? (
        <div className="text-xs text-muted-foreground px-3 py-8 text-center">
          no recent observations, flags, or alerts for this ticker
        </div>
      ) : (
        <div className="divide-y divide-white/5">
          {events.map(e => (
            <div key={e.id} className="px-4 py-3 space-y-2">
              <div className="flex items-center gap-2 text-[10px]">
                <Badge variant="outline" className={`uppercase tracking-wider ${kindBadge(e._type)}`}>
                  {e._type}
                </Badge>
                {e.direction && (
                  <span className="text-foreground/70 uppercase tracking-wider">{e.direction}</span>
                )}
                {e.conviction !== null && (
                  <span className="text-muted-foreground">conv {e.conviction}/5</span>
                )}
                {e.horizon && (
                  <span className="text-muted-foreground">· {e.horizon}</span>
                )}
                <span className="text-muted-foreground tabular-nums ml-auto">
                  {fmtDate(e.created_at)} {fmtTime(e.created_at)}
                </span>
              </div>
              {e.glance && e.glance.length > 0 && (
                <ul className="space-y-0.5 text-[12px] text-foreground/90">
                  {e.glance.map((g, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="text-muted-foreground">·</span>
                      <span>{g}</span>
                    </li>
                  ))}
                </ul>
              )}
              {e.alert_trigger && (
                <div className="text-[11px] italic text-amber-300/90">
                  trigger: {e.alert_trigger}
                </div>
              )}
              {e.full_reasoning && (
                <div className="text-[11px] text-muted-foreground leading-snug">
                  {e.full_reasoning.length > 280
                    ? `${e.full_reasoning.slice(0, 280)}…`
                    : e.full_reasoning}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
});

// ─── Page ──────────────────────────────────────────────────────────────

export default function TickerTerminal() {
  const { symbol } = useParams<{ symbol: string }>();
  const ticker = (symbol ?? '').toUpperCase().trim();

  const { data, isLoading, isError, error } = useTickerTerminal(ticker);

  if (!ticker) {
    return (
      <div className="min-h-screen bg-background text-foreground p-6">
        <div className="text-sm text-muted-foreground">No ticker specified.</div>
      </div>
    );
  }

  const header = data?.header;
  const priceColor =
    header?.change !== null && header?.change !== undefined
      ? header.change >= 0
        ? COLOR_CALL
        : COLOR_PUT
      : '#94a3b8';
  const regimeBadge =
    header?.regime === 'positive'
      ? 'bg-green-500/15 text-green-400 border-green-500/30'
      : header?.regime === 'negative'
        ? 'bg-amber-500/15 text-amber-400 border-amber-500/30'
        : 'bg-slate-500/15 text-slate-300 border-slate-500/30';
  const regimeLabel =
    header?.regime === 'positive'
      ? '+Γ · mean-revert'
      : header?.regime === 'negative'
        ? '−Γ · momentum'
        : 'regime ·';

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-[1600px] mx-auto p-4 space-y-4">
        {/* ─── Header ─────────────────────────────────────────────── */}
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button asChild size="sm" variant="ghost" className="h-8 w-8 p-0">
              <Link to="/" aria-label="back to command station">
                <ArrowLeft className="w-4 h-4" />
              </Link>
            </Button>
            <div className="flex items-baseline gap-4">
              <h1 className="text-3xl font-bold tracking-tight">{ticker}</h1>
              <span
                className="text-2xl font-semibold tabular-nums"
                style={{ color: COLOR_SPOT }}
              >
                ${fmtPrice(header?.price)}
              </span>
              <span
                className="text-sm font-semibold tabular-nums"
                style={{ color: priceColor }}
              >
                {header?.change !== null && header?.change !== undefined
                  ? `${header.change >= 0 ? '+' : ''}${header.change.toFixed(2)}`
                  : '—'}
                {' '}
                ({fmtPct(header?.changePct)})
              </span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {!data?.isWatched && !isLoading && (
              <Badge variant="outline" className="text-[10px] bg-slate-500/10 text-slate-300 border-slate-500/30">
                not in watchlist · partial data
              </Badge>
            )}
            <Badge variant="outline" className={`text-[10px] ${regimeBadge}`}>
              {regimeLabel}
            </Badge>
            {header?.updatedAt && (
              <span className="text-[10px] text-muted-foreground tabular-nums">
                updated {fmtTime(header.updatedAt)}
              </span>
            )}
          </div>
        </header>

        {isError && (
          <Card className="p-3 bg-red-950/30 border-red-500/30 text-xs text-red-300">
            terminal fetch failed: {(error as Error | undefined)?.message ?? 'unknown'}
          </Card>
        )}

        {/* ─── Row 1: session price sparkline (span 12) ───────────── */}
        <PriceSparklineRow
          points={data?.sparkline ?? []}
          sessionOpen={header?.sessionOpen ?? null}
        />

        {/* ─── Row 2: attention history + option chain ───────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          <div className="lg:col-span-6">
            <AttentionHistoryChart points={data?.attentionHistory ?? []} />
          </div>
          <div className="lg:col-span-6">
            <LinkGexDeep ticker={ticker} enabled={true} />
          </div>
        </div>

        {/* ─── Row 3: flow · dark pool · news ────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          <div className="lg:col-span-4">
            <FlowAlertsList rows={data?.flowAlerts ?? []} />
          </div>
          <div className="lg:col-span-4">
            <DarkPoolList rows={data?.darkPoolPrints ?? []} />
          </div>
          <div className="lg:col-span-4">
            <NewsList rows={data?.news ?? []} />
          </div>
        </div>

        {/* ─── Row 4: graded timeline + open positions ───────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          <div className="lg:col-span-6">
            <GradedTimeline rows={data?.gradedAlerts ?? []} />
          </div>
          <div className="lg:col-span-6">
            <OpenPositionsCard rows={data?.openPositions ?? []} />
          </div>
        </div>

        {/* ─── Row 5: recent Claude reads (span 12) ──────────────── */}
        <RecentReadsCard events={data?.recentReads ?? []} />

        <footer className="pt-2 text-[10px] text-muted-foreground/60 text-center">
          30s refresh · LinkGex deep (2 UW calls) · other sections hit Postgres only
        </footer>
      </div>
    </div>
  );
}
