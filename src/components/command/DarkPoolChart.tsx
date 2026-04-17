/**
 * DarkPoolChart — 3x4 grid of two stacked mini-charts per watched ticker.
 *
 * Each cell:
 *   - Top (100px): cumulative DP notional ($) over session — line chart.
 *   - Bottom (80px): DP print sizes scatter, dot opacity ~ notional magnitude.
 *     Blocks >= $1M get a larger, fully-opaque dot with a label.
 *
 * Dark pool = institutional. Muted-slate/blue palette — deliberately not
 * call-green/put-red. Additive to DarkPoolTape (list view).
 *
 * Note: ct_dark_pool_prints has no `premium` column — dark pool prints use
 * `notional_value` (size * price, generated). We treat notional as the $ figure
 * everywhere the spec says "premium".
 */
import { useMemo } from 'react';
import { Card } from '@/components/ui/card';
import {
  Line,
  LineChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  XAxis,
  YAxis,
  Tooltip,
  ZAxis,
  Cell,
} from 'recharts';
import { useDarkPoolChart, type DarkPoolChartGroup, type DarkPoolPrintLite } from '@/hooks/useDarkPoolChart';

const DP_LINE = '#60A5FA';   // muted blue — institutional
const DP_DOT = '#94A3B8';    // slate-400
const DP_BLOCK = '#38BDF8';  // sky-400 — highlighted blocks
const BLOCK_THRESHOLD = 1_000_000; // >= $1M notional → labeled block

