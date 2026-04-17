/**
 * FlowPerStrike — horizontal bar ladder of premium per strike.
 * Calls bars extend right (orange), puts left (blue). Height = strike, bar
 * length = sum of premium. This is the core "where is the conviction going"
 * view that every pro dashboard ships.
 */
import { useMemo, useState } from 'react';
import { useFlowAlerts, type FlowAlert } from '@/hooks/useCoTraderData';
import { Card } from '@/components/ui/card';
import { Bar, BarChart, Cell, ResponsiveContainer, XAxis, YAxis, Tooltip, ReferenceLine } from 'recharts';

function fmtMoney(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

interface Bucket {
  strike: number;
  call_prem: number;
  put_prem: number;
  net: number;
}

export function FlowPerStrike() {
  const { data: alerts } = useFlowAlerts(100);
  const tickers = useMemo(() => {
    if (!alerts) return [] as string[];
    const counts = new Map<string, number>();
    for (const a of alerts) counts.set(a.ticker, (counts.get(a.ticker) ?? 0) + 1);
    return Array.from(counts.entries()).sort(([, a], [, b]) => b - a).map(([t]) => t).slice(0, 10);
  }, [alerts]);

  const [ticker, setTicker] = useState<string>('');
  const active = ticker || tickers[0] || '';

  const buckets = useMemo(() => {
    if (!alerts || !active) return [] as Bucket[];
    const map = new Map<number, Bucket>();
    for (const a of alerts) {
      if (a.ticker !== active) continue;
      if (a.strike == null || a.premium == null) continue;
      const b = map.get(a.strike) ?? { strike: a.strike, call_prem: 0, put_prem: 0, net: 0 };
      if ((a.side ?? '').toLowerCase().startsWith('c')) b.call_prem += a.premium;
      else b.put_prem -= a.premium;  // puts displayed negative (leftward)
      b.net = b.call_prem + b.put_prem;
      map.set(a.strike, b);
    }
    return Array.from(map.values()).sort((x, y) => x.strike - y.strike);
  }, [alerts, active]);

  const latestUnderlying = useMemo(() => {
    if (!alerts || !active) return null;
    const first = alerts.find(a => a.ticker === active && a.underlying_price != null);
    return first?.underlying_price ?? null;
  }, [alerts, active]);

  return (
    <Card>
      <div className="px-3 py-2 border-b border-border bg-muted/30 flex items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-foreground">Flow per Strike</span>
        <div className="flex items-center gap-0.5 ml-auto">
          {tickers.slice(0, 6).map(t => (
            <button
              key={t}
              onClick={() => setTicker(t)}
              className={`px-1.5 py-0.5 rounded text-[10px] font-mono transition-colors ${
                active === t ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted/50'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {buckets.length === 0 ? (
        <div className="p-4 text-center text-xs text-muted-foreground">
          {alerts?.length ? `no strikes for ${active || 'selected ticker'}` : 'no flow yet'}
        </div>
      ) : (
        <div className="p-2">
          <div style={{ height: Math.min(400, Math.max(160, buckets.length * 18)) }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={buckets}
                layout="vertical"
                margin={{ top: 4, right: 8, left: 4, bottom: 4 }}
                stackOffset="sign"
              >
                <XAxis type="number" hide />
                <YAxis
                  type="category"
                  dataKey="strike"
                  tickFormatter={(v) => `$${v}`}
                  width={50}
                  tick={{ fontSize: 9, fill: 'hsl(var(--muted-foreground))' }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  cursor={{ fill: 'transparent' }}
                  contentStyle={{ background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', fontSize: '10px', padding: '4px 6px' }}
                  formatter={(v: number, k: string) => [fmtMoney(Math.abs(v)), k === 'call_prem' ? 'Calls' : 'Puts']}
                  labelFormatter={(l) => `Strike $${l}`}
                />
                <Bar dataKey="put_prem" stackId="flow" radius={[2, 0, 0, 2]} isAnimationActive={false}>
                  {buckets.map((_, i) => <Cell key={i} fill="rgba(59, 130, 246, 0.8)" />)}
                </Bar>
                <Bar dataKey="call_prem" stackId="flow" radius={[0, 2, 2, 0]} isAnimationActive={false}>
                  {buckets.map((_, i) => <Cell key={i} fill="rgba(251, 146, 60, 0.85)" />)}
                </Bar>
                <ReferenceLine x={0} stroke="hsl(var(--border))" strokeWidth={1} />
                {latestUnderlying != null && (
                  <ReferenceLine
                    y={buckets.reduce((best, b) => Math.abs(b.strike - latestUnderlying!) < Math.abs(best.strike - latestUnderlying!) ? b : best, buckets[0]).strike}
                    stroke="hsl(var(--primary))"
                    strokeWidth={1.5}
                    strokeDasharray="2 2"
                  />
                )}
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="flex items-center justify-between text-[10px] text-muted-foreground px-2 pt-1">
            <span>← puts (blue)</span>
            {latestUnderlying != null && <span>spot ${latestUnderlying.toFixed(2)}</span>}
            <span>calls (orange) →</span>
          </div>
        </div>
      )}
    </Card>
  );
}
