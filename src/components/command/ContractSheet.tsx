/**
 * ContractSheet — right-side drill-down for a single option_symbol.
 *
 * Opened from /tape row clicks. Shows:
 *   - Header: option_symbol + strike/side/expiry/DTE + today's print count
 *   - Today's prints table (ct_flow_alerts, date = today ET, limit 100)
 *   - OI snapshot history (ct_oi_snapshots, all days for this symbol)
 *   - Claude's take (ct_flags row whose source_flow_ids ref this contract
 *     OR whose option_symbol matches, compact link-style)
 *
 * All data fetched on-demand when the sheet opens; polls every 30s while open.
 */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { Activity, Gauge, Target, Newspaper } from 'lucide-react';

/** Parse underlying ticker from OCC option symbol.
 *  OCC format: ROOT + YYMMDD + (C|P) + 8-digit strike.
 *  Strip the last 15 chars to get the ticker. */
function parseOccTicker(sym: string | null | undefined): string | null {
  if (!sym || sym.length < 16) return null;
  return sym.slice(0, sym.length - 15).toUpperCase();
}

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

interface ContractSheetProps {
  optionSymbol: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
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

export function ContractSheet({ optionSymbol, open, onOpenChange }: ContractSheetProps) {
  // Today-ET range for prints query.
  const todayBounds = useMemo(() => {
    const now = new Date();
    // US/Eastern midnight → next midnight. Naive but correct for most use.
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

  // Underlying ticker inferred from OCC symbol.
  const ticker = useMemo(() => parseOccTicker(optionSymbol), [optionSymbol]);

  // Breaking news (Tavily sweep + macro watcher) — last 6h for this ticker.
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
  const { data: breakingNews } = useQuery<BreakingNewsRow[]>({
    queryKey: ['contract_breaking_news', ticker],
    enabled: open && !!ticker,
    refetchInterval: 60_000,
    queryFn: async () => {
      if (!ticker) return [];
      const since = new Date(Date.now() - 6 * 3600_000).toISOString();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await (supabase.from('ct_breaking_news' as never) as any)
        .select('headline,source,severity,sentiment,summary,macro_wide,tickers_affected,ingested_at')
        .gte('ingested_at', since)
        .order('ingested_at', { ascending: false })
        .limit(30);
      const rows = (data ?? []) as BreakingNewsRow[];
      return rows.filter((r) => (r.tickers_affected ?? []).includes(ticker) || r.macro_wide === true).slice(0, 4);
    },
  });

  // Ticker-level micro snapshot + recent news. Same table TickerSheet uses;
  // ct-watcher maintains one row per ticker with the quant card payload.
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

  // Derive header metadata from first print (newest).
  const first = prints?.[0];
  const strike = first?.strike ?? null;
  const side = first?.side ?? null;
  const expiry = first?.expiry ?? null;
  const dte = expiry ? Math.round((Date.parse(expiry) - Date.now()) / 86_400_000) : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-2xl overflow-y-auto p-0"
      >
        <div className="p-6 space-y-5">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2 text-base font-mono break-all">
              <Activity className="w-4 h-4 text-primary shrink-0" />
              <span>{optionSymbol ?? '—'}</span>
            </SheetTitle>
            <div className="flex items-center gap-2 flex-wrap text-xs text-muted-foreground tabular-nums">
              {strike != null && <span>strike <span className="text-foreground font-mono">${strike}</span></span>}
              {side && (
                <Badge
                  variant="outline"
                  className={cn(
                    'text-[10px] font-mono px-1.5 py-0',
                    side === 'call'
                      ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40'
                      : 'bg-red-500/15 text-red-300 border-red-500/40',
                  )}
                >
                  {side === 'call' ? 'CALL' : 'PUT'}
                </Badge>
              )}
              {expiry && <span>exp <span className="text-foreground font-mono">{expiry.slice(5)}</span></span>}
              {dte != null && <span>{dte}d</span>}
              <span className="ml-auto">today&apos;s prints <span className="text-foreground font-semibold">{prints?.length ?? 0}</span></span>
            </div>
          </SheetHeader>

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

          {/* Breaking news (Tavily sweep) — last 6h for this ticker */}
          {breakingNews && breakingNews.length > 0 && (
            <section>
              <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">
                <Newspaper className="w-3 h-3" />
                Breaking news · last 6h · {ticker}
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

          {/* Recent news for this ticker with Claude's take — news moves stocks, options front-run news */}
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
        </div>
      </SheetContent>
    </Sheet>
  );
}
