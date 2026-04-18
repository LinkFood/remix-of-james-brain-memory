/**
 * RegimeConditionalPanel — "where does Claude actually have edge?"
 *
 * Decomposes the single overall win rate into 6 conditional slices per regime
 * dimension (gamma / IV / session / catalyst / day-of-week / OPEX). Each
 * dimension renders as a mini-table with a "best edge" header stat and
 * color-coded rows (green if > baseline +10pp, amber within ±10pp, red if
 * below baseline -10pp).
 *
 * Plus a gamma × session 2D heatmap — cells colored by win rate, count shown
 * in corner. Sparse cells (< 3) rendered dim with a dashed border.
 *
 * Multiple-testing caveat explicitly surfaced in the footer: with ~30 slices
 * across dimensions, a 5% alpha yields ~1.5 false discoveries by chance.
 * We don't print p-values, but we tell James not to treat any single slice as
 * confirmed edge — the cross-dimension heatmap is the honest test.
 */
import { useMemo } from 'react';
import { Card } from '@/components/ui/card';
import { Compass, Info } from 'lucide-react';
import { ChartSafe } from '@/components/ChartSafe';
import {
  useRegimeConditionalPerformance,
  type DimensionReport,
  type RegimeSlice,
  type CrossCell,
} from '@/hooks/useRegimeConditionalPerformance';

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

