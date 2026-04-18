/**
 * CorrelationMatrix — 12×12 Pearson-correlation heatmap of the watchlist.
 *
 * Source: ct_ticker_correlation_cache (populated weekdays 22:00 UTC by
 * ct-correlation-compute). One row per unordered pair + self-pair diagonals.
 *
 * Rendering rules (kept simple because a 12×12 grid is readable but tight):
 *   - Diagonal = 1.0 (self-pair) rendered in neutral grey.
 *   - Off-diagonal cell color: −1 red → 0 white → +1 green, linear.
 *   - Cell shows the correlation as a 2-decimal number. No number when
 *     sample_size < 7 — we render a dash and an "insufficient" tooltip
 *     instead (consistent with the edge function's thin-history contract).
 *   - Click a cell → Dialog with a 30-day scatter of the two tickers'
 *     daily returns (ScatterChart, wrapped in ChartSafe).
 *   - Whole grid is wrapped so warming-up state shows a single empty-state
 *     card instead of 144 dashes.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  ZAxis,
  CartesianGrid,
  Tooltip as RTooltip,
  ReferenceLine,
  ResponsiveContainer,
} from 'recharts';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from '@/components/ui/tooltip';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ChartSafe } from '@/components/ChartSafe';
import { Grid3x3, AlertTriangle } from 'lucide-react';
import { pearson, toReturns } from '@/lib/correlation';
import { useOpenTrades } from '@/hooks/useStressScenarios';
import { finiteDomain, safeMin, safeMax } from '@/lib/chartSanitize';

const LOOKBACK_DAYS = 30;
const MIN_SAMPLE = 7;

// Mirrors the default in supabase/functions/_shared/watchlist.ts. Only used
// as a render-time fallback when the cache is empty (first-deploy state).
const DEFAULT_WATCHLIST_FALLBACK = [
  'SPY', 'QQQ', 'IWM',
  'NVDA', 'AAPL', 'MSFT', 'META', 'GOOGL', 'AMZN', 'TSLA',
  'GLD', 'USO',
];

interface CorrelationRow {
  ticker_a: string;
  ticker_b: string;
  correlation_pearson: number | null;
  correlation_rolling_20d: number | null;
  sample_size: number;
  lookback_days: number;
  computed_at: string;
}

// ---------------------------------------------------------------------------
// Data hooks
// ---------------------------------------------------------------------------
function useCorrelationCache() {
  return useQuery<CorrelationRow[]>({
    queryKey: ['ct_ticker_correlation_cache', LOOKBACK_DAYS],
    refetchInterval: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('ct_ticker_correlation_cache')
        .select('ticker_a,ticker_b,correlation_pearson,correlation_rolling_20d,sample_size,lookback_days,computed_at')
        .eq('lookback_days', LOOKBACK_DAYS);
      if (error) throw error;
      return (data ?? []) as CorrelationRow[];
    },
  });
}

// ---------------------------------------------------------------------------
// Color scale: −1 red → 0 white → +1 green, linear in the |r| magnitude.
// We interpolate in HSL-ish land via rgb lerp between white and endpoint.
// ---------------------------------------------------------------------------
function cellColor(r: number | null): string {
  if (r == null || !Number.isFinite(r)) return 'hsl(var(--muted) / 0.3)';
  const clamped = Math.max(-1, Math.min(1, r));
  const mag = Math.abs(clamped); // 0..1
  // Green = #00C853, Red = #FF1744, White = #FFFFFF (background-friendly).
  // We go for translucent fills so the numbers remain readable on top.
  if (clamped >= 0) {
    // Blend white → green
    const g = { r: 0, g: 200, b: 83 };
    const R = Math.round(255 + (g.r - 255) * mag);
    const G = Math.round(255 + (g.g - 255) * mag);
    const B = Math.round(255 + (g.b - 255) * mag);
    return `rgb(${R} ${G} ${B} / 0.55)`;
  } else {
    const red = { r: 255, g: 23, b: 68 };
    const R = Math.round(255 + (red.r - 255) * mag);
    const G = Math.round(255 + (red.g - 255) * mag);
    const B = Math.round(255 + (red.b - 255) * mag);
    return `rgb(${R} ${G} ${B} / 0.55)`;
  }
}

/** Text color chosen to stay readable against the pale tinted cells. */
function textColorFor(r: number | null): string {
  if (r == null) return 'hsl(var(--muted-foreground))';
  return Math.abs(r) > 0.55 ? '#111' : 'inherit';
}

