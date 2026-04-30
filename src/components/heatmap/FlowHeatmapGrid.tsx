/**
 * FlowHeatmapGrid — combined view: 10 watchlist tickers × N expiry-week columns.
 *
 * Custom CSS-grid heatmap. recharts is bad at heatmaps and we don't want a new
 * dep. Each cell is a div with a backgroundColor computed from the row's (or
 * the global table's) percentile distribution.
 *
 * Color scale:
 *   - Directional modes (net_signed, aggressive_directional_*) → orange = bearish,
 *     blue = bullish, neutral mid.
 *   - Non-directional (total, voi_unusual) → single-hue intensity (blue).
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

export interface HeatmapCell {
  ticker: string;
  expiryBucketWeek: string;
  expiryCountInBucket: number;
  value: number;
  sourceAlertCount: number;
  contributingAlertIds: (string | number)[];
  latestSnapshotAt: string;
}

interface FlowHeatmapGridProps {
  rows: HeatmapRow[] | undefined;
  mathMode: HeatmapMathMode;
  colorAnchor: 'per_row' | 'global';
  onCellClick: (cell: HeatmapCell) => void;
  /** Override the default ticker list (defaults to the 10-ticker watchlist). */
  tickers?: string[];
}

/** True if the math mode produces signed values (orange/blue diverging scale). */
function isDirectional(mode: HeatmapMathMode): boolean {
  return mode === 'net_signed'
    || mode === 'aggressive_directional_raw'
    || mode === 'aggressive_directional_decay';
}

function isPremiumMode(mode: HeatmapMathMode): boolean {
  return mode !== 'voi_unusual';
}

