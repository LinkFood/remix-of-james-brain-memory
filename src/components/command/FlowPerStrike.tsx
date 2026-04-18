/**
 * FlowPerStrike — horizontal bar ladder of premium per strike.
 * Calls bars extend right (orange), puts left (blue). Height = strike, bar
 * length = sum of premium. This is the core "where is the conviction going"
 * view that every pro dashboard ships.
 *
 * NOTE on overlap with NetPremiumLine:
 *   FlowPerStrike  = "right-now distribution" — where is premium sitting across
 *                    strikes at this moment (spatial view, X = $, Y = strike).
 *   NetPremiumLine = "intraday time-series" — how net premium has evolved over
 *                    the day (temporal view, X = time, Y = $).
 * Both exist because they answer different questions. Don't collapse them.
 */
import { ChartSafe } from '@/components/ChartSafe';
import { useMemo, useState } from 'react';
import { useFlowAlerts, type FlowAlert } from '@/hooks/useCoTraderData';
import { Card } from '@/components/ui/card';
import { Bar, BarChart, Cell, ResponsiveContainer, XAxis, YAxis, Tooltip, ReferenceLine } from 'recharts';
import { SessionBadge } from '@/components/command/SessionBadge';
import { finite } from '@/lib/chartSanitize';

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
  prints: number;
  notional: number;
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
      // Guard against non-finite strike/premium — a single NaN in a bar
      // chart's data array collapses the axis domain and trips LN10.
      const strike = finite(a.strike);
      const premium = finite(a.premium);
      if (strike === null || premium === null) continue;
      const b = map.get(strike) ?? { strike, call_prem: 0, put_prem: 0, net: 0, prints: 0, notional: 0 };
      if ((a.side ?? '').toLowerCase().startsWith('c')) b.call_prem += premium;
      else b.put_prem -= premium;  // puts displayed negative (leftward)
      b.net = b.call_prem + b.put_prem;
      b.prints += 1;
      b.notional += premium;
      map.set(strike, b);
    }
    return Array.from(map.values()).sort((x, y) => x.strike - y.strike);
  }, [alerts, active]);

  const totals = useMemo(() => {
    let call = 0, put = 0, notional = 0;
    for (const b of buckets) {
      call += b.call_prem;
      put += Math.abs(b.put_prem);
      notional += b.notional;
    }
    return { call, put, notional };
  }, [buckets]);

  const latestUnderlying = useMemo(() => {
    if (!alerts || !active) return null;
    const first = alerts.find(a => a.ticker === active && a.underlying_price != null);
    return finite(first?.underlying_price);
  }, [alerts, active]);

  return (
    <Card>
      <div className="px-3 py-2 border-b border-border bg-muted/30 flex items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-foreground">Flow per Strike</span>
        <SessionBadge />
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
        <div className="min-h-[80px] flex items-center justify-center text-xs text-muted-foreground">
          {alerts?.length ? `no strikes for ${active || 'selected ticker'}` : 'no flow yet — watching'}
        </div>
      ) : (
        <div className="p-2" style={{ minWidth: 320 }}>
          {/* Container min-height 360 prevents collapse in grid cells;
              scale linearly when >20 strikes so bars stay readable. */}
          <div style={{ height: Math.max(360, buckets.length * 18), minHeight: 360 }}>
            <ChartSafe><ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={buckets}
                layout="vertical"
                margin={{ top: 4, right: 8, left: 60, bottom: 4 }}
                stackOffset="sign"
                barCategoryGap={buckets.length < 6 ? '40%' : '10%'}
              >
                <XAxis type="number" hide />
                <YAxis
                  type="category"
                  dataKey="strike"
                  tickFormatter={(v) => `$${v}`}
                  width={60}
                  tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))', fontVariantNumeric: 'tabular-nums' }}
                  axisLine={false}
                  tickLine={false}
                  padding={buckets.length < 6 ? { top: 20, bottom: 20 } : { top: 0, bottom: 0 }}
                />
                <Tooltip
                  cursor={{ fill: 'transparent' }}
                  contentStyle={{ background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', fontSize: '11px', padding: '6px 8px', fontVariantNumeric: 'tabular-nums' }}
                  content={({ active: tActive, payload, label }) => {
                    if (!tActive || !payload || !payload.length) return null;
                    const b = payload[0].payload as Bucket;
                    const pct = totals.notional > 0 ? (b.notional / totals.notional) * 100 : 0;
                    return (
                      <div style={{ background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', fontSize: '11px', padding: '6px 8px', fontVariantNumeric: 'tabular-nums', lineHeight: 1.4 }}>
                        <div style={{ fontWeight: 600, marginBottom: 2 }}>Strike ${label}</div>
                        <div>calls {fmtMoney(b.call_prem)} · puts {fmtMoney(Math.abs(b.put_prem))}</div>
                        <div>total {fmtMoney(b.notional)} · {b.prints} {b.prints === 1 ? 'print' : 'prints'} · {pct.toFixed(1)}% of flow</div>
                      </div>
                    );
                  }}
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
            </ResponsiveContainer></ChartSafe>
          </div>
          <div className="flex items-center justify-between text-[10px] text-muted-foreground px-2 pt-1" style={{ fontVariantNumeric: 'tabular-nums' }}>
            <span>← puts {fmtMoney(totals.put)}</span>
            {latestUnderlying != null && <span>spot ${latestUnderlying.toFixed(2)}</span>}
            <span>calls {fmtMoney(totals.call)} →</span>
          </div>
        </div>
      )}
    </Card>
  );
}
