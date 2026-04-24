/**
 * /tape — The tape James reads himself (Co-Trader v2 Pillar 1).
 *
 * Raw options flow curated to the 10 specialist tickers. Primary source is
 * ct_scored_flow (classified + scored), fallback union with unscored
 * ct_flow_alerts rows when "Show unscored" is on. Reads like UW's own flow
 * view — dense tabular rows, sticky filter strip, row click opens the
 * ContractSheet drill-down.
 *
 * Pillar 2 (Claude specialists) runs alongside; /flags shows their output.
 * This page is the human reading surface.
 */

import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { Waves, RefreshCw, ArrowUp, ArrowDown, Minus } from 'lucide-react';
import { ContractSheet } from '@/components/command/ContractSheet';

const TICKERS = ['SPY','QQQ','IWM','AAPL','MSFT','GOOGL','AMZN','META','NVDA','TSLA'];

type Direction = 'bullish' | 'bearish' | 'neutral';
type Classification = 'opening_buy' | 'opening_sell' | 'closing' | 'hedge' | 'ambiguous';
type DteBand = 'any' | '0-7' | '7-30' | '30-90' | '90+';
type SortKey = 'event_ts' | 'score' | 'premium' | 'vol_oi';

interface ScoredRow {
  id: number;
  source_table: string;
  source_id: string;
  ticker: string;
  option_symbol: string;
  event_ts: string;
  classification: Classification | null;
  direction: Direction | null;
  score: number | null;
  strike: number | null;
  expiry: string | null;
  dte: number | null;
  delta_est: number | null;
  premium: number | null;
  volume: number | null;
  open_interest: number | null;
  ask_side_perc: number | null;
  // Not all ingesters populate these — keep nullable.
  alert_type?: string | null;
  raw?: Record<string, unknown> | null;
  side?: 'call' | 'put' | null;
}

interface AlertRow {
  id: number;
  alert_id: string;
  ticker: string;
  option_symbol: string;
  strike: number | null;
  expiry: string | null;
  side: 'call' | 'put' | null;
  is_ask: boolean | null;
  is_bid: boolean | null;
  is_otm: boolean | null;
  size: number | null;
  volume: number | null;
  open_interest: number | null;
  size_gt_oi: boolean | null;
  premium: number | null;
  price: number | null;
  underlying_price: number | null;
  executed_at: string;
  alert_type: string | null;
  raw: Record<string, unknown> | null;
}

interface OiSnap {
  option_symbol: string;
  snap_date: string;
  snap_slot: 'open' | 'mid' | 'close';
  oi: number | null;
  oi_delta_1d: number | null;
}

interface TapeRow {
  key: string;
  source: 'scored' | 'alert';
  id: number;
  ticker: string;
  option_symbol: string;
  event_ts: string;
  side: 'call' | 'put' | null;
  strike: number | null;
  expiry: string | null;
  dte: number | null;
  premium: number | null;
  volume: number | null;
  open_interest: number | null;
  vol_oi: number | null;
  oi_delta_1d: number | null;
  ask_side_perc: number | null;
  score: number | null;
  direction: Direction | null;
  classification: Classification | null;
  tape_kind: string;
  is_sweep: boolean;
  is_otm: boolean | null;
}

interface Filters {
  tickers: Set<string>;
  minPremium: number;
  minVolOi: number;
  dteBand: DteBand;
  sweepOnly: boolean;
  minScore: number;
  direction: 'all' | Direction;
  sortBy: SortKey;
  showUnscored: boolean;
}

const PREMIUM_PRESETS = [10_000, 100_000, 500_000, 1_000_000, 5_000_000];
const VOL_OI_PRESETS = [0, 1, 2, 5];

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

