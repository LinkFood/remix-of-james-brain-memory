/**
 * RiskMetricsPanel — hedge-fund-grade stats block for Claude's book.
 *
 * Sits below the equity curve on /book. Renders:
 *   - Period selector (7d / 30d / all, default 30d)
 *   - Grade header (A/B/C/D/N/A) with rubric tooltip
 *   - Top-line stats: Sharpe · Sortino · Calmar · Max DD · Kurtosis
 *   - R-multiple histogram (Recharts)
 *   - Beta / Alpha (or "—" when SPY benchmark not stored yet)
 *   - Expectancy / Kelly
 *
 * All numbers come from `useRiskMetrics` → `src/lib/riskMetrics.ts`.
 * When the sample is too thin (fewer than 5 returns or <5 trades with
 * stop data), we render "insufficient sample" inline rather than NaN.
 */
import { ChartSafe } from '@/components/ChartSafe';
import { useState } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  ResponsiveContainer,
  Tooltip as RTooltip,
  Cell,
  ReferenceLine,
} from 'recharts';
import { Card } from '@/components/ui/card';
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from '@/components/ui/tooltip';
import { Activity, Info, TrendingUp } from 'lucide-react';
import { useRiskMetrics, type RiskPeriod } from '@/hooks/useRiskMetrics';

const GREEN = '#00C853';
const RED = '#FF1744';
const NEUTRAL = '#94A3B8';

function fmtNum(n: number, digits = 2, suffix = ''): string {
  if (!Number.isFinite(n)) return '—';
  return `${n.toFixed(digits)}${suffix}`;
}

function fmtPct(n: number, digits = 2, signed = true): string {
  if (!Number.isFinite(n)) return '—';
  const v = (n * 100).toFixed(digits);
  if (!signed) return `${v}%`;
  return n >= 0 ? `+${v}%` : `${v}%`;
}

function gradeColor(grade: 'A' | 'B' | 'C' | 'D' | 'N/A'): string {
  switch (grade) {
    case 'A': return 'text-emerald-400';
    case 'B': return 'text-lime-400';
    case 'C': return 'text-amber-400';
    case 'D': return 'text-red-400';
    default:  return 'text-muted-foreground';
  }
}

