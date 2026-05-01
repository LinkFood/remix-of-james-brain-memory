/**
 * FlowHeatmapDrill — slide-in panel showing the contributing flow alerts
 * behind a single heatmap cell.
 *
 * Props mirror the HeatmapCell shape from FlowHeatmapGrid. The contributing
 * alert ids are pulled from the cell — we hydrate them with full ct_flow_alerts
 * rows, top 20 by premium.
 *
 * Sections:
 *   - Header: ticker · expiry · value · math mode used
 *   - Strike-breakdown bar chart (recharts) — premium grouped by strike
 *   - Contributing alerts list (top 20 by premium)
 *   - Mini time-series of how this cell evolved (history hook, last 24h)
 */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import {
  BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip as RTooltip, CartesianGrid,
  LineChart, Line,
} from 'recharts';
import { cn } from '@/lib/utils';
import type { HeatmapCell } from './FlowHeatmapGrid';
import type { HeatmapMathMode } from '@/hooks/useFlowHeatmap';
import { useFlowHeatmapHistory } from '@/hooks/useFlowHeatmap';
// Phase 5 — System State organ mirrors. Cell drill shows the same brain
// state Claude consumers see when reasoning about this cell.
import { useSpecialistReads } from '@/hooks/useSpecialistReads';
import { useFlowPulse } from '@/hooks/useFlowPulse';
import { useDetectorFlags, filterFlagsByExpiryBucket } from '@/hooks/useDetectorFlags';
import { useJamesFlags, jamesFlagMatchesCell } from '@/hooks/useJamesFlags';
import { useNewsCausality } from '@/hooks/useNewsCausality';
import { useCellAnalogs } from '@/hooks/useCellAnalogs';

interface FlowHeatmapDrillProps {
  cell: HeatmapCell | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mathMode: HeatmapMathMode;
  /** Human-readable label for the active baseline (e.g. "session open", "1h ago").
   *  When undefined the baseline section is hidden. */
  baselineLabel?: string;
}

interface FlowAlertRow {
  id: string;
  alert_id: string | null;
  ticker: string;
  option_symbol: string | null;
  strike: number | null;
  expiry: string | null;
  side: 'call' | 'put' | null;
  is_ask: boolean | null;
  is_bid: boolean | null;
  size: number | null;
  premium: number | null;
  price: number | null;
  underlying_price: number | null;
  executed_at: string | null;
  ingested_at: string | null;
  alert_type: string | null;
}

function formatUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function formatSignedUsd(n: number | null | undefined, mode: HeatmapMathMode): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (mode === 'voi_unusual') return `${n.toFixed(2)}× volume / OI`;
  const sign = n < 0 ? '-' : n > 0 ? '+' : '';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

