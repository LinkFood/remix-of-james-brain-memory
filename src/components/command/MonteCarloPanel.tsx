/**
 * MonteCarloPanel — 30-day forward simulator for Claude's paper book.
 *
 * Pulls the book's observed R-distribution + current equity (via
 * `useMonteCarloInputs`), runs `runMonteCarlo` entirely client-side, and
 * renders:
 *   - Header with path count + warnings
 *   - Big stats row: median · p5/p95 · expected max DD · P(ruin)
 *   - Fan chart: p5→p95 shaded band + median line + 30 sample trajectories
 *   - Sliders: days · paths · risk/trade · trades/day · seed toggle
 *   - Assumptions footnote
 *
 * All client-side. No edge function, no DB write. Changes re-run instantly
 * because `runMonteCarlo` is cheap (10k × 30 × 3 ≈ 900k ops, <1s).
 *
 * Fan-chart rendering: naively overlaying 100 lines is sluggish on weaker
 * CPUs — Recharts allocates DOM paths per series. Instead we render the
 * percentile band as two ComposedChart Areas (stacked to form the band),
 * the median as a Line, and a deliberately small sample (30 trajectories)
 * as thin low-opacity Lines so the "fan" visual survives without 100 paths.
 * The summary stats already use all 10k paths — the sample is pure eye candy.
 */

import { useMemo, useState } from 'react';
import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  ResponsiveContainer,
  Tooltip as RTooltip,
  ReferenceLine,
} from 'recharts';
import { Card } from '@/components/ui/card';
import { Slider } from '@/components/ui/slider';
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from '@/components/ui/tooltip';
import { Dice5, Info, AlertTriangle } from 'lucide-react';
import { ChartSafe } from '@/components/ChartSafe';
import { useMonteCarloInputs } from '@/hooks/useMonteCarloInputs';
import { runMonteCarlo, MAX_PATHS } from '@/lib/monteCarlo';
import { FreshnessChip } from '@/components/FreshnessChip';
import { useQueryFreshness } from '@/hooks/useFreshness';

const DAYS_STEPS = [7, 30, 60, 90] as const;
const PATHS_STEPS = [1000, 5000, 10000] as const;
const RISK_STEPS = [0.005, 0.01, 0.02] as const;           // 0.5% · 1% · 2%
const TRADES_STEPS = [2, 3, 5] as const;
const FAN_SAMPLE = 30;                                     // sample trajectories drawn on top of the band

