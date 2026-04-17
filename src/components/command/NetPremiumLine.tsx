/**
 * NetPremiumLine — intraday running net call-put premium per ticker.
 * Cumulative line through the session, instant sentiment read at a glance.
 */
import { useMemo, useState } from 'react';
import { useFlowAlerts } from '@/hooks/useCoTraderData';
import { Card } from '@/components/ui/card';
import { Line, LineChart, ResponsiveContainer, XAxis, YAxis, Tooltip, ReferenceLine } from 'recharts';

function fmtMoney(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e6) return `${n < 0 ? '-' : ''}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${n < 0 ? '-' : ''}$${(abs / 1e3).toFixed(0)}K`;
  return `${n < 0 ? '-' : ''}$${abs.toFixed(0)}`;
}

export function NetPremiumLine() {
  const { data: alerts } = useFlowAlerts(200);
  const tickers = useMemo(() => {
    if (!alerts) return [] as string[];
    const counts = new Map<string, number>();
    for (const a of alerts) counts.set(a.ticker, (counts.get(a.ticker) ?? 0) + 1);
    return Array.from(counts.entries()).sort(([, a], [, b]) => b - a).map(([t]) => t).slice(0, 10);
  }, [alerts]);

  const [ticker, setTicker] = useState<string>('');
  const active = ticker || tickers[0] || '';

  const series = useMemo(() => {
    if (!alerts || !active) return [] as Array<{ t: number; cum: number; label: string }>;
    const sorted = alerts
      .filter(a => a.ticker === active && a.premium != null)
      .sort((a, b) => a.ingested_at.localeCompare(b.ingested_at));
    let cum = 0;
    return sorted.map(a => {
      const prem = a.premium ?? 0;
      const signed = (a.side ?? '').toLowerCase().startsWith('c') ? prem : -prem;
      cum += signed;
      const t = Date.parse(a.ingested_at);
      return {
        t,
        cum,
        label: new Date(t).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
      };
    });
  }, [alerts, active]);

  const latest = series[series.length - 1]?.cum ?? 0;
  const bullish = latest > 0;

  return (
    <Card>
      <div className="px-3 py-2 border-b border-border bg-muted/30 flex items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-foreground">Net Premium</span>
        <span className="text-[10px] text-muted-foreground">cumulative call − put</span>
        <div className="flex items-center gap-0.5 ml-auto">
          {tickers.slice(0, 5).map(t => (
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
          need at least 2 prints to draw — loading…
        </div>
      ) : (
        <div className="p-2">
          <div className={`text-right text-xs font-semibold mb-1 pr-2 ${bullish ? 'text-green-400' : 'text-red-400'}`}>
            {fmtMoney(latest)} {bullish ? '↑' : '↓'}
          </div>
          <div className="h-[120px]">
            <ResponsiveContainer width="100%" height="100%">
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
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </Card>
  );
}
