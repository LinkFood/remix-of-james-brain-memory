/**
 * FlowHeatmapPerTicker — strikes (Y, descending) × expiry dates (X) for a
 * single ticker.
 *
 * REAL per-strike data via ct_flow_heatmap_strikes RPC (useFlowHeatmapStrikes).
 * Each row in the RPC output is one (ticker, strike, expiry_date, side) cell
 * already aggregated, filtered by min-premium, and capped at 30 rows by
 * abs(value). No more synthetic ATM±2 splits.
 *
 * Cell click → existing FlowHeatmapDrill. The drill panel hydrates from
 * `contributingAlertIds` — providing the actual per-strike alert ids means
 * the drill works exactly the same as the combined view.
 *
 * Color logic shared with the combined grid via `heatmapColors.ts`
 * (11-step diverging for signed modes / 6-step sequential for non-directional).
 */

import { useMemo, useState } from 'react';
import {
  HEATMAP_DEFAULT_TICKERS,
  useFlowHeatmapStrikes,
  type HeatmapMathMode,
  type HeatmapStrikeRow,
} from '@/hooks/useFlowHeatmap';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { HeatmapCell } from './FlowHeatmapGrid';
import {
  getCellColorClasses,
  isDirectionalMode,
  EMPTY_CELL_BG,
  EMPTY_CELL_TEXT,
} from './heatmapColors';

interface FlowHeatmapPerTickerProps {
  /** Combined-view rows kept for prop-shape backwards compatibility — unused
   *  by the per-strike fetch. Heatmap.tsx may still pass it. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rows?: any;
  mathMode: HeatmapMathMode;
  colorAnchor: 'per_row' | 'global';
  onCellClick: (cell: HeatmapCell) => void;
  /** Default selected ticker. */
  defaultTicker?: string;
  /** Hours of lookback to feed into the strikes RPC. Default 168 (7d). */
  lookbackHours?: number;
  /** Floor passed to RPC. Default 50,000. */
  minPremium?: number;
}

