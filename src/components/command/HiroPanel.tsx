/**
 * HiroPanel — Hedging Imbalance Running Order.
 *
 * Cumulative integral of dealer delta hedging flow through the session.
 * Positive = cumulative dealer BUYING pressure (bullish for underlying).
 * Negative = cumulative dealer SELLING pressure (bearish).
 *
 * Fed by ct_greek_flow_minute for SPY/QQQ/IWM.
 */
import { ChartSafe } from '@/components/ChartSafe';
import { useMemo, useState } from 'react';
import { useGreekFlow } from '@/hooks/useCoTraderData';
import { Card } from '@/components/ui/card';
import { Line, LineChart, ResponsiveContainer, XAxis, YAxis, Tooltip, ReferenceLine } from 'recharts';
import { SessionBadge } from '@/components/command/SessionBadge';
import { finite } from '@/lib/chartSanitize';

type IndexTicker = 'SPY' | 'QQQ' | 'IWM';
const TICKERS: IndexTicker[] = ['SPY', 'QQQ', 'IWM'];

function fmtDelta(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(0)}K`;
  return `${sign}${abs.toFixed(0)}`;
}

export function HiroPanel() {
  const [ticker, setTicker] = useState<IndexTicker>('SPY');
  const { data: rows } = useGreekFlow(ticker, 8);

  const series = useMemo(() => {
    if (!rows || rows.length === 0) return [] as Array<{ t: number; hiro: number; label: string }>;
    let cum = 0;
    const out: Array<{ t: number; hiro: number; label: string }> = [];
    for (const r of rows) {
      const flow = finite(r.total_delta_flow) ?? 0;
      cum += flow;
      const t = Date.parse(r.tick_timestamp);
      // Skip anything that would poison the axis — NaN timestamps or a cum
      // that went non-finite after a bad row.
      if (!Number.isFinite(t) || !Number.isFinite(cum)) continue;
      out.push({
        t,
        hiro: cum,
        label: new Date(t).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
      });
    }
    return out;
  }, [rows]);

  const latest = series[series.length - 1]?.hiro ?? 0;
  const bullish = latest > 0;

  return (
    <Card>
      <div className="px-3 py-2 border-b border-border bg-muted/30 flex items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-foreground">HIRO</span>
        <span className="text-[10px] text-muted-foreground">cumulative dealer hedging pressure</span>
        <SessionBadge />
        <div className="flex items-center gap-0.5 ml-auto">
          {TICKERS.map(t => (
            <button
              key={t}
              onClick={() => setTicker(t)}
              className={`px-1.5 py-0.5 rounded text-[10px] font-mono transition-colors ${
                ticker === t ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted/50'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {series.length < 2 ? (
        <div className="p-4 text-center text-xs text-muted-foreground">
          need at least 2 minutes of greek flow — loading…
        </div>
      ) : (
        <div className="p-2">
          <div className={`text-right text-xs font-semibold mb-1 pr-2 ${bullish ? 'text-green-400' : 'text-red-400'}`}>
            {fmtDelta(latest)} {bullish ? '↑' : '↓'}
          </div>
          <div className="h-[120px]">
            <ChartSafe><ResponsiveContainer width="100%" height="100%">
              <LineChart data={series} margin={{ top: 4, right: 8, left: 4, bottom: 4 }}>
                <defs>
                  <linearGradient id="hiroStroke" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="rgb(34,197,94)" />
                    <stop offset="50%" stopColor="rgb(34,197,94)" />
                    <stop offset="50%" stopColor="rgb(239,68,68)" />
                    <stop offset="100%" stopColor="rgb(239,68,68)" />
                  </linearGradient>
                </defs>
                <XAxis dataKey="label" tick={{ fontSize: 9, fill: 'hsl(var(--muted-foreground))' }} interval="preserveStartEnd" />
                <YAxis tickFormatter={(v) => fmtDelta(v)} tick={{ fontSize: 9, fill: 'hsl(var(--muted-foreground))' }} width={48} />
                <Tooltip
                  contentStyle={{ background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', fontSize: '10px', padding: '4px 6px' }}
                  formatter={(v: number) => [fmtDelta(v), 'HIRO']}
                />
                <ReferenceLine y={0} stroke="hsl(var(--border))" strokeWidth={1} />
                <Line
                  type="monotone"
                  dataKey="hiro"
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
