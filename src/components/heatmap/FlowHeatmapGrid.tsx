/**
 * FlowHeatmapGrid — combined view: 10 watchlist tickers × N expiry-week columns.
 *
 * Custom CSS-grid heatmap. recharts is bad at heatmaps and we don't want a new
 * dep. Each cell is a div with a Tailwind bg class computed from the row's
 * (or the global table's) percentile distribution via `heatmapColors.ts`.
 *
 * Color scale:
 *   - Directional modes (net_signed, aggressive_directional_*) → 11-step
 *     orange→slate→blue diverging gradient.
 *   - Non-directional (total, voi_unusual) → 6-step sky-blue intensity ramp.
 *
 * Empty cells render as a light gray dash so absence of flow stays visible —
 * "the quiet ticker is signal" (per the spec).
 *
 * Click → onCellClick(cell). Hover → tooltip.
 */

import { useMemo } from 'react';
import type { HeatmapMathMode, HeatmapRow } from '@/hooks/useFlowHeatmap';
import { HEATMAP_DEFAULT_TICKERS } from '@/hooks/useFlowHeatmap';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  getCellColorClasses,
  isDirectionalMode,
  anchorLabel,
  DIVERGING_BG_CLASSES,
  SEQUENTIAL_BG_CLASSES,
  EMPTY_CELL_BG,
  EMPTY_CELL_TEXT,
} from './heatmapColors';
// Synthesis Layer Phase 5 — brain organ mirrors for row + cell enrichment.
// Each hook polls 30-60s and degrades to empty on missing data, so the grid
// renders fine even when one organ is unavailable.
import { useFlowPulse, type FlowPulseRow } from '@/hooks/useFlowPulse';
import {
  useDetectorFlagsByTicker,
  filterFlagsByExpiryBucket,
} from '@/hooks/useDetectorFlags';
import { useJamesFlags, jamesFlagMatchesCell } from '@/hooks/useJamesFlags';
import { useNewsCausality } from '@/hooks/useNewsCausality';
import { useHeatmapMultiModeAgreement } from '@/hooks/useHeatmapMultiModeAgreement';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface HeatmapCell {
  ticker: string;
  expiryBucketWeek: string;
  expiryCountInBucket: number;
  value: number;
  sourceAlertCount: number;
  contributingAlertIds: (string | number)[];
  latestSnapshotAt: string;
  /** Optional delta enrichment — populated when the page is using
   *  useFlowHeatmapLiveWithDelta and a baseline is set. */
  baselineValue?: number;
  deltaValue?: number;
  deltaPct?: number | null;
}