function relTime(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - Date.parse(iso);
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function MATH_MODE_LABEL(m: HeatmapMathMode): string {
  switch (m) {
    case 'total': return 'Total Premium';
    case 'net_signed': return 'Net Signed (calls−puts)';
    case 'aggressive_directional_raw': return 'Aggressive Directional (raw)';
    case 'aggressive_directional_decay': return 'Aggressive Directional (decay 5d)';
    case 'voi_unusual': return 'Volume / OI Unusual';
  }
}

export function FlowHeatmapDrill({ cell, open, onOpenChange, mathMode, baselineLabel }: FlowHeatmapDrillProps) {
  /** Hydrate the contributing alerts. Sort top 20 by premium DESC. */
  const { data: alerts = [], isLoading: alertsLoading } = useQuery<FlowAlertRow[]>({
    queryKey: ['flow-heatmap-drill-alerts', cell?.contributingAlertIds ?? [], cell?.ticker],
    enabled: open && !!cell && (cell.contributingAlertIds?.length ?? 0) > 0,
    queryFn: async () => {
      if (!cell) return [];
      const ids = (cell.contributingAlertIds ?? []).slice(0, 200); // cap for query size
      // Try alert_id first (text column from UW). If empty, fall back to id.
      // Both query paths return the same column shape so the rest of the panel
      // doesn't care which key matched.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sb: any = supabase;
      const select = 'id, alert_id, ticker, option_symbol, strike, expiry, side, is_ask, is_bid, size, premium, price, underlying_price, executed_at, ingested_at, alert_type';

      const stringIds = ids.map(String);
      const { data: byAlertId } = await sb.from('ct_flow_alerts')
        .select(select)
        .in('alert_id', stringIds)
        .order('premium', { ascending: false, nullsFirst: false })
        .limit(20);
      if (Array.isArray(byAlertId) && byAlertId.length > 0) {
        return byAlertId as FlowAlertRow[];
      }
      // Fallback: try the uuid id column (some sources use the row uuid).
      const { data: byId } = await sb.from('ct_flow_alerts')
        .select(select)
        .in('id', stringIds)
        .order('premium', { ascending: false, nullsFirst: false })
        .limit(20);
      return (byId ?? []) as FlowAlertRow[];
    },
    staleTime: 60_000,
  });

  /** Strike breakdown — sum premium grouped by strike + side. */
  const strikeBreakdown = useMemo(() => {
    if (!alerts.length) return [];
    const map = new Map<string, { strike: number; calls: number; puts: number }>();
    for (const a of alerts) {
      if (a.strike == null) continue;
      const key = String(a.strike);
      const cur = map.get(key) ?? { strike: a.strike, calls: 0, puts: 0 };
      const prem = a.premium ?? 0;
      if (a.side === 'call') cur.calls += prem;
      else if (a.side === 'put') cur.puts += prem;
      map.set(key, cur);
    }
    return Array.from(map.values()).sort((a, b) => a.strike - b.strike);
  }, [alerts]);

  /** Historical evolution — last 24h of this ticker × expiry combo.
   *  Pass lookbackHours: 24 explicitly (matches the displayed window — the
   *  hook default is 168h, which over-fetched and didn't match the header). */
  const sinceIso = useMemo(() => new Date(Date.now() - 24 * 3600_000).toISOString(), [open]);
  const untilIso = useMemo(() => new Date().toISOString(), [open]);
  const { data: historyRows = [] } = useFlowHeatmapHistory({
    tickers: cell ? [cell.ticker] : null,
    since: sinceIso,
    until: untilIso,
    mathMode,
    lookbackHours: 24,
  });
  /**
   * Filter history rows that belong to this cell.
   *
   * The combined grid stores Friday-of-week as `cell.expiryBucketWeek`. The
   * per-strike grid (FlowHeatmapPerTicker) stuffs the actual `expiry_date`
   * into the same field for drill compatibility. The history RPC always
   * returns Friday-of-week. So we normalize the cell key to a Friday and
   * compare both forms — gives correct filtering regardless of source.
   */
  const cellFriday = useMemo(() => {
    if (!cell?.expiryBucketWeek) return null;
    const d = new Date(cell.expiryBucketWeek + 'T00:00:00Z');
    if (Number.isNaN(d.getTime())) return null;
    const js = d.getUTCDay();
    const iso = js === 0 ? 7 : js; // Mon=1..Sun=7
    const diff = 5 - iso; // Friday-of-week shift
    const fri = new Date(d);
    fri.setUTCDate(d.getUTCDate() + diff);
    return fri.toISOString().slice(0, 10);
  }, [cell]);
  const historySeries = useMemo(() => {
    if (!cell) return [];
    // The history RPC (ct_flow_heatmap_history) returns the per-snapshot
    // timestamp as `snapshot_at`, while the live RPC (ct_flow_heatmap_live)
    // returns it as `latest_snapshot_at` after MAX-aggregation. The shared
    // HeatmapRow type only declares `latest_snapshot_at`, so reading that
    // field on history rows yields `undefined` → Date.parse(undefined) = NaN
    // → all points get x=NaN → recharts draws axes but no line. Read both
    // field names defensively until the RPC contract is unified.
    type HistoryRowLoose = typeof historyRows[number] & { snapshot_at?: string };
    return historyRows
      .filter((r) => r.ticker === cell.ticker && (
        r.expiry_bucket_week === cell.expiryBucketWeek ||
        (cellFriday !== null && r.expiry_bucket_week === cellFriday)
      ))
      .map((r) => {
        const rl = r as HistoryRowLoose;
        const ts = rl.snapshot_at ?? rl.latest_snapshot_at;
        return {
          t: ts ? Date.parse(ts) : NaN,
          ts,
          value: r.value,
        };
      })
      .filter((p) => Number.isFinite(p.t))
      .sort((a, b) => a.t - b.t);
  }, [historyRows, cell, cellFriday]);

  // ---------------------------------------------------------------------
  // Phase 5 — System State organ reads. Each hook is defensive (empty on
  // missing data) so the drill renders even when one organ is unavailable.
  // ---------------------------------------------------------------------
  const { latest: specialistLatest } = useSpecialistReads(cell?.ticker, 1);
  const { rows: pulseRows } = useFlowPulse(60);
  const cellPulse = useMemo(() => {
    if (!cell) return null;
    const tk = cell.ticker.toUpperCase();
    return (pulseRows ?? []).find((r) => r.ticker.toUpperCase() === tk) ?? null;
  }, [pulseRows, cell]);
  const { flags: tickerDetectorFlags } = useDetectorFlags({
    ticker: cell?.ticker,
    lookbackHours: 24,
    limit: 50,
  });
  const cellDetectorFlags = useMemo(() => {
    if (!cell || !cellFriday) return [];
    return filterFlagsByExpiryBucket(tickerDetectorFlags, cell.ticker, cellFriday);
  }, [tickerDetectorFlags, cell, cellFriday]);
  const { flags: tickerJamesFlags } = useJamesFlags({
    ticker: cell?.ticker,
    lookbackHours: 24,
    perTicker: 20,
  });
  const cellJamesFlags = useMemo(() => {
    if (!cell || !cellFriday) return [];
    return tickerJamesFlags.filter((f) => jamesFlagMatchesCell(f, cell.ticker, cellFriday));
  }, [tickerJamesFlags, cell, cellFriday]);
  const { perTicker: newsByTicker } = useNewsCausality({
    ticker: cell?.ticker,
    lookbackHours: 6,
    cap: 25,
    minSeverity: 1,
  });
  const cellNews = useMemo(() => {
    if (!cell) return [];
    return newsByTicker.get(cell.ticker.toUpperCase()) ?? [];
  }, [newsByTicker, cell]);
  const { analogs, isPending: analogsPending } = useCellAnalogs({
    ticker: cell?.ticker ?? null,
    expiryBucketWeek: cellFriday ?? cell?.expiryBucketWeek ?? null,
    mathMode,
    cap: 5,
  });

  if (!cell) return null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-xl md:max-w-2xl overflow-y-auto"
      >
        <SheetHeader>
          <SheetTitle className="font-mono text-base">
            {cell.ticker} · expiry {cell.expiryBucketWeek}
          </SheetTitle>
          <SheetDescription className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="font-mono">
              {formatSignedUsd(cell.value, mathMode)}
            </Badge>
            <span className="text-xs text-muted-foreground">{MATH_MODE_LABEL(mathMode)}</span>
            <span className="text-xs text-muted-foreground">·</span>
            <span className="text-xs text-muted-foreground">
              {cell.sourceAlertCount ?? 0} alert{(cell.sourceAlertCount ?? 0) === 1 ? '' : 's'}
            </span>
            {(cell.expiryCountInBucket ?? 0) > 1 && (
              <>
                <span className="text-xs text-muted-foreground">·</span>
                <span className="text-xs text-muted-foreground">
                  {cell.expiryCountInBucket} expiries in week
                </span>
              </>
            )}
            <span className="text-xs text-muted-foreground">·</span>
            <span className="text-xs text-muted-foreground">
              snapshot {relTime(cell.latestSnapshotAt)}
            </span>
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 space-y-5">
          {/* Change since baseline (only when delta data is on the cell) */}
          {cell.deltaValue != null && Number.isFinite(cell.deltaValue) && (
            <section>
              <h3 className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5">
                Change since baseline
              </h3>
              <div className="rounded-md border border-border/40 bg-muted/20 px-3 py-2 text-sm">
                {(() => {
                  const dv = cell.deltaValue as number;
                  const verb = dv > 0 ? 'Up' : dv < 0 ? 'Down' : 'Flat';
                  const window = baselineLabel ?? 'baseline';
                  const sign = dv > 0 ? '+' : dv < 0 ? '-' : '';
                  const abs = Math.abs(dv);
                  const body = abs >= 1_000_000_000
                    ? `${(abs / 1_000_000_000).toFixed(1)}B`
                    : abs >= 1_000_000
                      ? `${(abs / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`
                      : abs >= 1_000
                        ? `${Math.round(abs / 1_000)}K`
                        : abs.toFixed(0);
                  const colorClass = dv > 0
                    ? 'text-emerald-500'
                    : dv < 0
                      ? 'text-rose-500'
                      : 'text-muted-foreground';
                  return (
                    <div>
                      <span className="text-muted-foreground">{verb}</span>{' '}
                      <span className={cn('font-mono font-semibold', colorClass)}>{sign}${body}</span>{' '}
                      <span className="text-muted-foreground">
                        {window === '1h ago' ? 'in last 1h' : `since ${window}`}
                      </span>
                      {cell.deltaPct != null && Number.isFinite(cell.deltaPct) && (
                        <span className="text-muted-foreground ml-1">
                          ({cell.deltaPct > 0 ? '+' : ''}{cell.deltaPct.toFixed(1)}%)
                        </span>
                      )}
                    </div>
                  );
                })()}
                {cell.baselineValue != null && Number.isFinite(cell.baselineValue) && (
                  <div className="text-[10px] text-muted-foreground mt-0.5">
                    Baseline value: {formatSignedUsd(cell.baselineValue, mathMode)}
                  </div>
                )}
              </div>
            </section>
          )}

          {/* Phase 5 — System State at this cell.
              Mirrors the brain organs Claude consumers read: specialist's
              latest take, Pulse regime, recent detector flags scoped to
              (ticker × expiry-bucket-week), James's flags in this strike
              range, and recent news with sentiment + causality. Empty
              sub-sections fall through silently — the goal is to surface
              CONVERGENT signal, not exhaustive panels. */}
          <section>
            <h3 className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5">
              System state at this cell
            </h3>
            <div className="rounded-md border border-border/40 bg-muted/10 px-3 py-2.5 space-y-2.5 text-sm">
              {/* Specialist read */}
              {specialistLatest ? (
                <div>
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground">specialist</span>
                    {specialistLatest.direction_lean && (
                      <Badge
                        variant="outline"
                        className={cn(
                          'text-[9px] font-mono px-1 py-0 h-4',
                          specialistLatest.direction_lean === 'bullish' && 'text-sky-300 border-sky-500/40',
                          specialistLatest.direction_lean === 'bearish' && 'text-orange-300 border-orange-500/40',
                          specialistLatest.direction_lean === 'mixed' && 'text-slate-300 border-slate-500/40',
                          specialistLatest.direction_lean === 'neutral' && 'text-muted-foreground',
                        )}
                      >
                        {specialistLatest.direction_lean}
                        {specialistLatest.conviction != null && (
                          <span className="opacity-70 ml-0.5">{Math.round(specialistLatest.conviction)}</span>
                        )}
                      </Badge>
                    )}
                    <span className="text-[9px] text-muted-foreground/70 ml-auto">
                      {relTime(specialistLatest.updated_at)}
                    </span>
                  </div>
                  <p className="text-xs text-foreground/85 leading-snug">
                    {specialistLatest.read_text}
                  </p>
                </div>
              ) : (
                <div className="text-[11px] text-muted-foreground italic">
                  No specialist read for {cell.ticker} in window.
                </div>
              )}

              {/* Pulse regime */}
              {cellPulse && (
                <div className="border-t border-border/40 pt-2">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground">pulse</span>
                    <Badge
                      variant="outline"
                      className={cn(
                        'text-[9px] font-mono px-1 py-0 h-4',
                        cellPulse.premium_net > 0 ? 'text-sky-300 border-sky-500/40' : 'text-orange-300 border-orange-500/40',
                      )}
                    >
                      C/P {Number.isFinite(cellPulse.call_put_ratio) ? cellPulse.call_put_ratio.toFixed(2) : '—'}
                    </Badge>
                    <span className="text-[10px] text-foreground/80 font-mono">
                      net {formatSignedUsd(cellPulse.premium_net, 'net_signed')}
                    </span>
                    {cellPulse.is_unusual && (
                      <span className="text-[9px] text-amber-300">⚡ unusual vs 30d</span>
                    )}
                  </div>
                </div>
              )}

              {/* Detector flags on this cell */}
              {cellDetectorFlags.length > 0 && (
                <div className="border-t border-border/40 pt-2">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                    detectors ({cellDetectorFlags.length})
                  </div>
                  <div className="space-y-1.5">
                    {cellDetectorFlags.slice(0, 5).map((f) => {
                      const breakdownPreview = f.score_breakdown && typeof f.score_breakdown === 'object'
                        ? Object.entries(f.score_breakdown as Record<string, unknown>)
                            .filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object')
                            .slice(0, 4)
                            .map(([k, v]) => `${k}=${typeof v === 'number' ? v.toFixed(2) : String(v).slice(0, 24)}`)
                            .join(' · ')
                        : null;
                      return (
                        <div key={f.flag_id} className="flex items-start gap-2 text-[11px]">
                          <Badge
                            variant="outline"
                            className={cn(
                              'text-[9px] font-mono px-1 py-0 h-4 shrink-0',
                              f.direction === 'bullish' && 'text-sky-300 border-sky-500/40',
                              f.direction === 'bearish' && 'text-orange-300 border-orange-500/40',
                              f.direction === 'neutral' && 'text-slate-300 border-slate-500/40',
                            )}
                          >
                            {f.direction}
                          </Badge>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5 text-foreground/85">
                              <span className="font-mono font-semibold">{f.detector_name ?? f.detector_id ?? 'detector'}</span>
                              <span className="font-mono text-muted-foreground">z={(f.score ?? 0).toFixed(1)}</span>
                              <span className="text-[9px] text-muted-foreground/70 ml-auto">{relTime(f.created_at)}</span>
                            </div>
                            {breakdownPreview && (
                              <div className="text-[10px] text-muted-foreground/80 font-mono truncate">
                                {breakdownPreview}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* James's flags in this cell */}
              {cellJamesFlags.length > 0 && (
                <div className="border-t border-border/40 pt-2">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                    James flags ({cellJamesFlags.length})
                  </div>
                  <div className="space-y-1.5">
                    {cellJamesFlags.slice(0, 5).map((f) => (
                      <div key={f.id} className="flex items-start gap-2 text-[11px]">
                        <span className="shrink-0 mt-0.5 text-amber-400">★</span>
                        <Badge
                          variant="outline"
                          className={cn(
                            'text-[9px] font-mono px-1 py-0 h-4 shrink-0',
                            f.direction_view === 'bullish' && 'text-sky-300 border-sky-500/40',
                            f.direction_view === 'bearish' && 'text-orange-300 border-orange-500/40',
                            f.direction_view === 'neutral' && 'text-slate-300 border-slate-500/40',
                          )}
                        >
                          {f.direction_view}
                        </Badge>
                        <div className="min-w-0 flex-1">
                          {f.strike != null && (
                            <span className="font-mono text-foreground/85 mr-1.5">${f.strike}</span>
                          )}
                          {f.note ? (
                            <span className="text-foreground/80">{f.note}</span>
                          ) : (
                            <span className="text-muted-foreground italic">no note</span>
                          )}
                          <span className="text-[9px] text-muted-foreground/70 ml-2">{relTime(f.flagged_at)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* News (last 6h, ticker-filtered) */}
              {cellNews.length > 0 && (
                <div className="border-t border-border/40 pt-2">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                    news ({cellNews.length}) · last 6h
                  </div>
                  <div className="space-y-1.5">
                    {cellNews.slice(0, 5).map((n) => (
                      <div key={n.id} className="flex items-start gap-2 text-[11px]">
                        <Badge
                          variant="outline"
                          className={cn(
                            'text-[9px] font-mono px-1 py-0 h-4 shrink-0',
                            n.severity >= 4 && 'text-rose-300 border-rose-500/40',
                            n.severity === 3 && 'text-amber-300 border-amber-500/40',
                            n.severity <= 2 && 'text-muted-foreground border-border',
                          )}
                        >
                          sev {n.severity}
                        </Badge>
                        <div className="min-w-0 flex-1">
                          <div className="text-foreground/85 line-clamp-2">{n.headline}</div>
                          <div className="text-[10px] text-muted-foreground/80 flex items-center gap-1.5">
                            {n.sentiment && <span>· {n.sentiment}</span>}
                            {n.causality.moved === true && (
                              <span className="text-emerald-300">flow moved within 15m</span>
                            )}
                            {n.causality.moved === false && (
                              <span className="text-muted-foreground/60">no flow follow-through</span>
                            )}
                            <span className="ml-auto">{relTime(n.ingested_at)}</span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Empty-state hint when nothing converged */}
              {!specialistLatest && !cellPulse && cellDetectorFlags.length === 0 &&
                cellJamesFlags.length === 0 && cellNews.length === 0 && (
                <div className="text-[11px] text-muted-foreground italic">
                  No system signal on {cell.ticker} in this window — the cell is
                  flow-only convergence, not multi-organ.
                </div>
              )}
            </div>
          </section>

          {/* Strike breakdown bar */}
          <section>
            <h3 className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5">
              Strike breakdown
            </h3>
            {strikeBreakdown.length === 0 ? (
              <div className="text-xs text-muted-foreground italic py-6 text-center">
                {alertsLoading ? 'Loading strike breakdown…' : 'No per-strike detail available.'}
              </div>
            ) : (
              <div className="h-44 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={strikeBreakdown} margin={{ top: 4, right: 8, left: -12, bottom: 0 }}>
                    <CartesianGrid stroke="rgba(255,255,255,0.05)" />
                    <XAxis
                      dataKey="strike"
                      stroke="#94a3b8"
                      tick={{ fontSize: 10 }}
                    />
                    <YAxis
                      stroke="#94a3b8"
                      tick={{ fontSize: 10 }}
                      tickFormatter={(v: number) => formatUsd(v)}
                    />
                    <RTooltip
                      contentStyle={{ background: '#0f172a', border: '1px solid rgba(255,255,255,0.1)', fontSize: 11 }}
                      labelFormatter={(label) => `$${label} strike`}
                      formatter={(v: number, name: string) => [formatUsd(v), name]}
                    />
                    <Bar dataKey="calls" stackId="a" fill="#38bdf8" name="calls" />
                    <Bar dataKey="puts" stackId="a" fill="#f97316" name="puts" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </section>

          {/* Time-series */}
          <section>
            <h3 className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5">
              Cell evolution (last 24h)
            </h3>
            {historySeries.length < 2 ? (
              <div className="text-xs text-muted-foreground italic py-4 text-center">
                Not enough history yet — comes online after a few snapshots accumulate.
              </div>
            ) : (
              <div className="h-32 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={historySeries} margin={{ top: 4, right: 8, left: -12, bottom: 0 }}>
                    <CartesianGrid stroke="rgba(255,255,255,0.05)" />
                    <XAxis
                      dataKey="t"
                      type="number"
                      domain={['dataMin', 'dataMax']}
                      stroke="#94a3b8"
                      tick={{ fontSize: 10 }}
                      tickFormatter={(t: number) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                    />
                    <YAxis
                      stroke="#94a3b8"
                      tick={{ fontSize: 10 }}
                      tickFormatter={(v: number) => formatUsd(v)}
                    />
                    <RTooltip
                      contentStyle={{ background: '#0f172a', border: '1px solid rgba(255,255,255,0.1)', fontSize: 11 }}
                      labelFormatter={(t) => new Date(t as number).toLocaleString()}
                      formatter={(v: number) => [formatSignedUsd(v, mathMode), 'value']}
                    />
                    <Line
                      type="monotone"
                      dataKey="value"
                      stroke="#7dd3fc"
                      strokeWidth={1.5}
                      dot={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </section>

          {/* Historical analogs — Phase 6 placeholder.
              ct_cell_analogs RPC will perform semantic similarity over
              embedded ct_flow_alerts to find prior cells that resolved a
              certain way ("this looks like X past situation, which became
              Y"). Hook is wired and stubbed; the section renders even now
              so the convergence terminus is visually complete. */}
          <section>
            <h3 className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5">
              Historical analogs
            </h3>
            {analogsPending && analogs.length === 0 ? (
              <div className="rounded-md border border-dashed border-border/40 bg-muted/10 px-3 py-3 text-[11px] text-muted-foreground">
                <span className="font-mono text-amber-300">Phase 6 pending</span>
                {' — '}
                semantic similarity over embedded ct_flow_alerts will surface
                analog cells that resolved a certain way. Wire is in place;
                fills in after the ct_cell_analogs RPC ships.
              </div>
            ) : (
              <div className="space-y-1">
                {analogs.slice(0, 5).map((a) => (
                  <div key={a.alert_id} className="text-[11px] flex items-center gap-2">
                    <span className="font-mono text-foreground/85">{a.ticker}</span>
                    <span className="text-muted-foreground">{a.expiry_bucket_week}</span>
                    <span className="text-muted-foreground">·</span>
                    <span className="font-mono">{(a.similarity * 100).toFixed(0)}%</span>
                    {a.resolution?.label && (
                      <span className="text-foreground/80">{a.resolution.label}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Alert list */}
          <section>
            <h3 className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5">
              Top contributing alerts ({alerts?.length ?? 0}/{cell.sourceAlertCount ?? 0})
            </h3>
            {alertsLoading ? (
              <div className="text-xs text-muted-foreground italic py-4 text-center">Loading alerts…</div>
            ) : (alerts?.length ?? 0) === 0 ? (
              <div className="text-xs text-muted-foreground italic py-4 text-center">
                No alert detail available for this cell yet.
              </div>
            ) : (
              <div className="space-y-1.5">
                {alerts.map((a) => {
                  const aggressive = a.is_ask === true ? 'ask' : a.is_bid === true ? 'bid' : null;
                  return (
                    <div
                      key={a.id}
                      className="flex items-center justify-between gap-2 px-2 py-1.5 rounded border border-border/40 hover:bg-muted/20 transition-colors"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className={cn(
                            'text-[10px] font-mono px-1 py-0.5 rounded',
                            a.side === 'call' ? 'text-sky-300 bg-sky-500/10' : 'text-orange-300 bg-orange-500/10',
                          )}>
                            {a.side === 'call' ? 'C' : a.side === 'put' ? 'P' : '?'}
                          </span>
                          <span className="text-xs font-mono">${a.strike ?? '—'}</span>
                          <span className="text-[10px] text-muted-foreground">{a.expiry ?? '—'}</span>
                          {aggressive && (
                            <Badge variant="outline" className="text-[9px] font-mono px-1 py-0 h-4">
                              {aggressive}
                            </Badge>
                          )}
                          {a.alert_type && (
                            <span className="text-[9px] text-muted-foreground/70 truncate">
                              {a.alert_type}
                            </span>
                          )}
                        </div>
                        {a.option_symbol && (
                          <div className="text-[9px] font-mono text-muted-foreground/70 truncate">
                            {a.option_symbol}
                          </div>
                        )}
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-xs font-mono tabular-nums">
                          {formatUsd(a.premium)}
                        </div>
                        <div className="text-[9px] text-muted-foreground">
                          {a.size ? `${a.size}x` : '—'} · {relTime(a.executed_at ?? a.ingested_at)}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}
