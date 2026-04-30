/**
 * FlowHeatmapPerTicker — strikes Y axis × expiry dates X axis for a single ticker.
 *
 * Same color/cell treatment as the combined grid. The combined RPC returns
 * ticker × expiry_bucket_week — it does NOT carry strike granularity per row.
 * For now we synthesize a per-strike breakdown by:
 *   1. Pulling the per-week rows for the selected ticker.
 *   2. Mocking strikes against each cell's value (until the parallel agent
 *      ships a per-strike RPC variant).
 *
 * When a real per-strike RPC lands, swap the buildStrikeMatrix() generator
 * with the RPC call — the rendering layer is unchanged.
 */

import { useMemo, useState } from 'react';
import type { HeatmapMathMode, HeatmapRow } from '@/hooks/useFlowHeatmap';
import { HEATMAP_DEFAULT_TICKERS } from '@/hooks/useFlowHeatmap';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { HeatmapCell } from './FlowHeatmapGrid';

interface FlowHeatmapPerTickerProps {
  rows: HeatmapRow[] | undefined;
  mathMode: HeatmapMathMode;
  colorAnchor: 'per_row' | 'global';
  onCellClick: (cell: HeatmapCell) => void;
  /** Default selected ticker. */
  defaultTicker?: string;
}

function isDirectional(mode: HeatmapMathMode): boolean {
  return mode === 'net_signed'
    || mode === 'aggressive_directional_raw'
    || mode === 'aggressive_directional_decay';
}