function fmtCorr(r: number | null): string {
  if (r == null || !Number.isFinite(r)) return '—';
  const s = r.toFixed(2);
  // Strip a leading '+' so columns stay aligned; include '-' when negative.
  return s;
}

// ---------------------------------------------------------------------------
// Detail dialog — scatter of 30d daily returns for a pair
// ---------------------------------------------------------------------------
interface DetailPayload {
  tickerA: string;
  tickerB: string;
  r30?: number | null;
  r20?: number | null;
  n?: number;
}

interface TickRow {
  tick_time: string;
  price: number;
}

function useClosesForTicker(ticker: string | null) {
  return useQuery<TickRow[]>({
    queryKey: ['correlation_detail_closes', ticker],
    enabled: !!ticker,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      if (!ticker) return [];
      // 33 days buffer so we have enough for a 30-day return window plus a
      // couple tolerance days for weekends/holidays.
      const sinceIso = new Date(Date.now() - 33 * 24 * 60 * 60 * 1000).toISOString();
      // Try ct_price_ticks first (may cover only 7 days), fall back to heartbeats.
      const [ticksRes, hbRes] = await Promise.all([
        supabase
          .from('ct_price_ticks')
          .select('tick_time, price')
          .eq('ticker', ticker)
          .gte('tick_time', sinceIso)
          .order('tick_time', { ascending: true }),
        supabase
          .from('ct_heartbeats')
          .select('created_at, current_reads')
          .gte('created_at', sinceIso)
          .order('created_at', { ascending: true }),
      ]);

      const byDate = new Map<string, { tick_time: string; price: number }>();
      if (!hbRes.error && hbRes.data) {
        for (const hb of hbRes.data as Array<{ created_at: string; current_reads: unknown }>) {
          const reads = hb.current_reads as { _snapshot?: { per_ticker?: Record<string, { price?: number | null }> } } | null;
          const cell = reads?._snapshot?.per_ticker?.[ticker];
          const price = cell?.price == null ? NaN : Number(cell.price);
          if (!Number.isFinite(price)) continue;
          const key = hb.created_at.slice(0, 10);
          byDate.set(key, { tick_time: key, price });
        }
      }
      if (!ticksRes.error && ticksRes.data) {
        for (const row of ticksRes.data as Array<{ tick_time: string; price: number | string | null }>) {
          const price = Number(row.price);
          if (!Number.isFinite(price)) continue;
          const key = row.tick_time.slice(0, 10);
          byDate.set(key, { tick_time: key, price }); // ticks win
        }
      }
      return [...byDate.values()].sort((a, b) => a.tick_time.localeCompare(b.tick_time));
    },
  });
}

