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
import { Textarea } from '@/components/ui/textarea';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { Waves, RefreshCw, ArrowUp, ArrowDown, Minus, Star, Radio } from 'lucide-react';
import { toast } from 'sonner';
import { ContractSheet } from '@/components/command/ContractSheet';
import { TickerSheet } from '@/components/command/TickerSheet';
import { ContractPnLChip } from '@/components/co-trader/ContractPnLChip';
import { ContractGradeChips } from '@/components/co-trader/ContractGradeChips';
import { ContractDrillSheet } from '@/components/co-trader/ContractDrillSheet';
import { AlarmBanner } from '@/components/co-trader/AlarmBanner';
import { useAlarmRealtime } from '@/hooks/useAlarmRealtime';
import {
  useContractTracksByAlerts,
  useContractGradesByAlerts,
  useContractTracksRealtime,
} from '@/hooks/useContractTracks';
import { MacroBanner } from '@/components/command/MacroBanner';
import { TapeReaderBanner } from '@/components/command/TapeReaderBanner';
import { OvernightPositioning } from '@/components/command/OvernightPositioning';
import { StackingPatterns } from '@/components/command/StackingPatterns';
import { FlowPulse } from '@/components/command/FlowPulse';
import { RegimeChip } from '@/hooks/useTickerIntradayContext';
import {
  useContractStacking,
  formatStackCount,
  formatStackPremium,
  interpretStack,
} from '@/hooks/useContractStacking';
import { useTodaysEligibleTickers } from '@/hooks/useDteEligibility';

const TICKERS = ['SPY','QQQ','IWM','AAPL','MSFT','GOOGL','AMZN','META','NVDA','TSLA'];

type Direction = 'bullish' | 'bearish' | 'neutral';
type Classification = 'opening_buy' | 'opening_sell' | 'closing' | 'hedge' | 'ambiguous';
type DteBand = 'any' | '0-7' | '7-30' | '30-90' | '90+';
type SortKey = 'event_ts' | 'score' | 'premium' | 'vol_oi';
type DayFilter = 'today' | 'yesterday' | 'last3d' | 'all';

/**
 * RTH open cutoff for a given UTC calendar date, pinned at 13:30 UTC (09:30 ET during EDT).
 * Simple approach per spec: take the date string and build an ISO Z timestamp.
 * Caveat: during EST (Nov-Mar) this is actually 08:30 ET — off by an hour.
 * For day-filter cutoffs that's fine: pre-open prints still fall on the prior day,
 * and during market hours the filter is robust. If we ever need exact 09:30 ET
 * year-round, swap to a tz-aware library — not worth a new dep for this.
 */
function rthOpenCutoffUtc(daysAgo = 0): Date {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysAgo));
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return new Date(`${yyyy}-${mm}-${dd}T13:30:00Z`);
}

// Trading-day-aware cutoff. Walks back N TRADING days from today's UTC date
// (skips Sat/Sun) and returns RTH open of that day. Use for "Last N trading days"
// filters so weekend viewing still shows the right window. Plain calendar math
// would give Sat-3 = Wed but our viewing-on-Saturday user wants the last 3 actual
// trading days = Wed-Thu-Fri.
function tradingDaysAgoCutoff(tradingDaysAgo: number): Date {
  const d = new Date();
  let count = 0;
  while (count < tradingDaysAgo) {
    d.setUTCDate(d.getUTCDate() - 1);
    const wd = d.getUTCDay();
    if (wd >= 1 && wd <= 5) count++;
  }
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return new Date(`${yyyy}-${mm}-${dd}T13:30:00Z`);
}

/** ET calendar date string (YYYY-MM-DD) for a given ISO timestamp. Used for separator grouping. */
function etDateKey(iso: string): string {
  try {
    // en-CA yields YYYY-MM-DD which sorts and compares cleanly.
    return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  } catch {
    return iso.slice(0, 10);
  }
}

/** Friendly label for a separator row. "Today · Apr 24", "Yesterday · Apr 23", "Fri · Apr 22". */
function formatSeparatorLabel(etDate: string): string {
  const todayEt = etDateKey(new Date().toISOString());
  const yesterdayEt = etDateKey(new Date(Date.now() - 86_400_000).toISOString());
  // Parse YYYY-MM-DD as a local date for month/day formatting (timezone-agnostic for the label).
  const [y, m, d] = etDate.split('-').map(Number);
  const dateObj = new Date(y, m - 1, d);
  const monthDay = dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  if (etDate === todayEt) return `Today · ${monthDay}`;
  if (etDate === yesterdayEt) return `Yesterday · ${monthDay}`;
  const weekday = dateObj.toLocaleDateString('en-US', { weekday: 'short' });
  return `${weekday} · ${monthDay}`;
}

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
  // Regime context at the time of the print — populated by backend scorer.
  // Null for older rows or when the backfill hasn't landed yet.
  spot_pct_from_prev_close: number | null;
  spot_pct_from_today_open: number | null;
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
  alert_id: string | null;
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
  underlying_price: number | null;
  score: number | null;
  direction: Direction | null;
  classification: Classification | null;
  tape_kind: string;
  is_sweep: boolean;
  is_otm: boolean | null;
  // Regime at the moment of the print — scored rows only. Alert-only rows stay null.
  spot_pct_from_prev_close: number | null;
  spot_pct_from_today_open: number | null;
}

interface Filters {
  tickers: Set<string>;
  minPremium: number;
  minVolOi: number;
  dteBand: DteBand;
  sweepOnly: boolean;
  minScore: number;
  direction: 'all' | Direction;
  side: 'all' | 'call' | 'put';
  sortBy: SortKey;
  showUnscored: boolean;
  mineOnly: boolean;
  liveMode: boolean;
}

const PREMIUM_PRESETS = [25_000, 100_000, 500_000, 1_000_000, 5_000_000];
const VOL_OI_PRESETS = [0, 1, 2, 5];

/**
 * Parse call/put from an OCC option symbol. UW's flow-alerts endpoint
 * often returns side=null (known gap — see CLAUDE.md gotcha), so we
 * derive from the symbol itself. OCC format: ROOT + YYMMDD + (C|P) + 8-digit strike.
 * The C/P char sits right after the 6-digit date. Example:
 *   NVDA260522C00205000 → call
 *   SPY260606P00500000  → put
 */