function fmtMoney(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

function fmtMoneyCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(abs / 1e3).toFixed(0)}K`;
  return `${abs.toFixed(0)}`;
}

function fmtSize(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return n.toFixed(0);
}

function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York',
  });
}

function epochMs(iso: string | null): number {
  return iso ? Date.parse(iso) : 0;
}

interface CellRow {
  t: number;
  label: string;
  cum: number;
  size: number;
  price: number;
  notional: number;
  isBlock: boolean;
}

function TickerCell({ group }: { group: DarkPoolChartGroup }) {
  const { ticker, prints } = group;

  const { rows, xDomain, cumMax, sizeMax } = useMemo(() => {
    const sorted = prints
      .filter(p => p.executed_at)
      .sort((a, b) => epochMs(a.executed_at) - epochMs(b.executed_at));

    let running = 0;
    const out: CellRow[] = sorted.map((p: DarkPoolPrintLite) => {
      running += p.notional_value || 0;
      return {
        t: epochMs(p.executed_at),
        label: fmtTime(p.executed_at),
        cum: running,
        size: p.size,
        price: p.price,
        notional: p.notional_value || 0,
        isBlock: (p.notional_value || 0) >= BLOCK_THRESHOLD,
      };
    });

    const xs = out.map(r => r.t);
    const domain: [number, number] | undefined = xs.length > 0
      ? [Math.min(...xs), Math.max(...xs)]
      : undefined;
    const cm = out.length > 0 ? out[out.length - 1].cum : 0;
    const sm = out.reduce((m, r) => Math.max(m, r.size), 0);

    return { rows: out, xDomain: domain, cumMax: cm, sizeMax: sm };
  }, [prints]);

  const hasData = rows.length > 0;
  const latestCum = hasData ? rows[rows.length - 1].cum : 0;
  const blockCount = hasData ? rows.filter(r => r.isBlock).length : 0;

  // Opacity scale: normalize notional against max in this cell. Floor at 0.25
  // so tiny prints are still visible.
  const maxNotional = useMemo(
    () => rows.reduce((m, r) => Math.max(m, r.notional), 1),
    [rows]
  );
  const scaledRows = useMemo(
    () => rows.map(r => ({
      ...r,
      opacity: Math.max(0.25, Math.min(1, r.notional / maxNotional)),
    })),
    [rows, maxNotional]
  );

  return (
    <div className="border border-border rounded-md bg-card/40 overflow-hidden">
      <div className="px-2 py-1 flex items-center justify-between border-b border-border bg-muted/20">
        <span className="text-[11px] font-mono font-semibold text-foreground">{ticker}</span>
        <div className="flex items-center gap-2">
          {blockCount > 0 && (
            <span className="text-[10px] font-mono text-sky-400" title={`${blockCount} block(s) ≥ $1M`}>
              {blockCount}◆
            </span>
          )}
          <span
            className="text-[10px] font-mono text-muted-foreground"
            title={`cumulative notional today · ${rows.length} prints`}
          >
            {fmtMoney(latestCum)}
          </span>
        </div>
      </div>

      {!hasData ? (
        <div className="h-[180px] flex items-center justify-center text-[10px] text-muted-foreground/60">
          — no prints —
        </div>
      ) : (
        <>
          {/* Top: cumulative notional line */}
          <div className="h-[100px] p-1 border-b border-border/50">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={scaledRows} margin={{ top: 4, right: 6, left: 2, bottom: 0 }}>
                <XAxis
                  dataKey="t"
                  type="number"
                  domain={xDomain ?? ['auto', 'auto']}
                  tick={{ fontSize: 8, fill: 'hsl(var(--muted-foreground))' }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v: number) => fmtTime(new Date(v).toISOString())}
                  tickCount={3}
                  hide={rows.length < 3}
                />
                <YAxis
                  tickFormatter={fmtMoneyCompact}
                  tick={{ fontSize: 8, fill: 'hsl(var(--muted-foreground))' }}
                  width={32}
                  tickLine={false}
                  axisLine={false}
                  tickCount={2}
                  domain={[0, cumMax || 'auto']}
                />
                <Tooltip
                  contentStyle={{
                    background: 'hsl(var(--popover))',
                    border: '1px solid hsl(var(--border))',
                    fontSize: '10px',
                    padding: '4px 6px',
                  }}
                  labelFormatter={(v: number) => fmtTime(new Date(v).toISOString())}
                  formatter={(val: number, name: string, item: { payload?: CellRow }) => {
                    const p = item?.payload;
                    if (!p) return [fmtMoney(val), 'Cum'];
                    return [
                      `${fmtMoney(p.cum)} · ${fmtSize(p.size)} @ $${p.price.toFixed(2)} · ${fmtMoney(p.notional)}`,
                      ticker,
                    ];
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="cum"
                  stroke={DP_LINE}
                  strokeWidth={1.5}
                  dot={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Bottom: scatter of print sizes */}
          <div className="h-[80px] p-1">
            <ResponsiveContainer width="100%" height="100%">
              <ScatterChart margin={{ top: 4, right: 6, left: 2, bottom: 2 }}>
                <XAxis
                  dataKey="t"
                  type="number"
                  domain={xDomain ?? ['auto', 'auto']}
                  tick={{ fontSize: 8, fill: 'hsl(var(--muted-foreground))' }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v: number) => fmtTime(new Date(v).toISOString())}
                  tickCount={3}
                  hide={rows.length < 3}
                />
                <YAxis
                  dataKey="size"
                  tickFormatter={fmtSize}
                  tick={{ fontSize: 8, fill: 'hsl(var(--muted-foreground))' }}
                  width={32}
                  tickLine={false}
                  axisLine={false}
                  tickCount={2}
                  domain={[0, sizeMax || 'auto']}
                />
                <ZAxis range={[20, 20]} />
                <Tooltip
                  cursor={{ strokeDasharray: '3 3', stroke: 'hsl(var(--border))' }}
                  contentStyle={{
                    background: 'hsl(var(--popover))',
                    border: '1px solid hsl(var(--border))',
                    fontSize: '10px',
                    padding: '4px 6px',
                  }}
                  formatter={(_v: number, _k: string, item: { payload?: CellRow }) => {
                    const p = item?.payload;
                    if (!p) return ['', ''];
                    return [
                      `${fmtTime(new Date(p.t).toISOString())} · ${fmtSize(p.size)} @ $${p.price.toFixed(2)} · ${fmtMoney(p.notional)}`,
                      ticker,
                    ];
                  }}
                  labelFormatter={() => ''}
                />
                <Scatter
                  data={scaledRows}
                  shape={(props: unknown) => {
                    const p = props as { cx: number; cy: number; payload: CellRow & { opacity: number } };
                    const isBlock = p.payload.isBlock;
                    const r = isBlock ? 4 : 2.2;
                    const fill = isBlock ? DP_BLOCK : DP_DOT;
                    const fillOpacity = isBlock ? 1 : p.payload.opacity;
                    return (
                      <g>
                        <circle
                          cx={p.cx}
                          cy={p.cy}
                          r={r}
                          fill={fill}
                          fillOpacity={fillOpacity}
                          stroke={isBlock ? DP_BLOCK : 'none'}
                          strokeWidth={isBlock ? 0.5 : 0}
                        />
                        {isBlock && (
                          <text
                            x={p.cx + 5}
                            y={p.cy - 3}
                            fontSize={8}
                            fill={DP_BLOCK}
                            fontFamily="monospace"
                          >
                            {fmtMoney(p.payload.notional)}
                          </text>
                        )}
                      </g>
                    );
                  }}
                >
                  {scaledRows.map((r, i) => (
                    <Cell key={i} fill={r.isBlock ? DP_BLOCK : DP_DOT} />
                  ))}
                </Scatter>
              </ScatterChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </div>
  );
}

export function DarkPoolChart() {
  const { data, isLoading, error } = useDarkPoolChart();
  const groups = data?.groups ?? [];

  const totalBlocks = useMemo(
    () => groups.reduce(
      (sum, g) => sum + g.prints.filter(p => (p.notional_value || 0) >= BLOCK_THRESHOLD).length,
      0,
    ),
    [groups],
  );
  const totalPrints = useMemo(
    () => groups.reduce((sum, g) => sum + g.prints.length, 0),
    [groups],
  );

  return (
    <Card>
      <div className="px-3 py-2 border-b border-border bg-muted/30 flex items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-foreground">
          Dark Pool Chart
        </span>
        <span className="text-[10px] text-muted-foreground">
          cumulative notional + print scatter · session to now
        </span>
        <div className="ml-auto flex items-center gap-3 text-[10px] text-muted-foreground">
          <span>{totalPrints} prints</span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-full" style={{ background: DP_LINE }} />
            cumulative
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-full" style={{ background: DP_BLOCK }} />
            ≥ $1M block ({totalBlocks})
          </span>
        </div>
      </div>
      <div className="p-2">
        {isLoading && groups.length === 0 ? (
          <div className="p-4 text-center text-xs text-muted-foreground">loading prints…</div>
        ) : error ? (
          <div className="p-4 text-center text-xs text-red-400">
            {error instanceof Error ? error.message : 'fetch failed'}
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-3 gap-2">
            {groups.map(g => (
              <TickerCell key={g.ticker} group={g} />
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}
