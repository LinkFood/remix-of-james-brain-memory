/**
 * ClaudesBookTab — Claude's autonomous paper account.
 *
 * Top banner: current paper balance, YTD P&L %, cumulative return since
 * inception, open position count, today's P&L. Below: an equity curve
 * built from ct_book rows (trader='claude'). Below that: list of currently
 * open Claude positions with live unrealized P&L (written by
 * ct-book-manager every 15min; options rows stay null per migration
 * 20260419000010).
 */
import { useMemo } from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  LineChart, Line, YAxis, XAxis, ResponsiveContainer, Tooltip, CartesianGrid,
} from 'recharts';
import { ChartSafe } from '@/components/ChartSafe';
import { finiteDomain } from '@/lib/chartSanitize';
import { Bot, TrendingUp, TrendingDown, Wallet, Activity, Target } from 'lucide-react';
import { useClaudeBook, useClaudeTrades } from '@/hooks/useClaudeBook';
import type { CtBookRow, CtTradeRow } from '@/hooks/useCoTraderData';

const SEED_BALANCE = 100_000;

interface EquityPoint {
  idx: number;
  date: string;
  label: string;
  balance: number;
}

function computeEquityPoints(history: CtBookRow[]): EquityPoint[] {
  if (history.length === 0) {
    return [{ idx: 0, date: 'seed', label: 'start', balance: SEED_BALANCE }];
  }
  const points: EquityPoint[] = [];
  let idx = 0;
  // Seed origin so a single-session book still draws a line, not a dot.
  points.push({ idx: idx++, date: 'seed', label: 'start', balance: SEED_BALANCE });
  for (const b of history) {
    const live = b.starting_balance + (b.realized_pnl ?? 0) + (b.unrealized_pnl ?? 0);
    const balance = b.ending_balance ?? live;
    const [, mm, dd] = b.session_date.split('-');
    points.push({
      idx: idx++,
      date: b.session_date,
      label: `${mm}/${dd}`,
      balance,
    });
  }
  return points;
}

