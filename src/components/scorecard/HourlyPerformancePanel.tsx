/**
 * HourlyPerformancePanel — "is Claude sharper in the first hour or last hour?"
 *
 * Drills finer than wave 24's open/midday/close session slices: 13 half-hour
 * ET buckets across the regular trading session (09:30 → 15:30 start, each
 * bucket covers a 30-minute window).
 *
 * Layout:
 *   1. Top stat   — "Sharpest hour: 10:30 (68% hit, n=14) · Deadest: 13:00
 *                    (40%, n=8)". Skipped if no bucket clears SPARSE_THRESHOLD.
 *   2. Heat strip — 13 cells, x-axis = bucket label, colored by winRate:
 *                    red <40% · amber 40-55% · green >55%. Edge-flagged cells
 *                    (red/green flag from hook) render with a bold ring and
 *                    hint copy on hover.
 *   3. Bar chart  — avg actual_return_pct per bucket. Positive bars green,
 *                    negative bars red. Sparse buckets render muted.
 *   4. Alerts overlay — small per-bucket count of alerts+flags *fired*,
 *                    revealing whether Claude fires a lot in weak hours.
 *   5. Footer     — multiple-testing caveat (13 × 0.05 ≈ 0.65 spurious finds).
 *
 * Sparse bucket (n < 3) handling: muted text, dashed border on the heat
 * cell, "insufficient" sub-label, return bar hidden (shows an em-dash).
 *
 * Wrapped in ChartSafe on each renderable chart (heat strip, bar chart, and
 * alerts overlay) — if the bucket data comes back malformed we render the
 * fallback rather than crash the Scorecard page.
 */
import { Card } from '@/components/ui/card';
import { Clock, Info } from 'lucide-react';
import { ChartSafe } from '@/components/ChartSafe';
import {
  useHourlyPerformance,
  type HourBucket,
} from '@/hooks/useHourlyPerformance';

// ─── formatting ──────────────────────────────────────────────────────────────