/** Compact dollar formatter for the delta chip — "+$2.4M", "-$1.1M", "±$0". */
function formatDeltaChip(delta: number): string {
  const abs = Math.abs(delta);
  let body: string;
  if (abs >= 1_000_000_000) body = `${(abs / 1_000_000_000).toFixed(1)}B`;
  else if (abs >= 1_000_000) body = `${(abs / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  else if (abs >= 1_000) body = `${Math.round(abs / 1_000)}K`;
  else body = abs.toFixed(0);
  if (delta > 0) return `+$${body}`;
  if (delta < 0) return `-$${body}`;
  return `±$0`;
}

/** Precise dollar string for the tooltip — "$1,234,567". */
function formatPreciseUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  return `${sign}$${abs.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

interface FlowHeatmapGridProps {
  rows: HeatmapRow[] | undefined;
  mathMode: HeatmapMathMode;
  colorAnchor: 'per_row' | 'global';
  onCellClick: (cell: HeatmapCell) => void;
  /** Override the default ticker list (defaults to the 10-ticker watchlist). */
  tickers?: string[];
}

function isPremiumMode(mode: HeatmapMathMode): boolean {
  return mode !== 'voi_unusual';
}

/** Format a value for display inside a cell. Compact by design (cells are narrow). */
function formatCellValue(value: number | null | undefined, mode: HeatmapMathMode): string {
  if (value == null || !Number.isFinite(value)) return '—';
  if (mode === 'voi_unusual') {
    return `${value.toFixed(1)}×`;
  }
  const abs = Math.abs(value);
  let body: string;
  if (abs >= 1_000_000_000) body = `${(abs / 1_000_000_000).toFixed(1)}B`;
  else if (abs >= 1_000_000) body = `${(abs / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  else if (abs >= 1_000) body = `${(abs / 1_000).toFixed(0)}K`;
  else body = abs.toFixed(0);
  if (isDirectionalMode(mode)) {
    if (value > 0) return `+${body}`;
    if (value < 0) return `-${body}`;
  }
  return body;
}

/** Format a value for tooltip — fully precise. */
function formatTooltipValue(value: number | null | undefined, mode: HeatmapMathMode): string {
  if (value == null || !Number.isFinite(value)) return '—';
  if (mode === 'voi_unusual') return `${value.toFixed(2)}× volume / OI`;
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  return `${sign}$${abs.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

/** ISO YYYY-MM-DD → "Mar 18" / "Mar 18 (0DTE)" / "Mar 18 (monthly)". */
function formatExpiryHeader(iso: string, _expiryCount: number): { date: string; hint: string } {
  const d = new Date(iso + 'T00:00:00Z');
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const dayMs = 86_400_000;
  const daysOut = Math.round((d.getTime() - today.getTime()) / dayMs);
  const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

  let hint = 'weekly';
  if (daysOut <= 0) hint = '0DTE';
  else if (daysOut > 60) hint = 'quarterly';
  else if (daysOut > 25) hint = 'monthly';
  return { date, hint };
}

// ---------------------------------------------------------------------------
// Phase 5 — row chips and cell-marker rendering helpers
// ---------------------------------------------------------------------------

type DirectionLeanBucket = 'bullish' | 'bearish' | 'neutral' | 'mixed';

function leanBucketColor(lean: DirectionLeanBucket | null | undefined): string {
  switch (lean) {
    case 'bullish': return 'bg-sky-500/20 text-sky-200 border-sky-500/40';
    case 'bearish': return 'bg-orange-500/20 text-orange-200 border-orange-500/40';
    case 'mixed':   return 'bg-slate-500/20 text-slate-200 border-slate-500/40';
    case 'neutral': return 'bg-muted/40 text-muted-foreground border-border';
    default:        return 'bg-muted/30 text-muted-foreground/70 border-border/40';
  }
}

/** Concise FlowPulse regime tag for the row chip. Tone follows premium-net sign. */
function pulseRegimeLabel(p: FlowPulseRow | undefined): { label: string; tone: DirectionLeanBucket } {
  if (!p) return { label: '—', tone: 'neutral' };
  const net = Number.isFinite(p.premium_net) ? p.premium_net : 0;
  const cp = Number.isFinite(p.call_put_ratio) ? p.call_put_ratio : 1;
  let tone: DirectionLeanBucket = 'neutral';
  if (Math.abs(net) < 50_000) tone = cp > 1.5 ? 'bullish' : cp < 0.66 ? 'bearish' : 'neutral';
  else tone = net > 0 ? 'bullish' : 'bearish';
  let regime = 'steady';
  if (p.is_unusual) regime = 'unusual';
  else if (cp > 2 || cp < 0.5) regime = 'tilted';
  else if (Math.abs(net) > 1_000_000) regime = 'flowing';
  return { label: regime, tone };
}

// ---------------------------------------------------------------------------
// Batched specialist-reads query — one row per ticker, latest by updated_at.
// useSpecialistReads (single-ticker hook) violates hook-rules in a render loop.
// ---------------------------------------------------------------------------

interface BatchedSpecialistRead {
  ticker: string;
  read_text: string;
  direction_lean: DirectionLeanBucket | null;
  conviction: number | null;
  updated_at: string;
}

function useSpecialistReadsForTickers(tickers: string[]) {
  const sortedTickers = useMemo(() => [...tickers].sort(), [tickers]);
  const query = useQuery<BatchedSpecialistRead[]>({
    queryKey: ['specialist-reads-batch', sortedTickers],
    refetchInterval: 30_000,
    staleTime: 25_000,
    retry: false,
    queryFn: async () => {
      if (sortedTickers.length === 0) return [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sb: any = supabase;
      // Over-pull (3x ticker count) so we have headroom to keep the latest
      // per ticker. Deduped client-side.
      const { data, error } = await sb.from('ct_specialist_reads')
        .select('ticker, read_text, direction_lean, conviction, updated_at')
        .in('ticker', sortedTickers)
        .order('updated_at', { ascending: false })
        .limit(Math.min(sortedTickers.length * 3, 60));
      if (error) throw error;
      const seen = new Map<string, BatchedSpecialistRead>();
      for (const r of (Array.isArray(data) ? data : []) as BatchedSpecialistRead[]) {
        if (!r.ticker || seen.has(r.ticker)) continue;
        seen.set(r.ticker, r);
      }
      return Array.from(seen.values());
    },
  });
  const byTicker = useMemo(() => {
    const m = new Map<string, BatchedSpecialistRead>();
    for (const r of query.data ?? []) m.set(r.ticker.toUpperCase(), r);
    return m;
  }, [query.data]);
  return { byTicker, isLoading: query.isLoading };
}

// ---------------------------------------------------------------------------
// FlowHeatmapGrid
// ---------------------------------------------------------------------------

export function FlowHeatmapGrid({
  rows,
  mathMode,
  colorAnchor,
  onCellClick,
  tickers,
}: FlowHeatmapGridProps) {
  const tickerList = (tickers && tickers.length > 0) ? tickers : HEATMAP_DEFAULT_TICKERS;

  // ---------------------------------------------------------------------
  // Phase 5 — brain-organ data hooks for row + cell enrichment.
  //
  // Each hook is defensive (empty data on error / missing table) so a
  // partially-built brain doesn't break grid render. Polled at 30-60s; the
  // bell-ring useMarketHoursTrigger invalidator picks them up at the open.
  // ---------------------------------------------------------------------
  const { byTicker: detectorByTicker } = useDetectorFlagsByTicker({
    watchlist: tickerList,
    lookbackHours: 24,
    limit: 100,
  });
  const { byTicker: jamesByTicker } = useJamesFlags({
    watchlist: tickerList,
    lookbackHours: 24,
  });
  const news = useNewsCausality({ lookbackHours: 6, cap: 50, minSeverity: 3 });
  const { byTicker: specialistByTicker } = useSpecialistReadsForTickers(tickerList);
  const { rows: pulseRows } = useFlowPulse(60);
  const pulseByTicker = useMemo(() => {
    const m = new Map<string, FlowPulseRow>();
    for (const r of pulseRows ?? []) m.set(r.ticker.toUpperCase(), r);
    return m;
  }, [pulseRows]);

  // Multi-mode agreement: 3 directional RPCs fanned out (60s cadence). The
  // ring marker only renders when the visible mode is directional — for
  // non-directional modes we skip the entire computation.
  const isDirectional = isDirectionalMode(mathMode);
  const agreement = useHeatmapMultiModeAgreement({
    tickers: tickerList,
    enabled: isDirectional,
  });

  /** Index rows by [ticker][expiry_bucket_week]. Defensive: skip null/malformed rows. */
  const cellMap = useMemo(() => {
    const m = new Map<string, HeatmapRow>();
    for (const r of (rows || [])) {
      if (!r || !r.ticker || !r.expiry_bucket_week) continue;
      m.set(`${r.ticker}::${r.expiry_bucket_week}`, r);
    }
    return m;
  }, [rows]);

  /** Column headers — union of all expiry weeks present, sorted ascending. */
  const expiryWeeks = useMemo(() => {
    const set = new Set<string>();
    for (const r of (rows || [])) {
      if (r?.expiry_bucket_week) set.add(r.expiry_bucket_week);
    }
    return Array.from(set).sort();
  }, [rows]);

  /** Per-row pool of values for percentile coloring (per ticker). */
  const valuesByTicker = useMemo(() => {
    const m = new Map<string, number[]>();
    for (const r of (rows || [])) {
      if (!r || !r.ticker) continue;
      if (r.value == null || !Number.isFinite(r.value)) continue;
      const arr = m.get(r.ticker) ?? [];
      arr.push(r.value);
      m.set(r.ticker, arr);
    }
    return m;
  }, [rows]);

  /** Global pool of values for percentile coloring. */
  const allValues = useMemo(() => {
    const arr: number[] = [];
    for (const r of (rows || [])) {
      if (r?.value != null && Number.isFinite(r.value)) arr.push(r.value);
    }
    return arr;
  }, [rows]);

  if (!rows) {
    return (
      <div className="rounded-md border border-border bg-card/40 p-12 text-center text-sm text-muted-foreground">
        Loading heatmap…
      </div>
    );
  }

  if (expiryWeeks.length === 0) {
    return (
      <div className="rounded-md border border-border bg-card/40 p-12 text-center text-sm text-muted-foreground">
        No expiries match the current filters. Try lowering the min-premium floor or enabling 0DTE.
      </div>
    );
  }

  // Layout: ticker label column + N expiry columns. Use minmax so very long
  // expiry lists scroll horizontally and we don't squash cells unreadable.
  // Widened from 64px → 200px to fit the Phase 5 row chips (specialist lean,
  // pulse regime, hot-news count) inline alongside the ticker label.
  const gridTemplateColumns = `200px repeat(${expiryWeeks.length}, minmax(72px, 1fr))`;

  return (
    <TooltipProvider delayDuration={150}>
      <div className="rounded-md border border-border bg-card/40 overflow-x-auto">
        <div className="min-w-fit p-2">
          {/* Header row */}
          <div className="grid items-end mb-1" style={{ gridTemplateColumns }}>
            <div /> {/* ticker col spacer */}
            {expiryWeeks.map((wk) => {
              // Use the FIRST non-empty cell in this column to read expiry_count
              // — column-level hint, not per-row.
              const exampleRow = tickerList
                .map((t) => cellMap.get(`${t}::${wk}`))
                .find((r): r is HeatmapRow => !!r);
              const { date, hint } = formatExpiryHeader(wk, exampleRow?.expiry_count_in_bucket ?? 1);
              return (
                <div key={wk} className="px-1 pb-1 text-center">
                  <div className="text-[11px] font-mono text-foreground/80">{date}</div>
                  <div className={cn(
                    'text-[9px] uppercase tracking-wider mt-0.5',
                    hint === '0DTE' ? 'text-amber-300' : 'text-muted-foreground/70',
                  )}>{hint}</div>
                </div>
              );
            })}
          </div>

          {/* Body rows */}
          <div className="space-y-1">
            {tickerList.map((ticker) => {
              const rowValues = valuesByTicker.get(ticker) ?? [];
              const tkUpper = ticker.toUpperCase();
              // Phase 5 row chips — read straight from the brain organs.
              const specialist = specialistByTicker.get(tkUpper);
              const pulse = pulseByTicker.get(tkUpper);
              const pulseChip = pulseRegimeLabel(pulse);
              const hotNews = news.hotCountForTicker(tkUpper, { withinMin: 30, minSev: 3 });
              const tickerDetectorFlags = detectorByTicker.get(tkUpper) ?? [];
              const tickerJamesFlags = jamesByTicker.get(tkUpper) ?? [];
              return (
                <div key={ticker} className="grid items-center" style={{ gridTemplateColumns }}>
                  <div className="pl-2 pr-1 flex items-center gap-1.5 min-w-0">
                    <span className="text-[11px] font-mono font-semibold text-foreground/80 tabular-nums shrink-0">
                      {ticker}
                    </span>
                    {/* Specialist chip — direction lean + conviction */}
                    {specialist?.direction_lean ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span
                            className={cn(
                              'inline-flex items-center gap-0.5 px-1 py-px rounded-sm text-[9px] font-mono uppercase tracking-wide border',
                              leanBucketColor(specialist.direction_lean),
                            )}
                          >
                            <span>{specialist.direction_lean.slice(0, 4)}</span>
                            {specialist.conviction != null && (
                              <span className="opacity-70">{Math.round(specialist.conviction)}</span>
                            )}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="text-xs max-w-xs">
                          <div className="font-semibold mb-0.5">Specialist · {ticker}</div>
                          <div className="text-foreground/80 text-[11px]">{specialist.read_text}</div>
                        </TooltipContent>
                      </Tooltip>
                    ) : (
                      <span className="px-1 py-px rounded-sm text-[9px] font-mono uppercase tracking-wide border border-border/30 text-muted-foreground/50">
                        spec —
                      </span>
                    )}
                    {/* Pulse regime chip */}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span
                          className={cn(
                            'inline-flex items-center px-1 py-px rounded-sm text-[9px] font-mono uppercase tracking-wide border',
                            leanBucketColor(pulseChip.tone),
                          )}
                        >
                          {pulseChip.label}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="text-xs">
                        <div className="font-semibold mb-0.5">Pulse · {ticker}</div>
                        {pulse ? (
                          <div className="text-foreground/80 text-[11px] space-y-0.5">
                            <div>C/P ratio: {Number.isFinite(pulse.call_put_ratio) ? pulse.call_put_ratio.toFixed(2) : '—'}</div>
                            <div>net premium: ${Math.round((pulse.premium_net ?? 0) / 1000).toLocaleString()}K</div>
                            {pulse.is_unusual && <div className="text-amber-300">⚡ unusual vs 30d</div>}
                          </div>
                        ) : (
                          <div className="text-muted-foreground text-[11px]">no pulse data</div>
                        )}
                      </TooltipContent>
                    </Tooltip>
                    {/* Hot news badge — only if > 0 */}
                    {hotNews > 0 && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="inline-flex items-center px-1 py-px rounded-sm text-[9px] font-mono font-bold bg-rose-500/25 text-rose-200 border border-rose-500/40">
                            {hotNews}n
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="text-xs">
                          <div className="font-semibold">{hotNews} hot news ·  ≥sev 3, last 30m</div>
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </div>
                  {expiryWeeks.map((wk) => {
                    const row = cellMap.get(`${ticker}::${wk}`);
                    const value: number | null = row && row.value != null && Number.isFinite(row.value)
                      ? row.value
                      : null;
                    const sourceCount = row?.source_alert_count ?? 0;

                    // No row at all, OR row exists with null value AND zero alerts → "no flow" cell
                    if (!row || (value == null && sourceCount === 0)) {
                      return (
                        <div
                          key={wk}
                          className={cn(
                            'h-8 mx-0.5 rounded-sm flex items-center justify-center text-[10px] font-mono select-none',
                            EMPTY_CELL_BG,
                            EMPTY_CELL_TEXT,
                          )}
                          aria-label={`${ticker} ${wk} no flow`}
                        >
                          —
                        </div>
                      );
                    }

                    // Row exists but value is null with alerts present — log warn, render dash.
                    if (value == null) {
                      // eslint-disable-next-line no-console
                      console.warn('[FlowHeatmapGrid] null value with non-zero source_alert_count', {
                        ticker, wk, sourceCount,
                      });
                    }

                    const { bg, text } = getCellColorClasses(
                      value, colorAnchor, mathMode, rowValues, allValues,
                    );
                    const hasDelta = row.delta_value != null && Number.isFinite(row.delta_value);
                    const deltaVal = hasDelta ? (row.delta_value as number) : 0;
                    // Subtle, consistent strip bg per direction. The chip lives in
                    // its own dedicated bottom-right zone (rounded-sm) so it never
                    // overlaps the main value.
                    const deltaChipClass = !hasDelta
                      ? ''
                      : deltaVal > 0
                        ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                        : deltaVal < 0
                          ? 'bg-rose-500/15 text-rose-700 dark:text-rose-300'
                          : 'bg-slate-500/10 text-muted-foreground';

                    // Phase 5 cell-level enrichment ----------------------------------
                    // Detector flag border/glow when an active flag matches this cell.
                    const cellDetectorFlags = filterFlagsByExpiryBucket(
                      tickerDetectorFlags, ticker, wk,
                    );
                    const detectorBorder = (() => {
                      if (cellDetectorFlags.length === 0) return null;
                      // Strongest by score wins. Direction colors the ring.
                      const top = [...cellDetectorFlags].sort(
                        (a, b) => (b.score ?? 0) - (a.score ?? 0),
                      )[0];
                      const dirColor =
                        top.direction === 'bullish' ? 'ring-sky-400/80 shadow-sky-500/30'
                        : top.direction === 'bearish' ? 'ring-orange-400/80 shadow-orange-500/30'
                        : 'ring-slate-400/80 shadow-slate-500/30';
                      return { ringClass: cn('ring-2 shadow-[0_0_8px]', dirColor), top };
                    })();

                    // James-flag gold dot — only when his flag's expiry rolls up here.
                    const cellJamesFlags = tickerJamesFlags.filter((f) =>
                      jamesFlagMatchesCell(f, ticker, wk),
                    );

                    // Multi-mode agreement ring (only in directional modes).
                    const cellAgreement = isDirectional ? agreement.get(ticker, wk) : undefined;
                    const showAgreementRing =
                      cellAgreement &&
                      (cellAgreement.level === 'two_of_three' || cellAgreement.level === 'three_of_three');
                    const agreementRingClass = !showAgreementRing
                      ? ''
                      : cellAgreement!.winner === 'bullish'
                        ? 'ring-1 ring-sky-300/60'
                        : cellAgreement!.winner === 'bearish'
                          ? 'ring-1 ring-orange-300/60'
                          : '';

                    const cell: HeatmapCell = {
                      ticker: row.ticker,
                      expiryBucketWeek: row.expiry_bucket_week,
                      expiryCountInBucket: row.expiry_count_in_bucket ?? 1,
                      value: value ?? 0,
                      sourceAlertCount: sourceCount,
                      contributingAlertIds: (row.contributing_alert_ids || []) as (string | number)[],
                      latestSnapshotAt: row.latest_snapshot_at,
                      baselineValue: row.baseline_value,
                      deltaValue: row.delta_value,
                      deltaPct: row.delta_pct,
                    };
                    return (
                      <Tooltip key={wk}>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            onClick={() => onCellClick(cell)}
                            className={cn(
                              // When a delta chip is present, give the cell extra
                              // vertical room and bottom padding so the main value
                              // can stay centered above its dedicated strip without
                              // overlap. When no delta, behave identically to the
                              // pre-baseline cell (h-8, centered).
                              'relative mx-0.5 rounded-sm flex flex-col items-center justify-center text-[10px] font-mono tabular-nums leading-none transition-transform hover:scale-[1.04] hover:ring-1 hover:ring-primary/60 focus:outline-none focus:ring-1 focus:ring-primary',
                              hasDelta ? 'h-9 pb-2.5' : 'h-8',
                              bg,
                              text,
                              // Phase 5 markers — outermost layer. Detector glow
                              // wins over agreement ring when both apply.
                              detectorBorder ? detectorBorder.ringClass : agreementRingClass,
                            )}
                            aria-label={`${ticker} ${wk} ${formatTooltipValue(value, mathMode)}`}
                          >
                            <span className="leading-none">{formatCellValue(value, mathMode)}</span>
                            {/* James-flag gold dot — top-left, doesn't compete with delta chip */}
                            {cellJamesFlags.length > 0 && (
                              <span
                                className="pointer-events-none absolute top-0.5 left-0.5 w-1.5 h-1.5 rounded-full bg-amber-400 shadow-[0_0_4px] shadow-amber-500/70"
                                aria-label={`James flag x${cellJamesFlags.length}`}
                              />
                            )}
                            {hasDelta && (
                              <span
                                className={cn(
                                  'pointer-events-none absolute bottom-0 right-0 px-1 py-0.5 rounded-sm text-[9px] font-semibold leading-none',
                                  deltaChipClass,
                                )}
                              >
                                {formatDeltaChip(deltaVal)}
                              </span>
                            )}
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="text-xs">
                          <div className="font-mono font-semibold">{ticker} · {wk}</div>
                          <div className="text-foreground/80">
                            {formatTooltipValue(value, mathMode)}
                          </div>
                          <div className="text-muted-foreground text-[10px] mt-1">
                            {sourceCount} alert{sourceCount === 1 ? '' : 's'}
                            {(row.expiry_count_in_bucket ?? 0) > 1 && (
                              <> · {row.expiry_count_in_bucket} expiries in week</>
                            )}
                          </div>
                          {hasDelta && (
                            <div className="text-foreground/80 text-[10px] mt-1 border-t border-border/40 pt-1">
                              Baseline: {formatPreciseUsd(row.baseline_value)}
                              {' · '}
                              Delta: {formatDeltaChip(deltaVal)}
                              {row.delta_pct != null && Number.isFinite(row.delta_pct) && (
                                <> ({row.delta_pct > 0 ? '+' : ''}{row.delta_pct.toFixed(1)}%)</>
                              )}
                            </div>
                          )}
                          {/* Phase 5 — convergence summary in tooltip */}
                          {(detectorBorder || cellJamesFlags.length > 0 || showAgreementRing) && (
                            <div className="text-[10px] mt-1 border-t border-border/40 pt-1 space-y-0.5">
                              {detectorBorder && (
                                <div className="text-foreground/80">
                                  <span className="font-mono text-amber-300">▣</span>{' '}
                                  {cellDetectorFlags.length} detector flag{cellDetectorFlags.length === 1 ? '' : 's'}
                                  {' · '}
                                  {detectorBorder.top.detector_name ?? detectorBorder.top.detector_id ?? 'detector'}
                                  {' '}
                                  ({detectorBorder.top.direction})
                                </div>
                              )}
                              {cellJamesFlags.length > 0 && (
                                <div className="text-amber-200">
                                  ★ {cellJamesFlags.length} James flag{cellJamesFlags.length === 1 ? '' : 's'}
                                </div>
                              )}
                              {showAgreementRing && cellAgreement && (
                                <div className="text-foreground/70">
                                  Multi-mode agreement: {cellAgreement.bullish_votes}↑ / {cellAgreement.bearish_votes}↓
                                  {' '}
                                  ({cellAgreement.level === 'three_of_three' ? '3 of 3' : '2 of 3'})
                                </div>
                              )}
                            </div>
                          )}
                        </TooltipContent>
                      </Tooltip>
                    );
                  })}
                </div>
              );
            })}
          </div>

          {/* Legend */}
          <div className="flex items-center justify-end gap-3 mt-3 text-[10px] text-muted-foreground">
            {isDirectionalMode(mathMode) ? (
              <>
                <div className="flex items-center gap-1">
                  <span className={cn('inline-block w-3 h-3 rounded-sm', DIVERGING_BG_CLASSES[0])} />
                  <span>bearish</span>
                </div>
                <div className="flex items-center gap-1">
                  <span className={cn('inline-block w-3 h-3 rounded-sm', DIVERGING_BG_CLASSES[5])} />
                  <span>flat</span>
                </div>
                <div className="flex items-center gap-1">
                  <span className={cn('inline-block w-3 h-3 rounded-sm', DIVERGING_BG_CLASSES[DIVERGING_BG_CLASSES.length - 1])} />
                  <span>bullish</span>
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center gap-1">
                  <span className={cn('inline-block w-3 h-3 rounded-sm', SEQUENTIAL_BG_CLASSES[0])} />
                  <span>low</span>
                </div>
                <div className="flex items-center gap-1">
                  <span className={cn('inline-block w-3 h-3 rounded-sm', SEQUENTIAL_BG_CLASSES[SEQUENTIAL_BG_CLASSES.length - 1])} />
                  <span>high {isPremiumMode(mathMode) ? 'premium' : 'unusual'}</span>
                </div>
              </>
            )}
            <div className="text-muted-foreground/70 ml-2">
              anchor: {colorAnchor === 'per_row' ? 'per-ticker' : anchorLabel(colorAnchor)}
            </div>
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