function parseOccSide(sym: string | null | undefined): 'call' | 'put' | null {
  if (!sym || sym.length < 8) return null;
  // Walk from the right: 8-digit strike → preceded by C or P.
  const strikeStart = sym.length - 8;
  if (strikeStart < 1) return null;
  const ch = sym.charAt(strikeStart - 1);
  if (ch === 'C' || ch === 'c') return 'call';
  if (ch === 'P' || ch === 'p') return 'put';
  return null;
}

function formatTimeET(iso: string): string {
  try {
    // 12-hour clock, no seconds, lowercase am/pm — "3:56 pm" is easier to read
    // than "15:56:32" when you're scanning tape fast.
    return new Date(iso).toLocaleTimeString('en-US', {
      timeZone: 'America/New_York',
      hour12: true,
      hour: 'numeric',
      minute: '2-digit',
    }).toLowerCase().replace(' ', '');
  } catch {
    return iso.slice(11, 16);
  }
}

// Compact date label for multi-day views — "Fri 4/24" or "Wed 4/22".
// Used as a prefix on time cells when separator rows can't be relied on
// (e.g. user is sorted by score, not time).
function formatDateLabelET(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short',
      month: 'numeric',
      day: 'numeric',
    });
  } catch {
    return iso.slice(5, 10);
  }
}

function premiumColor(n: number | null): string {
  if (n == null) return 'text-muted-foreground';
  if (n >= 1_000_000) return 'text-emerald-400 font-semibold';
  if (n >= 500_000) return 'text-emerald-300';
  if (n >= 100_000) return 'text-foreground';
  return 'text-muted-foreground';
}

function dteColor(dte: number | null): string {
  if (dte == null) return 'text-muted-foreground';
  if (dte <= 1) return 'text-red-400 font-semibold';  // 0-DTE / next-day — high decay
  if (dte <= 7) return 'text-orange-300';
  return 'text-muted-foreground';
}

function formatPrice(n: number | null): string {
  if (n == null) return '-';
  if (n >= 1000) return `$${n.toFixed(0)}`;
  return `$${n.toFixed(2)}`;
}

/**
 * Color the SPOT cell by distance from the strike. Inverted from the
 * usual moneyness scheme: brighter = FURTHER from strike, because a
 * far-OTM contract with real premium behind it is the conviction signal.
 * Near-spot strikes are mundane — everyone trades ATM.
 * Symmetric — doesn't care about call/put side, just |strike - spot| / spot.
 */