function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(0)}%`;
}

function fmtReturn(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

function bucketEndLabel(startLabel: string): string {
  // Start label is "HH:MM". End is +29 minutes so each bucket reads as
  // a half-hour window (inclusive start, inclusive end at :59 / :29).
  const [hStr, mStr] = startLabel.split(':');
  const h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);
  const end = h * 60 + m + 29;
  const eh = Math.floor(end / 60);
  const em = end % 60;
  return `${String(eh).padStart(2, '0')}:${String(em).padStart(2, '0')}`;
}

function winRateTone(
  winRate: number,
  insufficient: boolean,
): 'red' | 'amber' | 'green' | 'muted' {
  if (insufficient) return 'muted';
  if (winRate < 0.4) return 'red';
  if (winRate <= 0.55) return 'amber';
  return 'green';
}

// Heat cell background from the 3-band rubric (red <40, amber 40-55, green >55).
// Separate from the edge-flag ring: a cell can be "amber 52%" and still be an
// edge-flagged green if it had a 68% win rate on n>=10... wait, no. Edge flag
// is gated on its own threshold. These two live independently.
function heatBg(tone: 'red' | 'amber' | 'green' | 'muted'): string {
  switch (tone) {
    case 'red':
      return 'hsl(0 75% 55% / 0.28)';
    case 'amber':
      return 'hsl(38 92% 55% / 0.25)';
    case 'green':
      return 'hsl(140 70% 45% / 0.28)';
    default:
      return 'hsl(var(--muted) / 0.2)';
  }
}

// ─── sub-components ─────────────────────────────────────────────────────────

function HeatStrip({ buckets }: { buckets: HourBucket[] }) {
  return (
    <ChartSafe label="hourly win-rate heat strip">
      <div className="overflow-x-auto">
        <div className="flex gap-1 min-w-fit">
          {buckets.map((b) => {
            const tone = winRateTone(b.winRate, b.insufficient);
            const bg = heatBg(tone);
            const ring =
              b.edgeFlag === 'green'
                ? 'ring-2 ring-green-400/80'
                : b.edgeFlag === 'red'
                  ? 'ring-2 ring-red-400/80'
                  : '';
            const borderStyle = b.insufficient
              ? 'border border-dashed border-border/40'
              : 'border border-border/50';
            const title = b.insufficient
              ? `${b.label}-${bucketEndLabel(b.label)} ET · insufficient (n=${b.count})`
              : `${b.label}-${bucketEndLabel(b.label)} ET · ${fmtPct(b.winRate)} hit (n=${b.count})${
                  b.edgeFlag === 'green'
                    ? ' · edge window'
                    : b.edgeFlag === 'red'
                      ? ' · consider avoiding this window'
                      : ''
                }`;
            return (
              <div
                key={b.label}
                className={`flex flex-col items-center justify-center rounded min-w-[56px] h-[62px] ${borderStyle} ${ring}`}
                style={{ background: bg }}
                title={title}
              >
                <div className="text-[9px] font-mono text-muted-foreground">
                  {b.label}
                </div>
                <div
                  className={`text-sm font-bold font-mono ${
                    b.insufficient
                      ? 'text-muted-foreground/60'
                      : tone === 'red'
                        ? 'text-red-300'
                        : tone === 'amber'
                          ? 'text-amber-300'
                          : 'text-green-300'
                  }`}
                >
                  {b.insufficient ? '—' : fmtPct(b.winRate)}
                </div>
                <div className="text-[9px] font-mono text-muted-foreground/80">
                  n={b.count}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </ChartSafe>
  );
}

function ReturnBars({ buckets }: { buckets: HourBucket[] }) {
  // Normalize bar heights against the max absolute return across non-sparse
  // buckets so a single outlier doesn't flatten everyone else. Minimum scale
  // floor of 0.5% keeps tiny returns visible.
  const maxAbs = Math.max(
    0.5,
    ...buckets
      .filter((b) => !b.insufficient)
      .map((b) => Math.abs(b.avgReturnPct)),
  );
  return (
    <ChartSafe label="hourly average return bars">
      <div className="overflow-x-auto">
        <div className="flex gap-1 min-w-fit items-end h-[90px]">
          {buckets.map((b) => {
            if (b.insufficient) {
              return (
                <div
                  key={b.label}
                  className="min-w-[56px] h-full flex flex-col justify-end items-center border-b border-border/30"
                  title={`${b.label}-${bucketEndLabel(b.label)} ET · insufficient (n=${b.count})`}
                >
                  <div className="text-[9px] font-mono text-muted-foreground/60">—</div>
                </div>
              );
            }
            const ratio = Math.min(1, Math.abs(b.avgReturnPct) / maxAbs);
            const heightPx = Math.max(2, Math.round(ratio * 60));
            const positive = b.avgReturnPct >= 0;
            const barColor = positive ? 'bg-green-500/70' : 'bg-red-500/70';
            const justify = positive ? 'justify-end' : 'justify-start';
            return (
              <div
                key={b.label}
                className={`min-w-[56px] flex flex-col ${justify} items-center border-b border-border/30 h-full`}
                title={`${b.label}-${bucketEndLabel(b.label)} ET · avg return ${fmtReturn(b.avgReturnPct)}`}
              >
                <div
                  className={`${barColor} rounded-sm w-[36px]`}
                  style={{ height: `${heightPx}px` }}
                />
                <div
                  className={`text-[9px] font-mono mt-1 ${
                    positive ? 'text-green-400/90' : 'text-red-400/90'
                  }`}
                >
                  {fmtReturn(b.avgReturnPct)}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </ChartSafe>
  );
}

function AlertsOverlay({ buckets }: { buckets: HourBucket[] }) {
  const maxAlerts = Math.max(
    1,
    ...buckets.map((b) => b.alertsTotal),
  );
  return (
    <ChartSafe label="alerts per hour overlay">
      <div className="overflow-x-auto">
        <div className="flex gap-1 min-w-fit items-end h-[40px]">
          {buckets.map((b) => {
            const ratio = b.alertsTotal / maxAlerts;
            const heightPx = Math.max(2, Math.round(ratio * 32));
            return (
              <div
                key={b.label}
                className="min-w-[56px] flex flex-col justify-end items-center"
                title={`${b.label}-${bucketEndLabel(b.label)} ET · ${b.alertsTotal} alerts+flags fired`}
              >
                <div
                  className="bg-primary/50 rounded-sm w-[36px]"
                  style={{ height: `${heightPx}px` }}
                />
                <div className="text-[9px] font-mono text-muted-foreground mt-0.5">
                  {b.alertsTotal}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </ChartSafe>
  );
}

// ─── main panel ─────────────────────────────────────────────────────────────

export function HourlyPerformancePanel() {
  const { data, isLoading } = useHourlyPerformance();

  const topLine =
    data?.sharpest && data?.deadest
      ? `Sharpest hour: ${data.sharpest.label}-${bucketEndLabel(
          data.sharpest.label,
        )} (${fmtPct(data.sharpest.winRate)} hit, n=${data.sharpest.count}) · Deadest: ${
          data.deadest.label
        }-${bucketEndLabel(data.deadest.label)} (${fmtPct(data.deadest.winRate)}, n=${
          data.deadest.count
        })`
      : null;

  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
        <Clock className="w-3 h-3" />
        Intraday edge — by ET half-hour
        <span className="normal-case tracking-normal text-muted-foreground/70">
          — hit rate, return, and firing rate across the session (last 30d)
        </span>
        {data && (
          <span className="ml-auto normal-case tracking-normal font-mono">
            n={data.sample} graded · {data.alertsSample} fired · baseline {fmtPct(data.overallWinRate)}
          </span>
        )}
      </div>
      <p className="text-[10px] text-muted-foreground mb-3 leading-relaxed">
        Sessions are split into 13 half-hour windows starting at 09:30 ET.
        Heat-strip cells color by win rate (red &lt; 40% · amber 40-55% · green &gt; 55%).
        Cells with count &ge; 10 and win rate &lt; 40% ring red ("consider
        avoiding this window"). Cells with count &ge; 10 and win rate &gt; 65%
        ring green ("edge window"). Buckets with fewer than 3 samples render
        muted as "insufficient".
      </p>

      {isLoading && (
        <div className="text-xs text-muted-foreground py-6 text-center">
          loading hourly slices…
        </div>
      )}

      {data && data.dataThinNote && (
        <div className="mb-3 rounded border border-amber-500/30 bg-amber-500/5 px-2.5 py-2 text-[11px] text-amber-300 flex items-start gap-1.5">
          <Info className="w-3 h-3 mt-0.5 shrink-0" />
          <span>{data.dataThinNote}</span>
        </div>
      )}

      {data && data.sample === 0 && data.alertsSample === 0 ? (
        <div className="rounded border border-dashed border-muted bg-muted/10 px-3 py-6 text-center">
          <p className="text-xs text-muted-foreground leading-relaxed">
            No graded or fired alerts+flags in the 30d window landed inside RTH
            ET. Hourly slices light up once claims fire during regular hours
            and horizons close with a verdict.
          </p>
        </div>
      ) : data ? (
        <>
          {topLine && (
            <div className="mb-3 rounded border border-border bg-muted/20 px-2.5 py-2 text-[11px] font-mono text-foreground/90">
              {topLine}
            </div>
          )}

          {/* Heat strip — primary read. */}
          <div className="mb-3">
            <div className="text-[10px] uppercase tracking-wider text-foreground/80 font-semibold mb-1.5">
              Win rate by half-hour
            </div>
            <HeatStrip buckets={data.buckets} />
          </div>

          {/* Bar chart — avg return per bucket. */}
          <div className="mb-3">
            <div className="text-[10px] uppercase tracking-wider text-foreground/80 font-semibold mb-1.5">
              Avg return by half-hour
            </div>
            <ReturnBars buckets={data.buckets} />
          </div>

          {/* Alerts overlay — shows firing rate by bucket. */}
          <div className="mb-3">
            <div className="text-[10px] uppercase tracking-wider text-foreground/80 font-semibold mb-1.5">
              Alerts + flags fired per half-hour
            </div>
            <AlertsOverlay buckets={data.buckets} />
          </div>

          {/* Edge-flag callouts — surface red/green rings in plain copy too. */}
          {(() => {
            const red = data.buckets.filter((b) => b.edgeFlag === 'red');
            const green = data.buckets.filter((b) => b.edgeFlag === 'green');
            if (red.length === 0 && green.length === 0) return null;
            return (
              <div className="mb-3 grid grid-cols-1 md:grid-cols-2 gap-2">
                {green.length > 0 && (
                  <div className="rounded border border-green-500/40 bg-green-500/5 px-2.5 py-2 text-[11px] text-green-300">
                    <span className="font-semibold">Edge windows:</span>{' '}
                    {green
                      .map(
                        (b) =>
                          `${b.label} (${fmtPct(b.winRate)}, n=${b.count})`,
                      )
                      .join(' · ')}
                  </div>
                )}
                {red.length > 0 && (
                  <div className="rounded border border-red-500/40 bg-red-500/5 px-2.5 py-2 text-[11px] text-red-300">
                    <span className="font-semibold">Consider avoiding:</span>{' '}
                    {red
                      .map(
                        (b) =>
                          `${b.label} (${fmtPct(b.winRate)}, n=${b.count})`,
                      )
                      .join(' · ')}
                  </div>
                )}
              </div>
            );
          })()}

          <div className="mt-3 text-[10px] text-muted-foreground leading-relaxed">
            <span className="text-foreground/80 font-semibold">
              Caveat — multiple testing:
            </span>{' '}
            13 hour buckets × alpha=0.05 = 0.65 spurious finds expected by
            chance. Treat single-hour outliers as hypotheses, not conclusions.
            An "edge at 10:30" could also be "edge when the tape is bullish"
            if regime confounds with hour — cross-check against the
            regime-conditional panel before acting.
          </div>
        </>
      ) : null}
    </Card>
  );
}

export default HourlyPerformancePanel;
