/**
 * NetPremiumLine — intraday cumulative net call-put premium per ticker.
 *
 * Reads the true UW tick stream from ct_net_premium_ticks (populated every ~3min
 * by ct-flow-ingester). Cumulative delta = sum of (net_call_premium - net_put_premium)
 * across the session — the real intraday sentiment signal, not a derived guess
 * cumsummed from flow_alerts.
 */
import { ChartSafe } from '@/components/ChartSafe';
import { useMemo, useState } from 'react';
import { useNetPremiumTicks, useNetPremiumTickers } from '@/hooks/useCoTraderData';
import { Card } from '@/components/ui/card';
import { Line, LineChart, ResponsiveContainer, XAxis, YAxis, Tooltip, ReferenceLine } from 'recharts';
import { SessionBadge } from '@/components/command/SessionBadge';
import { finite } from '@/lib/chartSanitize';

function fmtMoney(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e6) return `${n < 0 ? '-' : ''}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${n < 0 ? '-' : ''}$${(abs / 1e3).toFixed(0)}K`;
  return `${n < 0 ? '-' : ''}$${abs.toFixed(0)}`;
}

export function NetPremiumLine() {
  const { data: tickers = [] } = useNetPremiumTickers();
  const [ticker, setTicker] = useState<string>('');
  const active = ticker || tickers[0] || '';
  const { data: ticks } = useNetPremiumTicks(active, 4);

  const series = useMemo(() => {
    if (!ticks || ticks.length === 0) return [] as Array<{ t: number; cum: number; label: string }>;
    let cum = 0;
    const out: Array<{ t: number; cum: number; label: string }> = [];
    for (const row of ticks) {
      const call = finite(Number(row.net_call_premium ?? 0)) ?? 0;
      const put = finite(Number(row.net_put_premium ?? 0)) ?? 0;
      // Each tick is a snapshot of UW-side net premium; we sum deltas across the
      // session so the line shows cumulative directional conviction. Skip rows
      // whose timestamp can't be parsed — a NaN x-value trips the LN10 crash.
      cum += (call - put);
      const t = Date.parse(row.tick_timestamp);
      if (!Number.isFinite(t) || !Number.isFinite(cum)) continue;
      out.push({
        t,
        cum,
        label: new Date(t).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
      });
    }
    return out;
  }, [ticks]);

  const latest = series[series.length - 1]?.cum ?? 0;
  const bullish = latest > 0;

  return (
    <Card>
      <div className="px-3 py-2 border-b border-border bg-muted/30 flex items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-foreground">Net Premium</span>
        <span className="text-[10px] text-muted-foreground">UW tick stream · call − put</span>
        <SessionBadge />
        <div className="flex items-center gap-0.5 ml-auto flex-wrap justify-end">
          {tickers.slice(0, 12).map(t => (
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

      {series.length < 2 ? (
        <div className="p-4 text-center text-xs text-muted-foreground">
          {active ? `waiting on ticks for ${active}…` : 'no net-premium ticks ingested yet'}
        </div>
      ) : (
        <div className="p-2">
          <div className={`text-right text-xs font-semibold mb-1 pr-2 ${bullish ? 'text-green-400' : 'text-red-400'}`}>
            {fmtMoney(latest)} {bullish ? '↑' : '↓'}
          </div>
          <div className="h-[120px]">
            <ChartSafe><ResponsiveContainer width="100%" height="100%">
              <LineChart data={series} margin={{ top: 4, right: 8, left: 4, bottom: 4 }}>
                <XAxis dataKey="label" tick={{ fontSize: 9, fill: 'hsl(var(--muted-foreground))' }} interval="preserveStartEnd" />
                <YAxis tickFormatter={(v) => fmtMoney(v).replace('$', '')} tick={{ fontSize: 9, fill: 'hsl(var(--muted-foreground))' }} width={40} />
                <Tooltip
                  contentStyle={{ background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', fontSize: '10px', padding: '4px 6px' }}
                  formatter={(v: number) => [fmtMoney(v), 'Net Prem']}
                />
                <ReferenceLine y={0} stroke="hsl(var(--border))" strokeWidth={1} />
                <Line
                  type="monotone"
                  dataKey="cum"
                  stroke={bullish ? 'rgb(34,197,94)' : 'rgb(239,68,68)'}
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer></ChartSafe>
          </div>
        </div>
      )}
    </Card>
  );
}