function formatExpiry(iso: string | null): string {
  if (!iso) return '-';
  return iso.slice(5, 10).replace('-', '/');
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

function scoreColor(s: number | null): string {
  if (s == null) return 'text-muted-foreground';
  if (s >= 80) return 'text-emerald-400';
  if (s >= 60) return 'text-amber-400';
  return 'text-muted-foreground';
}

function volOiColor(vo: number | null): string {
  if (vo == null) return 'text-muted-foreground';
  if (vo >= 5) return 'text-emerald-400 font-semibold';
  if (vo >= 2) return 'text-emerald-300';
  if (vo >= 1) return 'text-amber-300';
  return 'text-muted-foreground';
}

function directionPill(d: Direction | null): string {
  if (d === 'bullish') return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40';
  if (d === 'bearish') return 'bg-red-500/15 text-red-300 border-red-500/40';
  return 'bg-slate-500/15 text-slate-300 border-slate-500/40';
}

/**
 * Infer the tape kind (sweep / block / floor / alert) from alert_type or raw
 * flags. UW tags individual prints; ct_scored_flow carries source_table +
 * event_ts, and when available the alert_type comes along on the joined raw
 * or alert row. Fallback: 'ALERT'.
 */
function deriveTapeKind(alertType: string | null | undefined, raw: Record<string, unknown> | null | undefined): { kind: string; isSweep: boolean } {
  const r = raw ?? {};
  const hasSweep = r.has_sweep === true || alertType === 'sweep';
  const hasBlock = r.has_block === true || alertType === 'block';
  const hasFloor = r.has_floor === true || alertType === 'floor';
  const hasMultileg = r.has_multileg === true || alertType === 'multileg';
  if (hasSweep) return { kind: 'SWEEP', isSweep: true };
  if (hasBlock) return { kind: 'BLOCK', isSweep: false };
  if (hasFloor) return { kind: 'FLOOR', isSweep: false };
  if (hasMultileg) return { kind: 'MLEG', isSweep: false };
  if (alertType && typeof alertType === 'string') return { kind: alertType.toUpperCase().slice(0, 5), isSweep: false };
  return { kind: 'ALERT', isSweep: false };
}

function tapeKindClass(kind: string): string {
  if (kind === 'SWEEP') return 'bg-orange-500/15 text-orange-300 border-orange-500/40';
  if (kind === 'BLOCK') return 'bg-purple-500/15 text-purple-300 border-purple-500/40';
  if (kind === 'FLOOR') return 'bg-cyan-500/15 text-cyan-300 border-cyan-500/40';
  return 'bg-slate-500/15 text-slate-300 border-slate-500/40';
}

function inDteBand(dte: number | null, band: DteBand): boolean {
  if (band === 'any') return true;
  if (dte == null) return false;
  if (band === '0-7') return dte >= 0 && dte <= 7;
  if (band === '7-30') return dte > 7 && dte <= 30;
  if (band === '30-90') return dte > 30 && dte <= 90;
  if (band === '90+') return dte > 90;
  return true;
}

export default function Tape() {
  const qc = useQueryClient();
  const [filters, setFilters] = useState<Filters>({
    tickers: new Set(),
    minPremium: 10_000,
    minVolOi: 0,
    dteBand: 'any',
    sweepOnly: false,
    minScore: 60,
    direction: 'all',
    sortBy: 'event_ts',
    showUnscored: false,
  });
  const [activeSymbol, setActiveSymbol] = useState<string | null>(null);

  // Scored flow — primary source
  const { data: scored, isLoading: loadingScored } = useQuery<ScoredRow[]>({
    queryKey: ['ct_tape_scored', {
      tickers: Array.from(filters.tickers).sort(),
      minScore: filters.minScore,
      direction: filters.direction,
    }],
    refetchInterval: 20_000,
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let q: any = supabase
        .from('ct_scored_flow' as never)
        .select('id,source_table,source_id,ticker,option_symbol,event_ts,classification,direction,score,strike,expiry,dte,delta_est,premium,volume,open_interest,ask_side_perc')
        .order('event_ts', { ascending: false })
        .limit(500);
      if (filters.tickers.size > 0) q = q.in('ticker', Array.from(filters.tickers));
      if (filters.direction !== 'all') q = q.eq('direction', filters.direction);
      if (filters.minScore > 0) q = q.gte('score', filters.minScore);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as ScoredRow[];
    },
  });

  // Unscored alerts — union pass, only when toggle is on
  const { data: unscored } = useQuery<AlertRow[]>({
    queryKey: ['ct_tape_unscored', {
      tickers: Array.from(filters.tickers).sort(),
    }],
    refetchInterval: 20_000,
    enabled: filters.showUnscored,
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let q: any = supabase
        .from('ct_flow_alerts' as never)
        .select('id,alert_id,ticker,option_symbol,strike,expiry,side,is_ask,is_bid,is_otm,size,volume,open_interest,size_gt_oi,premium,price,underlying_price,executed_at,alert_type,raw')
        .order('executed_at', { ascending: false })
        .limit(500);
      if (filters.tickers.size > 0) q = q.in('ticker', Array.from(filters.tickers));
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as AlertRow[];
    },
  });

  // Pull alert_type + raw + side for the scored rows so the Tape column is accurate.
  // One batched call keyed on the set of alert_ids that scored rows point at.
  const scoredSourceIds = useMemo(() => {
    if (!scored) return [] as string[];
    return Array.from(new Set(scored.filter((r) => r.source_table === 'flow_alerts').map((r) => r.source_id)));
  }, [scored]);

  const { data: alertMeta } = useQuery<Map<string, { alert_type: string | null; raw: Record<string, unknown> | null; side: 'call' | 'put' | null; is_otm: boolean | null }>>({
    queryKey: ['ct_tape_alert_meta', scoredSourceIds.sort().join(',')],
    enabled: scoredSourceIds.length > 0,
    refetchInterval: 20_000,
    queryFn: async () => {
      const map = new Map<string, { alert_type: string | null; raw: Record<string, unknown> | null; side: 'call' | 'put' | null; is_otm: boolean | null }>();
      // Chunk IN queries at 200 ids to keep URL length sane.
      const chunks: string[][] = [];
      for (let i = 0; i < scoredSourceIds.length; i += 200) chunks.push(scoredSourceIds.slice(i, i + 200));
      for (const chunk of chunks) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data, error } = await (supabase.from('ct_flow_alerts' as never) as any)
          .select('alert_id,alert_type,raw,side,is_otm')
          .in('alert_id', chunk);
        if (error) throw error;
        for (const row of (data ?? []) as { alert_id: string; alert_type: string | null; raw: Record<string, unknown> | null; side: 'call' | 'put' | null; is_otm: boolean | null }[]) {
          map.set(row.alert_id, { alert_type: row.alert_type, raw: row.raw, side: row.side, is_otm: row.is_otm });
        }
      }
      return map;
    },
  });

  // OI delta lookup — latest snapshot per option_symbol, today ET.
  const symbolsInView = useMemo(() => {
    const s = new Set<string>();
    scored?.forEach((r) => s.add(r.option_symbol));
    unscored?.forEach((r) => s.add(r.option_symbol));
    return Array.from(s);
  }, [scored, unscored]);

  const { data: oiMap } = useQuery<Map<string, number | null>>({
    queryKey: ['ct_tape_oi_delta', symbolsInView.sort().join(',')],
    enabled: symbolsInView.length > 0,
    refetchInterval: 60_000,
    queryFn: async () => {
      const map = new Map<string, number | null>();
      const today = new Date().toISOString().slice(0, 10);
      const chunks: string[][] = [];
      for (let i = 0; i < symbolsInView.length; i += 200) chunks.push(symbolsInView.slice(i, i + 200));
      for (const chunk of chunks) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data, error } = await (supabase.from('ct_oi_snapshots' as never) as any)
          .select('option_symbol,snap_date,snap_slot,oi,oi_delta_1d')
          .in('option_symbol', chunk)
          .eq('snap_date', today)
          .order('captured_at', { ascending: false });
        if (error) throw error;
        for (const row of (data ?? []) as OiSnap[]) {
          if (!map.has(row.option_symbol)) map.set(row.option_symbol, row.oi_delta_1d ?? null);
        }
      }
      return map;
    },
  });

  // Build the unified row set.
  const rows = useMemo<TapeRow[]>(() => {
    const out: TapeRow[] = [];
    const seenScoredSourceIds = new Set<string>();

    for (const r of scored ?? []) {
      const meta = alertMeta?.get(r.source_id);
      const alertType = meta?.alert_type ?? null;
      const raw = meta?.raw ?? null;
      const side = meta?.side ?? r.side ?? null;
      const { kind, isSweep } = deriveTapeKind(alertType, raw);
      const vol = r.volume;
      const oi = r.open_interest;
      const volOi = vol != null && oi != null && oi > 0 ? vol / oi : null;
      out.push({
        key: `s-${r.id}`,
        source: 'scored',
        id: r.id,
        ticker: r.ticker,
        option_symbol: r.option_symbol,
        event_ts: r.event_ts,
        side,
        strike: r.strike,
        expiry: r.expiry,
        dte: r.dte,
        premium: r.premium,
        volume: vol,
        open_interest: oi,
        vol_oi: volOi,
        oi_delta_1d: oiMap?.get(r.option_symbol) ?? null,
        ask_side_perc: r.ask_side_perc,
        score: r.score,
        direction: r.direction,
        classification: r.classification,
        tape_kind: kind,
        is_sweep: isSweep,
        is_otm: meta?.is_otm ?? null,
      });
      if (r.source_table === 'flow_alerts') seenScoredSourceIds.add(r.source_id);
    }

    if (filters.showUnscored) {
      for (const a of unscored ?? []) {
        if (seenScoredSourceIds.has(a.alert_id)) continue;
        const { kind, isSweep } = deriveTapeKind(a.alert_type, a.raw);
        const vol = a.volume;
        const oi = a.open_interest;
        const volOi = vol != null && oi != null && oi > 0 ? vol / oi : null;
        const dte = a.expiry
          ? Math.round((Date.parse(a.expiry) - Date.now()) / 86_400_000)
          : null;
        out.push({
          key: `a-${a.id}`,
          source: 'alert',
          id: a.id,
          ticker: a.ticker,
          option_symbol: a.option_symbol,
          event_ts: a.executed_at,
          side: a.side,
          strike: a.strike,
          expiry: a.expiry,
          dte,
          premium: a.premium,
          volume: vol,
          open_interest: oi,
          vol_oi: volOi,
          oi_delta_1d: oiMap?.get(a.option_symbol) ?? null,
          ask_side_perc: a.is_ask ? 100 : a.is_bid ? 0 : null,
          score: null,
          direction: null,
          classification: null,
          tape_kind: kind,
          is_sweep: isSweep,
          is_otm: a.is_otm,
        });
      }
    }

    // Client-side filters that depend on derived/joined fields.
    const filtered = out.filter((r) => {
      if (filters.minPremium > 0 && (r.premium == null || r.premium < filters.minPremium)) return false;
      if (filters.minVolOi > 0 && (r.vol_oi == null || r.vol_oi < filters.minVolOi)) return false;
      if (!inDteBand(r.dte, filters.dteBand)) return false;
      if (filters.sweepOnly && !r.is_sweep) return false;
      return true;
    });

    // Sort.
    filtered.sort((a, b) => {
      if (filters.sortBy === 'event_ts') return Date.parse(b.event_ts) - Date.parse(a.event_ts);
      if (filters.sortBy === 'score') return (b.score ?? -1) - (a.score ?? -1);
      if (filters.sortBy === 'premium') return (b.premium ?? 0) - (a.premium ?? 0);
      if (filters.sortBy === 'vol_oi') return (b.vol_oi ?? 0) - (a.vol_oi ?? 0);
      return 0;
    });

    return filtered;
  }, [scored, unscored, alertMeta, oiMap, filters]);

  const totalBeforeFilter = (scored?.length ?? 0) + (filters.showUnscored ? (unscored?.length ?? 0) : 0);

  const toggleTicker = (t: string) => {
    setFilters((prev) => {
      const next = new Set(prev.tickers);
      if (next.has(t)) next.delete(t); else next.add(t);
      return { ...prev, tickers: next };
    });
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-[1800px] mx-auto p-4 space-y-4">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Waves className="w-5 h-5 text-primary" />
              <span>Tape</span>
            </h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              Raw options flow for the 10 specialist tickers. Click any row to drill into the contract.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-[11px] text-muted-foreground tabular-nums">
              Showing <span className="text-foreground font-semibold">{rows.length}</span> of{' '}
              <span className="text-foreground font-semibold">{totalBeforeFilter}</span> today
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                qc.invalidateQueries({ queryKey: ['ct_tape_scored'] });
                qc.invalidateQueries({ queryKey: ['ct_tape_unscored'] });
                qc.invalidateQueries({ queryKey: ['ct_tape_alert_meta'] });
                qc.invalidateQueries({ queryKey: ['ct_tape_oi_delta'] });
              }}
              className="text-xs"
            >
              <RefreshCw className="w-3 h-3 mr-1" />
              Refresh
            </Button>
          </div>
        </header>

        {/* Sticky filter strip */}
        <Card className="p-3 space-y-3 sticky top-0 z-30 bg-card/95 backdrop-blur">
          {/* Ticker chips */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-muted-foreground mr-1">Ticker:</span>
            {TICKERS.map((t) => {
              const on = filters.tickers.has(t);
              return (
                <button
                  key={t}
                  onClick={() => toggleTicker(t)}
                  className={cn(
                    'text-[11px] font-mono px-2 py-1 rounded border transition-colors',
                    on
                      ? 'border-primary/40 bg-primary/10 text-primary'
                      : 'border-muted bg-muted/20 text-muted-foreground hover:text-foreground',
                  )}
                >
                  {t}
                </button>
              );
            })}
            {filters.tickers.size > 0 && (
              <button
                onClick={() => setFilters((p) => ({ ...p, tickers: new Set() }))}
                className="text-[10px] text-muted-foreground underline ml-1"
              >
                clear
              </button>
            )}
          </div>

          <div className="flex items-center gap-4 flex-wrap">
            {/* Min premium presets */}
            <div className="flex items-center gap-1">
              <span className="text-xs text-muted-foreground mr-1">Min prem:</span>
              {PREMIUM_PRESETS.map((n) => (
                <button
                  key={n}
                  onClick={() => setFilters((p) => ({ ...p, minPremium: n }))}
                  className={cn(
                    'text-[10px] font-mono px-2 py-0.5 rounded transition-colors',
                    filters.minPremium === n
                      ? 'bg-primary/10 text-primary'
                      : 'bg-muted/20 text-muted-foreground hover:text-foreground',
                  )}
                >
                  {formatPremium(n)}
                </button>
              ))}
            </div>

            {/* Vol/OI presets */}
            <div className="flex items-center gap-1">
              <span className="text-xs text-muted-foreground mr-1">Min V/OI:</span>
              {VOL_OI_PRESETS.map((n) => (
                <button
                  key={n}
                  onClick={() => setFilters((p) => ({ ...p, minVolOi: n }))}
                  className={cn(
                    'text-[10px] font-mono px-2 py-0.5 rounded transition-colors',
                    filters.minVolOi === n
                      ? 'bg-primary/10 text-primary'
                      : 'bg-muted/20 text-muted-foreground hover:text-foreground',
                  )}
                >
                  {n === 0 ? 'any' : `${n}x`}
                </button>
              ))}
            </div>

            {/* DTE band */}
            <div className="flex items-center gap-1">
              <span className="text-xs text-muted-foreground mr-1">DTE:</span>
              {(['any', '0-7', '7-30', '30-90', '90+'] as const).map((b) => (
                <button
                  key={b}
                  onClick={() => setFilters((p) => ({ ...p, dteBand: b }))}
                  className={cn(
                    'text-[10px] font-mono px-2 py-0.5 rounded transition-colors',
                    filters.dteBand === b
                      ? 'bg-primary/10 text-primary'
                      : 'bg-muted/20 text-muted-foreground hover:text-foreground',
                  )}
                >
                  {b}
                </button>
              ))}
            </div>

            {/* Direction */}
            <div className="flex items-center gap-1">
              <span className="text-xs text-muted-foreground mr-1">Dir:</span>
              {(['all', 'bullish', 'bearish', 'neutral'] as const).map((d) => (
                <button
                  key={d}
                  onClick={() => setFilters((p) => ({ ...p, direction: d }))}
                  className={cn(
                    'text-[10px] font-mono px-2 py-0.5 rounded capitalize transition-colors',
                    filters.direction === d
                      ? 'bg-primary/10 text-primary'
                      : 'bg-muted/20 text-muted-foreground hover:text-foreground',
                  )}
                >
                  {d}
                </button>
              ))}
            </div>

            {/* Sweep-only */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Sweep only</span>
              <Switch
                checked={filters.sweepOnly}
                onCheckedChange={(v) => setFilters((p) => ({ ...p, sweepOnly: v }))}
              />
            </div>

            {/* Show unscored */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Show unscored</span>
              <Switch
                checked={filters.showUnscored}
                onCheckedChange={(v) => setFilters((p) => ({ ...p, showUnscored: v }))}
              />
            </div>

            {/* Sort */}
            <div className="flex items-center gap-1 ml-auto">
              <span className="text-xs text-muted-foreground mr-1">Sort:</span>
              {(
                [
                  ['event_ts', 'time'],
                  ['score', 'score'],
                  ['premium', 'prem'],
                  ['vol_oi', 'V/OI'],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => setFilters((p) => ({ ...p, sortBy: k }))}
                  className={cn(
                    'text-[10px] font-mono px-2 py-0.5 rounded transition-colors',
                    filters.sortBy === k
                      ? 'bg-primary/10 text-primary'
                      : 'bg-muted/20 text-muted-foreground hover:text-foreground',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Min score slider */}
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground shrink-0">Min score: {filters.minScore}</span>
            <div className="flex-1 max-w-sm">
              <Slider
                min={0}
                max={100}
                step={1}
                value={[filters.minScore]}
                onValueChange={(v) => setFilters((p) => ({ ...p, minScore: v[0] }))}
              />
            </div>
            <div className="flex gap-1">
              {[0, 40, 60, 80].map((n) => (
                <button
                  key={n}
                  onClick={() => setFilters((p) => ({ ...p, minScore: n }))}
                  className={cn(
                    'text-[10px] font-mono px-1.5 py-0.5 rounded transition-colors',
                    filters.minScore === n
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
        </Card>

        {/* Tape table */}
        <Card className="p-0 overflow-hidden">
          <div className="overflow-x-auto">
            <Table className="text-[11px]">
              <TableHeader>
                <TableRow className="border-b border-border hover:bg-transparent">
                  <TableHead className="h-8 px-2 text-[10px] uppercase tracking-wider">Time</TableHead>
                  <TableHead className="h-8 px-2 text-[10px] uppercase tracking-wider">Tkr</TableHead>
                  <TableHead className="h-8 px-2 text-[10px] uppercase tracking-wider">Contract</TableHead>
                  <TableHead className="h-8 px-2 text-[10px] uppercase tracking-wider text-right">Strike</TableHead>
                  <TableHead className="h-8 px-2 text-[10px] uppercase tracking-wider">Exp</TableHead>
                  <TableHead className="h-8 px-2 text-[10px] uppercase tracking-wider text-right">DTE</TableHead>
                  <TableHead className="h-8 px-2 text-[10px] uppercase tracking-wider">Side</TableHead>
                  <TableHead className="h-8 px-2 text-[10px] uppercase tracking-wider">Tape</TableHead>
                  <TableHead className="h-8 px-2 text-[10px] uppercase tracking-wider text-right">Prem</TableHead>
                  <TableHead className="h-8 px-2 text-[10px] uppercase tracking-wider text-right">Vol</TableHead>
                  <TableHead className="h-8 px-2 text-[10px] uppercase tracking-wider text-right">OI</TableHead>
                  <TableHead className="h-8 px-2 text-[10px] uppercase tracking-wider text-right">V/OI</TableHead>
                  <TableHead className="h-8 px-2 text-[10px] uppercase tracking-wider text-right">OI Δ1d</TableHead>
                  <TableHead className="h-8 px-2 text-[10px] uppercase tracking-wider text-right">Ask%</TableHead>
                  <TableHead className="h-8 px-2 text-[10px] uppercase tracking-wider text-right">Score</TableHead>
                  <TableHead className="h-8 px-2 text-[10px] uppercase tracking-wider">Tags</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loadingScored && !scored ? (
                  <TableRow>
                    <TableCell colSpan={16} className="text-center text-xs text-muted-foreground py-8">
                      Loading tape…
                    </TableCell>
                  </TableRow>
                ) : rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={16} className="text-center text-xs text-muted-foreground py-8">
                      No flow matches current filters. Loosen min premium, drop min score, or enable "Show unscored".
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((r) => (
                    <TableRow
                      key={r.key}
                      onClick={() => setActiveSymbol(r.option_symbol)}
                      className="cursor-pointer hover:bg-muted/40 border-b border-border/50"
                    >
                      <TableCell className="py-1.5 px-2 font-mono tabular-nums text-muted-foreground">
                        {formatTimeET(r.event_ts)}
                      </TableCell>
                      <TableCell className="py-1.5 px-2 font-mono font-semibold">{r.ticker}</TableCell>
                      <TableCell className="py-1.5 px-2 font-mono text-[10px] text-foreground/80 truncate max-w-[220px]">
                        {r.option_symbol}
                      </TableCell>
                      <TableCell className="py-1.5 px-2 font-mono tabular-nums text-right">
                        {r.strike != null ? `$${r.strike}` : '-'}
                      </TableCell>
                      <TableCell className="py-1.5 px-2 font-mono tabular-nums text-muted-foreground">
                        {formatExpiry(r.expiry)}
                      </TableCell>
                      <TableCell className="py-1.5 px-2 font-mono tabular-nums text-right text-muted-foreground">
                        {r.dte ?? '-'}
                      </TableCell>
                      <TableCell className="py-1.5 px-2">
                        {r.side ? (
                          <Badge
                            variant="outline"
                            className={cn(
                              'text-[9px] font-mono px-1 py-0',
                              r.side === 'call'
                                ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40'
                                : 'bg-red-500/15 text-red-300 border-red-500/40',
                            )}
                          >
                            {r.side === 'call' ? 'CALL' : 'PUT'}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </TableCell>
                      <TableCell className="py-1.5 px-2">
                        <Badge variant="outline" className={cn('text-[9px] font-mono px-1 py-0', tapeKindClass(r.tape_kind))}>
                          {r.tape_kind}
                        </Badge>
                      </TableCell>
                      <TableCell className="py-1.5 px-2 font-mono tabular-nums text-right">
                        {formatPremium(r.premium)}
                      </TableCell>
                      <TableCell className="py-1.5 px-2 font-mono tabular-nums text-right text-muted-foreground">
                        {formatInt(r.volume)}
                      </TableCell>
                      <TableCell className="py-1.5 px-2 font-mono tabular-nums text-right text-muted-foreground">
                        {formatInt(r.open_interest)}
                      </TableCell>
                      <TableCell className={cn('py-1.5 px-2 font-mono tabular-nums text-right', volOiColor(r.vol_oi))}>
                        {r.vol_oi != null ? `${r.vol_oi.toFixed(2)}x` : '-'}
                      </TableCell>
                      <TableCell className="py-1.5 px-2 font-mono tabular-nums text-right">
                        {r.oi_delta_1d != null ? (
                          <span className={r.oi_delta_1d > 0 ? 'text-emerald-400' : r.oi_delta_1d < 0 ? 'text-red-400' : 'text-muted-foreground'}>
                            {r.oi_delta_1d > 0 ? '+' : ''}
                            {formatInt(r.oi_delta_1d)}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </TableCell>
                      <TableCell className="py-1.5 px-2 font-mono tabular-nums text-right text-muted-foreground">
                        {r.ask_side_perc != null ? `${Math.round(r.ask_side_perc)}%` : '-'}
                      </TableCell>
                      <TableCell className={cn('py-1.5 px-2 font-mono tabular-nums font-semibold text-right', scoreColor(r.score))}>
                        {r.score != null ? Math.round(r.score) : '-'}
                      </TableCell>
                      <TableCell className="py-1.5 px-2">
                        <div className="flex items-center gap-1">
                          {r.direction && (
                            <Badge variant="outline" className={cn('text-[9px] font-mono px-1 py-0', directionPill(r.direction))}>
                              {r.direction === 'bullish' ? <ArrowUp className="w-2.5 h-2.5" /> : r.direction === 'bearish' ? <ArrowDown className="w-2.5 h-2.5" /> : <Minus className="w-2.5 h-2.5" />}
                            </Badge>
                          )}
                          {r.classification && (
                            <span className="text-[9px] font-mono px-1 py-0.5 rounded bg-muted/40 text-muted-foreground">
                              {r.classification.replace('_', ' ')}
                            </span>
                          )}
                          {r.is_otm === true && (
                            <span className="text-[9px] font-mono px-1 py-0.5 rounded bg-amber-500/15 text-amber-300">OTM</span>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </Card>

        <div className="text-[10px] text-muted-foreground leading-relaxed">
          Tape reads ct_scored_flow as primary source; toggle "Show unscored" to union raw ct_flow_alerts rows that
          haven't been scored yet. Refreshes every 20s. Limit 500 rows per source.
        </div>
      </div>

      {/* Contract drill-down sheet */}
      <ContractSheet
        optionSymbol={activeSymbol}
        open={activeSymbol !== null}
        onOpenChange={(o) => { if (!o) setActiveSymbol(null); }}
      />
    </div>
  );
}
