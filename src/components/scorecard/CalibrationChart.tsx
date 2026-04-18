/**
 * CalibrationChart — bar chart of hit-rate per bucket, with optional ideal-line overlay.
 *
 * Reusable for conviction buckets (1-5) and attention_score buckets (0-20..80-100).
 * Sparse buckets (< 3 samples) are rendered muted with "(sparse)" label — they
 * still show, but it's visually clear they're noise.
 *
 * Ideal line: if any bucket has an `ideal` value, we overlay a dashed line at
 * that target so deviation from calibrated reasoning pops.
 */
import { ChartSafe } from '@/components/ChartSafe';
import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  ResponsiveContainer,
  Tooltip,
  ReferenceLine,
  Cell,
  LabelList,
} from 'recharts';
import type { CalibrationBucket } from '@/hooks/useCalibration';
import { FreshnessChip } from '@/components/FreshnessChip';

const GREEN = '#00C853';
const RED = '#FF1744';
const AMBER = '#F59E0B';
const MUTED = 'hsl(var(--muted-foreground))';
const TEAL = '#00E6B4';

interface CalibrationChartProps {
  title: string;
  subtitle?: string;
  buckets: CalibrationBucket[];
  /** Show dashed ideal line overlay. Default true if any bucket has an ideal. */
  showIdealLine?: boolean;
  /** X-axis label for the bucket dimension, e.g. "conviction" or "attention score". */
  xLabel?: string;
  height?: number;
  /** Optional: anchor for the freshness chip in the header (e.g. latest graded_at). */
  updatedAt?: Date | string | number | null;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

/** Color the bar by deviation from ideal (if present) or by absolute hit rate. */
function barColor(b: CalibrationBucket): string {
  if (b.sparse) return MUTED;
  if (b.ideal != null) {
    const delta = b.hit_rate - b.ideal;
    if (Math.abs(delta) < 0.1) return GREEN;
    if (Math.abs(delta) < 0.2) return AMBER;
    return RED;
  }
  if (b.hit_rate >= 0.6) return GREEN;
  if (b.hit_rate >= 0.4) return AMBER;
  return RED;
}

export function CalibrationChart({
  title,
  subtitle,
  buckets,
  showIdealLine,
  xLabel,
  height = 220,
  updatedAt,
}: CalibrationChartProps) {
  const hasIdeal = buckets.some((b) => b.ideal != null);
  const drawIdeal = showIdealLine ?? hasIdeal;
  const populated = buckets.filter((b) => b.count > 0);
  const totalSamples = buckets.reduce((s, b) => s + b.count, 0);

  // Shape for recharts: hit_rate * 100 so the Y axis reads as percent.
  const chartData = buckets.map((b) => ({
    label: b.sparse && b.count > 0 ? `${b.label} (sparse)` : b.label,
    rawLabel: b.label,
    hit_rate_pct: b.count > 0 ? b.hit_rate * 100 : 0,
    ideal_pct: b.ideal != null ? b.ideal * 100 : null,
    count: b.count,
    right: b.right,
    partial: b.partial,
    wrong: b.wrong,
    ambiguous: b.ambiguous,
    sparse: b.sparse,
    fill: barColor(b),
  }));

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-foreground">
          {title}
        </h4>
        {subtitle && (
          <span className="text-[10px] text-muted-foreground">{subtitle}</span>
        )}
        <span className="ml-auto text-[10px] text-muted-foreground font-mono">
          n={totalSamples}
        </span>
        {updatedAt !== undefined && <FreshnessChip timestamp={updatedAt ?? null} />}
      </div>

      {populated.length === 0 ? (
        <div className="text-xs text-muted-foreground py-8 text-center">
          No graded data yet. Flags/alerts score at horizon close — calibration
          fills in as horizons complete.
        </div>
      ) : (
        <div style={{ height }}>
          <ChartSafe><ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              data={chartData}
              margin={{ top: 16, right: 16, left: 0, bottom: 4 }}
            >
              <XAxis
                dataKey="label"
                tick={{ fontSize: 10, fill: MUTED }}
                axisLine={false}
                tickLine={false}
                label={
                  xLabel
                    ? {
                        value: xLabel,
                        position: 'insideBottom',
                        offset: -2,
                        fontSize: 9,
                        fill: MUTED,
                      }
                    : undefined
                }
              />
              <YAxis
                domain={[0, 100]}
                tick={{ fontSize: 9, fill: MUTED }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v) => `${v}%`}
                width={36}
              />
              <Tooltip
                contentStyle={{
                  background: 'hsl(var(--popover))',
                  border: '1px solid hsl(var(--border))',
                  fontSize: '10px',
                  padding: '6px 8px',
                }}
                formatter={(value: number, name: string, item) => {
                  const p = item.payload as (typeof chartData)[number];
                  if (name === 'hit_rate_pct') {
                    return [
                      `${value.toFixed(0)}% (${p.right}R · ${p.partial}P · ${p.wrong}W · ${p.ambiguous}?)`,
                      'hit rate',
                    ];
                  }
                  if (name === 'ideal_pct') {
                    return [value != null ? `${value.toFixed(0)}%` : '—', 'ideal'];
                  }
                  return [String(value), name];
                }}
                labelFormatter={(label, payload) => {
                  const p = payload?.[0]?.payload as
                    | (typeof chartData)[number]
                    | undefined;
                  if (!p) return String(label);
                  return `${p.rawLabel} · n=${p.count}${p.sparse ? ' (sparse)' : ''}`;
                }}
              />

              <ReferenceLine
                y={50}
                stroke="hsl(var(--border))"
                strokeDasharray="2 2"
              />

              <Bar
                dataKey="hit_rate_pct"
                name="hit rate"
                isAnimationActive={false}
                radius={[3, 3, 0, 0]}
              >
                {chartData.map((d, i) => (
                  <Cell key={i} fill={d.fill} fillOpacity={d.sparse ? 0.35 : 1} />
                ))}
                <LabelList
                  dataKey="hit_rate_pct"
                  position="top"
                  formatter={(v: number) =>
                    typeof v === 'number' && v > 0 ? `${v.toFixed(0)}%` : ''
                  }
                  style={{ fontSize: 9, fill: MUTED }}
                />
              </Bar>

              {drawIdeal && (
                <Line
                  type="monotone"
                  dataKey="ideal_pct"
                  stroke={TEAL}
                  strokeWidth={1.5}
                  strokeDasharray="4 3"
                  dot={{ r: 2, fill: TEAL }}
                  isAnimationActive={false}
                  name="ideal"
                  connectNulls
                />
              )}
            </ComposedChart>
          </ResponsiveContainer></ChartSafe>
        </div>
      )}

      {/* Compact legend / bucket summary row */}
      <div className="grid grid-cols-5 gap-1 text-[9px] text-muted-foreground">
        {buckets.map((b) => (
          <div
            key={b.label}
            className={`rounded bg-muted/20 px-1.5 py-1 text-center ${b.sparse ? 'opacity-50' : ''}`}
          >
            <div className="font-mono uppercase tracking-wide">{b.label}</div>
            <div
              className="font-mono font-semibold"
              style={{ color: barColor(b) }}
            >
              {b.count > 0 ? pct(b.hit_rate) : '—'}
            </div>
            <div className="font-mono">n={b.count}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
