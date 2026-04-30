/**
 * /heatmap — Flow Heatmap. Where positioning is stacking.
 *
 * Combined view (10 watchlist tickers × expiry weeks) + per-ticker view
 * (strikes × expiries). Cell click → drill panel with contributing flow
 * alerts, strike breakdown, history mini-chart.
 *
 * Backed by useFlowHeatmapLive (30s refetch). RPCs are being built in
 * parallel — until they land, the hook returns mock rows shaped exactly
 * like the real RPC output, so the swap is one line.
 */

import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Activity, RefreshCw, Flame } from 'lucide-react';
import {
  HeatmapToolbar,
  type HeatmapToolbarValue,
  lookbackToExpiryDays,
} from '@/components/heatmap/HeatmapToolbar';
import { FlowHeatmapGrid, type HeatmapCell } from '@/components/heatmap/FlowHeatmapGrid';
import { FlowHeatmapPerTicker } from '@/components/heatmap/FlowHeatmapPerTicker';
import { FlowHeatmapDrill } from '@/components/heatmap/FlowHeatmapDrill';
import { useFlowHeatmapLive } from '@/hooks/useFlowHeatmap';

function relSeconds(iso: string | null | undefined): string {
  if (!iso) return '—';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

export default function Heatmap() {
  const qc = useQueryClient();
  const [toolbar, setToolbar] = useState<HeatmapToolbarValue>({
    mathMode: 'aggressive_directional_decay',
    lookback: '7d',
    include0DTE: false,
    minPremium: 100_000,
    view: 'combined',
    colorAnchor: 'per_row',
  });
  const [drillCell, setDrillCell] = useState<HeatmapCell | null>(null);
  const [drillOpen, setDrillOpen] = useState(false);

  const maxExpiryDays = lookbackToExpiryDays(toolbar.lookback);

  const { data: rows, isLoading, dataUpdatedAt } = useFlowHeatmapLive({
    mathMode: toolbar.mathMode,
    minPremium: toolbar.minPremium,
    include0DTE: toolbar.include0DTE,
    maxExpiryDays,
  });

  // Tick the "last updated NN seconds ago" clock.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const lastUpdatedIso = useMemo(
    () => (dataUpdatedAt ? new Date(dataUpdatedAt).toISOString() : null),
    [dataUpdatedAt],
  );

  const handleCellClick = (cell: HeatmapCell) => {
    setDrillCell(cell);
    setDrillOpen(true);
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-[1600px] mx-auto p-4 space-y-4">
        <header className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Flame className="w-5 h-5 text-primary" />
              <span>Flow Heatmap</span>
            </h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              Where positioning is stacking. Each cell = total flow into one ticker × expiry-week.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Activity className="w-3 h-3" />
              <span>Last updated {relSeconds(lastUpdatedIso)}</span>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => qc.invalidateQueries({ queryKey: ['flow-heatmap-live'] })}
              className="text-xs"
            >
              <RefreshCw className="w-3 h-3 mr-1" />
              Refresh
            </Button>
          </div>
        </header>

        <HeatmapToolbar value={toolbar} onChange={setToolbar} />

        {isLoading && !rows ? (
          <Card className="p-8 text-center text-sm text-muted-foreground">
            Loading flow heatmap…
          </Card>
        ) : !rows || rows.length === 0 ? (
          <Card className="p-8 text-center text-sm text-muted-foreground">
            No flow rows match the current filters. Try lowering the min-premium floor,
            extending the lookback, or enabling 0DTE.
          </Card>
        ) : toolbar.view === 'combined' ? (
          <FlowHeatmapGrid
            rows={rows}
            mathMode={toolbar.mathMode}
            colorAnchor={toolbar.colorAnchor}
            onCellClick={handleCellClick}
          />
        ) : (
          <FlowHeatmapPerTicker
            rows={rows}
            mathMode={toolbar.mathMode}
            colorAnchor={toolbar.colorAnchor}
            onCellClick={handleCellClick}
          />
        )}

        <div className="text-[10px] text-muted-foreground leading-relaxed">
          Live every 30s · cell click drills to contributing alerts · per-row color
          anchor by default (toggle to global to compare across tickers).
        </div>
      </div>

      <FlowHeatmapDrill
        cell={drillCell}
        open={drillOpen}
        onOpenChange={(o) => {
          setDrillOpen(o);
          if (!o) setDrillCell(null);
        }}
        mathMode={toolbar.mathMode}
      />
    </div>
  );
}
