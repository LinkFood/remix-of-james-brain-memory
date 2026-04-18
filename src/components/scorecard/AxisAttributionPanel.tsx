/**
 * AxisAttributionPanel — which evidence axes actually predict?
 *
 * Reads useAxisAttribution (ct_alerts + ct_flags with non-empty evidence_axes,
 * joined to ct_grades, unnested per axis). Renders:
 *   1) Header stat: most reliable / least reliable axis (qualified by >=3 samples)
 *   2) 6-row table: letter · name · count · win rate · avg return · avg R · top co-cited
 *   3) Horizontal bar chart: width = win rate, color by win rate threshold
 *   4) 6x6 co-citation heatmap: "when A is cited, B is cited N% of the time"
 *   5) Flag-weak-axis CTA linking to /prompts (v2 would draft a note)
 *
 * Empty state: if no rows have evidence_axes yet, show v1.3 bootstrap copy.
 * Per-axis: if graded < 3, render "insufficient sample" instead of win rate.
 */
import { Card } from '@/components/ui/card';
import { Link } from 'react-router-dom';
import { Axis3d, ArrowRight, AlertCircle } from 'lucide-react';
import { ChartSafe } from '@/components/ChartSafe';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Cell,
  Tooltip,
  ResponsiveContainer,
  LabelList,
  ReferenceLine,
} from 'recharts';
import {
  useAxisAttribution,
  AXIS_KEYS,
  type AxisKey,
  type AxisStat,
} from '@/hooks/useAxisAttribution';

const GREEN = '#00C853';
const AMBER = '#F59E0B';
const RED = '#FF1744';
const MUTED = 'hsl(var(--muted-foreground))';

function winRateColor(wr: number | null): string {
  if (wr == null) return MUTED;
  if (wr >= 0.6) return GREEN;
  if (wr >= 0.4) return AMBER;
  return RED;
}

function fmtPct(n: number | null): string {
  return n == null ? '—' : `${(n * 100).toFixed(0)}%`;
}

function fmtReturn(n: number | null): string {
  if (n == null) return '—';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

/** Background color for a co-citation cell. Uses amber-to-teal gradient on %. */
function coCellColor(p: number | null, isDiagonal: boolean): string {
  if (p == null) return 'transparent';
  if (isDiagonal) return 'hsl(var(--muted) / 0.35)';
  // 0% -> muted, 100% -> teal-green. Clamp.
  const alpha = Math.max(0.05, Math.min(1, p));
  return `hsl(160 80% 45% / ${alpha.toFixed(3)})`;
}

function coCellTextColor(p: number | null): string {
  if (p == null) return 'hsl(var(--muted-foreground))';
  return p > 0.5 ? '#0a1a12' : 'hsl(var(--foreground))';
}

export function AxisAttributionPanel() {
  const { data, isLoading } = useAxisAttribution();

  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground mb-3">
        <Axis3d className="w-3 h-3" /> Axis Attribution
        <span className="normal-case tracking-normal text-muted-foreground/70">
          — which evidence axes (A..F) actually predict?
        </span>
        {data?.sample ? (
          <span className="ml-auto normal-case tracking-normal font-mono">
            n={data.sample} rows cite axes
          </span>
        ) : null}
      </div>

      {isLoading ? (
        <div className="text-xs text-muted-foreground py-4">loading…</div>
      ) : !data || data.empty ? (
        <EmptyState />
      ) : (
        <div className="space-y-4">
          <HeaderStat data={data} />
          <AxisTable axes={data.axes} />
          <AxisBarChart axes={data.axes} />
          <CoCitationMatrix data={data} />
          <FlagWeakAxisCTA data={data} />
        </div>
      )}

      <div className="mt-3 text-[10px] text-muted-foreground leading-relaxed">
        <span className="text-foreground/80 font-semibold">Read this:</span>{' '}
        Each graded ALERT/FLAG contributes to every axis it cites — an alert
        citing A+B+C counts as one sample in A, one in B, one in C. Win rate =
        right / (right + partial + wrong); ambiguous excluded. Axes with fewer
        than 3 graded samples show "insufficient sample". R-multiple requires
        stop_price on the claim — not yet captured at write time, so "—" until
        a future prompt rev starts emitting it.
      </div>
    </Card>
  );
}

// ----------------------------------------------------------------------------

function EmptyState() {
  return (
    <div className="flex items-start gap-2 p-3 rounded border border-amber-500/20 bg-amber-500/5">
      <AlertCircle className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
      <div className="text-xs text-foreground/90">
        <div className="font-semibold">No axis attribution data yet.</div>
        <div className="text-muted-foreground mt-1">
          Axis attribution requires v1.3+ alerts with{' '}
          <span className="font-mono">evidence_axes</span> populated. Pre-v1.3
          alerts cite nothing. Starts populating Monday once the new prompt ships.
        </div>
      </div>
    </div>
  );
}

