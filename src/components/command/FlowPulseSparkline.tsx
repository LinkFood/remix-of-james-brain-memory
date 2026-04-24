/**
 * FlowPulseSparkline — tiny inline area chart of how a ticker's 60-min
 * rolling premium_net has evolved through today.
 *
 * Each point is one ct_flow_pulse_ticks capture (every 5 min during RTH).
 * Color is derived from first-vs-last value: emerald (last > first), rose
 * (last < first), gray (flat). Reuses Recharts (already in the bundle from
 * PriceChart). Fixed dimensions so it slots into table cells cleanly.
 */

import { Area, AreaChart, ResponsiveContainer } from 'recharts';
import { useId } from 'react';
import type { FlowPulseSeriesPoint } from '@/hooks/useFlowPulse';

interface Props {
  points: FlowPulseSeriesPoint[] | undefined;
  width?: number;
  height?: number;
}

export function FlowPulseSparkline({ points, width = 64, height = 20 }: Props) {
  const gradientId = useId();

  if (!points || points.length < 2) {
    return (
      <div
        style={{ width, height }}
        className="inline-block align-middle bg-muted/10 rounded-sm"
        title="not enough data yet"
      />
    );
  }

  const first = points[0].premium_net;
  const last = points[points.length - 1].premium_net;
  const direction: 'up' | 'down' | 'flat' =
    last > first * 1.05 ? 'up' : last < first * 0.95 ? 'down' : 'flat';

  const stroke =
    direction === 'up' ? '#34d399' : direction === 'down' ? '#fb7185' : '#94a3b8';
  const fillStop =
    direction === 'up' ? '#10b981' : direction === 'down' ? '#f43f5e' : '#64748b';

  const data = points.map((p) => ({ y: Number(p.premium_net) || 0 }));

  return (
    <div
      style={{ width, height }}
      className="inline-block align-middle"
      title={`${points.length} ticks · first ${formatShort(first)} → last ${formatShort(last)}`}
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
