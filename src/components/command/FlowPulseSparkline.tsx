/**
 * FlowPulseSparkline — tiny inline sparkline showing how a ticker's session-
 * cumulative net call-vs-put bias has evolved through today.
 *
 * Data source: useNetPremiumExpirySplit(ticker, undefined). Each point is one
 * minute's signed net premium for calls/puts (all expiries). We compute the
 * running session sum of (all_net_call - all_net_put) — same convention as
 * FlowPulseChart's cumulative cp mode — and plot the single net-bias line.
 *
 *   net > 0  → cumulative call buying dominated puts (session-bullish)
 *   net < 0  → cumulative put buying dominated calls (session-bearish)
 *   |net| < $500K → effectively flat — color goes gray
 *
 * Color is keyed on the LAST cumulative value. Width/height are fixed so the
 * sparkline slots into table cells unchanged. Multiple instances on the page
 * share a single query (React Query dedupes by ['net-premium-expiry-split',
 * <ticker>, 'today']), so 10 watchlist tickers = 10 fetches, not 10 × N.
 *
 * Pre-deploy / empty data: shows a faint placeholder block, never crashes.
 */

import { Area, AreaChart, ResponsiveContainer } from 'recharts';
import { useId, useMemo } from 'react';
import { useNetPremiumExpirySplit } from '@/hooks/useFlowPulse';

interface Props {
  /**
   * Ticker symbol — passed through to useNetPremiumExpirySplit. When omitted
   * (or 'MARKET'), the hook returns the watchlist aggregate. Keep the prop
   * name `ticker` so callers don't have to change with this migration.
   */
  ticker?: string;
  width?: number;
  height?: number;
}

const FLAT_THRESHOLD = 500_000; // dollars

export function FlowPulseSparkline({ ticker, width = 64, height = 20 }: Props) {
  const gradientId = useId();
  // Pass undefined for MARKET so the hook's MARKET path is hit.
  const symbol = ticker && ticker !== 'MARKET' ? ticker : undefined;
  const { points } = useNetPremiumExpirySplit(symbol, undefined);

  // Build the cumulative-bias series: running sum of (all_net_call - all_net_put)
  // across the session. Multiple ticks at the same timestamp (rare but possible
  // when the RPC aggregates) are summed before the cumulation step.
  const data = useMemo(() => {
    if (!points || points.length === 0) return [] as { y: number }[];
    const byTime = new Map<string, number>();
    for (const p of points) {
      const call = Number.isFinite(p.all_net_call) ? p.all_net_call : 0;
      const put = Number.isFinite(p.all_net_put) ? p.all_net_put : 0;
      const delta = call - put;
      byTime.set(p.tick_timestamp, (byTime.get(p.tick_timestamp) ?? 0) + delta);
    }
    const sorted = Array.from(byTime.entries()).sort(
      (a, b) => Date.parse(a[0]) - Date.parse(b[0]),
    );
    let cum = 0;
    const out: { y: number }[] = [];
    for (const [, d] of sorted) {
      cum += d;
      out.push({ y: cum });
    }
    return out;
  }, [points]);

  if (data.length < 2) {
    return (
      <div
        style={{ width, height }}
        className="inline-block align-middle bg-muted/10 rounded-sm"
        title="not enough data yet"
      />
    );
  }

  const last = data[data.length - 1].y;
  const direction: 'up' | 'down' | 'flat' =
    last > FLAT_THRESHOLD ? 'up' : last < -FLAT_THRESHOLD ? 'down' : 'flat';

  const stroke =
    direction === 'up' ? '#34d399' : direction === 'down' ? '#fb7185' : '#94a3b8';
  const fillStop =
    direction === 'up' ? '#10b981' : direction === 'down' ? '#f43f5e' : '#64748b';

  return (
    <div
      style={{ width, height }}
      className="inline-block align-middle"
      title={`${data.length} ticks · cumulative net ${formatShort(last)}`}
    >
      <ResponsiveContainer>
        <AreaChart data={data} margin={{ top: 1, right: 1, bottom: 1, left: 1 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={fillStop} stopOpacity={0.4} />
              <stop offset="100%" stopColor={fillStop} stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area
            type="monotone"
            dataKey="y"
            stroke={stroke}
            strokeWidth={1.4}
            fill={`url(#${gradientId})`}
            isAnimationActive={false}
            dot={false}
            activeDot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function formatShort(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : n > 0 ? '+' : '';
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}
