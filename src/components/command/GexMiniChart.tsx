/**
 * Mini GEX bar chart — SpotGamma-style split bars.
 *
 * ORANGE bars (positive, upward) = call gamma concentration per strike.
 * BLUE bars (negative, downward) = put gamma concentration per strike.
 * Dashed vertical line at current spot. Gamma flip line if in-range.
 *
 * This replaces the previous single "net" bar which was not how any
 * retail GEX dashboard (SpotGamma, MenthorQ, UW) renders the data.
 */
import { Bar, BarChart, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

interface Strike {
  strike: number;
  call_gex: number;
  put_gex: number;
  net: number;
}

interface Props {
  strikes: Strike[];
  price: number | null;
  flip: number | null;
}

function fmtCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return n.toFixed(0);
}

export function GexMiniChart({ strikes, price, flip }: Props) {
  if (!strikes || strikes.length === 0) {
    return <div className="h-[72px] flex items-center justify-center text-[10px] text-muted-foreground/50">no strike data</div>;
  }
  // Recharts stacked bars need positive/negative sections rendered as signed values
  const data = strikes.map(s => ({
    strike: s.strike,
    call_gex: s.call_gex,                         // positive — orange up
    put_gex: s.put_gex,                           // negative — blue down
    label: `$${s.strike}`,
  }));

  const priceLabel = price != null ? `$${price.toFixed(0)}` : null;
  const flipLabel = flip != null ? `$${flip.toFixed(0)}` : null;
  const priceStr = price != null ? String(price) : undefined;
  const flipStr = flip != null ? String(flip) : undefined;

  return (
    <div className="h-[72px] -mx-1">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} stackOffset="sign" margin={{ top: 4, right: 2, left: 2, bottom: 0 }}>
          <XAxis dataKey="strike" hide type="number" domain={['dataMin', 'dataMax']} />
          <YAxis hide />
          <Tooltip
            cursor={{ fill: 'transparent' }}
            contentStyle={{ background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', fontSize: '10px', padding: '4px 6px' }}
            labelStyle={{ color: 'hsl(var(--foreground))', fontSize: '10px' }}
            formatter={(v: number, k: string) => [fmtCompact(v), k === 'call_gex' ? 'Call Γ' : k === 'put_gex' ? 'Put Γ' : k]}
            labelFormatter={(l) => `Strike $${l}`}
          />
          <Bar dataKey="call_gex" stackId="gex" radius={[1, 1, 0, 0]} isAnimationActive={false}>
            {data.map((_, i) => <Cell key={`c-${i}`} fill="rgba(251, 146, 60, 0.85)" />)}
          </Bar>
          <Bar dataKey="put_gex" stackId="gex" radius={[0, 0, 1, 1]} isAnimationActive={false}>
            {data.map((_, i) => <Cell key={`p-${i}`} fill="rgba(59, 130, 246, 0.75)" />)}
          </Bar>
          <ReferenceLine y={0} stroke="hsl(var(--border))" strokeWidth={1} />
          {priceStr && (
            <ReferenceLine
              x={priceStr}
              stroke="hsl(var(--primary))"
              strokeWidth={1.5}
              strokeDasharray="2 2"
              label={{ value: priceLabel, position: 'top', fontSize: 9, fill: 'hsl(var(--primary))' }}
            />
          )}
          {flipStr && flip != null && price != null && Math.abs(flip - price) / price < 0.25 && (
            <ReferenceLine
              x={flipStr}
              stroke="hsl(var(--muted-foreground))"
              strokeWidth={1}
              strokeDasharray="1 3"
              label={{ value: `flip`, position: 'top', fontSize: 8, fill: 'hsl(var(--muted-foreground))' }}
            />
          )}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