function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return `$${Math.round(n).toLocaleString('en-US')}`;
}
function fmtPct(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(digits)}%`;
}
function fmtPctScalar(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return '—';
  return `${n.toFixed(digits)}%`;
}

function InfoDot({ label }: { label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Info className="w-3 h-3 text-muted-foreground/60 hover:text-muted-foreground cursor-help inline-block align-middle ml-1" />
      </TooltipTrigger>
      <TooltipContent className="max-w-[280px] text-[11px] leading-snug">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

function Stat({
  label,
  value,
  tooltip,
  valueClass,
}: {
  label: string;
  value: string;
  tooltip: string;
  valueClass?: string;
}) {
  return (
    <div className="px-3 py-2">
      <div className="text-[9px] uppercase tracking-wider text-muted-foreground flex items-center">
        {label}
        <InfoDot label={tooltip} />
      </div>
      <div className={`text-lg font-mono font-semibold ${valueClass ?? ''}`}>{value}</div>
    </div>
  );
}

function SliderRow({
  label,
  options,
  value,
  onChange,
  format,
}: {
  label: string;
  options: readonly number[];
  value: number;
  onChange: (v: number) => void;
  format: (v: number) => string;
}) {
  const idx = Math.max(0, options.indexOf(value));
  return (
    <div className="flex items-center gap-3 py-1.5">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground w-20 flex-shrink-0">
        {label}
      </div>
      <Slider
        value={[idx]}
        min={0}
        max={options.length - 1}
        step={1}
        onValueChange={vals => onChange(options[vals[0]] ?? options[0])}
        className="flex-1"
      />
      <div className="text-[11px] font-mono font-semibold w-14 text-right flex-shrink-0">
        {format(value)}
      </div>
    </div>
  );
}

export function MonteCarloPanel() {
  const inputs = useMonteCarloInputs();
  // Inputs are derived from the latest ct_book row; anchor freshness to that
  // query's refetch time so "the sim uses data pulled N seconds ago" is obvious.
  const inputsUpdatedAt = useQueryFreshness(['mc_latest_book_row']);

  // Slider state.
  const [days, setDays] = useState<number>(30);
  const [paths, setPaths] = useState<number>(5000);
  const [riskPerTrade, setRisk] = useState<number>(0.01);
  const [tradesPerDay, setTradesPerDay] = useState<number>(3);
  const [seeded, setSeeded] = useState<boolean>(false);
  const [seedValue, setSeedValue] = useState<number>(42);

  const pathsCapped = paths > MAX_PATHS;

  // Re-run the sim any time a dependency changes. The call is pure and cheap
  // enough to do inline; memoization just dedupes identical runs.
  const result = useMemo(() => {
    if (inputs.isLoading) return null;
    return runMonteCarlo({
      startingEquity: inputs.startingEquity,
      winRate: inputs.winRate,
      rDistribution: inputs.rDistribution,
      tradesPerDay,
      days,
      paths,
      riskPerTrade,
      seed: seeded ? seedValue : undefined,
      sampleSize: FAN_SAMPLE,
    });
    // Don't depend on the full distribution array reference — derive a
    // stable key from its contents so sliders re-run only on real changes.
  }, [
    inputs.isLoading,
    inputs.startingEquity,
    inputs.winRate,
    // Stable content hash for the distribution array.
    JSON.stringify(inputs.rDistribution),
    tradesPerDay,
    days,
    paths,
    riskPerTrade,
    seeded,
    seedValue,
  ]);

  const chartData = useMemo(() => {
    if (!result) return [];
    const { percentileBands, paths: samplePaths, inputs: ri } = result;
    // One row per day index, with p5/p50/p95 and each sample path as its
    // own key. Recharts will map each key to its series.
    return percentileBands.p5.map((_, dayIdx) => {
      const row: Record<string, number> = {
        day: dayIdx,
        p5: percentileBands.p5[dayIdx],
        // We stack the band by rendering (p95 - p5) on top of a transparent
        // baseline; simplest way is to give Recharts a `bandLow = p5` and
        // `bandSpread = p95 - p5` and stackId them together.
        bandLow: percentileBands.p5[dayIdx],
        bandSpread: percentileBands.p95[dayIdx] - percentileBands.p5[dayIdx],
        p50: percentileBands.p50[dayIdx],
        p95: percentileBands.p95[dayIdx],
        start: ri.startingEquity,
      };
      for (let i = 0; i < samplePaths.length; i++) {
        row[`s${i}`] = samplePaths[i].equity[dayIdx];
      }
      return row;
    });
  }, [result]);

  return (
    <TooltipProvider delayDuration={150}>
      <Card className="overflow-hidden">
        {/* Header */}
        <div className="px-4 py-2.5 border-b border-border bg-muted/20 flex items-center gap-3 flex-wrap">
          <Dice5 className="w-4 h-4 text-primary" />
          <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground">
            {days}-Day Forward Simulation
            {result && (
              <span className="ml-2 text-[10px] font-normal text-muted-foreground">
                ({result.inputs.paths.toLocaleString()} paths)
              </span>
            )}
          </h3>

          {inputs.usingDefaults && (
            <span className="inline-flex items-center gap-1 text-[10px] text-amber-400">
              <AlertTriangle className="w-3 h-3" />
              {inputs.defaultReason}
            </span>
          )}

          <div className="ml-auto flex items-center gap-2 text-[10px]">
            <label className="inline-flex items-center gap-1 cursor-pointer">
              <input
                type="checkbox"
                checked={seeded}
                onChange={e => setSeeded(e.target.checked)}
                className="accent-primary"
              />
              <span className="text-muted-foreground">seed</span>
            </label>
            {seeded && (
              <input
                type="number"
                value={seedValue}
                onChange={e => setSeedValue(Number(e.target.value) || 0)}
                className="w-16 bg-background border border-border rounded px-1 py-0.5 text-[11px] font-mono"
              />
            )}
            <FreshnessChip timestamp={inputsUpdatedAt} label="inputs" />
          </div>
        </div>

        {inputs.isLoading || !result ? (
          <div className="p-4 text-xs text-muted-foreground">running simulation…</div>
        ) : (
          <div className="divide-y divide-border">
            {/* Stats row */}
            <div className="grid grid-cols-2 md:grid-cols-5">
              <Stat
                label="Median Final"
                value={fmtUsd(result.median_final_equity)}
                valueClass={
                  result.median_final_equity > result.inputs.startingEquity
                    ? 'text-emerald-400'
                    : result.median_final_equity < result.inputs.startingEquity
                      ? 'text-red-400'
                      : ''
                }
                tooltip="50th-percentile final equity across all paths. Half the paths end above, half below."
              />
              <Stat
                label="5th %ile"
                value={fmtUsd(result.p5_final_equity)}
                valueClass="text-red-400"
                tooltip="Only 5% of simulated paths ended worse than this. Your 'bad month' floor."
              />
              <Stat
                label="95th %ile"
                value={fmtUsd(result.p95_final_equity)}
                valueClass="text-emerald-400"
                tooltip="Only 5% of paths ended better. Your 'good month' ceiling."
              />
              <Stat
                label="Expected Max DD"
                value={fmtPct(result.expected_max_dd_pct)}
                valueClass="text-red-400"
                tooltip="Mean max drawdown across paths. Also shown: p95-worst DD for tail sense."
              />
              <Stat
                label="P(ruin < $1k)"
                value={fmtPctScalar(result.prob_ruin_pct, 2)}
                valueClass={
                  result.prob_ruin_pct > 5
                    ? 'text-red-400'
                    : result.prob_ruin_pct > 1
                      ? 'text-amber-400'
                      : 'text-emerald-400'
                }
                tooltip="Percent of simulated paths that touched ≤ $1k at any point. The number that matters for survival."
              />
            </div>

            {/* Fan chart */}
            <div className="px-4 py-3">
              <div className="flex items-center gap-2 mb-2">
                <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Equity curve fan · p5 / p50 / p95 bands, {FAN_SAMPLE} sample paths overlaid
                </h4>
                <InfoDot
                  label={`Shaded band = 90% confidence envelope across all ${result.inputs.paths.toLocaleString()} paths. Median line in the middle. The thin faded lines are a small sample of individual simulated trajectories — just there to show the texture of variance, not to be read individually.`}
                />
                {result.inputs.pathsCapped && (
                  <span className="ml-auto text-[10px] text-amber-400">
                    capped at {MAX_PATHS.toLocaleString()}
                  </span>
                )}
              </div>
              <div className="h-72 w-full">
                <ChartSafe><ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 8 }}>
                    <XAxis
                      dataKey="day"
                      tick={{ fontSize: 10, fill: '#94A3B8' }}
                      axisLine={false}
                      tickLine={false}
                      label={{
                        value: 'trading day',
                        position: 'insideBottom',
                        offset: -4,
                        style: { fontSize: 10, fill: '#94A3B8' },
                      }}
                    />
                    <YAxis
                      tick={{ fontSize: 10, fill: '#94A3B8' }}
                      axisLine={false}
                      tickLine={false}
                      tickFormatter={v => `$${(v / 1000).toFixed(0)}k`}
                      domain={['auto', 'auto']}
                    />
                    <RTooltip
                      cursor={{ stroke: '#64748B', strokeDasharray: '3 3' }}
                      contentStyle={{
                        background: 'hsl(var(--popover))',
                        border: '1px solid hsl(var(--border))',
                        borderRadius: 6,
                        fontSize: 11,
                      }}
                      formatter={(v: number, name: string) => {
                        if (name === 'bandLow' || name === 'start') return [null, null] as [null, null];
                        if (name === 'bandSpread') return [null, null] as [null, null];
                        if (name.startsWith('s')) return [null, null] as [null, null];
                        return [fmtUsd(v), name];
                      }}
                      labelFormatter={(d: number) => `day ${d}`}
                    />
                    <ReferenceLine
                      y={result.inputs.startingEquity}
                      stroke="#64748B"
                      strokeDasharray="3 3"
                      label={{
                        value: 'start',
                        position: 'insideRight',
                        fontSize: 10,
                        fill: '#94A3B8',
                      }}
                    />

                    {/* 90% band — render as two stacked Areas. The baseline is
                        transparent, the spread is translucent emerald. */}
                    <Area
                      type="monotone"
                      dataKey="bandLow"
                      stackId="band"
                      stroke="none"
                      fill="transparent"
                      isAnimationActive={false}
                    />
                    <Area
                      type="monotone"
                      dataKey="bandSpread"
                      stackId="band"
                      stroke="none"
                      fill="#10B981"
                      fillOpacity={0.14}
                      isAnimationActive={false}
                    />

                    {/* Sample trajectories — thin, low-opacity, no dots. */}
                    {result.paths.map((_, i) => (
                      <Line
                        key={`s${i}`}
                        type="linear"
                        dataKey={`s${i}`}
                        stroke="#94A3B8"
                        strokeOpacity={0.18}
                        strokeWidth={1}
                        dot={false}
                        activeDot={false}
                        isAnimationActive={false}
                        legendType="none"
                      />
                    ))}

                    {/* Median — the eye's anchor line. */}
                    <Line
                      type="monotone"
                      dataKey="p50"
                      name="median"
                      stroke="#00C853"
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 3 }}
                      isAnimationActive={false}
                    />
                    {/* Explicit p5 / p95 edges — subtle so the band dominates. */}
                    <Line
                      type="monotone"
                      dataKey="p5"
                      name="p5"
                      stroke="#EF4444"
                      strokeWidth={1}
                      strokeDasharray="3 3"
                      dot={false}
                      isAnimationActive={false}
                    />
                    <Line
                      type="monotone"
                      dataKey="p95"
                      name="p95"
                      stroke="#10B981"
                      strokeWidth={1}
                      strokeDasharray="3 3"
                      dot={false}
                      isAnimationActive={false}
                    />
                  </ComposedChart>
                </ResponsiveContainer></ChartSafe>
              </div>

              {/* Secondary stats: mean + p95 DD + prob profit. */}
              <div className="mt-2 grid grid-cols-3 text-[10px] text-muted-foreground gap-2">
                <div>
                  <span className="uppercase tracking-wide">mean final</span>{' '}
                  <span className="font-mono font-semibold text-foreground">
                    {fmtUsd(result.mean_final_equity)}
                  </span>
                </div>
                <div>
                  <span className="uppercase tracking-wide">p95 max DD</span>{' '}
                  <span className="font-mono font-semibold text-red-400">
                    {fmtPct(result.p95_max_dd_pct)}
                  </span>
                </div>
                <div className="text-right">
                  <span className="uppercase tracking-wide">P(profitable)</span>{' '}
                  <span className="font-mono font-semibold text-emerald-400">
                    {fmtPctScalar(result.prob_profit_pct, 1)}
                  </span>
                </div>
              </div>
            </div>

            {/* Sliders */}
            <div className="px-4 py-3 bg-muted/5">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6">
                <SliderRow
                  label="Days"
                  options={DAYS_STEPS}
                  value={days}
                  onChange={setDays}
                  format={v => `${v}d`}
                />
                <SliderRow
                  label="Paths"
                  options={PATHS_STEPS}
                  value={paths}
                  onChange={setPaths}
                  format={v => v.toLocaleString()}
                />
                <SliderRow
                  label="Risk/trade"
                  options={RISK_STEPS}
                  value={riskPerTrade}
                  onChange={setRisk}
                  format={v => `${(v * 100).toFixed(1)}%`}
                />
                <SliderRow
                  label="Trades/day"
                  options={TRADES_STEPS}
                  value={tradesPerDay}
                  onChange={setTradesPerDay}
                  format={v => `${v}`}
                />
              </div>
              {pathsCapped && (
                <div className="mt-2 text-[10px] text-amber-400 flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3" />
                  Paths capped at {MAX_PATHS.toLocaleString()} to keep the sim responsive on weaker CPUs.
                </div>
              )}
            </div>

            {/* Assumptions footnote */}
            <div className="px-4 py-2.5 bg-muted/10 text-[10px] text-muted-foreground leading-relaxed">
              <span className="font-semibold uppercase tracking-wide text-muted-foreground/80">
                Assumptions:
              </span>{' '}
              trades are treated as <em>independent</em> (in reality they correlate — the same
              regime that wins one trade often wins the next). Past R-distribution is assumed
              to <em>persist</em> (stationarity — the market's personality doesn't shift). No
              slippage, commissions, or liquidity limits.{' '}
              <span className="italic">
                This is a tool for sanity-checking risk of ruin, not a forecast.
              </span>{' '}
              Based on {inputs.tradesWithR} closed trades with stops
              {inputs.usingDefaults ? ' (insufficient → defaults shown)' : ''}.
            </div>
          </div>
        )}
      </Card>
    </TooltipProvider>
  );
}