function spotDistanceColor(spot: number | null, strike: number | null): string {
  if (spot == null || strike == null || spot <= 0) return 'text-foreground/90';
  const pct = Math.abs(strike - spot) / spot;
  if (pct < 0.01) return 'text-muted-foreground';                       // < 1% — ATM, boring
  if (pct < 0.03) return 'text-foreground/90';                          // 1-3% — normal
  if (pct < 0.07) return 'text-amber-300';                              // 3-7% — warm
  return 'text-emerald-400 font-bold';                                  // >= 7% — conviction
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
  // UW's flow-alerts sometimes puts just 'call' / 'put' in alert_type
  // when there's no special tape classification. That's the side, not a
  // tape kind — fall back to 'ALERT'.
  if (alertType && typeof alertType === 'string') {
    const lc = alertType.toLowerCase();
    if (lc === 'call' || lc === 'put') return { kind: 'ALERT', isSweep: false };
    return { kind: alertType.toUpperCase().slice(0, 5), isSweep: false };
  }
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

interface JamesFlagRow {
  id: number;
  option_symbol: string;
  ticker: string;
  source_flow_id: number | null;
  source_alert_id: string | null;
  direction_view: Direction | null;
  note: string | null;
  created_at: string;
}

interface MarkDialogState {
  open: boolean;
  row: TapeRow | null;
  note: string;
  direction_view: Direction | null;
  saving: boolean;
}

// Subtle inline pill: which tickers actually have 0DTE expiry today.
// Hides itself if config hasn't loaded so it never flashes empty state.
function DteEligibilityPill() {
  const { tickers, map } = useTodaysEligibleTickers();
  if (!tickers || tickers.length === 0 || Object.keys(map).length === 0) return null;
  return (
    <div className="hidden md:flex items-center gap-1.5 px-2 py-1 rounded border border-rose-500/30 bg-rose-500/5 text-[10px] font-mono">
      <span className="text-rose-300/80 uppercase tracking-wider">0DTE today:</span>
      {tickers.map((t) => (
        <span key={t} className="text-rose-200 font-semibold">{t}</span>
      ))}
    </div>
  );
}

export default function Tape() {
  const qc = useQueryClient();
  const [filters, setFilters] = useState<Filters>({
    tickers: new Set(),
    minPremium: 25_000,
    minVolOi: 0,
    dteBand: 'any',
    sweepOnly: false,
    minScore: 0,
    direction: 'all',
    side: 'all',
    sortBy: 'event_ts',
    showUnscored: false,
    mineOnly: false,
    liveMode: false,
  });
  const [dayFilter, setDayFilter] = useState<DayFilter>('today');

  // Compute the event_ts cutoff (lower bound) and optional upper bound for the active day filter.
  // Null cutoff = no filter ('all'). Upper bound only used for 'yesterday'.
  const dayBounds = useMemo<{ from: string | null; to: string | null }>(() => {
    if (dayFilter === 'all') return { from: null, to: null };
    if (dayFilter === 'today') return { from: rthOpenCutoffUtc(0).toISOString(), to: null };
    if (dayFilter === 'yesterday') return {
      from: rthOpenCutoffUtc(1).toISOString(),
      to: rthOpenCutoffUtc(0).toISOString(),
    };
    // last3d — 3 TRADING days back (skips Sat/Sun) so weekend viewing still
    // shows Wed-Thu-Fri. Calendar math (rthOpenCutoffUtc(3)) gives Thursday-only
    // on a Saturday and excludes Wednesday. tradingDaysAgoCutoff(3) walks back
    // 3 actual trading sessions regardless of which weekday it's run on.
    return { from: tradingDaysAgoCutoff(3).toISOString(), to: null };
  }, [dayFilter]);
  const [activeSymbol, setActiveSymbol] = useState<string | null>(null);
  const [activeTicker, setActiveTicker] = useState<string | null>(null);
  const [drillAlertId, setDrillAlertId] = useState<string | null>(null);
  const [markDialog, setMarkDialog] = useState<MarkDialogState>({
    open: false, row: null, note: '', direction_view: null, saving: false,
  });

  // Live contract-axis P&L (Phase D). Subscribe once at the page level so the
  // chip column on every visible row repaints when Phase B's poller bumps a
  // ct_contract_tracks row. Defensive — silently no-ops if the table or
  // realtime channel isn't deployed yet.
  useContractTracksRealtime();

  // Live tiered alarms from ct-signature-watcher — banner pills + per-row glow.
  const { glowingForSymbol } = useAlarmRealtime();

  // Refetch interval scales with LIVE mode — 5s when on, 20s baseline.
  const tapeInterval = filters.liveMode ? 5_000 : 20_000;

  // PostgREST silently caps every response at 1000 rows. To pull a deeper
  // window (e.g. all of Friday RTH = 1800+ alerts) we paginate via .range().
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function paginatedFetch<T>(builder: (start: number, end: number) => any, target: number): Promise<T[]> {
    const pageSize = 1000;
    const out: T[] = [];
    for (let start = 0; start < target; start += pageSize) {
      const end = Math.min(start + pageSize - 1, target - 1);
      const { data, error } = await builder(start, end);
      if (error) throw error;
      const rows = (data ?? []) as T[];
      out.push(...rows);
      if (rows.length < pageSize) break;
    }
    return out;
  }

  // Contract stacking — lookup map for per-row badges. Window adapts to the
  // active day filter so stacks line up with the prints on screen. Default
  // 360min (6h) only covers live RTH; for "yesterday" or "last3d" we widen
  // so weekend / off-hours viewing actually surfaces stacks.
  const stackWindowMin = useMemo(() => {
    if (dayFilter === 'today') return 360;       // 6h — live session
    if (dayFilter === 'yesterday') return 2880;  // 48h — covers prior RTH + buffer
    if (dayFilter === 'last3d') return 5760;     // 4d — covers 3-day window + buffer
    return 10080;                                // 'all' = 7d
  }, [dayFilter]);
  const { bySymbol: stackBySymbol } = useContractStacking(stackWindowMin, 50);

  // Scored flow — primary source
  const { data: scored, isLoading: loadingScored } = useQuery<ScoredRow[]>({
    queryKey: ['ct_tape_scored', {
      tickers: Array.from(filters.tickers).sort(),
      minScore: filters.minScore,
      direction: filters.direction,
      dayFilter,
    }],
    refetchInterval: tapeInterval,
    queryFn: async () => {
      // PostgREST caps at 1000 rows; paginate to surface a full RTH session.
      return paginatedFetch<ScoredRow>((start, end) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let q: any = supabase
          .from('ct_scored_flow' as never)
          .select('id,source_table,source_id,ticker,option_symbol,event_ts,classification,direction,score,strike,expiry,dte,delta_est,premium,volume,open_interest,ask_side_perc,spot_pct_from_prev_close,spot_pct_from_today_open')
          .order('event_ts', { ascending: false });
        if (filters.tickers.size > 0) q = q.in('ticker', Array.from(filters.tickers));
        if (filters.direction !== 'all') q = q.eq('direction', filters.direction);
        if (filters.minScore > 0) q = q.gte('score', filters.minScore);
        if (dayBounds.from) q = q.gte('event_ts', dayBounds.from);
        if (dayBounds.to) q = q.lt('event_ts', dayBounds.to);
        return q.range(start, end);
      }, 5000);
    },
  });

  // Unscored alerts — union pass, only when toggle is on
  const { data: unscored } = useQuery<AlertRow[]>({
    queryKey: ['ct_tape_unscored', {
      tickers: Array.from(filters.tickers).sort(),
      dayFilter,
    }],
    refetchInterval: tapeInterval,
    enabled: filters.showUnscored,
    queryFn: async () => {
      return paginatedFetch<AlertRow>((start, end) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let q: any = supabase
          .from('ct_flow_alerts' as never)
          .select('id,alert_id,ticker,option_symbol,strike,expiry,side,is_ask,is_bid,is_otm,size,volume,open_interest,size_gt_oi,premium,price,underlying_price,executed_at,alert_type,raw')
          .order('executed_at', { ascending: false });
        if (filters.tickers.size > 0) q = q.in('ticker', Array.from(filters.tickers));
        if (dayBounds.from) q = q.gte('executed_at', dayBounds.from);
        if (dayBounds.to) q = q.lt('executed_at', dayBounds.to);
        return q.range(start, end);
      }, 5000);
    },
  });

  // James's flagged prints — read from unified ct_flags WHERE source='james_star'.
  const { data: jamesFlags } = useQuery<JamesFlagRow[]>({
    queryKey: ['ct_james_flags_all'],
    refetchInterval: 30_000,
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.from('ct_flags' as never) as any)
        .select('id,option_symbol,instrument,direction,thesis,source_flow_ids,created_at')
        .eq('source', 'james_star')
        .order('created_at', { ascending: false })
        .limit(1500);
      if (error) return [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return ((data ?? []) as any[]).map((r) => ({
        id: r.id,
        option_symbol: r.option_symbol,
        ticker: r.instrument,
        source_flow_id: Array.isArray(r.source_flow_ids) && r.source_flow_ids.length > 0 ? Number(r.source_flow_ids[0]) : null,
        source_alert_id: null,
        direction_view: r.direction === 'neutral' ? null : (r.direction as Direction),
        note: r.thesis,
        created_at: r.created_at,
      })) as JamesFlagRow[];
    },
  });

  // Fast lookup: has James flagged this option_symbol at all?
  const flaggedSymbols = useMemo(() => {
    const s = new Set<string>();
    jamesFlags?.forEach((f) => s.add(f.option_symbol));
    return s;
  }, [jamesFlags]);

  // Latest grade per starred option_symbol — read from unified ct_flag_grades
  // joined to ct_flags WHERE source='james_star'. Outcome shown as chip next
  // to the star icon on each row.
  interface JamesGradeRow {
    option_symbol: string;
    outcome: string;
    price_change_pct: number | null;
  }
  const { data: jamesGrades } = useQuery<JamesGradeRow[]>({
    queryKey: ['ct_james_flag_grades_all'],
    refetchInterval: 60_000,
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.from('ct_flags' as never) as any)
        .select('option_symbol, ct_flag_grades(outcome, price_change_pct, graded_at)')
        .eq('source', 'james_star')
        .not('option_symbol', 'is', null)
        .order('created_at', { ascending: false })
        .limit(2000);
      if (error) return [];
      const out: JamesGradeRow[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const r of (data ?? []) as any[]) {
        const g = Array.isArray(r.ct_flag_grades) ? r.ct_flag_grades[0] : r.ct_flag_grades;
        if (!g || !g.outcome) continue;
        out.push({
          option_symbol: r.option_symbol,
          outcome: g.outcome,
          price_change_pct: g.price_change_pct == null ? null : Number(g.price_change_pct),
        });
      }
      return out;
    },
  });
  const latestGradeByOption = useMemo(() => {
    const m = new Map<string, JamesGradeRow>();
    for (const g of jamesGrades ?? []) {
      if (!m.has(g.option_symbol)) m.set(g.option_symbol, g);
    }
    return m;
  }, [jamesGrades]);

  // Pull alert_type + raw + side for the scored rows so the Tape column is accurate.
  // One batched call keyed on the set of alert_ids that scored rows point at.
  const scoredSourceIds = useMemo(() => {
    if (!scored) return [] as string[];
    // ct_scored_flow.source_table was 'flow_alerts' in early migrations and
    // became 'ct_flow_alerts' in 20260424000003. Match both so the spot
    // price / tape kind / is_otm join works for rows from either era.
    return Array.from(new Set(
      scored
        .filter((r) => r.source_table === 'flow_alerts' || r.source_table === 'ct_flow_alerts')
        .map((r) => r.source_id),
    ));
  }, [scored]);

  interface AlertMetaRow {
    alert_type: string | null;
    raw: Record<string, unknown> | null;
    side: 'call' | 'put' | null;
    is_otm: boolean | null;
    underlying_price: number | null;
  }
  const { data: alertMeta } = useQuery<Map<string, AlertMetaRow>>({
    queryKey: ['ct_tape_alert_meta', scoredSourceIds.sort().join(',')],
    enabled: scoredSourceIds.length > 0,
    refetchInterval: tapeInterval,
    queryFn: async () => {
      const map = new Map<string, AlertMetaRow>();
      const chunks: string[][] = [];
      for (let i = 0; i < scoredSourceIds.length; i += 200) chunks.push(scoredSourceIds.slice(i, i + 200));
      for (const chunk of chunks) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data, error } = await (supabase.from('ct_flow_alerts' as never) as any)
          .select('alert_id,alert_type,raw,side,is_otm,underlying_price')
          .in('alert_id', chunk);
        if (error) throw error;
        for (const row of (data ?? []) as (AlertMetaRow & { alert_id: string })[]) {
          map.set(row.alert_id, {
            alert_type: row.alert_type,
            raw: row.raw,
            side: row.side,
            is_otm: row.is_otm,
            underlying_price: row.underlying_price,
          });
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
      // Find the latest snap_date that has data (skips weekends, pre-snap mornings).
      // Cheap one-row probe before the bulk lookup.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: probe } = await (supabase.from('ct_oi_snapshots' as never) as any)
        .select('snap_date')
        .order('snap_date', { ascending: false })
        .limit(1);
      const latestSnapDate = (probe?.[0] as { snap_date?: string } | undefined)?.snap_date;
      if (!latestSnapDate) return map;
      const chunks: string[][] = [];
      for (let i = 0; i < symbolsInView.length; i += 200) chunks.push(symbolsInView.slice(i, i + 200));
      for (const chunk of chunks) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data, error } = await (supabase.from('ct_oi_snapshots' as never) as any)
          .select('option_symbol,snap_date,snap_slot,oi,oi_delta_1d')
          .in('option_symbol', chunk)
          .eq('snap_date', latestSnapDate)
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
      const side = meta?.side ?? r.side ?? parseOccSide(r.option_symbol);
      const { kind, isSweep } = deriveTapeKind(alertType, raw);
      const vol = r.volume;
      const oi = r.open_interest;
      const volOi = vol != null && oi != null && oi > 0 ? vol / oi : null;
      out.push({
        key: `s-${r.id}`,
        source: 'scored',
        id: r.id,
        alert_id: r.source_table === 'flow_alerts' || r.source_table === 'ct_flow_alerts' ? r.source_id : null,
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
        underlying_price: meta?.underlying_price ?? null,
        score: r.score,
        direction: r.direction,
        classification: r.classification,
        tape_kind: kind,
        is_sweep: isSweep,
        is_otm: meta?.is_otm ?? null,
        spot_pct_from_prev_close: r.spot_pct_from_prev_close ?? null,
        spot_pct_from_today_open: r.spot_pct_from_today_open ?? null,
      });
      if (r.source_table === 'flow_alerts' || r.source_table === 'ct_flow_alerts') seenScoredSourceIds.add(r.source_id);
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
          alert_id: a.alert_id,
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
          underlying_price: a.underlying_price ?? null,
          score: null,
          direction: null,
          classification: null,
          tape_kind: kind,
          is_sweep: isSweep,
          is_otm: a.is_otm,
          spot_pct_from_prev_close: null,
          spot_pct_from_today_open: null,
        });
      }
    }

    // Alert rows may also have side=null from UW — derive from OCC symbol.
    for (const r of out) {
      if (!r.side) r.side = parseOccSide(r.option_symbol);
    }

    // Client-side filters that depend on derived/joined fields.
    const filtered = out.filter((r) => {
      if (filters.minPremium > 0 && (r.premium == null || r.premium < filters.minPremium)) return false;
      if (filters.minVolOi > 0 && (r.vol_oi == null || r.vol_oi < filters.minVolOi)) return false;
      if (!inDteBand(r.dte, filters.dteBand)) return false;
      if (filters.sweepOnly && !r.is_sweep) return false;
      if (filters.mineOnly && !flaggedSymbols.has(r.option_symbol)) return false;
      if (filters.side !== 'all' && r.side !== filters.side) return false;
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
  }, [scored, unscored, alertMeta, oiMap, filters, flaggedSymbols]);

  const totalBeforeFilter = (scored?.length ?? 0) + (filters.showUnscored ? (unscored?.length ?? 0) : 0);

  // Interleave day-separator markers into the sorted rows. Walks in render order
  // (which is newest → oldest when sortBy = event_ts) and drops a separator
  // whenever the ET calendar date changes. Always emits a leading separator
  // for the first row so the user sees which day they're starting on.
  type TapeItem =
    | { type: 'sep'; key: string; label: string }
    | { type: 'row'; row: TapeRow };
  const items = useMemo<TapeItem[]>(() => {
    const out: TapeItem[] = [];
    let lastDate: string | null = null;
    for (const r of rows) {
      const d = etDateKey(r.event_ts);
      if (d !== lastDate) {
        out.push({ type: 'sep', key: `sep-${d}`, label: formatSeparatorLabel(d) });
        lastDate = d;
      }
      out.push({ type: 'row', row: r });
    }
    return out;
  }, [rows]);

  // Batch-load contract tracks for visible rows. Keyed off the set of
  // alert_ids the rows point at — TanStack dedupes the network call. The
  // chip itself reads from the returned Map; rows without a track render
  // a thin "—" placeholder so the column never stretches the row.
  const visibleAlertIds = useMemo<string[]>(
    () => rows.map((r) => r.alert_id).filter((x): x is string => !!x),
    [rows],
  );
  const { data: contractTracks } = useContractTracksByAlerts(visibleAlertIds);
  const { data: contractGradesByAlert } = useContractGradesByAlerts(visibleAlertIds);

  // Header count line — honest about what the filter is showing.
  const headerCountText = useMemo(() => {
    const n = rows.length;
    const m = totalBeforeFilter;
    if (dayFilter === 'today') return { n, m, suffix: 'today', showM: true };
    if (dayFilter === 'yesterday') return { n, m, suffix: 'yesterday', showM: false };
    if (dayFilter === 'last3d') return { n, m, suffix: 'last 3 trading days', showM: false };
    return { n, m, suffix: 'all time (capped)', showM: true };
  }, [rows.length, totalBeforeFilter, dayFilter]);

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
        <TapeReaderBanner />
        <MacroBanner onTickerClick={(t) => setActiveTicker(t)} />
        <FlowPulse onTickerClick={(t) => setActiveTicker(t)} />
        <StackingPatterns onContractClick={(sym) => setActiveSymbol(sym)} />
        <OvernightPositioning
          onContractClick={(sym) => setActiveSymbol(sym)}
          onTickerClick={(t) => setActiveTicker(t)}
        />
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
              Showing <span className="text-foreground font-semibold">{headerCountText.n}</span>
              {headerCountText.showM && (
                <>
                  {' '}of <span className="text-foreground font-semibold">{headerCountText.m}</span>
                </>
              )}
              {' '}· {headerCountText.suffix}
            </div>
            <DteEligibilityPill />
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
          {/* Day-filter chips */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-muted-foreground mr-1">Day:</span>
            {(
              [
                ['today', 'Today'],
                ['yesterday', 'Yesterday'],
                ['last3d', 'Last 3d'],
                ['all', 'All'],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                onClick={() => setDayFilter(k)}
                className={cn(
                  'text-[11px] font-mono px-2 py-1 rounded border transition-colors',
                  dayFilter === k
                    ? 'border-primary/40 bg-primary/10 text-primary'
                    : 'border-muted bg-muted/20 text-muted-foreground hover:text-foreground',
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Ticker chips */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-muted-foreground mr-1">Ticker:</span>
            <button
              onClick={() => setFilters((p) => ({ ...p, tickers: new Set() }))}
              className={cn(
                'text-[11px] font-mono px-2 py-1 rounded border transition-colors',
                filters.tickers.size === 0
                  ? 'border-primary/40 bg-primary/10 text-primary'
                  : 'border-muted bg-muted/20 text-muted-foreground hover:text-foreground',
              )}
            >
              ALL
            </button>
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

            {/* Side (call/put) — separate from directional sentiment */}
            <div className="flex items-center gap-1">
              <span className="text-xs text-muted-foreground mr-1">Side:</span>
              {(['all', 'call', 'put'] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setFilters((p) => ({ ...p, side: s }))}
                  className={cn(
                    'text-[10px] font-mono px-2 py-0.5 rounded uppercase transition-colors',
                    filters.side === s
                      ? s === 'call'
                        ? 'bg-emerald-500/15 text-emerald-300'
                        : s === 'put'
                          ? 'bg-red-500/15 text-red-300'
                          : 'bg-primary/10 text-primary'
                      : 'bg-muted/20 text-muted-foreground hover:text-foreground',
                  )}
                >
                  {s}
                </button>
              ))}
            </div>

            {/* Direction — sentiment, not side */}
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

            {/* Mine only */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground inline-flex items-center gap-1">
                <Star className="w-3 h-3" /> Mine only
                {jamesFlags && jamesFlags.length > 0 && (
                  <span className="text-[10px] tabular-nums text-muted-foreground/70">({jamesFlags.length})</span>
                )}
              </span>
              <Switch
                checked={filters.mineOnly}
                onCheckedChange={(v) => setFilters((p) => ({ ...p, mineOnly: v }))}
              />
            </div>

            {/* LIVE mode — 5s refresh */}
            <div className="flex items-center gap-2">
              <span className={cn(
                'text-xs inline-flex items-center gap-1',
                filters.liveMode ? 'text-emerald-300' : 'text-muted-foreground',
              )}>
                <Radio className={cn('w-3 h-3', filters.liveMode && 'animate-pulse')} />
                LIVE
              </span>
              <Switch
                checked={filters.liveMode}
                onCheckedChange={(v) => setFilters((p) => ({ ...p, liveMode: v }))}
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

        <AlarmBanner />

        {/* Tape table */}
        <Card className="p-0 overflow-hidden">
          <div className="overflow-x-auto">
            <Table className="text-xs">
              <TableHeader>
                <TableRow className="border-b border-border hover:bg-transparent">
                  <TableHead className="h-9 px-2 text-[11px] uppercase tracking-wider">Time</TableHead>
                  <TableHead className="h-9 px-2 text-[11px] uppercase tracking-wider">Ticker</TableHead>
                  <TableHead className="h-9 px-2 text-[11px] uppercase tracking-wider text-right">Spot</TableHead>
                  <TableHead className="h-9 px-2 text-[11px] uppercase tracking-wider text-right">Strike</TableHead>
                  <TableHead className="h-9 px-2 text-[11px] uppercase tracking-wider">Side</TableHead>
                  <TableHead className="h-9 px-2 text-[11px] uppercase tracking-wider">Exp</TableHead>
                  <TableHead className="h-9 px-2 text-[11px] uppercase tracking-wider text-right">DTE</TableHead>
                  <TableHead className="h-9 px-2 text-[11px] uppercase tracking-wider">Tape</TableHead>
                  <TableHead className="h-9 px-2 text-[11px] uppercase tracking-wider text-right">Prem</TableHead>
                  <TableHead className="h-9 px-2 text-[11px] uppercase tracking-wider text-right">Vol</TableHead>
                  <TableHead className="h-9 px-2 text-[11px] uppercase tracking-wider text-right">OI</TableHead>
                  <TableHead className="h-9 px-2 text-[11px] uppercase tracking-wider text-right">V/OI</TableHead>
                  <TableHead className="h-9 px-2 text-[11px] uppercase tracking-wider text-right">OI Δ1d</TableHead>
                  <TableHead className="h-9 px-2 text-[11px] uppercase tracking-wider text-right">Ask%</TableHead>
                  <TableHead className="h-9 px-2 text-[11px] uppercase tracking-wider text-right" title="Volatility-magnitude detector (0-100). High = setup likely to MOVE big; direction is the specialist's job, not this score's. Per 4,300-event analysis, scorer is a volatility predictor not a direction predictor.">Score</TableHead>
                  <TableHead className="h-9 px-2 text-[11px] uppercase tracking-wider">Tags</TableHead>
                  <TableHead className="h-9 px-2 text-[11px] uppercase tracking-wider text-center w-10">
                    <Star className="w-3.5 h-3.5 inline" />
                  </TableHead>
                  <TableHead className="h-9 px-2 text-[11px] uppercase tracking-wider text-right">P&amp;L</TableHead>
                  <TableHead className="h-9 px-2 text-[11px] uppercase tracking-wider text-center w-[200px]">Horizons</TableHead>
                  <TableHead className="h-9 px-2 text-[11px] uppercase tracking-wider text-right">Stack</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loadingScored && !scored ? (
                  <TableRow>
                    <TableCell colSpan={20} className="text-center text-xs text-muted-foreground py-8">
                      Loading tape…
                    </TableCell>
                  </TableRow>
                ) : rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={20} className="text-center text-xs text-muted-foreground py-8">
                      No flow matches current filters. Loosen min premium, drop min score, or enable "Show unscored".
                    </TableCell>
                  </TableRow>
                ) : (
                  items.map((it) => {
                    if (it.type === 'sep') {
                      return (
                        <TableRow
                          key={it.key}
                          className="hover:bg-transparent border-b border-border/50"
                        >
                          <TableCell
                            colSpan={20}
                            className="py-1.5 px-2 bg-muted/40 text-[10px] uppercase tracking-widest text-muted-foreground"
                          >
                            <div className="flex items-center gap-3">
                              <div className="flex-1 h-px bg-border/60" />
                              <span className="font-mono">{it.label}</span>
                              <div className="flex-1 h-px bg-border/60" />
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    }
                    const r = it.row;
                    const glowTier = glowingForSymbol(r.option_symbol);
                    return (
                    <TableRow
                      key={r.key}
                      data-option-symbol={r.option_symbol}
                      onClick={() => setActiveSymbol(r.option_symbol)}
                      className={cn(
                        'cursor-pointer hover:bg-muted/40 border-b border-border/50',
                        glowTier === 'gold' && 'alarm-row-gold',
                        glowTier === 'silver' && 'alarm-row-silver',
                        glowTier === 'bronze' && 'alarm-row-bronze',
                      )}
                    >
                      <TableCell className="py-2 px-2 font-mono tabular-nums text-muted-foreground">
                        {(dayFilter === 'last3d' || dayFilter === 'all' || filters.sortBy !== 'event_ts') ? (
                          <div className="flex flex-col leading-tight">
                            <span className="text-[10px] text-muted-foreground/70">{formatDateLabelET(r.event_ts)}</span>
                            <span>{formatTimeET(r.event_ts)}</span>
                          </div>
                        ) : (
                          formatTimeET(r.event_ts)
                        )}
                      </TableCell>
                      <TableCell
                        className="py-2 px-2"
                        onClick={(e) => {
                          e.stopPropagation();
                          setActiveTicker(r.ticker);
                        }}
                      >
                        <div className="flex flex-col leading-tight">
                          <span className="font-mono font-bold text-foreground hover:text-primary transition-colors underline decoration-dotted underline-offset-2">
                            {r.ticker}
                          </span>
                          {r.spot_pct_from_prev_close != null && (
                            <RegimeChip
                              pctFromPrevClose={r.spot_pct_from_prev_close}
                              variant="from-prev-close"
                              withLabel={false}
                            />
                          )}
                        </div>
                      </TableCell>
                      <TableCell
                        className={cn('py-2 px-2 font-mono tabular-nums text-right', spotDistanceColor(r.underlying_price, r.strike))}
                        title={
                          r.underlying_price != null && r.strike != null
                            ? `Strike is ${(Math.abs(r.strike - r.underlying_price) / r.underlying_price * 100).toFixed(1)}% from spot`
                            : undefined
                        }
                      >
                        {formatPrice(r.underlying_price)}
                      </TableCell>
                      <TableCell className="py-2 px-2 font-mono tabular-nums text-right font-semibold">
                        {r.strike != null ? `$${r.strike}` : '-'}
                      </TableCell>
                      <TableCell className="py-2 px-2">
                        {r.side ? (
                          <Badge
                            variant="outline"
                            className={cn(
                              'text-[10px] font-mono px-1.5 py-0 font-bold',
                              r.side === 'call'
                                ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/50'
                                : 'bg-red-500/20 text-red-300 border-red-500/50',
                            )}
                          >
                            {r.side === 'call' ? 'CALL' : 'PUT'}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </TableCell>
                      <TableCell className="py-2 px-2 font-mono tabular-nums text-muted-foreground">
                        {formatExpiry(r.expiry)}
                      </TableCell>
                      <TableCell className={cn('py-2 px-2 font-mono tabular-nums text-right', dteColor(r.dte))}>
                        {r.dte ?? '-'}
                      </TableCell>
                      <TableCell className="py-2 px-2">
                        <Badge variant="outline" className={cn('text-[10px] font-mono px-1.5 py-0', tapeKindClass(r.tape_kind))}>
                          {r.tape_kind}
                        </Badge>
                      </TableCell>
                      <TableCell className={cn('py-2 px-2 font-mono tabular-nums text-right', premiumColor(r.premium))}>
                        {formatPremium(r.premium)}
                      </TableCell>
                      <TableCell className="py-2 px-2 font-mono tabular-nums text-right text-muted-foreground">
                        {formatInt(r.volume)}
                      </TableCell>
                      <TableCell className="py-2 px-2 font-mono tabular-nums text-right text-muted-foreground">
                        {formatInt(r.open_interest)}
                      </TableCell>
                      <TableCell className={cn('py-2 px-2 font-mono tabular-nums text-right', volOiColor(r.vol_oi))}>
                        {r.vol_oi != null ? `${r.vol_oi.toFixed(2)}x` : '-'}
                      </TableCell>
                      <TableCell className="py-2 px-2 font-mono tabular-nums text-right">
                        {r.oi_delta_1d != null ? (
                          <span className={r.oi_delta_1d > 0 ? 'text-emerald-400' : r.oi_delta_1d < 0 ? 'text-red-400' : 'text-muted-foreground'}>
                            {r.oi_delta_1d > 0 ? '+' : ''}
                            {formatInt(r.oi_delta_1d)}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </TableCell>
                      <TableCell className="py-2 px-2 font-mono tabular-nums text-right text-muted-foreground">
                        {r.ask_side_perc != null ? `${Math.round(r.ask_side_perc)}%` : '-'}
                      </TableCell>
                      <TableCell className={cn('py-2 px-2 font-mono tabular-nums font-bold text-right text-sm', scoreColor(r.score))}>
                        {r.score != null ? Math.round(r.score) : '-'}
                      </TableCell>
                      <TableCell className="py-2 px-2">
                        <div className="flex items-center gap-1">
                          {r.direction && (
                            <Badge variant="outline" className={cn('text-[10px] font-mono px-1 py-0', directionPill(r.direction))}>
                              {r.direction === 'bullish' ? <ArrowUp className="w-3 h-3" /> : r.direction === 'bearish' ? <ArrowDown className="w-3 h-3" /> : <Minus className="w-3 h-3" />}
                            </Badge>
                          )}
                          {r.classification && (
                            <span className={cn(
                              'text-[10px] font-mono px-1.5 py-0.5 rounded',
                              // Color the classification pill by DIRECTION, not class.
                              // opening_buy on a put is bearish; painting it green was
                              // a bug — the row's direction is the real signal.
                              r.classification === 'opening_buy' && r.direction === 'bullish'
                                ? 'bg-emerald-500/15 text-emerald-300 font-semibold'
                                : r.classification === 'opening_buy' && r.direction === 'bearish'
                                  ? 'bg-red-500/15 text-red-300 font-semibold'
                                  : r.classification === 'hedge'
                                    ? 'bg-amber-500/15 text-amber-300'
                                    : 'bg-muted/40 text-muted-foreground',
                            )}>
                              {r.classification.replace('_', ' ')}
                            </span>
                          )}
                          {r.is_otm === true && (
                            <span className="text-[10px] font-mono px-1 py-0.5 rounded bg-amber-500/15 text-amber-300">OTM</span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell
                        className="py-1.5 px-2 text-center"
                        onClick={(e) => {
                          e.stopPropagation();
                          setMarkDialog({
                            open: true,
                            row: r,
                            note: '',
                            direction_view: r.direction ?? null,
                            saving: false,
                          });
                        }}
                      >
                        <div className="inline-flex items-center gap-1">
                          <Star
                            className={cn(
                              'w-3.5 h-3.5 cursor-pointer transition-colors',
                              flaggedSymbols.has(r.option_symbol)
                                ? 'fill-amber-400 text-amber-400'
                                : 'text-muted-foreground/40 hover:text-amber-400',
                            )}
                          />
                          {flaggedSymbols.has(r.option_symbol) && latestGradeByOption.has(r.option_symbol) && (() => {
                            const g = latestGradeByOption.get(r.option_symbol)!;
                            const pct = g.price_change_pct;
                            const color = g.outcome === 'win' ? 'text-emerald-400 font-bold'
                              : g.outcome === 'partial' ? 'text-emerald-300'
                              : g.outcome === 'loss' ? 'text-red-400'
                              : 'text-muted-foreground';
                            const label = pct != null
                              ? `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`
                              : g.outcome;
                            return (
                              <span
                                className={cn('text-[9px] font-mono tabular-nums', color)}
                                title={`${g.outcome} (underlying ${pct != null ? pct.toFixed(2) + '%' : 'n/a'})`}
                              >
                                {label}
                              </span>
                            );
                          })()}
                        </div>
                      </TableCell>
                      <TableCell
                        className="py-2 px-2 text-right whitespace-nowrap"
                        onClick={(e) => {
                          if (!r.alert_id) return;
                          e.stopPropagation();
                          setDrillAlertId(r.alert_id);
                        }}
                      >
                        <ContractPnLChip
                          track={r.alert_id ? contractTracks?.get(r.alert_id) ?? null : null}
                          onClick={r.alert_id ? () => setDrillAlertId(r.alert_id) : undefined}
                        />
                      </TableCell>
                      <TableCell className="py-2 px-2 text-center whitespace-nowrap">
                        <ContractGradeChips
                          grades={r.alert_id ? contractGradesByAlert?.get(r.alert_id) : undefined}
                        />
                      </TableCell>
                      <TableCell className="py-2 px-2 text-right whitespace-nowrap">
                        {(() => {
                          const stack = stackBySymbol.get(r.option_symbol);
                          if (!stack || stack.prints_count < 3) return null;
                          const sig = interpretStack(stack);
                          const dot = sig.color === 'bullish' ? '🟢' : sig.color === 'bearish' ? '🔴' : '🟡';
                          const tone =
                            sig.color === 'bullish'
                              ? 'bg-emerald-500/15 text-emerald-200 border-emerald-500/40'
                              : sig.color === 'bearish'
                                ? 'bg-rose-500/15 text-rose-200 border-rose-500/40'
                                : 'bg-slate-500/20 text-slate-200 border-slate-500/30';
                          return (
                            <span
                              className={cn(
                                'inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded border tabular-nums',
                                tone,
                              )}
                              title={`${stack.prints_count} prints · ${formatStackPremium(stack.premium_total)} cum — ${sig.mechanism}`}
                            >
                              <span>{dot}</span>
                              <span className="font-semibold">{formatStackCount(stack.prints_count)}</span>
                              <span className="opacity-60">·</span>
                              <span>{formatStackPremium(stack.premium_total)}</span>
                            </span>
                          );
                        })()}
                      </TableCell>
                    </TableRow>
                    );
                  })
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
        onTickerClick={(t) => { setActiveSymbol(null); setActiveTicker(t); }}
      />

      {/* Ticker briefing sheet */}
      <TickerSheet
        ticker={activeTicker}
        open={activeTicker !== null}
        onOpenChange={(o) => { if (!o) setActiveTicker(null); }}
      />

      {/* Contract-axis P&L drill sheet (Phase D) */}
      <ContractDrillSheet
        alertId={drillAlertId}
        open={drillAlertId !== null}
        onOpenChange={(o) => { if (!o) setDrillAlertId(null); }}
      />

      {/* Mark-as-interesting dialog */}
      <Dialog
        open={markDialog.open}
        onOpenChange={(o) => {
          if (!o) setMarkDialog({ open: false, row: null, note: '', direction_view: null, saving: false });
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Star className={cn(
                'w-4 h-4',
                markDialog.row && flaggedSymbols.has(markDialog.row.option_symbol) ? 'fill-amber-400 text-amber-400' : 'text-amber-400',
              )} />
              {markDialog.row && flaggedSymbols.has(markDialog.row.option_symbol)
                ? 'Already flagged — add another or unflag'
                : 'Flag this print'}
            </DialogTitle>
            <DialogDescription className="text-[11px]">
              Your flags are a training signal for the specialists.
            </DialogDescription>
          </DialogHeader>

          {markDialog.row && (
            <div className="space-y-3">
              {/* Context row */}
              <div className="text-[11px] font-mono bg-muted/30 rounded p-2 space-y-1">
                <div className="flex items-center gap-2">
                  <span className="font-semibold">{markDialog.row.ticker}</span>
                  {markDialog.row.side && (
                    <Badge
                      variant="outline"
                      className={cn(
                        'text-[9px] px-1 py-0',
                        markDialog.row.side === 'call'
                          ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40'
                          : 'bg-red-500/15 text-red-300 border-red-500/40',
                      )}
                    >
                      {markDialog.row.side === 'call' ? 'CALL' : 'PUT'}
                    </Badge>
                  )}
                  <span>{markDialog.row.strike != null ? `$${markDialog.row.strike}` : ''}</span>
                  {markDialog.row.expiry && <span className="text-muted-foreground">{formatExpiry(markDialog.row.expiry)}</span>}
                  <span className="ml-auto text-muted-foreground">{formatPremium(markDialog.row.premium)}</span>
                </div>
                <div className="text-[10px] text-muted-foreground truncate">{markDialog.row.option_symbol}</div>
              </div>

              {/* Direction toggle */}
              <div className="flex items-center gap-1">
                <span className="text-xs text-muted-foreground mr-2">Your read:</span>
                {(['bullish', 'bearish', 'neutral'] as const).map((d) => (
                  <button
                    key={d}
                    onClick={() => setMarkDialog((s) => ({ ...s, direction_view: s.direction_view === d ? null : d }))}
                    className={cn(
                      'text-[10px] font-mono px-2 py-1 rounded border transition-colors capitalize',
                      markDialog.direction_view === d
                        ? d === 'bullish'
                          ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                          : d === 'bearish'
                            ? 'border-red-500/40 bg-red-500/10 text-red-300'
                            : 'border-slate-500/40 bg-slate-500/10 text-slate-300'
                        : 'border-muted bg-muted/20 text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {d}
                  </button>
                ))}
              </div>

              {/* Note */}
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Note (optional)</label>
                <Textarea
                  value={markDialog.note}
                  onChange={(e) => setMarkDialog((s) => ({ ...s, note: e.target.value }))}
                  placeholder="Why does this print stand out?"
                  rows={3}
                  className="text-xs resize-none"
                />
              </div>
            </div>
          )}

          <DialogFooter className="gap-2">
            {markDialog.row && flaggedSymbols.has(markDialog.row.option_symbol) && (
              <Button
                variant="outline"
                size="sm"
                className="mr-auto text-red-300 border-red-500/40 hover:bg-red-500/10"
                disabled={markDialog.saving}
                onClick={async () => {
                  if (!markDialog.row) return;
                  setMarkDialog((s) => ({ ...s, saving: true }));
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  const { error } = await (supabase.from('ct_flags' as never) as any)
                    .delete()
                    .eq('source', 'james_star')
                    .eq('option_symbol', markDialog.row.option_symbol);
                  if (error) {
                    toast.error(`Unflag failed: ${error.message}`);
                    setMarkDialog((s) => ({ ...s, saving: false }));
                    return;
                  }
                  toast.success(`Unflagged ${markDialog.row.ticker} ${markDialog.row.option_symbol}`);
                  setMarkDialog({ open: false, row: null, note: '', direction_view: null, saving: false });
                  qc.invalidateQueries({ queryKey: ['ct_james_flags_all'] });
                  qc.invalidateQueries({ queryKey: ['ct_james_flag_grades_all'] });
                }}
              >
                Unflag
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setMarkDialog({ open: false, row: null, note: '', direction_view: null, saving: false })}
              disabled={markDialog.saving}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={markDialog.saving || !markDialog.row}
              onClick={async () => {
                if (!markDialog.row) return;
                setMarkDialog((s) => ({ ...s, saving: true }));
                const r = markDialog.row;
                const now = new Date();
                const horizon = new Date(now.getTime() + 24 * 60 * 60 * 1000);
                // Vibes-tagged star: source='james_star', NOT NULL columns
                // satisfied with safe defaults (instrument=ticker, score=0,
                // 24h horizon). thesis carries James's note (or NULL).
                const payload = {
                  source: 'james_star',
                  specialist_ticker: null,
                  instrument: r.ticker,
                  option_symbol: r.option_symbol,
                  direction: markDialog.direction_view ?? 'neutral',
                  score: 0,
                  thesis: markDialog.note.trim() || null,
                  tags: ['james_star'],
                  horizon_hours: 24,
                  horizon_ts: horizon.toISOString(),
                  source_flow_ids: r.source === 'scored' ? [r.id] : null,
                  status: 'active',
                };
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const { error } = await (supabase.from('ct_flags' as never) as any).insert(payload);
                if (error) {
                  toast.error(`Flag failed: ${error.message}`);
                  setMarkDialog((s) => ({ ...s, saving: false }));
                  return;
                }
                toast.success(`Flagged ${r.ticker} ${r.option_symbol}`);
                setMarkDialog({ open: false, row: null, note: '', direction_view: null, saving: false });
                qc.invalidateQueries({ queryKey: ['ct_james_flags_all'] });
              }}
            >
              {markDialog.saving ? 'Saving…' : 'Flag it'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
