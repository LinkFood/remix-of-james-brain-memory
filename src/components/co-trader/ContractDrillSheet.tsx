/**
 * ContractDrillSheet — the SOLE right-side drill sheet for an option contract.
 *
 * Replaces the older ContractSheet (deleted 2026-04-29) — this component is
 * the convergence point per CO-TRADER THESIS Tenets 21 (one glance-first view)
 * and 24 (no silos). Every "click into a contract" path on the site routes
 * here.
 *
 * Two layers stacked top-to-bottom:
 *   1) Contract-axis P&L (Phase D grading) — header, big P&L card with
 *      peak/drawdown/print_count chips, mid-price chart with markers,
 *      time-to-N% milestones. Sourced from ct_contract_tracks +
 *      ct_contract_quotes. Populated by ct-contract-poller.
 *   2) Contract context — Claude's take from ct_flags, micro-context grid
 *      from ct_ticker_snapshots, breaking news (ct_breaking_news), today's
 *      prints (ct_flow_alerts), OI snapshot history (ct_oi_snapshots).
 *
 * Section (1) gracefully degrades to "no track yet" if the grader hasn't
 * created a track for this symbol; section (2) still renders if optionSymbol
 * is supplied (the prints/OI/news layer doesn't depend on a track existing).
 */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import {
  TrendingUp, TrendingDown, Target, Clock, Hourglass, AlertCircle,
  Activity, Gauge, Newspaper,
} from 'lucide-react';
import {
  LineChart, Line, XAxis, YAxis, ResponsiveContainer, Tooltip,
  ReferenceLine, ReferenceDot,
} from 'recharts';
import {
  useContractTrack,
  useContractTrackBySymbol,
  fmtPctFromFraction, fmtPctMagnitude, fmtInterval, addInterval,
  type ContractTrackRow, type ContractTrackStatus,
} from '@/hooks/useContractTracks';
import { useContractQuotes } from '@/hooks/useContractQuotes';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Preferred — resolves the canonical track directly by symbol so re-prints
   * (which all share an option_symbol but differ on alert_id) surface the
   * aggregated print_count / last_print_at without depending on the
   * alert_id → ledger chain.
   */
  optionSymbol?: string | null;
  /** Fallback — used when the caller only has the alert_id (e.g. legacy chip clicks). */
  alertId?: string | null;
  /** Optional — when provided, the contract header exposes a "{ticker} dashboard →"
   *  button that closes this sheet and opens TickerSheet for that underlying. */
  onTickerClick?: (ticker: string) => void;
}

// ---------- shared types for context layer ----------

interface AlertRow {
  id: number;
  alert_id: string;
  option_symbol: string;
  strike: number | null;
  expiry: string | null;
  side: 'call' | 'put' | null;
  is_ask: boolean | null;
  is_bid: boolean | null;
  is_otm: boolean | null;
  volume: number | null;
  open_interest: number | null;
  premium: number | null;
  executed_at: string;
  alert_type: string | null;
  raw: Record<string, unknown> | null;
}

interface OiSnap {
  id: number;
  snap_date: string;
  snap_slot: 'open' | 'mid' | 'close';
  oi: number | null;
  oi_delta_1d: number | null;
  oi_delta_5d: number | null;
  volume_today: number | null;
  captured_at: string;
}

interface FlagRef {
  id: string;
  option_symbol: string | null;
  specialist_ticker: string;
  direction: string;
  score: number;
  status: string;
  thesis: string;
  created_at: string;
}

interface TickerSnapshot {
  ticker: string;
  spot: number | null;
  iv_rank: number | null;
  call_wall: number | null;
  put_wall: number | null;
  gamma_flip: number | null;
  max_pain: number | null;
  regime: string | null;
  put_call_ratio: number | null;
  next_earnings_date: string | null;
  earnings_expected_move: number | null;
  snapshot_at: string | null;
  recent_news: Array<{
    headline: string;
    source: string | null;
    impact: string | null;
    significance: number | null;
    claude_take: string | null;
    created_at: string;
  }> | null;
}

interface BreakingNewsRow {
  headline: string;
  source: string | null;
  severity: number | null;
  sentiment: string | null;
  summary: string | null;
  macro_wide: boolean | null;
  tickers_affected: string[] | null;
  ingested_at: string;
}

// ---------- helpers ----------

/** Parse underlying ticker from OCC option symbol.
 *  OCC format: ROOT + YYMMDD + (C|P) + 8-digit strike.
 *  Strip the last 15 chars to get the ticker. */
function parseOccTicker(sym: string | null | undefined): string | null {
  if (!sym || sym.length < 16) return null;
  return sym.slice(0, sym.length - 15).toUpperCase();
}

