/**
 * NetPremiumCumulative — 3×4 grid of mini-charts, one per watched ticker.
 *
 * Each mini-chart shows TWO cumulative lines from the opening bell:
 *   - Call premium running total   (green, #00C853)
 *   - Put  premium running total   (red,   #FF1744)
 *
 * This is additive to NetPremiumLine (which shows call − put as a single line).
 * Seeing the two accumulations side-by-side reveals *asymmetric conviction*:
 * both sides hot = volatility demand; one flat while the other climbs =
 * directional conviction building.
 *
 * Compact by design: ~120px tall per mini, 4 x-ticks, 2 y-ticks, no legend.
 */
import { ChartSafe } from '@/components/ChartSafe';
import { useMemo } from 'react';
import { Card } from '@/components/ui/card';
import {
  Line,
  LineChart,
  ResponsiveContainer,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceLine,
} from 'recharts';
import { useNetPremiumCumulative, type NetPremCumTicker } from '@/hooks/useNetPremiumCumulative';
import { SessionBadge } from '@/components/command/SessionBadge';
import { finite } from '@/lib/chartSanitize';

const CALL_COLOR = '#00C853';
const PUT_COLOR = '#FF1744';

function fmtMoney(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

function fmtMoneyCompact(n: number): string {
  // For axis — drop the $ sign to save width
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(0)}K`;
  return `${sign}${abs.toFixed(0)}`;
}

/** Minutes since 09:30 ET, derived from the first tape_time in the session. */
function minsSinceStart(tISO: string, startISO: string): number {
  return Math.round((Date.parse(tISO) - Date.parse(startISO)) / 60_000);
}

interface MiniProps {
  data: NetPremCumTicker;
}

function MiniChart({ data }: MiniProps) {
  const { ticker, points } = data;

  const series = useMemo(() => {
    if (points.length === 0) return [] as Array<{
      t: string; label: string; mins: number; call: number; put: number;
    }>;
    const startISO = points[0].t;
    // Filter out rows where a NaN/Infinity would poison Recharts' axis math
    // (LN10 precision crash). Non-finite call/put values are the usual
    // culprit — drop the row rather than coerce to 0, which would create
    // visually misleading flat segments.
    return points
      .map(p => ({
        t: p.t,
        mins: minsSinceStart(p.t, startISO),
        call: finite(p.cum_call_prem),
        put: finite(p.cum_put_prem),
        label: new Date(p.t).toLocaleTimeString('en-US', {
          hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York',
        }),
      }))
      .filter((r): r is { t: string; mins: number; call: number; put: number; label: string } =>
        r.call !== null && r.put !== null && Number.isFinite(r.mins)
      );
  }, [points]);

  const latestCall = series[series.length - 1]?.call ?? 0;
  const latestPut  = series[series.length - 1]?.put  ?? 0;
  const net = latestCall - latestPut;
  const bullish = net > 0;

  return (
    <div className="border border-border rounded-md bg-card/40 overflow-hidden">
      <div className="px-2 py-1 flex items-center justify-between border-b border-border bg-muted/20">
        <span className="text-[11px] font-mono font-semibold text-foreground">{ticker}</span>
        <span
          className={`text-[10px] font-mono ${bullish ? 'text-[#00C853]' : 'text-[#FF1744]'}`}
          title={`net: call ${fmtMoney(latestCall)} − put ${fmtMoney(latestPut)}`}
        >
          {fmtMoney(net)} {bullish ? '↑' : '↓'}
        </span>
      </div>
      {series.length < 2 ? (
        <div className="h-[120px] flex items-center justify-center text-[10px] text-muted-foreground/60">
          {data.error ? 'fetch failed' : 'no ticks yet'}
        </div>
      ) : (
        <div className="h-[120px] p-1">
          <ChartSafe><ResponsiveContainer width="100%" height="100%">
            <LineChart data={series} margin={{ top: 4, right: 6, left: 2, bottom: 2 }}>
              <XAxis
                dataKey="label"
                tick={{ fontSize: 9, fill: 'hsl(var(--muted-foreground))' }}
                interval={Math.max(0, Math.floor(series.length / 4) - 1)}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                tickFormatter={fmtMoneyCompact}
                tick={{ fontSize: 9, fill: 'hsl(var(--muted-foreground))' }}
                width={36}
                tickLine={false}
                axisLine={false}
                tickCount={2}
              />
              <Tooltip
                contentStyle={{
                  background: 'hsl(var(--popover))',
                  border: '1px solid hsl(var(--border))',
                  fontSize: '10px',
                  padding: '4px 6px',
                }}
                labelFormatter={(label, payload) => {
                  const row = payload?.[0]?.payload as { mins?: number } | undefined;
                  return `${label}${row?.mins != null ? ` · +${row.mins}m` : ''}`;
                }}
                formatter={(v: number, k: string) => [fmtMoney(v), k === 'call' ? 'Cum Call' : 'Cum Put']}
              />
              <ReferenceLine y={0} stroke="hsl(var(--border))" strokeWidth={1} />
              <Line
                type="monotone"
                dataKey="call"
                stroke={CALL_COLOR}
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="put"
                stroke={PUT_COLOR}
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer></ChartSafe>
        </div>
      )}
    </div>
  );
}

export function NetPremiumCumulative() {
  const { data, isLoading, error } = useNetPremiumCumulative();
  const tickers = data?.tickers ?? [];

  return (
    <Card>
      <div className="px-3 py-2 border-b border-border bg-muted/30 flex items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-foreground">
          Call/Put Cumulative (from bell)
        </span>
        <span className="text-[10px] text-muted-foreground">
          per-ticker running net premium · UW net-prem-ticks
        </span>
        <SessionBadge />
        <div className="ml-auto flex items-center gap-2 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-full" style={{ background: CALL_COLOR }} />
            call
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-full" style={{ background: PUT_COLOR }} />
            put
          </span>
        </div>
      </div>
      <div className="p-2">
        {isLoading && tickers.length === 0 ? (
          <div className="p-4 text-center text-xs text-muted-foreground">loading ticks…</div>
        ) : error ? (
          <div className="p-4 text-center text-xs text-red-400">
            {error instanceof Error ? error.message : 'fetch failed'}
          </div>
        ) : tickers.length === 0 ? (
          <div className="p-4 text-center text-xs text-muted-foreground">no data</div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {tickers.map(t => (
              <MiniChart key={t.ticker} data={t} />
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}