function fmtUsd(n: number, compact = false): string {
  if (compact && Math.abs(n) >= 1000) {
    return `${n < 0 ? '-' : ''}$${(Math.abs(n) / 1000).toFixed(1)}k`;
  }
  return `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

function fmtPct(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

export function ClaudesBookTab() {
  const { data: history = [], isLoading: bookLoading } = useClaudeBook();
  const { data: openTrades = [] } = useClaudeTrades('open');

  const points = useMemo(() => computeEquityPoints(history), [history]);

  const stats = useMemo(() => {
    if (history.length === 0) {
      return {
        current: SEED_BALANCE,
        currentDelta: 0,
        currentPct: 0,
        todayRealized: 0,
        todayUnrealized: 0,
        todayTotal: 0,
        ytdPct: 0,
      };
    }
    const last = history[history.length - 1];
    const current = last.ending_balance
      ?? last.starting_balance + (last.realized_pnl ?? 0) + (last.unrealized_pnl ?? 0);
    const currentDelta = current - SEED_BALANCE;
    const currentPct = (currentDelta / SEED_BALANCE) * 100;

    // YTD = this calendar year's first ct_book row vs current.
    const year = new Date().getFullYear();
    const ytdFirst = history.find(b => new Date(b.session_date).getFullYear() === year);
    const ytdStart = ytdFirst?.starting_balance ?? SEED_BALANCE;
    const ytdPct = ytdStart > 0 ? ((current - ytdStart) / ytdStart) * 100 : 0;

    const today = new Date().toISOString().slice(0, 10);
    const todayRow = history.find(b => b.session_date === today);
    const todayRealized = todayRow?.realized_pnl ?? 0;
    const todayUnrealized = todayRow?.unrealized_pnl ?? 0;
    const todayTotal = todayRealized + todayUnrealized;

    return { current, currentDelta, currentPct, todayRealized, todayUnrealized, todayTotal, ytdPct };
  }, [history]);

  return (
    <div className="space-y-3">
      {/* Header banner */}
      <Card className="p-4">
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
          <Bot className="w-3 h-3" /> Claude's paper book
          <span className="normal-case tracking-normal text-muted-foreground/70">
            — autonomous, $100k seed, no human approval
          </span>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <Stat
            icon={<Wallet className="w-3 h-3" />}
            label="Balance"
            value={fmtUsd(stats.current)}
            sub={fmtPct(stats.currentPct)}
            tone={stats.currentDelta >= 0 ? 'pos' : 'neg'}
          />
          <Stat
            icon={<TrendingUp className="w-3 h-3" />}
            label="YTD P&L"
            value={fmtPct(stats.ytdPct)}
            sub="this year"
            tone={stats.ytdPct >= 0 ? 'pos' : 'neg'}
          />
          <Stat
            icon={<Target className="w-3 h-3" />}
            label="Cum return"
            value={fmtPct(stats.currentPct)}
            sub={`from ${fmtUsd(SEED_BALANCE, true)}`}
            tone={stats.currentPct >= 0 ? 'pos' : 'neg'}
          />
          <Stat
            icon={<Activity className="w-3 h-3" />}
            label="Open positions"
            value={`${openTrades.length}`}
            sub={openTrades.length === 0 ? 'none' : `${openTrades.length} live`}
            tone="neutral"
          />
          <Stat
            icon={stats.todayTotal >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
            label="Today"
            value={fmtUsd(stats.todayTotal)}
            sub={`R ${fmtUsd(stats.todayRealized, true)} · U ${fmtUsd(stats.todayUnrealized, true)}`}
            tone={stats.todayTotal >= 0 ? 'pos' : 'neg'}
          />
        </div>
      </Card>

      {/* Equity curve */}
      <Card className="p-4">
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground mb-3">
          <TrendingUp className="w-3 h-3" /> Equity curve
          <span className="ml-auto font-mono">{history.length} session{history.length === 1 ? '' : 's'}</span>
        </div>
        {bookLoading ? (
          <div className="h-[200px] flex items-center text-xs text-muted-foreground">loading...</div>
        ) : history.length === 0 ? (
          <div className="h-[200px] flex items-center justify-center text-xs text-muted-foreground italic">
            No trades yet. Claude's book starts trading on his first heartbeat run.
          </div>
        ) : (
          <ChartSafe label="claude equity curve">
            <div className="h-[200px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={points} margin={{ top: 4, right: 8, bottom: 4, left: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                    axisLine={{ stroke: 'hsl(var(--border))' }}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                    axisLine={{ stroke: 'hsl(var(--border))' }}
                    tickLine={false}
                    domain={finiteDomain(
                      Math.min(...points.map(p => p.balance)),
                      Math.max(...points.map(p => p.balance)),
                      [SEED_BALANCE * 0.95, SEED_BALANCE * 1.05],
                      SEED_BALANCE * 0.01,
                    )}
                    tickFormatter={(v: number) => fmtUsd(v, true)}
                  />
                  <Tooltip
                    contentStyle={{
                      fontSize: 11,
                      background: 'hsl(var(--card))',
                      border: '1px solid hsl(var(--border))',
                    }}
                    formatter={(v: number) => [fmtUsd(v), 'balance']}
                  />
                  <Line
                    type="monotone"
                    dataKey="balance"
                    stroke="hsl(var(--primary))"
                    strokeWidth={1.75}
                    dot={false}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </ChartSafe>
        )}
      </Card>

      {/* Open positions list */}
      <Card className="p-4">
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground mb-3">
          <Activity className="w-3 h-3" /> Open Claude positions
          <span className="ml-auto font-mono">{openTrades.length}</span>
        </div>
        {openTrades.length === 0 ? (
          <div className="text-xs text-muted-foreground italic">
            No open positions. Claude closes on stop / target / expiry — watch the Trade Log tab for fills.
          </div>
        ) : (
          <div className="divide-y divide-border">
            {openTrades.map(t => <OpenPositionRow key={t.id} trade={t} />)}
          </div>
        )}
      </Card>
    </div>
  );
}

function Stat({
  icon, label, value, sub, tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
  tone: 'pos' | 'neg' | 'neutral';
}) {
  const color = tone === 'pos' ? 'text-green-400' : tone === 'neg' ? 'text-red-400' : 'text-foreground';
  return (
    <div className="bg-muted/20 rounded p-2">
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
        {icon} {label}
      </div>
      <div className={`text-lg font-bold ${color}`}>{value}</div>
      <div className="text-[10px] text-muted-foreground">{sub}</div>
    </div>
  );
}

function OpenPositionRow({ trade }: { trade: CtTradeRow }) {
  const pnlPct = trade.live_pnl_pct ?? null;
  const pnlUsd = trade.live_pnl_usd ?? null;
  const pnlColor = pnlPct == null
    ? 'text-muted-foreground'
    : pnlPct >= 0 ? 'text-green-400' : 'text-red-400';
  const dirIcon = trade.side === 'long'
    ? <TrendingUp className="w-3 h-3 text-green-400" />
    : <TrendingDown className="w-3 h-3 text-red-400" />;
  const stale = trade.live_pnl_updated_at
    ? (Date.now() - new Date(trade.live_pnl_updated_at).getTime()) > 20 * 60_000
    : false;
  return (
    <div className="py-2 flex items-center gap-2 text-xs">
      <span className="font-mono font-semibold text-foreground w-[48px]">{trade.instrument}</span>
      {dirIcon}
      <Badge variant="outline" className="text-[9px] px-1 py-0 h-4">
        {trade.contract_type ?? 'underlying'}
      </Badge>
      <span className="text-[10px] text-muted-foreground font-mono">size {trade.size_pct.toFixed(1)}%</span>
      <div className="ml-auto flex items-center gap-2 text-[10px] font-mono">
        <span className="text-muted-foreground">E {trade.entry_price.toFixed(2)}</span>
        {trade.stop_price != null && <span className="text-red-400/80">S {trade.stop_price.toFixed(2)}</span>}
        {trade.target_price != null && <span className="text-green-400/80">T {trade.target_price.toFixed(2)}</span>}
        {pnlPct != null ? (
          <span className={pnlColor}>
            {pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%
            {pnlUsd != null && <span className="text-muted-foreground"> ({pnlUsd >= 0 ? '+' : ''}${pnlUsd.toFixed(0)})</span>}
          </span>
        ) : (
          <span className="text-muted-foreground">— unresolved</span>
        )}
        {stale && <span className="text-amber-400/80">(stale)</span>}
      </div>
    </div>
  );
}