function CorrelationDetailDialog({
  detail,
  onClose,
}: {
  detail: DetailPayload | null;
  onClose: () => void;
}) {
  const { data: aRows, isLoading: aLoading } = useClosesForTicker(detail?.tickerA ?? null);
  const { data: bRows, isLoading: bLoading } = useClosesForTicker(detail?.tickerB ?? null);

  const { points, r } = useMemo(() => {
    if (!aRows?.length || !bRows?.length) return { points: [], r: NaN };
    const bMap = new Map(bRows.map((row) => [row.tick_time, row.price]));
    const alignedA: number[] = [];
    const alignedB: number[] = [];
    for (const ra of aRows) {
      const pb = bMap.get(ra.tick_time);
      if (pb == null) continue;
      alignedA.push(ra.price);
      alignedB.push(pb);
    }
    const xs = toReturns(alignedA);
    const ys = toReturns(alignedB);
    const pts = xs.map((x, i) => ({ x, y: ys[i] }));
    return { points: pts, r: pearson(xs, ys) };
  }, [aRows, bRows]);

  // Explicit scatter axis domains — ScatterChart auto-domains collapse when
  // all returns on one axis are identical (stale prices, constants), which
  // trips decimal.js LN10. Returns are small decimals (~-0.1..0.1); nudge
  // 0.01 when flat.
  const xDomain = useMemo<[number, number]>(() => {
    const xs = points.map(p => p.x);
    return finiteDomain(safeMin(xs), safeMax(xs), [-0.05, 0.05], 0.01);
  }, [points]);
  const yDomain = useMemo<[number, number]>(() => {
    const ys = points.map(p => p.y);
    return finiteDomain(safeMin(ys), safeMax(ys), [-0.05, 0.05], 0.01);
  }, [points]);

  const open = !!detail;
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <span className="font-mono">{detail?.tickerA}</span>
            <span className="text-muted-foreground">×</span>
            <span className="font-mono">{detail?.tickerB}</span>
            <span className="text-muted-foreground font-normal ml-2 text-[11px]">
              daily returns · last {LOOKBACK_DAYS}d
            </span>
          </DialogTitle>
        </DialogHeader>
        <div className="text-[11px] font-mono text-muted-foreground flex gap-4">
          <span>pearson 30d: <span className="font-semibold text-foreground">{fmtCorr(detail?.r30 ?? null)}</span></span>
          <span>rolling 20d: <span className="font-semibold text-foreground">{fmtCorr(detail?.r20 ?? null)}</span></span>
          <span>live calc: <span className="font-semibold text-foreground">{fmtCorr(Number.isFinite(r) ? r : null)}</span></span>
          <span>n = {points.length}</span>
        </div>
        <div className="h-[340px]">
          {aLoading || bLoading ? (
            <div className="flex items-center justify-center h-full text-xs text-muted-foreground">loading…</div>
          ) : points.length < 2 ? (
            <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
              not enough paired observations to scatter
            </div>
          ) : (
            <ChartSafe label="correlation scatter">
              <ResponsiveContainer width="100%" height="100%">
                <ScatterChart margin={{ top: 12, right: 16, left: 8, bottom: 20 }}>
                  <CartesianGrid stroke="hsl(var(--border) / 0.4)" strokeDasharray="3 3" />
                  <XAxis
                    type="number"
                    dataKey="x"
                    domain={xDomain}
                    allowDataOverflow={false}
                    name={`${detail?.tickerA} return`}
                    tickFormatter={(v: number) => `${(v * 100).toFixed(1)}%`}
                    tick={{ fontSize: 9, fill: 'hsl(var(--muted-foreground))' }}
                    label={{ value: `${detail?.tickerA} daily %`, position: 'insideBottom', offset: -8, style: { fontSize: 10, fill: 'hsl(var(--muted-foreground))' } }}
                  />
                  <YAxis
                    type="number"
                    dataKey="y"
                    domain={yDomain}
                    allowDataOverflow={false}
                    name={`${detail?.tickerB} return`}
                    tickFormatter={(v: number) => `${(v * 100).toFixed(1)}%`}
                    tick={{ fontSize: 9, fill: 'hsl(var(--muted-foreground))' }}
                    label={{ value: `${detail?.tickerB} daily %`, angle: -90, position: 'insideLeft', style: { fontSize: 10, fill: 'hsl(var(--muted-foreground))' } }}
                  />
                  <ZAxis range={[40, 40]} />
                  <ReferenceLine x={0} stroke="hsl(var(--border))" strokeDasharray="2 2" />
                  <ReferenceLine y={0} stroke="hsl(var(--border))" strokeDasharray="2 2" />
                  <RTooltip
                    cursor={{ strokeDasharray: '3 3', stroke: 'hsl(var(--border))' }}
                    contentStyle={{
                      background: 'hsl(var(--popover))',
                      border: '1px solid hsl(var(--border))',
                      fontSize: '10px',
                      padding: '4px 6px',
                    }}
                    formatter={(v: number) => `${(v * 100).toFixed(2)}%`}
                  />
                  <Scatter data={points} fill="hsl(var(--primary))" fillOpacity={0.7} />
                </ScatterChart>
              </ResponsiveContainer>
            </ChartSafe>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Matrix
// ---------------------------------------------------------------------------
export function CorrelationMatrix() {
  const { data: rows, isLoading } = useCorrelationCache();
  const [detail, setDetail] = useState<DetailPayload | null>(null);

  const tickers = useMemo(() => {
    // Derive the ticker list from the cache so UI stays honest to whatever
    // the cron actually wrote. Fall back to the client-side watchlist default
    // if the cache is empty (warming-up state).
    if (rows && rows.length > 0) {
      const set = new Set<string>();
      for (const r of rows) {
        set.add(r.ticker_a);
        set.add(r.ticker_b);
      }
      return [...set].sort();
    }
    return [...DEFAULT_WATCHLIST_FALLBACK];
  }, [rows]);

  // Build an unordered-pair lookup: key = "A|B" with A <= B alphabetical.
  const pairLookup = useMemo(() => {
    const map = new Map<string, CorrelationRow>();
    for (const r of rows ?? []) {
      const [a, b] = r.ticker_a < r.ticker_b ? [r.ticker_a, r.ticker_b] : [r.ticker_b, r.ticker_a];
      map.set(`${a}|${b}`, r);
    }
    return map;
  }, [rows]);

  const lookup = (a: string, b: string): CorrelationRow | undefined => {
    const [x, y] = a < b ? [a, b] : [b, a];
    return pairLookup.get(`${x}|${y}`);
  };

  const lastComputed = useMemo(() => {
    if (!rows || rows.length === 0) return null;
    return rows.reduce((acc, r) => (r.computed_at > acc ? r.computed_at : acc), rows[0].computed_at);
  }, [rows]);

  const nonSelfRows = (rows ?? []).filter((r) => r.ticker_a !== r.ticker_b);
  const populated = nonSelfRows.filter((r) => r.sample_size >= MIN_SAMPLE).length;
  const warming = nonSelfRows.length > 0 && populated === 0;
  const empty = !isLoading && (!rows || rows.length === 0);

  return (
    <Card className="overflow-hidden">
      <div className="px-4 py-2.5 border-b border-border bg-muted/20 flex items-center gap-2">
        <Grid3x3 className="w-4 h-4 text-primary" />
        <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground">
          Correlation Matrix
        </h3>
        <span className="text-[10px] text-muted-foreground">
          {LOOKBACK_DAYS}-day daily returns · {populated}/{nonSelfRows.length} pairs populated
        </span>
        {lastComputed && (
          <span className="ml-auto text-[9px] text-muted-foreground font-mono">
            computed {new Date(lastComputed).toLocaleString()}
          </span>
        )}
      </div>

      {isLoading ? (
        <div className="p-6 text-xs text-muted-foreground">loading…</div>
      ) : empty ? (
        <div className="p-6 text-xs text-muted-foreground italic">
          No correlation data yet — ct-correlation-compute runs weekdays at 22:00 UTC.
        </div>
      ) : warming ? (
        <div className="p-6 text-xs text-muted-foreground italic">
          Warming up — {LOOKBACK_DAYS}-day window needs ≥ {MIN_SAMPLE} paired daily observations per pair. Keep heartbeats running.
        </div>
      ) : (
        <TooltipProvider delayDuration={150}>
          <div className="overflow-x-auto p-3">
            <table className="text-[10px] font-mono border-separate border-spacing-0 mx-auto">
              <thead>
                <tr>
                  <th className="w-10"></th>
                  {tickers.map((t) => (
                    <th
                      key={`col-${t}`}
                      className="px-1 py-1 text-[9px] font-semibold text-muted-foreground uppercase"
                    >
                      {t}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tickers.map((rowTicker) => (
                  <tr key={`row-${rowTicker}`}>
                    <th
                      scope="row"
                      className="px-2 py-1 text-right text-[9px] font-semibold text-muted-foreground uppercase"
                    >
                      {rowTicker}
                    </th>
                    {tickers.map((colTicker) => {
                      const isSelf = rowTicker === colTicker;
                      const row = lookup(rowTicker, colTicker);
                      const r = isSelf ? 1 : row?.correlation_pearson ?? null;
                      const n = isSelf ? (row?.sample_size ?? 0) : (row?.sample_size ?? 0);
                      const r20 = isSelf ? 1 : row?.correlation_rolling_20d ?? null;
                      const insufficient = !isSelf && n < MIN_SAMPLE;

                      const display = insufficient ? '—' : fmtCorr(r);
                      const bg = isSelf
                        ? 'hsl(var(--muted) / 0.45)'
                        : insufficient
                          ? 'hsl(var(--muted) / 0.15)'
                          : cellColor(r);

                      const cellNode = (
                        <td
                          key={`${rowTicker}-${colTicker}`}
                          className={`w-[46px] h-[28px] text-center align-middle border border-border/50 ${
                            isSelf ? '' : 'cursor-pointer hover:outline hover:outline-1 hover:outline-primary'
                          }`}
                          style={{ background: bg, color: textColorFor(isSelf ? null : r) }}
                          onClick={() => {
                            if (isSelf) return;
                            setDetail({
                              tickerA: rowTicker,
                              tickerB: colTicker,
                              r30: r,
                              r20,
                              n,
                            });
                          }}
                        >
                          {display}
                        </td>
                      );

                      const tipLabel = isSelf
                        ? `${rowTicker} (self = 1.00)`
                        : insufficient
                          ? `${rowTicker}-${colTicker}: insufficient history (n=${n}, need ≥ ${MIN_SAMPLE})`
                          : `${rowTicker}-${colTicker}: ${fmtCorr(r)} (${LOOKBACK_DAYS}d, n=${n} obs${r20 != null ? ` · 20d=${fmtCorr(r20)}` : ''})`;

                      return (
                        <Tooltip key={`tip-${rowTicker}-${colTicker}`}>
                          <TooltipTrigger asChild>{cellNode}</TooltipTrigger>
                          <TooltipContent side="top" className="text-[10px]">
                            {tipLabel}
                          </TooltipContent>
                        </Tooltip>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Legend */}
            <div className="mt-3 flex items-center justify-center gap-2 text-[9px] text-muted-foreground">
              <span>−1.0</span>
              <div
                className="h-2 w-48 rounded"
                style={{
                  background:
                    'linear-gradient(to right, rgb(255 23 68 / 0.75), rgb(255 255 255 / 0.6), rgb(0 200 83 / 0.75))',
                }}
              />
              <span>+1.0</span>
              <span className="ml-4 italic">click a cell for the return scatter · n &lt; {MIN_SAMPLE} shown as dash</span>
            </div>
          </div>
        </TooltipProvider>
      )}

      <CorrelationDetailDialog detail={detail} onClose={() => setDetail(null)} />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Portfolio-wide correlation warning
// ---------------------------------------------------------------------------
/**
 * Compute the weighted average pairwise correlation of the currently-open
 * book, weighted by |size_usd_i · size_usd_j|. Longs vs shorts are handled
 * by sign-flipping: a long SPY + short QQQ pair with raw r=0.92 contributes
 * a NEGATIVE 0.92 to the book correlation (opposite directional bets on
 * correlated assets HEDGE each other — they're uncorrelated directional
 * exposure, not duplicated exposure).
 *
 * Output: a single number in [-1, +1].
 *
 *   +0.8  →  "3 positions are effectively 1.5 positions of directional risk"
 *    0    →  well diversified
 *   -0.4  →  net hedged structure
 *
 * Effective-position count = n / (1 + (n-1)·avg_r) when avg_r > 0. Below 0
 * we just show n (a hedged book doesn't "multiply" into >n effective bets).
 */
interface OpenTradeLite {
  instrument: string;
  side: 'long' | 'short';
  size_usd: number | null;
  status: string;
}

function computePortfolioCorrelation(
  trades: OpenTradeLite[],
  lookup: (a: string, b: string) => CorrelationRow | undefined,
): { avg: number | null; covered: number; total: number; n: number } {
  // Collapse to one weight per instrument (merging multiple legs on same
  // ticker by side → signed size). Options are included at their cash size
  // because that's what the sizing calc stores — good enough for a book
  // correlation heuristic; Greeks-adjusted is overkill for a banner.
  const signedByTicker = new Map<string, number>();
  for (const t of trades) {
    if (!t.instrument || t.size_usd == null || !Number.isFinite(t.size_usd)) continue;
    const sign = t.side === 'short' ? -1 : 1;
    const prev = signedByTicker.get(t.instrument) ?? 0;
    signedByTicker.set(t.instrument, prev + sign * Math.abs(t.size_usd));
  }
  const tickers = [...signedByTicker.keys()];
  const n = tickers.length;
  if (n < 2) return { avg: null, covered: 0, total: 0, n };

  let num = 0;
  let den = 0;
  let covered = 0;
  let total = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      total++;
      const ta = tickers[i];
      const tb = tickers[j];
      const row = lookup(ta, tb);
      if (!row || row.correlation_pearson == null || row.sample_size < MIN_SAMPLE) continue;
      const wa = signedByTicker.get(ta)!;
      const wb = signedByTicker.get(tb)!;
      // Sign-flip correlation based on the product of signs of the two
      // notional exposures. Long·Long and Short·Short keep r positive;
      // Long·Short flips r's sign. Weights themselves are |w|.
      const signProduct = Math.sign(wa) * Math.sign(wb);
      const effectiveR = signProduct * row.correlation_pearson;
      const w = Math.abs(wa) * Math.abs(wb);
      num += w * effectiveR;
      den += w;
      covered++;
    }
  }
  if (den <= 0) return { avg: null, covered, total, n };
  return { avg: num / den, covered, total, n };
}

export function PortfolioCorrelationWarning() {
  const { data: rows } = useCorrelationCache();
  const { data: trades, isLoading: tradesLoading } = useOpenTrades();

  const pairLookup = useMemo(() => {
    const map = new Map<string, CorrelationRow>();
    for (const r of rows ?? []) {
      const [a, b] = r.ticker_a < r.ticker_b ? [r.ticker_a, r.ticker_b] : [r.ticker_b, r.ticker_a];
      map.set(`${a}|${b}`, r);
    }
    return map;
  }, [rows]);

  const lookup = (a: string, b: string) => {
    const [x, y] = a < b ? [a, b] : [b, a];
    return pairLookup.get(`${x}|${y}`);
  };

  const { avg, covered, total, n } = useMemo(
    () => computePortfolioCorrelation((trades ?? []) as OpenTradeLite[], lookup),
    [trades, pairLookup], // eslint-disable-line react-hooks/exhaustive-deps
  );

  if (tradesLoading) return null;
  if (n < 2) return null; // single position → no correlation story
  if (avg == null) {
    return (
      <Card className="px-4 py-2.5 flex items-center gap-3 text-[11px] bg-muted/20">
        <AlertTriangle className="w-3.5 h-3.5 text-muted-foreground" />
        <span className="text-muted-foreground">
          Book has {n} open positions but correlation cache has no coverage yet — warming up.
        </span>
      </Card>
    );
  }

  const pct = avg * 100;
  // Effective-position count only meaningful when avg > 0.
  const effectiveN = avg > 0 ? n / (1 + (n - 1) * avg) : n;
  const tier: 'ok' | 'watch' | 'alert' =
    avg >= 0.7 ? 'alert' : avg >= 0.4 ? 'watch' : 'ok';
  const tierColor = tier === 'alert' ? 'text-red-400' : tier === 'watch' ? 'text-orange-400' : 'text-emerald-400';
  const tierBg = tier === 'alert' ? 'bg-red-500/10 border-red-500/40' : tier === 'watch' ? 'bg-orange-500/10 border-orange-500/40' : 'bg-emerald-500/10 border-emerald-500/30';

  const message =
    tier === 'alert'
      ? `Current book is ${pct.toFixed(0)}% correlated — your ${n} positions behave like ${effectiveN.toFixed(1)} positions of directional risk. Consider diversification.`
      : tier === 'watch'
        ? `Current book is ${pct.toFixed(0)}% correlated — ${n} positions ≈ ${effectiveN.toFixed(1)} effective bets. Monitor if adding more.`
        : avg < 0
          ? `Book has ${pct.toFixed(0)}% correlation — net hedged structure across ${n} positions.`
          : `Book is ${pct.toFixed(0)}% correlated across ${n} positions — diversification looks healthy.`;

  return (
    <Card className={`px-4 py-2.5 flex items-center gap-3 text-[11px] border ${tierBg}`}>
      <AlertTriangle className={`w-3.5 h-3.5 ${tierColor}`} />
      <span className={`${tierColor} font-semibold uppercase tracking-wide text-[10px]`}>
        {tier === 'alert' ? 'High correlation' : tier === 'watch' ? 'Watch correlation' : 'Diversification'}
      </span>
      <span className="text-foreground/90">{message}</span>
      <span className="ml-auto text-[9px] text-muted-foreground font-mono">
        {covered}/{total} pairs covered
      </span>
    </Card>
  );
}

export default CorrelationMatrix;