function formatCellValue(value: number | null | undefined, mode: HeatmapMathMode): string {
  if (value == null || !Number.isFinite(value)) return '—';
  if (mode === 'voi_unusual') return `${value.toFixed(1)}×`;
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

function formatTooltipValue(value: number | null | undefined, mode: HeatmapMathMode): string {
  if (value == null || !Number.isFinite(value)) return '—';
  if (mode === 'voi_unusual') return `${value.toFixed(2)}× volume / OI`;
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  return `${sign}$${abs.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function sideLabel(side: HeatmapStrikeRow['side']): string {
  if (side === 'C') return 'calls';
  if (side === 'P') return 'puts';
  return 'mixed';
}

interface BuiltMatrix {
  strikes: number[];
  expiries: string[];
  byKey: Map<string, HeatmapStrikeRow>;
  /** All cell values per strike row — used for per-row color anchor. */
  valuesByStrike: Map<number, number[]>;
  /** All cell values across the matrix — used for global color anchor. */
  allValues: number[];
}

function buildMatrix(rows: HeatmapStrikeRow[]): BuiltMatrix {
  const byKey = new Map<string, HeatmapStrikeRow>();
  const strikeSet = new Set<number>();
  const expirySet = new Set<string>();
  const valuesByStrike = new Map<number, number[]>();
  const allValues: number[] = [];

  for (const r of rows) {
    if (!r || r.strike == null || !r.expiry_date) continue;
    strikeSet.add(r.strike);
    expirySet.add(r.expiry_date);
    const key = `${r.strike}::${r.expiry_date}`;
    // Defensive: if the RPC ever returns multiple rows per (strike, expiry)
    // (it shouldn't — server-side per_cell collapses to 'mixed'), keep the
    // larger-abs row.
    const existing = byKey.get(key);
    if (!existing || (r.value != null && Math.abs(r.value) > Math.abs(existing.value ?? 0))) {
      byKey.set(key, r);
    }
    if (r.value != null && Number.isFinite(r.value)) {
      const arr = valuesByStrike.get(r.strike) ?? [];
      arr.push(r.value);
      valuesByStrike.set(r.strike, arr);
      allValues.push(r.value);
    }
  }

  const strikes = Array.from(strikeSet).sort((a, b) => b - a); // desc — high strikes top
  const expiries = Array.from(expirySet).sort();
  return { strikes, expiries, byKey, valuesByStrike, allValues };
}

export function FlowHeatmapPerTicker({
  mathMode,
  colorAnchor,
  onCellClick,
  defaultTicker = 'SPY',
  lookbackHours = 168,
  minPremium = 50_000,
}: FlowHeatmapPerTickerProps) {
  const [selectedTicker, setSelectedTicker] = useState<string>(defaultTicker);

  const { data: strikeRows, isLoading, isError } = useFlowHeatmapStrikes({
    ticker: selectedTicker,
    lookbackHours,
    mathMode,
    minPremium,
    strikeCount: 30,
  });

  const matrix = useMemo<BuiltMatrix>(
    () => buildMatrix(strikeRows ?? []),
    [strikeRows],
  );

  const formatExpiry = (iso: string): string =>
    new Date(iso + 'T00:00:00Z').toLocaleDateString(undefined, {
      month: 'short', day: 'numeric', timeZone: 'UTC',
    });

  const expiriesLen = matrix.expiries.length;
  const gridTemplateColumns = expiriesLen > 0
    ? `72px repeat(${expiriesLen}, minmax(72px, 1fr))`
    : `72px 1fr`;

  return (
    <TooltipProvider delayDuration={150}>
      <div className="rounded-md border border-border bg-card/40">
        {/* Ticker selector */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border flex-wrap">
          <span className="text-xs text-muted-foreground">Ticker:</span>
          {HEATMAP_DEFAULT_TICKERS.map((t) => (
            <button
              key={t}
              onClick={() => setSelectedTicker(t)}
              className={cn(
                'text-[11px] font-mono px-2 py-1 rounded border transition-colors',
                selectedTicker === t
                  ? 'border-primary/40 bg-primary/10 text-primary'
                  : 'border-muted bg-muted/20 text-muted-foreground hover:text-foreground',
              )}
            >
              {t}
            </button>
          ))}
          <span className="ml-auto text-[10px] text-muted-foreground/70 font-mono">
            {strikeRows ? `${strikeRows.length} strikes` : '—'}
          </span>
        </div>

        <div className="overflow-x-auto">
          <div className="min-w-fit p-2">
            {isLoading && !strikeRows ? (
              <div className="p-12 text-center text-sm text-muted-foreground">
                Loading {selectedTicker} strikes…
              </div>
            ) : isError ? (
              <div className="p-12 text-center text-sm text-destructive">
                Failed to load {selectedTicker} strike data.
              </div>
            ) : expiriesLen === 0 ? (
              <div className="p-12 text-center text-sm text-muted-foreground">
                No strike-level flow for {selectedTicker} at the current filters.
                Try a different math mode or lower the min-premium floor.
              </div>
            ) : (
              <>
                {/* Header row */}
                <div className="grid items-end mb-1" style={{ gridTemplateColumns }}>
                  <div className="px-1 text-[10px] uppercase tracking-wider text-muted-foreground/70">
                    strike
                  </div>
                  {matrix.expiries.map((exp) => (
                    <div key={exp} className="px-1 pb-1 text-center text-[11px] font-mono text-foreground/80">
                      {formatExpiry(exp)}
                    </div>
                  ))}
                </div>

                {/* Body */}
                <div className="space-y-1">
                  {matrix.strikes.map((strike) => {
                    const strikeValues = matrix.valuesByStrike.get(strike) ?? [];
                    return (
                      <div key={strike} className="grid items-center" style={{ gridTemplateColumns }}>
                        <div className="px-2 text-[11px] font-mono font-semibold text-foreground/80 tabular-nums">
                          ${strike}
                        </div>
                        {matrix.expiries.map((exp) => {
                          const cell = matrix.byKey.get(`${strike}::${exp}`);
                          const value: number | null = cell && cell.value != null && Number.isFinite(cell.value)
                            ? cell.value
                            : null;

                          if (!cell || value == null) {
                            return (
                              <div
                                key={exp}
                                className={cn(
                                  'h-8 mx-0.5 rounded-sm flex items-center justify-center text-[10px] font-mono select-none',
                                  EMPTY_CELL_BG,
                                  EMPTY_CELL_TEXT,
                                )}
                              >
                                —
                              </div>
                            );
                          }
                          const { bg, text } = getCellColorClasses(
                            value, colorAnchor, mathMode, strikeValues, matrix.allValues,
                          );
                          return (
                            <Tooltip key={exp}>
                              <TooltipTrigger asChild>
                                <button
                                  type="button"
                                  onClick={() => onCellClick({
                                    ticker: cell.ticker,
                                    // The drill panel reads expiryBucketWeek as a
                                    // label only, and hydrates contributing alerts
                                    // by id. Feeding the actual expiry_date here
                                    // makes the drill header read correctly for
                                    // per-strike cells.
                                    expiryBucketWeek: cell.expiry_date,
                                    expiryCountInBucket: 1,
                                    value: cell.value,
                                    sourceAlertCount: cell.source_alert_count ?? 0,
                                    contributingAlertIds: (cell.contributing_alert_ids || []) as (string | number)[],
                                    latestSnapshotAt: new Date().toISOString(),
                                  })}
                                  className={cn(
                                    'h-8 mx-0.5 rounded-sm flex items-center justify-center text-[10px] font-mono tabular-nums leading-none transition-transform hover:scale-[1.04] hover:ring-1 hover:ring-primary/60 focus:outline-none focus:ring-1 focus:ring-primary',
                                    bg,
                                    text,
                                  )}
                                >
                                  {formatCellValue(value, mathMode)}
                                </button>
                              </TooltipTrigger>
                              <TooltipContent side="top" className="text-xs">
                                <div className="font-mono font-semibold">
                                  {selectedTicker} ${strike} · {formatExpiry(exp)} · {sideLabel(cell.side)}
                                </div>
                                <div className="text-foreground/80">
                                  {formatTooltipValue(value, mathMode)}
                                </div>
                                <div className="text-muted-foreground text-[10px] mt-1">
                                  {cell.source_alert_count ?? 0} contributing {(cell.source_alert_count ?? 0) === 1 ? 'alert' : 'alerts'}
                                </div>
                              </TooltipContent>
                            </Tooltip>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