function statusBadge(status: ContractTrackStatus | null): { label: string; cls: string; Icon: React.ComponentType<{ className?: string }> } {
  switch (status) {
    case 'WIN':
      return { label: 'WIN', cls: 'bg-emerald-500/30 text-emerald-200 border-emerald-500/60', Icon: Target };
    case 'LOSS':
      return { label: 'LOSS', cls: 'bg-rose-500/30 text-rose-200 border-rose-500/60', Icon: TrendingDown };
    case 'EXPIRED_WIN':
      return { label: 'EXPIRED WIN', cls: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40', Icon: Clock };
    case 'EXPIRED_LOSS':
      return { label: 'EXPIRED LOSS', cls: 'bg-rose-500/20 text-rose-300 border-rose-500/40', Icon: Clock };
    case 'EXPIRED_FLAT':
      return { label: 'EXPIRED FLAT', cls: 'bg-slate-500/20 text-slate-300 border-slate-500/40', Icon: Clock };
    case 'STALE':
      return { label: 'STALE', cls: 'bg-slate-500/15 text-slate-400 border-slate-500/30', Icon: Hourglass };
    case 'WORKING':
      return { label: 'WORKING', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30', Icon: TrendingUp };
    default:
      return { label: '—', cls: 'bg-muted/40 text-muted-foreground border-border/50', Icon: AlertCircle };
  }
}

function fmtPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n >= 100) return `$${n.toFixed(2)}`;
  if (n >= 10) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(2)}`;
}

function fmtClock(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleTimeString('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return iso;
  }
}

function fmtDateShort(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' });
  } catch {
    return iso;
  }
}

function dteLabel(dte: number | null): string {
  if (dte == null) return '';
  if (dte === 0) return '0DTE';
  if (dte === 1) return '1DTE';
  return `${dte}DTE`;
}

function formatTimeET(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('en-US', {
      timeZone: 'America/New_York',
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return iso.slice(11, 19);
  }
}

function formatPremium(n: number | null): string {
  if (n == null) return '-';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function formatInt(n: number | null): string {
  if (n == null) return '-';
  return n.toLocaleString('en-US');
}

function relativeTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function deriveTapeKind(alertType: string | null, raw: Record<string, unknown> | null): string {
  const r = raw ?? {};
  if (r.has_sweep === true || alertType === 'sweep') return 'SWEEP';
  if (r.has_block === true || alertType === 'block') return 'BLOCK';
  if (r.has_floor === true || alertType === 'floor') return 'FLOOR';
  if (r.has_multileg === true || alertType === 'multileg') return 'MLEG';
  if (alertType) return alertType.toUpperCase().slice(0, 5);
  return 'ALERT';
}

// ---------- header ----------

function HeaderRow({
  track,
  onTickerClick,
}: {
  track: ContractTrackRow;
  onTickerClick?: (ticker: string) => void;
}) {
  const sb = statusBadge(track.track_status);
  const Icon = sb.Icon;
  const sideCls =
    track.side === 'call'
      ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40'
      : 'bg-rose-500/15 text-rose-300 border-rose-500/40';
  const dte = dteLabel(track.dte_at_print);
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          {onTickerClick ? (
            <button
              type="button"
              onClick={() => onTickerClick(track.ticker)}
              className="font-mono text-xl font-bold tracking-tight hover:text-primary transition-colors underline decoration-dotted underline-offset-2"
              title={`Open ${track.ticker} dashboard`}
            >
              {track.ticker}
            </button>
          ) : (
            <span className="font-mono text-xl font-bold tracking-tight">{track.ticker}</span>
          )}
          <span className="font-mono text-lg text-foreground/90">
            {track.strike != null ? `$${track.strike}` : '—'}
          </span>
          <Badge variant="outline" className={cn('text-[10px] font-mono px-1.5 py-0 font-bold', sideCls)}>
            {track.side?.toUpperCase()}
          </Badge>
          <span className="font-mono text-xs text-muted-foreground">
            {fmtDateShort(track.expiry)}
          </span>
          {dte && (
            <span className="font-mono text-[10px] text-muted-foreground">({dte})</span>
          )}
        </div>
        <div className="text-[11px] text-muted-foreground mt-0.5 font-mono">
          print {fmtClock(track.print_time)} · {track.predicted_direction} via {track.predicted_source}
        </div>
      </div>
      <Badge variant="outline" className={cn('inline-flex items-center gap-1 text-xs font-bold tracking-wide px-2 py-0.5', sb.cls)}>
        <Icon className="w-3 h-3" />
        <span>{sb.label}</span>
      </Badge>
    </div>
  );
}

// ---------- big P&L card ----------

function PnLCard({ track }: { track: ContractTrackRow }) {
  const cur = track.current_contract_pct;
  const isPos = cur != null && cur >= 0;
  const colorPnL = isPos ? 'text-emerald-400' : 'text-rose-400';
  const peak = track.peak_contract_pct;
  const dd = track.max_drawdown_pct;

  return (
    <Card className="p-4">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <div className={cn('font-mono font-bold tabular-nums tracking-tight text-4xl', colorPnL)}>
            {cur != null ? fmtPctFromFraction(cur, 0) : '—'}
          </div>
          <div className="text-xs text-muted-foreground mt-1 font-mono">
            entry {fmtPrice(track.entry_contract_price)} → current {fmtPrice(track.current_contract_price)}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          {peak > 0 && (
            <Badge variant="outline" className="bg-emerald-500/10 text-emerald-300 border-emerald-500/30 font-mono text-[11px]">
              peak {fmtPctMagnitude(peak)}
              {track.peak_contract_at && (
                <span className="opacity-60 ml-1">@ {fmtClock(track.peak_contract_at)}</span>
              )}
            </Badge>
          )}
          {dd > 0.01 && (
            <Badge variant="outline" className="bg-rose-500/10 text-rose-300 border-rose-500/30 font-mono text-[11px]">
              drawdown −{(dd * 100).toFixed(0)}%
              {track.trough_contract_at && (
                <span className="opacity-60 ml-1">@ {fmtClock(track.trough_contract_at)}</span>
              )}
            </Badge>
          )}
          {track.print_count > 1 && (
            <span className="text-[10px] text-amber-300 font-mono font-semibold">
              {track.print_count} prints
              {track.last_print_at && (
                <span className="opacity-70 ml-1">· last {fmtClock(track.last_print_at)}</span>
              )}
            </span>
          )}
          {track.sweep_count > 0 && (
            <span className="text-[10px] text-muted-foreground font-mono">
              {track.sweep_count} sweep{track.sweep_count === 1 ? '' : 's'} · last quote {fmtClock(track.last_quoted_at)}
            </span>
          )}
        </div>
      </div>
    </Card>
  );
}

// ---------- chart ----------

interface ChartPoint {
  ts: number;       // epoch ms
  mid: number;
}

function PriceChart({ track }: { track: ContractTrackRow }) {
  const { data: quotes, isLoading } = useContractQuotes(
    track.option_symbol,
    track.print_time,
  );

  const points = useMemo<ChartPoint[]>(() => {
    if (!quotes) return [];
    return quotes
      .filter((q) => q.mid != null && Number.isFinite(q.mid))
      .map((q) => ({ ts: Date.parse(q.ts), mid: q.mid as number }))
      .filter((p) => Number.isFinite(p.ts));
  }, [quotes]);

  if (isLoading) {
    return (
      <Card className="p-3">
        <Skeleton className="h-48 w-full" />
      </Card>
    );
  }

  if (points.length === 0) {
    return (
      <Card className="p-6 flex flex-col items-center justify-center text-center min-h-[200px] border-dashed">
        <Hourglass className="w-6 h-6 text-muted-foreground mb-2" />
        <div className="text-sm font-medium">Waiting for the next poller sweep</div>
        <div className="text-xs text-muted-foreground mt-1 max-w-sm">
          Quotes for <span className="font-mono">{track.option_symbol}</span> populate
          every ~5min during RTH. The chart will fill in as ct_contract_quotes builds.
        </div>
      </Card>
    );
  }

  const entryPrice = track.entry_contract_price;
  const peakAtMs = track.peak_contract_at ? Date.parse(track.peak_contract_at) : null;
  const peakPrice = track.peak_contract_price;
  const fiftyAt = addInterval(track.print_time, track.time_to_50pct);
  const fiftyAtMs = fiftyAt ? Date.parse(fiftyAt) : null;
  const printMs = Date.parse(track.print_time);

  return (
    <Card className="p-2">
      <div className="h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points} margin={{ top: 10, right: 12, bottom: 8, left: 8 }}>
            <XAxis
              dataKey="ts"
              type="number"
              domain={['dataMin', 'dataMax']}
              tickFormatter={(v) =>
                new Date(v).toLocaleTimeString('en-US', {
                  timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true,
                })
              }
              stroke="hsl(var(--muted-foreground))"
              fontSize={10}
              minTickGap={40}
            />
            <YAxis
              dataKey="mid"
              tickFormatter={(v) => `$${typeof v === 'number' ? v.toFixed(2) : v}`}
              stroke="hsl(var(--muted-foreground))"
              fontSize={10}
              width={48}
              domain={['auto', 'auto']}
            />
            <Tooltip
              contentStyle={{
                background: 'hsl(var(--background))',
                border: '1px solid hsl(var(--border))',
                fontSize: 11,
              }}
              labelFormatter={(v) =>
                new Date(typeof v === 'number' ? v : Date.parse(String(v))).toLocaleString('en-US', {
                  timeZone: 'America/New_York', month: 'numeric', day: 'numeric',
                  hour: 'numeric', minute: '2-digit', hour12: true,
                })
              }
              formatter={(value: number) => [`$${value.toFixed(2)}`, 'mid']}
            />
            {entryPrice != null && (
              <ReferenceLine
                y={entryPrice}
                stroke="hsl(var(--muted-foreground))"
                strokeDasharray="3 3"
                label={{
                  value: `entry ${fmtPrice(entryPrice)}`,
                  position: 'insideTopLeft',
                  fill: 'hsl(var(--muted-foreground))',
                  fontSize: 10,
                }}
              />
            )}
            {Number.isFinite(printMs) && (
              <ReferenceLine
                x={printMs}
                stroke="hsl(var(--primary))"
                strokeOpacity={0.6}
                strokeDasharray="2 2"
                label={{ value: 'print', position: 'top', fill: 'hsl(var(--primary))', fontSize: 10 }}
              />
            )}
            {peakAtMs && peakPrice != null && (
              <ReferenceDot
                x={peakAtMs}
                y={peakPrice}
                r={4}
                fill="hsl(var(--background))"
                stroke="rgb(52 211 153)"
                strokeWidth={2}
                label={{
                  value: `peak ${fmtPrice(peakPrice)}`,
                  position: 'top',
                  fill: 'rgb(52 211 153)',
                  fontSize: 10,
                }}
              />
            )}
            {fiftyAtMs && (
              <ReferenceLine
                x={fiftyAtMs}
                stroke="rgb(251 191 36)"
                strokeOpacity={0.5}
                strokeDasharray="2 4"
                label={{ value: '+50%', position: 'top', fill: 'rgb(251 191 36)', fontSize: 10 }}
              />
            )}
            <Line
              type="monotone"
              dataKey="mid"
              stroke="hsl(var(--primary))"
              strokeWidth={1.75}
              dot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="text-[10px] text-muted-foreground font-mono pt-1 px-1 flex items-center justify-between">
        <span>{points.length} quotes since print</span>
        <span>mid ($/contract share)</span>
      </div>
    </Card>
  );
}

// ---------- time-to footer ----------

function TimeToTable({ track }: { track: ContractTrackRow }) {
  const rows: { label: string; value: string | null }[] = [
    { label: '+50%',  value: track.time_to_50pct },
    { label: '+100%', value: track.time_to_100pct },
    { label: '+200%', value: track.time_to_200pct },
  ];
  return (
    <Card className="p-3">
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2">Time to</div>
      <div className="grid grid-cols-3 gap-2">
        {rows.map((r) => (
          <div key={r.label} className="flex flex-col">
            <div className="text-[10px] font-mono text-muted-foreground">{r.label}</div>
            <div className={cn(
              'font-mono tabular-nums text-sm font-semibold',
              r.value ? 'text-emerald-300' : 'text-muted-foreground',
            )}>
              {fmtInterval(r.value)}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

// ---------- context layer (Claude take, micro context, news, prints, OI) ----------
//
// Ported wholesale from the deleted ContractSheet (2026-04-29). Renders
// whenever an option_symbol is supplied — does NOT depend on a track row
// existing, so brand-new prints with no grader pass yet still show context.

function ContextLayer({
  optionSymbol,
  open,
  ticker,
  strike,
  onTickerClick,
}: {
  optionSymbol: string;
  open: boolean;
  ticker: string | null;
  strike: number | null;
  onTickerClick?: (ticker: string) => void;
}) {
  // Today-ET range for prints query.
  const todayBounds = useMemo(() => {
    const now = new Date();
    const etMidnight = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    etMidnight.setHours(0, 0, 0, 0);
    const startIso = etMidnight.toISOString();
    const end = new Date(etMidnight.getTime() + 24 * 3600_000);
    const endIso = end.toISOString();
    return { startIso, endIso };
  }, []);

  const { data: prints } = useQuery<AlertRow[]>({
    queryKey: ['ct_contract_prints', optionSymbol, todayBounds.startIso],
    enabled: open && !!optionSymbol,
    refetchInterval: 30_000,
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.from('ct_flow_alerts' as never) as any)
        .select('id,alert_id,option_symbol,strike,expiry,side,is_ask,is_bid,is_otm,volume,open_interest,premium,executed_at,alert_type,raw')
        .eq('option_symbol', optionSymbol)
        .gte('executed_at', todayBounds.startIso)
        .lt('executed_at', todayBounds.endIso)
        .order('executed_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      return (data ?? []) as unknown as AlertRow[];
    },
  });

  const { data: oiHistory } = useQuery<OiSnap[]>({
    queryKey: ['ct_contract_oi', optionSymbol],
    enabled: open && !!optionSymbol,
    refetchInterval: 60_000,
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.from('ct_oi_snapshots' as never) as any)
        .select('id,snap_date,snap_slot,oi,oi_delta_1d,oi_delta_5d,volume_today,captured_at')
        .eq('option_symbol', optionSymbol)
        .order('snap_date', { ascending: false })
        .order('captured_at', { ascending: false })
        .limit(20);
      if (error) throw error;
      return (data ?? []) as unknown as OiSnap[];
    },
  });

  // Breaking news (Tavily sweep + macro watcher) — last 7d for this ticker.
  const { data: breakingNews } = useQuery<BreakingNewsRow[]>({
    queryKey: ['contract_breaking_news', ticker],
    enabled: open && !!ticker,
    refetchInterval: 60_000,
    queryFn: async () => {
      if (!ticker) return [];
      const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await (supabase.from('ct_breaking_news' as never) as any)
        .select('headline,source,severity,sentiment,summary,macro_wide,tickers_affected,ingested_at')
        .gte('ingested_at', since)
        .order('ingested_at', { ascending: false })
        .limit(200);
      const rows = (data ?? []) as BreakingNewsRow[];
      return rows.filter((r) => (r.tickers_affected ?? []).includes(ticker) || r.macro_wide === true).slice(0, 20);
    },
  });

  // Ticker-level micro snapshot + recent news.
  const { data: snapshot } = useQuery<TickerSnapshot | null>({
    queryKey: ['contract_ticker_snapshot', ticker],
    enabled: open && !!ticker,
    refetchInterval: 60_000,
    queryFn: async () => {
      if (!ticker) return null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.from('ct_ticker_snapshots' as never) as any)
        .select('*')
        .eq('ticker', ticker)
        .maybeSingle();
      if (error) return null;
      return data as TickerSnapshot | null;
    },
  });

  const { data: flagRef } = useQuery<FlagRef | null>({
    queryKey: ['ct_contract_flag', optionSymbol],
    enabled: open && !!optionSymbol,
    refetchInterval: 60_000,
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.from('ct_flags' as never) as any)
        .select('id,option_symbol,specialist_ticker,direction,score,status,thesis,created_at')
        .eq('option_symbol', optionSymbol)
        .order('created_at', { ascending: false })
        .limit(1);
      if (error) throw error;
      const rows = (data ?? []) as unknown as FlagRef[];
      return rows[0] ?? null;
    },
  });

  return (
    <>
      {/* Today's print count + ticker dashboard bridge. Renders even when the
          P&L track hasn't been created yet — strong glance signal. */}
      <div className="flex items-center gap-2 flex-wrap text-xs text-muted-foreground tabular-nums">
        <Activity className="w-3.5 h-3.5" />
        <span className="font-mono break-all">{optionSymbol}</span>
        {ticker && onTickerClick && (
          <button
            type="button"
            onClick={() => onTickerClick(ticker)}
            className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-primary/40 bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
          >
            {ticker} dashboard →
          </button>
        )}
        <span className="ml-auto">today&apos;s prints <span className="text-foreground font-semibold">{prints?.length ?? 0}</span></span>
      </div>

      {/* Claude's take */}
      {flagRef && (
        <div className="rounded-md border border-primary/30 bg-primary/5 p-3">
          <div className="flex items-center justify-between gap-2 mb-1.5">
            <div className="flex items-center gap-2">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Claude&apos;s take</span>
              <Badge variant="outline" className="text-[9px] font-mono px-1 py-0">
                {flagRef.specialist_ticker}
              </Badge>
              <Badge
                variant="outline"
                className={cn(
                  'text-[9px] font-mono px-1 py-0',
                  flagRef.direction === 'bullish' && 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40',
                  flagRef.direction === 'bearish' && 'bg-red-500/15 text-red-300 border-red-500/40',
                  flagRef.direction === 'neutral' && 'bg-slate-500/15 text-slate-300 border-slate-500/40',
                )}
              >
                {flagRef.direction}
              </Badge>
              <span className="text-[10px] text-muted-foreground">{relativeTime(flagRef.created_at)}</span>
            </div>
            <span
              className={cn(
                'text-sm font-bold tabular-nums',
                flagRef.score >= 80 ? 'text-emerald-400' : flagRef.score >= 60 ? 'text-amber-400' : 'text-muted-foreground',
              )}
            >
              {Math.round(flagRef.score)}
            </span>
          </div>
          <div className="text-xs text-foreground/90 leading-snug">
            {flagRef.thesis.length > 240 ? `${flagRef.thesis.slice(0, 240)}…` : flagRef.thesis}
          </div>
        </div>
      )}

      {/* Micro context: where spot sits vs this contract's strike, plus ticker-level structure */}
      {snapshot && (
        <section>
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">
            <Gauge className="w-3 h-3" />
            Micro context · {snapshot.ticker}
            {snapshot.snapshot_at && (
              <span className="ml-auto text-muted-foreground/60 normal-case text-[10px]">{relativeTime(snapshot.snapshot_at)}</span>
            )}
          </div>
          <Card className="p-3 grid grid-cols-2 md:grid-cols-4 gap-x-3 gap-y-2 text-xs">
            <div>
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Spot</div>
              <div className="font-mono tabular-nums font-semibold">
                {snapshot.spot != null ? `$${snapshot.spot.toFixed(2)}` : '—'}
              </div>
            </div>
            <div>
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Strike dist</div>
              <div className={cn(
                'font-mono tabular-nums',
                (() => {
                  if (snapshot.spot == null || strike == null || snapshot.spot <= 0) return 'text-muted-foreground';
                  const pct = Math.abs(strike - snapshot.spot) / snapshot.spot;
                  if (pct < 0.01) return 'text-muted-foreground';
                  if (pct < 0.03) return 'text-foreground';
                  if (pct < 0.07) return 'text-amber-300';
                  return 'text-emerald-400 font-bold';
                })(),
              )}>
                {snapshot.spot != null && strike != null
                  ? `${((strike - snapshot.spot) / snapshot.spot * 100).toFixed(1)}%`
                  : '—'}
              </div>
            </div>
            <div>
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Regime</div>
              <div className={cn(
                'font-mono text-[11px]',
                snapshot.regime === 'positive_gamma' ? 'text-emerald-300' : snapshot.regime === 'negative_gamma' ? 'text-red-300' : 'text-muted-foreground',
              )}>
                {snapshot.regime?.replace('_', ' ') ?? '—'}
              </div>
            </div>
            <div>
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider">IV rank</div>
              <div className="font-mono tabular-nums">
                {snapshot.iv_rank != null ? snapshot.iv_rank.toFixed(1) : '—'}
              </div>
            </div>
            <div>
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider inline-flex items-center gap-1">
                <Target className="w-2.5 h-2.5" /> Call wall
              </div>
              <div className="font-mono tabular-nums text-emerald-300">
                {snapshot.call_wall != null ? `$${snapshot.call_wall}` : '—'}
              </div>
            </div>
            <div>
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider inline-flex items-center gap-1">
                <Target className="w-2.5 h-2.5" /> Put wall
              </div>
              <div className="font-mono tabular-nums text-red-300">
                {snapshot.put_wall != null ? `$${snapshot.put_wall}` : '—'}
              </div>
            </div>
            <div>
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Max pain</div>
              <div className="font-mono tabular-nums">
                {snapshot.max_pain != null ? `$${snapshot.max_pain}` : '—'}
              </div>
            </div>
            <div>
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider">P/C</div>
              <div className="font-mono tabular-nums">
                {snapshot.put_call_ratio != null ? snapshot.put_call_ratio.toFixed(2) : '—'}
              </div>
            </div>
            {snapshot.next_earnings_date && (
              <div className="col-span-2 md:col-span-4 pt-2 border-t border-border/40">
                <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Earnings</div>
                <div className="font-mono text-amber-300">
                  {snapshot.next_earnings_date}
                  {snapshot.earnings_expected_move != null && (
                    <span className="ml-2 text-muted-foreground">±{(snapshot.earnings_expected_move * 100).toFixed(1)}%</span>
                  )}
                </div>
              </div>
            )}
          </Card>
        </section>
      )}

      {/* Breaking news (Tavily sweep) — last 7d for this ticker */}
      {breakingNews && breakingNews.length > 0 && (
        <section>
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5 flex-wrap">
            <Newspaper className="w-3 h-3" />
            Breaking news · last 7d · {ticker}
            {(() => {
              let bullScore = 0, bearScore = 0, counted = 0;
              for (const n of breakingNews) {
                const sev = n.severity ?? 1;
                if (n.sentiment === 'bullish') { bullScore += sev; counted++; }
                else if (n.sentiment === 'bearish') { bearScore += sev; counted++; }
              }
              if (counted < 2 || (bullScore + bearScore) === 0) return null;
              const bullPct = Math.round((bullScore / (bullScore + bearScore)) * 100);
              const skew = bullPct >= 65 ? 'bullish' : bullPct <= 35 ? 'bearish' : 'mixed';
              return (
                <span className={cn(
                  'ml-auto normal-case text-[10px] font-mono px-1.5 py-0.5 rounded border',
                  skew === 'bullish' && 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40',
                  skew === 'bearish' && 'bg-red-500/15 text-red-300 border-red-500/40',
                  skew === 'mixed' && 'bg-slate-500/15 text-slate-300 border-slate-500/40',
                )}
                title={`Severity-weighted: bullish=${bullScore}, bearish=${bearScore}, counted=${counted}`}
                >
                  {bullPct}% bull · {counted}
                </span>
              );
            })()}
          </div>
          <div className="space-y-1.5">
            {breakingNews.map((n, i) => (
              <Card key={`bn-${i}`} className={cn(
                'p-2.5',
                n.sentiment === 'bullish' && 'border-emerald-500/25',
                n.sentiment === 'bearish' && 'border-red-500/25',
                (n.severity ?? 0) >= 4 && 'ring-1 ring-amber-500/40',
              )}>
                <div className="flex items-baseline gap-2 mb-1">
                  <Badge variant="outline" className={cn(
                    'text-[9px] font-mono px-1 py-0 uppercase',
                    n.sentiment === 'bullish' && 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40',
                    n.sentiment === 'bearish' && 'bg-red-500/15 text-red-300 border-red-500/40',
                    (!n.sentiment || n.sentiment === 'neutral' || n.sentiment === 'ambiguous') && 'bg-slate-500/15 text-slate-300 border-slate-500/40',
                  )}>
                    {n.sentiment ?? 'neutral'}
                  </Badge>
                  {n.severity != null && (
                    <span className={cn('text-[10px] font-mono tabular-nums', n.severity >= 4 ? 'text-amber-300 font-bold' : 'text-muted-foreground')}>sev {n.severity}</span>
                  )}
                  {n.source && <span className="text-[10px] text-muted-foreground">{n.source}</span>}
                  {n.macro_wide && <span className="text-[10px] font-mono text-muted-foreground">macro</span>}
                  <span className="text-[10px] text-muted-foreground ml-auto">{relativeTime(n.ingested_at)}</span>
                </div>
                <div className="text-xs font-semibold text-foreground/90 leading-snug mb-1">{n.headline}</div>
                {n.summary && <div className="text-[11px] text-muted-foreground leading-snug">{n.summary}</div>}
              </Card>
            ))}
          </div>
        </section>
      )}

      {/* Recent news for this ticker with Claude's take */}
      {snapshot?.recent_news && snapshot.recent_news.length > 0 && (
        <section>
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">
            <Newspaper className="w-3 h-3" />
            Recent news · {snapshot.ticker}
          </div>
          <div className="space-y-1.5">
            {snapshot.recent_news.slice(0, 4).map((n, i) => (
              <Card
                key={i}
                className={cn(
                  'p-2.5',
                  n.impact === 'bullish' && 'border-emerald-500/25',
                  n.impact === 'bearish' && 'border-red-500/25',
                )}
              >
                <div className="flex items-baseline gap-2 mb-1">
                  <Badge variant="outline" className={cn(
                    'text-[9px] font-mono px-1 py-0 uppercase',
                    n.impact === 'bullish' && 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40',
                    n.impact === 'bearish' && 'bg-red-500/15 text-red-300 border-red-500/40',
                    (!n.impact || n.impact === 'neutral') && 'bg-slate-500/15 text-slate-300 border-slate-500/40',
                  )}>
                    {n.impact ?? 'neutral'}
                  </Badge>
                  {n.source && <span className="text-[10px] text-muted-foreground">{n.source}</span>}
                  {n.significance != null && <span className="text-[10px] text-muted-foreground">· sig {n.significance}</span>}
                  <span className="text-[10px] text-muted-foreground ml-auto">{relativeTime(n.created_at)}</span>
                </div>
                <div className="text-xs font-semibold text-foreground/90 leading-snug mb-1">{n.headline}</div>
                {n.claude_take && (
                  <div className="text-[11px] text-muted-foreground leading-snug">{n.claude_take}</div>
                )}
              </Card>
            ))}
          </div>
        </section>
      )}

      {/* Today's prints */}
      <section>
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">Today&apos;s prints</div>
        {!prints ? (
          <div className="text-xs text-muted-foreground">Loading…</div>
        ) : prints.length === 0 ? (
          <div className="text-xs text-muted-foreground">No prints today for this contract.</div>
        ) : (
          <div className="overflow-x-auto rounded-md border border-border">
            <Table className="text-[11px]">
              <TableHeader>
                <TableRow className="border-b border-border hover:bg-transparent">
                  <TableHead className="h-7 px-2 text-[10px] uppercase tracking-wider">Time</TableHead>
                  <TableHead className="h-7 px-2 text-[10px] uppercase tracking-wider">Tape</TableHead>
                  <TableHead className="h-7 px-2 text-[10px] uppercase tracking-wider text-right">Prem</TableHead>
                  <TableHead className="h-7 px-2 text-[10px] uppercase tracking-wider text-right">Vol</TableHead>
                  <TableHead className="h-7 px-2 text-[10px] uppercase tracking-wider text-right">Ask%</TableHead>
                  <TableHead className="h-7 px-2 text-[10px] uppercase tracking-wider">OTM</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {prints.map((p) => {
                  const kind = deriveTapeKind(p.alert_type, p.raw);
                  const askPct = p.is_ask ? 100 : p.is_bid ? 0 : null;
                  return (
                    <TableRow key={p.id} className="border-b border-border/50">
                      <TableCell className="py-1 px-2 font-mono tabular-nums text-muted-foreground">
                        {formatTimeET(p.executed_at)}
                      </TableCell>
                      <TableCell className="py-1 px-2">
                        <span className="text-[9px] font-mono px-1 py-0 rounded bg-muted/40 text-muted-foreground">
                          {kind}
                        </span>
                      </TableCell>
                      <TableCell className="py-1 px-2 font-mono tabular-nums text-right">
                        {formatPremium(p.premium)}
                      </TableCell>
                      <TableCell className="py-1 px-2 font-mono tabular-nums text-right text-muted-foreground">
                        {formatInt(p.volume)}
                      </TableCell>
                      <TableCell className="py-1 px-2 font-mono tabular-nums text-right text-muted-foreground">
                        {askPct != null ? `${askPct}%` : '-'}
                      </TableCell>
                      <TableCell className="py-1 px-2">
                        {p.is_otm === true ? (
                          <span className="text-[9px] font-mono px-1 py-0.5 rounded bg-amber-500/15 text-amber-300">OTM</span>
                        ) : p.is_otm === false ? (
                          <span className="text-[9px] text-muted-foreground">ITM</span>
                        ) : (
                          <span className="text-[9px] text-muted-foreground">-</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      {/* OI snapshot history */}
      <section>
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">OI snapshot history</div>
        {!oiHistory ? (
          <div className="text-xs text-muted-foreground">Loading…</div>
        ) : oiHistory.length === 0 ? (
          <div className="text-xs text-muted-foreground">No OI snapshots yet for this contract.</div>
        ) : (
          <div className="overflow-x-auto rounded-md border border-border">
            <Table className="text-[11px]">
              <TableHeader>
                <TableRow className="border-b border-border hover:bg-transparent">
                  <TableHead className="h-7 px-2 text-[10px] uppercase tracking-wider">Date</TableHead>
                  <TableHead className="h-7 px-2 text-[10px] uppercase tracking-wider">Slot</TableHead>
                  <TableHead className="h-7 px-2 text-[10px] uppercase tracking-wider text-right">OI</TableHead>
                  <TableHead className="h-7 px-2 text-[10px] uppercase tracking-wider text-right">Δ1d</TableHead>
                  <TableHead className="h-7 px-2 text-[10px] uppercase tracking-wider text-right">Δ5d</TableHead>
                  <TableHead className="h-7 px-2 text-[10px] uppercase tracking-wider text-right">Vol today</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {oiHistory.map((s) => (
                  <TableRow key={s.id} className="border-b border-border/50">
                    <TableCell className="py-1 px-2 font-mono tabular-nums text-muted-foreground">{s.snap_date}</TableCell>
                    <TableCell className="py-1 px-2 font-mono text-muted-foreground uppercase">{s.snap_slot}</TableCell>
                    <TableCell className="py-1 px-2 font-mono tabular-nums text-right">{formatInt(s.oi)}</TableCell>
                    <TableCell className="py-1 px-2 font-mono tabular-nums text-right">
                      {s.oi_delta_1d != null ? (
                        <span className={s.oi_delta_1d > 0 ? 'text-emerald-400' : s.oi_delta_1d < 0 ? 'text-red-400' : 'text-muted-foreground'}>
                          {s.oi_delta_1d > 0 ? '+' : ''}{formatInt(s.oi_delta_1d)}
                        </span>
                      ) : '-'}
                    </TableCell>
                    <TableCell className="py-1 px-2 font-mono tabular-nums text-right">
                      {s.oi_delta_5d != null ? (
                        <span className={s.oi_delta_5d > 0 ? 'text-emerald-400' : s.oi_delta_5d < 0 ? 'text-red-400' : 'text-muted-foreground'}>
                          {s.oi_delta_5d > 0 ? '+' : ''}{formatInt(s.oi_delta_5d)}
                        </span>
                      ) : '-'}
                    </TableCell>
                    <TableCell className="py-1 px-2 font-mono tabular-nums text-right text-muted-foreground">
                      {formatInt(s.volume_today)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </>
  );
}

// ---------- main ----------

export function ContractDrillSheet({
  open,
  onOpenChange,
  optionSymbol = null,
  alertId = null,
  onTickerClick,
}: Props) {
  // Prefer symbol-keyed lookup (canonical). Fall back to alert_id ledger
  // chain only when the caller didn't supply a symbol. Either lookup
  // returns the same ContractTrackRow shape, so the rest of the sheet
  // doesn't care which path resolved.
  const symbolQuery = useContractTrackBySymbol(optionSymbol);
  const alertQuery = useContractTrack(optionSymbol ? null : alertId);
  const isSymbolPath = optionSymbol !== null && optionSymbol !== '';
  const track = isSymbolPath ? symbolQuery.data : alertQuery.data;
  const isLoading = isSymbolPath ? symbolQuery.isLoading : alertQuery.isLoading;
  const isError = isSymbolPath ? symbolQuery.isError : alertQuery.isError;

  // Underlying ticker — prefer the track's authoritative ticker, fall back
  // to OCC parsing when there's no track yet (brand-new symbol pre-grader).
  const resolvedSymbol = optionSymbol ?? track?.option_symbol ?? null;
  const ticker = track?.ticker ?? parseOccTicker(resolvedSymbol) ?? null;
  const strike = track?.strike ?? null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-2xl overflow-y-auto"
      >
        <SheetHeader className="space-y-0">
          <SheetTitle className="text-base">Contract P&amp;L</SheetTitle>
          <SheetDescription className="text-xs">
            Lifetime contract-axis grading + today&apos;s context. ct_contract_tracks · ct_flow_alerts · ct_oi_snapshots · ct_flags · ct_ticker_snapshots · ct_breaking_news.
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 space-y-3">
          {/* P&L layer — header / chart / time-to. Skeleton while loading. */}
          {isLoading ? (
            <>
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-56 w-full" />
              <Skeleton className="h-16 w-full" />
            </>
          ) : !track ? (
            <Card className="p-6 flex flex-col items-center justify-center text-center min-h-[160px] border-dashed">
              <AlertCircle className="w-6 h-6 text-muted-foreground mb-2" />
              <div className="text-sm font-medium">No contract track yet</div>
              <div className="text-xs text-muted-foreground mt-1 max-w-sm">
                {isError
                  ? 'ct_contract_tracks lookup failed — table may not be deployed yet.'
                  : 'Tracks are created when the grader runs Pass 2 over a flagged print. Context layer below still renders.'}
              </div>
            </Card>
          ) : (
            <>
              <HeaderRow track={track} onTickerClick={onTickerClick} />
              <PnLCard track={track} />
              <PriceChart track={track} />
              <TimeToTable track={track} />
            </>
          )}

          {/* Context layer — renders whenever an option_symbol is supplied,
              even if no track exists. Today's prints, OI history, Claude's
              take, micro context, breaking news. */}
          {resolvedSymbol && (
            <ContextLayer
              optionSymbol={resolvedSymbol}
              open={open}
              ticker={ticker}
              strike={strike}
              onTickerClick={onTickerClick}
            />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
