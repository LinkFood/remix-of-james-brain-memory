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
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { Activity } from 'lucide-react';

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
