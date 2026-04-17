/**
 * Mini GEX bar chart — shows net gamma per strike near ATM.
 * Green = positive net gamma, red = negative. Current price marked with a
 * vertical reference line. ~16 strikes wide, 60px tall.
 */
import { Bar, BarChart, Cell, ReferenceLine, ResponsiveContainer, XAxis, YAxis, Tooltip } from 'recharts';

interface Strike {
  strike: number;
  call_gex: number;
  put_gex: number;
  net: number;
}

interface Props {
  strikes: Strike[];
  price: number | null;
}

function fmtCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return n.toFixed(0);
}

export function GexMiniChart({ strikes, price }: Props) {
  if (!strikes || strikes.length === 0) {
    return <div className="h-[60px] flex items-center justify-center text-[10px] text-muted-foreground/50">no strike data</div>;
  }
  const priceStr = price != null ? price.toString() : null;

  return (
    <div className="h-[64px] -mx-1">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={strikes} margin={{ top: 2, right: 2, left: 2, bottom: 0 }}>
          <XAxis dataKey="strike" hide />
          <YAxis hide />
          <Tooltip
            cursor={{ fill: 'transparent' }}
            contentStyle={{ background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', fontSize: '10px', padding: '4px 6px' }}
            labelStyle={{ color: 'hsl(var(--foreground))', fontSize: '10px' }}
            formatter={(v: number, k: string) => [fmtCompact(v), k]}
            labelFormatter={(l) => `Strike $${l}`}
          />
          <Bar dataKey="net" radius={[1, 1, 0, 0]}>
            {strikes.map((entry, i) => (
              <Cell key={i} fill={entry.net >= 0 ? 'rgba(34,197,94,0.7)' : 'rgba(239,68,68,0.7)'} />
            ))}
          </Bar>
          {priceStr && (
            <ReferenceLine x={priceStr} stroke="hsl(var(--primary))" strokeWidth={1.5} strokeDasharray="2 2" />
          )}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