function InfoDot({ label }: { label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Info className="w-3 h-3 text-muted-foreground/60 hover:text-muted-foreground cursor-help inline-block align-middle ml-1" />
      </TooltipTrigger>
      <TooltipContent className="max-w-[260px] text-[11px] leading-snug">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

interface StatProps {
  label: string;
  value: string;
  tooltip: string;
  valueClass?: string;
}

function Stat({ label, value, tooltip, valueClass }: StatProps) {
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

const RUBRIC_TOOLTIP =
  'A = Sharpe > 1.5, Max DD < 10%, expectancy > 0.3R. ' +
  'B = Sharpe > 1.0, Max DD < 15%. ' +
  'C = Sharpe > 0. ' +
  'D = Sharpe <= 0 or Max DD > 20%.';

const PERIODS: { key: RiskPeriod; label: string }[] = [
  { key: '7d', label: '7d' },
  { key: '30d', label: '30d' },
  { key: 'all', label: 'All' },
];

export function RiskMetricsPanel() {
  const [period, setPeriod] = useState<RiskPeriod>('30d');
  const { metrics, isLoading } = useRiskMetrics(period);

  const insufficient =
    !!metrics && metrics.sampleSize.sessions < 5;
  const insufficientTrades =
    !!metrics && metrics.sampleSize.tradesWithR < 5;

  // Color Sharpe/Sortino/Calmar by sign for quick scan.
  const sharpeClass =
    metrics && Number.isFinite(metrics.sharpe)
      ? metrics.sharpe > 0 ? 'text-emerald-400' : 'text-red-400'
      : 'text-muted-foreground';
  const sortinoClass =
    metrics && Number.isFinite(metrics.sortino)
      ? metrics.sortino > 0 ? 'text-emerald-400' : 'text-red-400'
      : 'text-muted-foreground';
  const calmarClass =
    metrics && Number.isFinite(metrics.calmar)
      ? metrics.calmar > 0 ? 'text-emerald-400' : 'text-red-400'
      : 'text-muted-foreground';
  const ddClass =
    metrics && Number.isFinite(metrics.maxDd) && metrics.maxDd < 0
      ? 'text-red-400'
      : 'text-muted-foreground';

  return (
    <TooltipProvider delayDuration={150}>
      <Card className="overflow-hidden">
        {/* Header */}
        <div className="px-4 py-2.5 border-b border-border bg-muted/20 flex items-center gap-3">
          <Activity className="w-4 h-4 text-primary" />
          <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground">
            Risk &amp; Performance
          </h3>

          {metrics && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className={`text-[11px] font-semibold uppercase tracking-wider cursor-help ${gradeColor(metrics.grade)}`}
                >
                  Grade {metrics.grade}
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-[320px] text-[11px] leading-snug">
                <div className="font-semibold mb-1">{metrics.gradeReason}</div>
                <div className="text-muted-foreground">{RUBRIC_TOOLTIP}</div>
              </TooltipContent>
            </Tooltip>
          )}

          <div className="ml-auto flex items-center gap-1">
            {PERIODS.map(p => (
              <button
                key={p.key}
                onClick={() => setPeriod(p.key)}
                className={`text-[10px] uppercase tracking-wide px-2 py-1 rounded border transition-colors ${
                  period === p.key
                    ? 'bg-primary/20 border-primary/40 text-primary'
                    : 'bg-transparent border-border text-muted-foreground hover:text-foreground'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {isLoading || !metrics ? (
          <div className="p-4 text-xs text-muted-foreground">loading risk metrics…</div>
        ) : insufficient ? (
          <div className="p-4 text-xs text-muted-foreground">
            insufficient sample — need at least 5 sessions in this window
            ({metrics.sampleSize.sessions} found).
          </div>
        ) : (
          <div className="divide-y divide-border">
            {/* Top row: Sharpe · Sortino · Calmar */}
            <div className="grid grid-cols-3">
              <Stat
                label="Sharpe"
                value={fmtNum(metrics.sharpe)}
                valueClass={sharpeClass}
                tooltip="Risk-adjusted return: (mean daily excess return × sqrt(252)) / std dev. Hedge-fund benchmark is >1.0, elite is >2.0. Uses 4.5% annual risk-free rate."
              />
              <Stat
                label="Sortino"
                value={fmtNum(metrics.sortino)}
                valueClass={sortinoClass}
                tooltip="Like Sharpe but only penalizes downside volatility. Better than Sharpe when upside swings shouldn't count as 'risk'. Benchmark is >1.5."
              />
              <Stat
                label="Calmar"
                value={fmtNum(metrics.calmar)}
                valueClass={calmarClass}
                tooltip="Annualized return divided by max drawdown magnitude. Measures how much pain you endured per unit of return. >1.0 is good, >3.0 is excellent."
              />
            </div>

            {/* Middle row: Max DD · Kurtosis · Beta · Alpha */}
            <div className="grid grid-cols-4">
              <Stat
                label="Max DD"
                value={fmtPct(metrics.maxDd, 2, false)}
                valueClass={ddClass}
                tooltip={
                  metrics.maxDdPeakDate && metrics.maxDdTroughDate
                    ? `Peak ${metrics.maxDdPeakDate} → trough ${metrics.maxDdTroughDate}. ${
                        metrics.recoveredAt
                          ? `Recovered ${metrics.recoveredAt}.`
                          : 'Still underwater.'
                      } Biggest peak-to-trough drawdown observed on the equity curve.`
                    : 'Biggest peak-to-trough drawdown observed on the equity curve.'
                }
              />
              <Stat
                label="Kurtosis"
                value={fmtNum(metrics.kurtosisExcess)}
                tooltip="Excess kurtosis of daily returns. >0 means fat tails (crash risk higher than a normal distribution would predict). ~0 is normal."
              />
              <Stat
                label="Beta (SPY)"
                value={metrics.benchmarkAvailable ? fmtNum(metrics.beta) : '—'}
                tooltip={
                  metrics.benchmarkAvailable
                    ? 'Covariance of strategy returns vs SPY divided by SPY variance. 1.0 = moves with market, 0 = uncorrelated, <0 = inverse.'
                    : 'Benchmark data missing — add a SPY price pipeline for beta tracking.'
                }
              />
              <Stat
                label="Alpha"
                value={metrics.benchmarkAvailable ? fmtPct(metrics.alpha, 2) : '—'}
                tooltip={
                  metrics.benchmarkAvailable
                    ? 'Excess annualized return vs what beta × SPY return would predict. Positive alpha = skill beyond market exposure.'
                    : 'Benchmark data missing — add a SPY price pipeline for beta tracking.'
                }
              />
            </div>

            {/* Expectancy row */}
            <div className="grid grid-cols-4">
              <Stat
                label="Win Rate"
                value={
                  insufficientTrades
                    ? '—'
                    : fmtNum(metrics.expectancy.winRate * 100, 1, '%')
                }
                tooltip="Percent of closed trades with R > 0. Needs to pair with avg-win/avg-loss to mean anything — a 40% win rate with 3R winners beats 70% with 0.5R winners."
              />
              <Stat
                label="Expectancy"
                value={
                  insufficientTrades
                    ? '—'
                    : `${metrics.expectancy.meanR.toFixed(2)}R`
                }
                tooltip="Average R multiple per trade. 0.3R+ is the minimum for a tradeable edge. R = realized P&L % / stop distance %."
              />
              <Stat
                label="Avg Win / Loss"
                value={
                  insufficientTrades
                    ? '—'
                    : `${fmtNum(metrics.expectancy.avgWinR)}R / ${fmtNum(metrics.expectancy.avgLossR)}R`
                }
                tooltip="Conditional means: average R on winning trades vs average R on losers (magnitude). Want avg win well above avg loss."
              />
              <Stat
                label="Kelly Size"
                value={
                  insufficientTrades || !Number.isFinite(metrics.expectancy.kelly)
                    ? '—'
                    : fmtNum(metrics.expectancy.kelly * 100, 1, '%')
                }
                tooltip="Kelly criterion optimal position size: winRate − (1 − winRate) / (avgWin/avgLoss). Most pros size at half-Kelly to smooth equity curve."
              />
            </div>

            {/* R-multiple histogram */}
            <div className="px-4 py-3">
              <div className="flex items-center gap-2 mb-2">
                <TrendingUp className="w-3.5 h-3.5 text-muted-foreground" />
                <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  R-Multiple Distribution
                </h4>
                <InfoDot
                  label="How each closed trade performed in units of its own stop-loss risk. A +2R bar means those trades made twice what they risked. Healthy distributions skew right — winners bigger than losers."
                />
                <span className="ml-auto text-[10px] text-muted-foreground">
                  {metrics.sampleSize.tradesWithR} of {metrics.sampleSize.trades} trades had stops
                </span>
              </div>
              {insufficientTrades ? (
                <div className="h-32 flex items-center justify-center text-[11px] text-muted-foreground">
                  insufficient sample — need at least 5 closed trades with stop_price
                </div>
              ) : (
                <div className="h-32 w-full">
                  <ChartSafe><ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={metrics.rHistogram.map(b => ({
                        ...b,
                        label: b.r === -3
                          ? '≤-3R'
                          : b.r === 4
                          ? '≥+4R'
                          : b.r >= 0 ? `+${b.r}R` : `${b.r}R`,
                      }))}
                      margin={{ top: 4, right: 4, left: 0, bottom: 4 }}
                    >
                      <XAxis
                        dataKey="label"
                        tick={{ fontSize: 10, fill: '#94A3B8' }}
                        axisLine={false}
                        tickLine={false}
                      />
                      <YAxis
                        tick={{ fontSize: 10, fill: '#94A3B8' }}
                        axisLine={false}
                        tickLine={false}
                        allowDecimals={false}
                      />
                      <RTooltip
                        cursor={{ fill: 'rgba(148,163,184,0.08)' }}
                        contentStyle={{
                          background: 'hsl(var(--popover))',
                          border: '1px solid hsl(var(--border))',
                          borderRadius: 6,
                          fontSize: 11,
                        }}
                        formatter={(v: number) => [v, 'trades']}
                      />
                      <ReferenceLine x="0R" stroke="#475569" strokeDasharray="2 2" />
                      <Bar dataKey="count" radius={[2, 2, 0, 0]}>
                        {metrics.rHistogram.map((b, i) => (
                          <Cell
                            key={i}
                            fill={b.r < 0 ? RED : b.r === 0 ? NEUTRAL : GREEN}
                          />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer></ChartSafe>
                </div>
              )}
            </div>

            <div className="px-4 py-2 bg-muted/10 text-[10px] text-muted-foreground flex items-center justify-between">
              <span>
                {metrics.sampleSize.sessions} sessions · {metrics.sampleSize.trades} trades ·
                period {period === 'all' ? 'all time' : period}
              </span>
              {!metrics.benchmarkAvailable && (
                <span className="italic">SPY price pipeline not live — beta/alpha pending</span>
              )}
            </div>
          </div>
        )}
      </Card>
    </TooltipProvider>
  );
}