function HeaderStat({
  data,
}: {
  data: ReturnType<typeof useAxisAttribution>['data'] & object;
}) {
  const mr = data.most_reliable;
  const lr = data.least_reliable;
  if (!mr && !lr) {
    return (
      <div className="text-xs text-muted-foreground">
        No axis has ≥3 graded samples yet — win rates below are provisional.
      </div>
    );
  }
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] font-mono">
      {mr && (
        <span>
          <span className="text-muted-foreground uppercase tracking-wider mr-1">
            Most reliable:
          </span>
          <span className="font-semibold text-foreground">
            {mr.axis} — {mr.name}
          </span>
          <span className="text-green-400 ml-1">
            ({fmtPct(mr.win_rate)} hit rate, n={mr.graded})
          </span>
        </span>
      )}
      {lr && (
        <span>
          <span className="text-muted-foreground uppercase tracking-wider mr-1">
            Least reliable:
          </span>
          <span className="font-semibold text-foreground">
            {lr.axis} — {lr.name}
          </span>
          <span className="text-red-400 ml-1">
            ({fmtPct(lr.win_rate)}, n={lr.graded})
          </span>
        </span>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------

function AxisTable({ axes }: { axes: AxisStat[] }) {
  return (
    <div className="rounded border border-border overflow-hidden">
      <div className="grid grid-cols-[32px_1fr_60px_80px_80px_80px_1fr] gap-2 px-3 py-2 bg-muted/30 text-[10px] uppercase tracking-wider text-muted-foreground">
        <span>axis</span>
        <span>name</span>
        <span className="text-right">count</span>
        <span className="text-right">win rate</span>
        <span className="text-right">avg ret</span>
        <span className="text-right">avg R</span>
        <span>top co-cited</span>
      </div>
      <div className="divide-y divide-border">
        {axes.map((a) => (
          <AxisRow key={a.axis} a={a} />
        ))}
      </div>
    </div>
  );
}

function AxisRow({ a }: { a: AxisStat }) {
  const color = winRateColor(a.win_rate);
  return (
    <div className="grid grid-cols-[32px_1fr_60px_80px_80px_80px_1fr] gap-2 px-3 py-2 text-xs items-center hover:bg-muted/20 transition-colors">
      <span className="font-mono font-bold text-foreground">{a.axis}</span>
      <span className="text-foreground">
        {a.name}
        <span className="text-muted-foreground text-[10px] ml-1">
          · {a.description}
        </span>
      </span>
      <span className="text-right font-mono text-muted-foreground">
        {a.count}
      </span>
      {a.insufficient ? (
        <span
          className="text-right text-[10px] text-muted-foreground italic"
          title={`${a.graded}/3 graded samples`}
        >
          insufficient
        </span>
      ) : (
        <span
          className="text-right font-mono font-semibold"
          style={{ color }}
          title={`${a.right}R · ${a.partial}P · ${a.wrong}W · ${a.ambiguous}? — n=${a.graded}`}
        >
          {fmtPct(a.win_rate)}
          <span className="text-[10px] text-muted-foreground ml-1">
            ({a.graded})
          </span>
        </span>
      )}
      <span
        className={`text-right font-mono ${
          a.avg_return_pct == null
            ? 'text-muted-foreground'
            : a.avg_return_pct >= 0
              ? 'text-green-400'
              : 'text-red-400'
        }`}
      >
        {fmtReturn(a.avg_return_pct)}
      </span>
      <span className="text-right font-mono text-muted-foreground">
        {a.avg_r == null ? '—' : a.avg_r.toFixed(2)}
      </span>
      <span className="text-muted-foreground text-[10px]">
        {a.top_co_cited == null ? (
          '—'
        ) : (
          <>
            <span className="font-mono font-semibold text-foreground">
              {a.top_co_cited}
            </span>{' '}
            ({fmtPct(a.top_co_cited_pct)})
          </>
        )}
      </span>
    </div>
  );
}

// ----------------------------------------------------------------------------

function AxisBarChart({ axes }: { axes: AxisStat[] }) {
  // Only plot axes with enough data for a meaningful bar; sparse axes still
  // render but muted.
  const chartData = axes.map((a) => ({
    axis: a.axis,
    label: `${a.axis} · ${a.name}`,
    win_rate_pct: a.win_rate == null ? 0 : a.win_rate * 100,
    graded: a.graded,
    insufficient: a.insufficient,
    fill: winRateColor(a.win_rate),
  }));

  const totalGraded = axes.reduce((s, a) => s + a.graded, 0);
  if (totalGraded === 0) return null;

  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
        Win rate by axis
      </div>
      <div style={{ height: 180 }}>
        <ChartSafe>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={chartData}
              layout="vertical"
              margin={{ top: 4, right: 48, left: 80, bottom: 4 }}
            >
              <XAxis
                type="number"
                domain={[0, 100]}
                tick={{ fontSize: 9, fill: MUTED }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v) => `${v}%`}
              />
              <YAxis
                type="category"
                dataKey="label"
                tick={{ fontSize: 10, fill: MUTED }}
                axisLine={false}
                tickLine={false}
                width={140}
              />
              <Tooltip
                contentStyle={{
                  background: 'hsl(var(--popover))',
                  border: '1px solid hsl(var(--border))',
                  fontSize: '10px',
                  padding: '6px 8px',
                }}
                formatter={(value: number, _name, item) => {
                  const p = item.payload as (typeof chartData)[number];
                  if (p.insufficient) return ['insufficient sample', 'win rate'];
                  return [`${value.toFixed(0)}% (n=${p.graded})`, 'win rate'];
                }}
                labelFormatter={(_label, payload) => {
                  const p = payload?.[0]?.payload as
                    | (typeof chartData)[number]
                    | undefined;
                  return p ? p.label : '';
                }}
              />
              <ReferenceLine
                x={50}
                stroke="hsl(var(--border))"
                strokeDasharray="2 2"
              />
              <Bar
                dataKey="win_rate_pct"
                isAnimationActive={false}
                radius={[0, 3, 3, 0]}
              >
                {chartData.map((d, i) => (
                  <Cell
                    key={i}
                    fill={d.fill}
                    fillOpacity={d.insufficient ? 0.3 : 1}
                  />
                ))}
                <LabelList
                  dataKey="win_rate_pct"
                  position="right"
                  formatter={(v: number, entry: unknown) => {
                    const p = (entry as { payload?: (typeof chartData)[number] })
                      ?.payload;
                    if (p?.insufficient) return '(sparse)';
                    return typeof v === 'number' && v > 0
                      ? `${v.toFixed(0)}%`
                      : '';
                  }}
                  style={{ fontSize: 9, fill: MUTED }}
                />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartSafe>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------

function CoCitationMatrix({
  data,
}: {
  data: ReturnType<typeof useAxisAttribution>['data'] & object;
}) {
  if (data.sample === 0) return null;
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
        Co-citation matrix · P(column | row)
      </div>
      <div className="text-[10px] text-muted-foreground mb-2">
        "When Claude cites <span className="font-mono text-foreground">row</span>
        , he cites <span className="font-mono text-foreground">column</span> N%
        of the time." Diagonal is definitionally 100%. Rows where axis count = 0
        render as "—".
      </div>
      <div className="inline-block rounded border border-border overflow-hidden">
        <table className="text-[10px] font-mono">
          <thead>
            <tr className="bg-muted/30">
              <th className="px-2 py-1 text-left text-muted-foreground uppercase tracking-wider">
                row \ col
              </th>
              {AXIS_KEYS.map((c) => (
                <th
                  key={c}
                  className="px-2 py-1 w-12 text-center text-foreground font-bold"
                  title={data.axis_counts[c].toString()}
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {AXIS_KEYS.map((row) => {
              const rowCount = data.axis_counts[row];
              return (
                <tr key={row} className="border-t border-border">
                  <td className="px-2 py-1 font-bold text-foreground bg-muted/20">
                    {row}
                    <span className="text-muted-foreground ml-1 font-normal">
                      (n={rowCount})
                    </span>
                  </td>
                  {AXIS_KEYS.map((col) => {
                    const p = data.co_citation_matrix[row][col];
                    const isDiag = row === col;
                    const count = data.co_counts[row][col];
                    return (
                      <td
                        key={col}
                        className="px-2 py-1 text-center"
                        style={{
                          background: coCellColor(p, isDiag),
                          color: coCellTextColor(p),
                        }}
                        title={
                          p == null
                            ? `${row} never cited`
                            : `${col} cited ${count}/${rowCount} times with ${row}`
                        }
                      >
                        {p == null ? '—' : `${(p * 100).toFixed(0)}%`}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------

function FlagWeakAxisCTA({
  data,
}: {
  data: ReturnType<typeof useAxisAttribution>['data'] & object;
}) {
  const lr = data.least_reliable;
  // Only surface the CTA when there's a qualified weak axis and it's notably
  // underperforming (<45% win rate). Anything tighter than that is within noise.
  if (!lr || lr.win_rate == null || lr.win_rate >= 0.45) return null;
  const axisLabel = `${lr.axis} (${lr.name})`;
  return (
    <Link
      to="/prompts"
      className="group flex items-center gap-3 px-3 py-2 rounded border border-red-500/20 bg-red-500/5 hover:bg-red-500/10 transition-colors"
      title="v2: open a pre-filled draft note. v1: just links to /prompts."
    >
      <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
      <div className="text-xs text-foreground/90">
        Axis <span className="font-mono font-semibold">{axisLabel}</span> is
        underperforming at{' '}
        <span className="font-mono text-red-400">{fmtPct(lr.win_rate)}</span>{' '}
        over n={lr.graded}.{' '}
        <span className="text-muted-foreground">
          Flag this in the next watcher prompt revision.
        </span>
      </div>
      <ArrowRight className="w-3.5 h-3.5 ml-auto text-muted-foreground group-hover:text-foreground transition-colors" />
    </Link>
  );
}

export default AxisAttributionPanel;