function formatCellValue(value: number, mode: HeatmapMathMode): string {
  if (mode === 'voi_unusual') return `${value.toFixed(1)}×`;
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

function formatTooltipValue(value: number, mode: HeatmapMathMode): string {
  if (mode === 'voi_unusual') return `${value.toFixed(2)}× volume / OI`;
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  return `${sign}$${abs.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function colorForCell(
  value: number,
  mode: HeatmapMathMode,
  rowMaxAbs: number,
  globalMaxAbs: number,
  anchor: 'per_row' | 'global',
): { bg: string; text: string } {
  const denom = Math.max(0.0001, anchor === 'global' ? globalMaxAbs : rowMaxAbs);
  const intensity = Math.min(1, Math.abs(value) / denom);
  const alpha = 0.12 + intensity * 0.78;
  if (isDirectional(mode)) {
    if (value > 0) return { bg: `rgba(56, 189, 248, ${alpha})`, text: alpha > 0.55 ? '#0c1729' : '#7dd3fc' };
    if (value < 0) return { bg: `rgba(249, 115, 22, ${alpha})`, text: alpha > 0.55 ? '#1a1208' : '#fdba74' };
    return { bg: 'rgba(100, 116, 139, 0.15)', text: '#94a3b8' };
  }
  return { bg: `rgba(56, 189, 248, ${alpha})`, text: alpha > 0.55 ? '#0c1729' : '#7dd3fc' };
}

/** Strike anchors per ticker — typical ATM range. Used to seed mock strikes. */
const TICKER_ANCHORS: Record<string, { atm: number; step: number }> = {
  SPY:   { atm: 552, step: 5 },
  QQQ:   { atm: 480, step: 5 },
  IWM:   { atm: 215, step: 2 },
  NVDA:  { atm: 870, step: 10 },
  AAPL:  { atm: 218, step: 2 },
  MSFT:  { atm: 420, step: 5 },
  GOOGL: { atm: 175, step: 2 },
  AMZN:  { atm: 195, step: 2 },
  META:  { atm: 530, step: 5 },
  TSLA:  { atm: 245, step: 5 },
};

interface StrikeCell {
  strike: number;
  expiry: string;
  value: number;
  sourceRow: HeatmapRow;
}

/**
 * Synthesize strike × expiry matrix from week-level rows. For each row, split
 * its value across 5 strikes (ATM-2 ... ATM+2) using a deterministic ratio.
 *
 * This is a placeholder until the per-strike RPC variant ships. The parent
 * RPC's `contributing_alert_ids` are preserved on each split cell so the
 * drill panel still has full provenance.
 */
function buildStrikeMatrix(rows: HeatmapRow[], ticker: string): {
  strikes: number[];
  expiries: string[];
  byKey: Map<string, StrikeCell>;
} {
  const anchor = TICKER_ANCHORS[ticker];
  const byKey = new Map<string, StrikeCell>();
  const strikeSet = new Set<number>();
  const expirySet = new Set<string>();

  if (!anchor) {
    return { strikes: [], expiries: [], byKey };
  }

  // 5 strikes around ATM: -2 -1 0 +1 +2
  const strikeOffsets = [-2, -1, 0, 1, 2];
  // distribution shape — heavier near ATM.
  const weights = [0.10, 0.20, 0.40, 0.20, 0.10];

  for (const r of rows) {
    if (r.ticker !== ticker) continue;
    expirySet.add(r.expiry_bucket_week);
    strikeOffsets.forEach((off, i) => {
      const strike = anchor.atm + off * anchor.step;
      strikeSet.add(strike);
      const cellValue = r.value * weights[i];
      const key = `${strike}::${r.expiry_bucket_week}`;
      byKey.set(key, {
        strike,
        expiry: r.expiry_bucket_week,
        value: cellValue,
        sourceRow: r,
      });
    });
  }

  const strikes = Array.from(strikeSet).sort((a, b) => b - a); // desc — high strikes top
  const expiries = Array.from(expirySet).sort();
  return { strikes, expiries, byKey };
}

export function FlowHeatmapPerTicker({
  rows,
  mathMode,
  colorAnchor,
  onCellClick,
  defaultTicker = 'SPY',
}: FlowHeatmapPerTickerProps) {
  const [selectedTicker, setSelectedTicker] = useState<string>(defaultTicker);

  const matrix = useMemo(() => {
    return buildStrikeMatrix(rows ?? [], selectedTicker);
  }, [rows, selectedTicker]);

  const rowMaxAbs = useMemo(() => {
    const m = new Map<number, number>();
    matrix.byKey.forEach((c) => {
      const cur = m.get(c.strike) ?? 0;
      const v = Math.abs(c.value);
      if (v > cur) m.set(c.strike, v);
    });
    return m;
  }, [matrix]);

  const globalMaxAbs = useMemo(() => {
    let g = 0;
    matrix.byKey.forEach((c) => {
      const v = Math.abs(c.value);
      if (v > g) g = v;
    });
    return g;
  }, [matrix]);

  const formatExpiry = (iso: string): string =>
    new Date(iso + 'T00:00:00Z').toLocaleDateString(undefined, {
      month: 'short', day: 'numeric', timeZone: 'UTC',
    });

  if (!rows) {
    return (
      <div className="rounded-md border border-border bg-card/40 p-12 text-center text-sm text-muted-foreground">
        Loading per-ticker view…
      </div>
    );
  }

  const gridTemplateColumns = matrix.expiries.length > 0
    ? `72px repeat(${matrix.expiries.length}, minmax(72px, 1fr))`
    : `72px 1fr`;

  return (
    <TooltipProvider delayDuration={150}>
      <div className="rounded-md border border-border bg-card/40">
        {/* Ticker selector */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
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
        </div>

        <div className="overflow-x-auto">
          <div className="min-w-fit p-2">
            {matrix.expiries.length === 0 ? (
              <div className="p-12 text-center text-sm text-muted-foreground">
                No flow rows for {selectedTicker} at the current filters.
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
                    const sMax = rowMaxAbs.get(strike) ?? 0;
                    return (
                      <div key={strike} className="grid items-center" style={{ gridTemplateColumns }}>
                        <div className="px-2 text-[11px] font-mono font-semibold text-foreground/80 tabular-nums">
                          ${strike}
                        </div>
                        {matrix.expiries.map((exp) => {
                          const cell = matrix.byKey.get(`${strike}::${exp}`);
                          if (!cell) {
                            return (
                              <div
                                key={exp}
                                className="h-8 mx-0.5 rounded-sm bg-muted/20 flex items-center justify-center text-[10px] text-muted-foreground/40 font-mono select-none"
                              >
                                —
                              </div>
                            );
                          }
                          const { bg, text } = colorForCell(
                            cell.value, mathMode, sMax, globalMaxAbs, colorAnchor,
                          );
                          return (
                            <Tooltip key={exp}>
                              <TooltipTrigger asChild>
                                <button
                                  type="button"
                                  onClick={() => onCellClick({
                                    ticker: cell.sourceRow.ticker,
                                    expiryBucketWeek: cell.sourceRow.expiry_bucket_week,
                                    expiryCountInBucket: cell.sourceRow.expiry_count_in_bucket,
                                    value: cell.sourceRow.value,
                                    sourceAlertCount: cell.sourceRow.source_alert_count,
                                    contributingAlertIds: cell.sourceRow.contributing_alert_ids as (string | number)[],
                                    latestSnapshotAt: cell.sourceRow.latest_snapshot_at,
                                  })}
                                  className="h-8 mx-0.5 rounded-sm flex items-center justify-center text-[10px] font-mono tabular-nums leading-none transition-transform hover:scale-[1.04] hover:ring-1 hover:ring-primary/60 focus:outline-none focus:ring-1 focus:ring-primary"
                                  style={{ backgroundColor: bg, color: text }}
                                >
                                  {formatCellValue(cell.value, mathMode)}
                                </button>
                              </TooltipTrigger>
                              <TooltipContent side="top" className="text-xs">
                                <div className="font-mono font-semibold">
                                  {selectedTicker} {strike} · {exp}
                                </div>
                                <div className="text-foreground/80">
                                  {formatTooltipValue(cell.value, mathMode)}
                                </div>
                                <div className="text-muted-foreground text-[10px] mt-1">
                                  share of {formatTooltipValue(cell.sourceRow.value, mathMode)} week-bucket
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
