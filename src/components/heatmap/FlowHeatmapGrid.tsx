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

export function FlowHeatmapGrid({
  rows,
  mathMode,
  colorAnchor,
  onCellClick,
  tickers,
}: FlowHeatmapGridProps) {
  const tickerList = (tickers && tickers.length > 0) ? tickers : HEATMAP_DEFAULT_TICKERS;

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
  const gridTemplateColumns = `64px repeat(${expiryWeeks.length}, minmax(72px, 1fr))`;

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
              return (
                <div key={ticker} className="grid items-center" style={{ gridTemplateColumns }}>
                  <div className="px-2 text-[11px] font-mono font-semibold text-foreground/80 tabular-nums">
                    {ticker}
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
                            )}
                            aria-label={`${ticker} ${wk} ${formatTooltipValue(value, mathMode)}`}
                          >
                            <span className="leading-none">{formatCellValue(value, mathMode)}</span>
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
