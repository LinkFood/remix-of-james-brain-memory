/**
 * EquityCurvePanel — Claude's running paper book balance vs time.
 * After 30 days the question is binary: does this beat SPY buy-hold?
 */
import { ChartSafe } from '@/components/ChartSafe';
import { useBookHistory } from '@/hooks/useCoTraderData';
import { useCurrentGeneration } from '@/hooks/useClaudeGeneration';
import { Card } from '@/components/ui/card';
import { TrendingUp } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, ResponsiveContainer, Tooltip, ReferenceLine } from 'recharts';

export function EquityCurvePanel() {
  const { data: history, isLoading } = useBookHistory(30);
  const { data: generation } = useCurrentGeneration();

  // Tenet 14 — use the active generation's starting balance as the baseline.
  // Hardcoded $10k made a +0.03% book look like +399%. Fallbacks: first
  // ct_book row's starting_balance, then $50k (the Gen 1 default).
  const genSeed = generation?.starting_balance_usd;
  const firstBookSeed = history && history.length > 0 ? history[0].starting_balance : undefined;
  const startingSeed = genSeed && genSeed > 0
    ? genSeed
    : firstBookSeed && firstBookSeed > 0
      ? firstBookSeed
      : 50000;

  const points = (history ?? []).map(b => ({
    date: b.session_date,
    balance: b.ending_balance ?? (b.starting_balance + b.realized_pnl + b.unrealized_pnl),
    hwm: b.high_water_mark ?? b.starting_balance,
  }));

  const latest = points[points.length - 1]?.balance ?? startingSeed;
  const totalPct = startingSeed > 0 ? ((latest - startingSeed) / startingSeed) * 100 : 0;
  const wins = (history ?? []).filter(b => b.goal_hit === true).length;
  const losses = (history ?? []).filter(b => b.goal_hit === false).length;

  return (
    <Card>
      <div className="px-4 py-3 border-b border-border bg-muted/20 flex items-center gap-2">
        <TrendingUp className="w-4 h-4 text-primary" />
        <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground">Equity Curve</h3>
        <span className="text-[10px] text-muted-foreground">30 sessions</span>
        <div className="ml-auto flex items-center gap-3 text-[10px] font-mono">
          <span className={totalPct >= 0 ? 'text-emerald-400' : 'text-red-400'}>
            {totalPct >= 0 ? '+' : ''}{totalPct.toFixed(2)}% total
          </span>
          <span className="text-muted-foreground">{wins}W / {losses}L</span>
        </div>
      </div>
      {isLoading ? (
        <div className="p-4 text-xs text-muted-foreground">loading…</div>
      ) : points.length === 0 ? (
        <div className="p-4 text-xs text-muted-foreground">
          No sessions closed yet. First real session closes today at 4pm ET.
        </div>
      ) : (
        <div className="p-3" style={{ height: 220 }}>
          <ChartSafe><ResponsiveContainer width="100%" height="100%">
            <LineChart data={points} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
              <XAxis dataKey="date" tick={{ fontSize: 9, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} />
              <YAxis domain={['auto', 'auto']} tick={{ fontSize: 9, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} tickFormatter={v => `$${(v/1000).toFixed(1)}k`} />
              <Tooltip
                contentStyle={{ background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', fontSize: '10px', padding: '4px 6px' }}
                formatter={(v: number) => `$${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}`}
              />
              <ReferenceLine y={startingSeed} stroke="hsl(var(--border))" strokeDasharray="2 2" />
              <Line type="monotone" dataKey="balance" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer></ChartSafe>
        </div>
      )}
    </Card>
  );
}
