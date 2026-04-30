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

  /** Historical evolution — last 24h of this ticker × expiry combo. */
  const sinceIso = useMemo(() => new Date(Date.now() - 24 * 3600_000).toISOString(), [open]);
  const untilIso = useMemo(() => new Date().toISOString(), [open]);
  const { data: historyRows = [] } = useFlowHeatmapHistory({
    tickers: cell ? [cell.ticker] : null,
    since: sinceIso,
    until: untilIso,
    mathMode,
  });
  const historySeries = useMemo(() => {
    if (!cell) return [];
    return historyRows
      .filter((r) => r.ticker === cell.ticker && r.expiry_bucket_week === cell.expiryBucketWeek)
      .map((r) => ({
        t: Date.parse(r.latest_snapshot_at),
        ts: r.latest_snapshot_at,
        value: r.value,
      }))
      .sort((a, b) => a.t - b.t);
  }, [historyRows, cell]);

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