function fmtR(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}R`;
}

// Color rules: baseline ±10pp. Insufficient or unscored → muted.
function rowTone(
  slice: RegimeSlice,
  baseline: number,
): 'green' | 'amber' | 'red' | 'muted' {
  if (slice.insufficient || slice.count === 0) return 'muted';
  const delta = slice.winRate - baseline;
  if (delta > 0.1) return 'green';
  if (delta < -0.1) return 'red';
  return 'amber';
}

function toneClasses(tone: 'green' | 'amber' | 'red' | 'muted'): string {
  switch (tone) {
    case 'green':
      return 'text-green-400';
    case 'red':
      return 'text-red-400';
    case 'amber':
      return 'text-amber-400';
    default:
      return 'text-muted-foreground';
  }
}

// ─── mini-table per dimension ────────────────────────────────────────────────

function DimensionTable({
  report,
  baseline,
}: {
  report: DimensionReport;
  baseline: number;
}) {
  const { best } = report;
  const deltaPp = best ? (best.winRate - baseline) * 100 : null;
  const bestCopy = best
    ? `Best edge: ${best.value} — ${fmtPct(best.winRate)} hit rate (n=${best.count}) vs ${fmtPct(baseline)} overall${
        deltaPp != null
          ? ` · ${deltaPp >= 0 ? '+' : ''}${deltaPp.toFixed(0)}pp`
          : ''
      }`
    : 'no slice has enough samples yet';

  return (
    <div className="rounded border border-border bg-muted/10 p-2.5">
      <div className="flex items-center gap-1.5 mb-1.5">
        <span className="text-[10px] uppercase tracking-wider text-foreground/80 font-semibold">
          {report.label}
        </span>
      </div>
      <div className="text-[10px] text-muted-foreground mb-2 leading-relaxed">
        {bestCopy}
      </div>
      <div className="overflow-hidden rounded border border-border/60">
        <table className="w-full text-[11px]">
          <thead className="bg-muted/30 text-[9px] uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="text-left px-2 py-1 font-medium">slice</th>
              <th className="text-right px-2 py-1 font-medium">n</th>
              <th className="text-right px-2 py-1 font-medium">win</th>
              <th className="text-right px-2 py-1 font-medium">ret</th>
              <th className="text-right px-2 py-1 font-medium">avgR</th>
            </tr>
          </thead>
          <tbody>
            {report.slices.map((s) => {
              const tone = rowTone(s, baseline);
              return (
                <tr
                  key={`${report.dim}-${s.value}`}
                  className="border-t border-border/40"
                >
                  <td className="px-2 py-1 font-mono text-foreground/90">
                    {s.value}
                  </td>
                  <td className="px-2 py-1 text-right font-mono text-muted-foreground">
                    {s.count}
                  </td>
                  <td
                    className={`px-2 py-1 text-right font-mono font-semibold ${toneClasses(tone)}`}
                  >
                    {s.insufficient ? (
                      <span className="text-muted-foreground/60 font-normal">
                        (insufficient)
                      </span>
                    ) : (
                      fmtPct(s.winRate)
                    )}
                  </td>
                  <td
                    className={`px-2 py-1 text-right font-mono ${
                      s.count === 0
                        ? 'text-muted-foreground'
                        : s.avgReturnPct >= 0
                          ? 'text-green-400/80'
                          : 'text-red-400/80'
                    }`}
                  >
                    {s.count === 0 ? '—' : fmtReturn(s.avgReturnPct)}
                  </td>
                  <td className="px-2 py-1 text-right font-mono text-foreground/70">
                    {s.avgR == null
                      ? '—'
                      : `${fmtR(s.avgR)}`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── gamma × session heatmap ────────────────────────────────────────────────

const GAMMA_ORDER: Array<CrossCell['gamma']> = ['positive', 'negative', 'unknown'];
const SESSION_ORDER: Array<CrossCell['session']> = ['open', 'midday', 'close', 'other'];

function heatColor(
  winRate: number,
  baseline: number,
  insufficient: boolean,
  count: number,
): string {
  if (insufficient || count === 0) return 'hsl(var(--muted) / 0.2)';
  const delta = winRate - baseline;
  // Map ±30pp → alpha 1. Below 0 = red, above 0 = green.
  const alpha = Math.min(1, Math.abs(delta) / 0.3);
  if (delta >= 0) {
    return `hsl(140 70% 45% / ${Math.max(0.08, alpha).toFixed(3)})`;
  }
  return `hsl(0 75% 55% / ${Math.max(0.08, alpha).toFixed(3)})`;
}

function CrossHeatmap({
  cells,
  baseline,
}: {
  cells: CrossCell[];
  baseline: number;
}) {
  const byKey = useMemo(() => {
    const m = new Map<string, CrossCell>();
    for (const c of cells) m.set(`${c.gamma}|${c.session}`, c);
    return m;
  }, [cells]);

  return (
    <div className="rounded border border-border bg-muted/10 p-2.5">
      <div className="flex items-center gap-1.5 mb-1">
        <span className="text-[10px] uppercase tracking-wider text-foreground/80 font-semibold">
          Gamma × Session — win rate
        </span>
      </div>
      <div className="text-[10px] text-muted-foreground mb-2 leading-relaxed">
        Multi-dimensional edge pockets. Green = above baseline, red = below. Count in
        corner. Cells with &lt; 3 samples shown muted with dashed border.
      </div>

      <ChartSafe label="gamma × session heatmap">
        <div className="overflow-x-auto">
          <table className="text-[11px] border-separate border-spacing-0">
            <thead>
              <tr>
                <th className="px-2 py-1 text-[9px] uppercase tracking-wide text-muted-foreground font-medium text-left">
                  gamma ↓ / session →
                </th>
                {SESSION_ORDER.map((s) => (
                  <th
                    key={s}
                    className="px-2 py-1 text-[9px] uppercase tracking-wide text-muted-foreground font-medium text-center"
                  >
                    {s}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {GAMMA_ORDER.map((g) => (
                <tr key={g}>
                  <td className="px-2 py-1 text-[10px] font-mono text-foreground/80 border-r border-border/40">
                    {g === 'positive' ? '+Γ' : g === 'negative' ? '−Γ' : '?Γ'}
                  </td>
                  {SESSION_ORDER.map((s) => {
                    const cell = byKey.get(`${g}|${s}`);
                    if (!cell) {
                      return (
                        <td
                          key={s}
                          className="min-w-[72px] h-[48px] border border-dashed border-border/40 text-center align-middle text-muted-foreground/50 text-[10px]"
                        >
                          —
                        </td>
                      );
                    }
                    const muted = cell.insufficient || cell.count === 0;
                    const bg = heatColor(cell.winRate, baseline, cell.insufficient, cell.count);
                    return (
                      <td
                        key={s}
                        className={`min-w-[72px] h-[48px] text-center align-middle relative ${
                          muted
                            ? 'border border-dashed border-border/40'
                            : 'border border-border/50'
                        }`}
                        style={{ background: bg }}
                        title={`${g} · ${s}: ${cell.count} claims, ${(cell.winRate * 100).toFixed(0)}% win rate${muted ? ' (sparse)' : ''}`}
                      >
                        <div
                          className={`font-mono font-semibold ${
                            muted ? 'text-muted-foreground/60' : 'text-foreground'
                          }`}
                        >
                          {muted ? '—' : fmtPct(cell.winRate)}
                        </div>
                        <div className="absolute top-0.5 right-1 text-[9px] font-mono text-foreground/60">
                          n={cell.count}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ChartSafe>
    </div>
  );
}

// ─── main panel ─────────────────────────────────────────────────────────────

export function RegimeConditionalPanel() {
  const { data, isLoading } = useRegimeConditionalPerformance();

  const baseline = data?.overallWinRate ?? 0;

  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
        <Compass className="w-3 h-3" />
        Where Claude actually has edge
        <span className="normal-case tracking-normal text-muted-foreground/70">
          — regime-conditional hit rates (last 30d)
        </span>
        {data && (
          <span className="ml-auto normal-case tracking-normal font-mono">
            n={data.sample} · baseline {fmtPct(baseline)}
          </span>
        )}
      </div>
      <p className="text-[10px] text-muted-foreground mb-3 leading-relaxed">
        The overall hit rate is one number. Sliced by regime, it fans out into
        conditional edges. Green = regime hit rate &gt; baseline +10pp, amber
        within ±10pp, red &gt; baseline −10pp. Rows with &lt; 3 samples show as
        "insufficient".
      </p>

      {isLoading && (
        <div className="text-xs text-muted-foreground py-6 text-center">
          loading regime slices…
        </div>
      )}

      {data && data.dataThinNote && (
        <div className="mb-3 rounded border border-amber-500/30 bg-amber-500/5 px-2.5 py-2 text-[11px] text-amber-300 flex items-start gap-1.5">
          <Info className="w-3 h-3 mt-0.5 shrink-0" />
          <span>{data.dataThinNote}</span>
        </div>
      )}

      {data && data.sample === 0 ? (
        <div className="rounded border border-dashed border-muted bg-muted/10 px-3 py-6 text-center">
          <p className="text-xs text-muted-foreground leading-relaxed">
            No graded alerts+flags in the 30d window yet. Regime slices light up
            once the first horizon closes land with a heartbeat + IV lookup hit.
          </p>
        </div>
      ) : data ? (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {data.dimensions.map((d) => (
              <DimensionTable key={d.dim} report={d} baseline={baseline} />
            ))}
          </div>

          <div className="mt-3">
            <CrossHeatmap cells={data.crossGammaSession} baseline={baseline} />
          </div>

          <div className="mt-3 text-[10px] text-muted-foreground leading-relaxed">
            <span className="text-foreground/80 font-semibold">Caveat — multiple testing:</span>{' '}
            ~30 slice comparisons across six dimensions. At alpha=0.05, roughly
            1–2 spurious "edges" are expected by chance even if Claude has no
            real conditional edge. Don't read a single green row as confirmation.
            The 2D heatmap (joint conditioning) is a tighter test: spurious edges
            don't survive a second conditioning dimension. Treat this panel as a
            hypothesis generator — convert any candidate edge into a pre-registered
            check before trusting it.
          </div>

          <div className="mt-1 text-[10px] text-muted-foreground/80 leading-relaxed">
            <span className="text-foreground/70 font-semibold">OPEX note:</span>{' '}
            "OPEX week" = Thursday + Friday of the 3rd Friday of each month
            (standard monthly equity OPEX). Quarterly / triple-witching not
            distinguished. Approximation per task constraints.
          </div>
        </>
      ) : null}
    </Card>
  );
}

export default RegimeConditionalPanel;