/** Format a value for display inside a cell. Compact by design (cells are narrow). */
function formatCellValue(value: number, mode: HeatmapMathMode): string {
  if (mode === 'voi_unusual') {
    return `${value.toFixed(1)}×`;
  }
  const abs = Math.abs(value);
  let body: string;
  if (abs >= 1_000_000_000) body = `${(abs / 1_000_000_000).toFixed(1)}B`;
  else if (abs >= 1_000_000) body = `${(abs / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  else if (abs >= 1_000) body = `${(abs / 1_000).toFixed(0)}K`;
  else body = abs.toFixed(0);
  if (isDirectional(mode)) {
    if (value > 0) return `+${body}`;
    if (value < 0) return `-${body}`;
  }
  return body;
}

/** Format a value for tooltip — fully precise. */
function formatTooltipValue(value: number, mode: HeatmapMathMode): string {
  if (mode === 'voi_unusual') return `${value.toFixed(2)}× volume / OI`;
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  return `${sign}$${abs.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

/** ISO YYYY-MM-DD → "Mar 18" / "Mar 18 (0DTE)" / "Mar 18 (monthly)". */
function formatExpiryHeader(iso: string, expiryCount: number): { date: string; hint: string } {
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

/** Cell color: diverging blue/orange for signed modes, blue intensity for unsigned. */
function colorForCell(
  value: number,
  mode: HeatmapMathMode,
  rowMaxAbs: number,
  globalMaxAbs: number,
  anchor: 'per_row' | 'global',
): { bg: string; text: string } {
  const denom = Math.max(0.0001, anchor === 'global' ? globalMaxAbs : rowMaxAbs);
  const intensity = Math.min(1, Math.abs(value) / denom);
  // alpha curve — keep the lowest cells visible but distinct.
  const alpha = 0.12 + intensity * 0.78;

  if (isDirectional(mode)) {
    if (value > 0) {
      // bullish — sky-blue (sky-500)
      return {
        bg: `rgba(56, 189, 248, ${alpha})`,
        text: alpha > 0.55 ? '#0c1729' : '#7dd3fc',
      };
    }
    if (value < 0) {
      // bearish — orange-500
      return {
        bg: `rgba(249, 115, 22, ${alpha})`,
        text: alpha > 0.55 ? '#1a1208' : '#fdba74',
      };
    }
    return { bg: 'rgba(100, 116, 139, 0.15)', text: '#94a3b8' };
  }
  // Non-directional — sky-blue intensity only.
  return {
    bg: `rgba(56, 189, 248, ${alpha})`,
    text: alpha > 0.55 ? '#0c1729' : '#7dd3fc',
  };
}

export function FlowHeatmapGrid({
  rows,
  mathMode,
  colorAnchor,
  onCellClick,
  tickers,
}: FlowHeatmapGridProps) {
  const tickerList = tickers ?? HEATMAP_DEFAULT_TICKERS;

  /** Index rows by [ticker][expiry_bucket_week]. */
  const cellMap = useMemo(() => {
    const m = new Map<string, HeatmapRow>();
    if (rows) {
      for (const r of rows) m.set(`${r.ticker}::${r.expiry_bucket_week}`, r);
    }
    return m;
  }, [rows]);

  /** Column headers — union of all expiry weeks present, sorted ascending. */
  const expiryWeeks = useMemo(() => {
    const set = new Set<string>();
    if (rows) for (const r of rows) set.add(r.expiry_bucket_week);
    return Array.from(set).sort();
  }, [rows]);

  /** Per-row max-abs for color anchoring. */
  const rowMaxAbs = useMemo(() => {
    const m = new Map<string, number>();
    if (rows) {
      for (const r of rows) {
        const cur = m.get(r.ticker) ?? 0;
        const v = Math.abs(r.value);
        if (v > cur) m.set(r.ticker, v);
      }
    }
    return m;
  }, [rows]);

  const globalMaxAbs = useMemo(() => {
    if (!rows) return 0;
    let g = 0;
    for (const r of rows) {
      const v = Math.abs(r.value);
      if (v > g) g = v;
    }
    return g;
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
              const tickerMax = rowMaxAbs.get(ticker) ?? 0;
              return (
                <div key={ticker} className="grid items-center" style={{ gridTemplateColumns }}>
                  <div className="px-2 text-[11px] font-mono font-semibold text-foreground/80 tabular-nums">
                    {ticker}
                  </div>
                  {expiryWeeks.map((wk) => {
                    const row = cellMap.get(`${ticker}::${wk}`);
                    if (!row) {
                      return (
                        <div
                          key={wk}
                          className="h-8 mx-0.5 rounded-sm bg-muted/20 flex items-center justify-center text-[10px] text-muted-foreground/40 font-mono select-none"
                          aria-label={`${ticker} ${wk} no flow`}
                        >
                          —
                        </div>
                      );
                    }
                    const { bg, text } = colorForCell(
                      row.value, mathMode, tickerMax, globalMaxAbs, colorAnchor,
                    );
                    const cell: HeatmapCell = {
                      ticker: row.ticker,
                      expiryBucketWeek: row.expiry_bucket_week,
                      expiryCountInBucket: row.expiry_count_in_bucket,
                      value: row.value,
                      sourceAlertCount: row.source_alert_count,
                      contributingAlertIds: row.contributing_alert_ids as (string | number)[],
                      latestSnapshotAt: row.latest_snapshot_at,
                    };
                    return (
                      <Tooltip key={wk}>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            onClick={() => onCellClick(cell)}
                            className="h-8 mx-0.5 rounded-sm flex items-center justify-center text-[10px] font-mono tabular-nums leading-none transition-transform hover:scale-[1.04] hover:ring-1 hover:ring-primary/60 focus:outline-none focus:ring-1 focus:ring-primary"
                            style={{ backgroundColor: bg, color: text }}
                            aria-label={`${ticker} ${wk} ${formatTooltipValue(row.value, mathMode)}`}
                          >
                            {formatCellValue(row.value, mathMode)}
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="text-xs">
                          <div className="font-mono font-semibold">{ticker} · {wk}</div>
                          <div className="text-foreground/80">
                            {formatTooltipValue(row.value, mathMode)}
                          </div>
                          <div className="text-muted-foreground text-[10px] mt-1">
                            {row.source_alert_count} alert{row.source_alert_count > 1 ? 's' : ''}
                            {row.expiry_count_in_bucket > 1 && (
                              <> · {row.expiry_count_in_bucket} expiries in week</>
                            )}
                          </div>
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
            {isDirectional(mathMode) ? (
              <>
                <div className="flex items-center gap-1">
                  <span className="inline-block w-3 h-3 rounded-sm" style={{ backgroundColor: 'rgba(249, 115, 22, 0.85)' }} />
                  <span>bearish</span>
                </div>
                <div className="flex items-center gap-1">
                  <span className="inline-block w-3 h-3 rounded-sm" style={{ backgroundColor: 'rgba(100, 116, 139, 0.4)' }} />
                  <span>flat</span>
                </div>
                <div className="flex items-center gap-1">
                  <span className="inline-block w-3 h-3 rounded-sm" style={{ backgroundColor: 'rgba(56, 189, 248, 0.85)' }} />
                  <span>bullish</span>
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center gap-1">
                  <span className="inline-block w-3 h-3 rounded-sm" style={{ backgroundColor: 'rgba(56, 189, 248, 0.18)' }} />
                  <span>low</span>
                </div>
                <div className="flex items-center gap-1">
                  <span className="inline-block w-3 h-3 rounded-sm" style={{ backgroundColor: 'rgba(56, 189, 248, 0.85)' }} />
                  <span>high {isPremiumMode(mathMode) ? 'premium' : 'unusual'}</span>
                </div>
              </>
            )}
            <div className="text-muted-foreground/70 ml-2">
              anchor: {colorAnchor === 'per_row' ? 'per-ticker' : 'global'}
            </div>
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
