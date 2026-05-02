/**
 * useRegimeState — Pulse v2 read surface.
 *
 * One hook, four parallel queries, derived projections for the page:
 *   1. ct_regime_classifications (latest per ticker incl. NULL=market-wide)
 *   2. ct_regime_signals          (latest per ticker)
 *   3. ct_regime_history          (last 7d for transition log + last 30d market-wide for analog frequency)
 *   4. ct_regime_config           (description tooltips, ordered priority DESC)
 *
 * Refetch every 30s. Global useMarketHoursTrigger (App root) already invalidates
 * everything on bell-cross — no need to gate intervals here.
 *
 * Latest-per-ticker derivation: query last-N-buckets across full watchlist with
 * a generous floor (24 rows × 11 entities = 264 rows max), then reduce to one
 * latest row per ticker key. Cheaper than 11 separate one-row queries.
 *
 * Analog frequency: client-side LEAD over the market-wide history slice — same
 * logic as the SQL version in the brief but no extra round-trip.
 *
 * Weekend fallback: data anchor is MAX(bucket_ts) across classifications. Page
 * renders that age and lets the user know we're showing last-Friday-close.
 */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export const REGIME_WATCHLIST = [
  'SPY', 'QQQ', 'IWM',
  'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'TSLA',
] as const;

export type RegimeTicker = typeof REGIME_WATCHLIST[number];

const REFETCH_INTERVAL_MS = 30_000;

// MARKET key for the NULL-ticker row throughout the page state.
export const MARKET_KEY = '__MARKET__';

export type Trajectory = 'accelerating' | 'steady' | 'decaying';

export interface MacroProximity {
  fomc_days?: number | null;
  cpi_days?: number | null;
  jobs_days?: number | null;
  earnings_clusters?: string[] | null;
  // Tolerate unknown future keys without breaking the type.
  [k: string]: unknown;
}

export interface RegimeClassificationRow {
  ticker: string | null;
  bucket_ts: string;
  classification: string;
  confidence: number;
  rationale: Record<string, unknown> | null;
  config_priority: number | null;
  last_updated: string;
}

export interface RegimeSignalRow {
  ticker: string | null;
  bucket_ts: string;
  momentum: number | null;
  breadth: number | null;
  trajectory: Trajectory | null;
  dispersion: number | null;
  duration_minutes: number | null;
  macro_proximity: MacroProximity | null;
  last_updated: string;
}

export interface RegimeHistoryRow {
  id: number;
  ticker: string | null;
  bucket_ts: string;
  momentum: number | null;
  breadth: number | null;
  trajectory: Trajectory | null;
  dispersion: number | null;
  duration_minutes: number | null;
  classification: string;
  confidence: number;
  rich_text: string | null;
  created_at: string;
}

export interface RegimeConfigRow {
  classification_name: string;
  priority: number;
  active: boolean;
  description: string | null;
}

export interface RegimeTransition {
  id: number;
  ticker: string | null;
  tickerKey: string;            // ticker || MARKET_KEY
  from_classification: string;
  to_classification: string;
  bucket_ts: string;
  created_at: string;
  confidence: number;
}

export interface AnalogFrequencyRow {
  prior: string;
  next: string;
  count: number;
  pct: number;                  // share within prior
}

export interface AnalogFrequencyForCurrent {
  prior: string;
  totalOccurrences: number;
  // sorted desc by count
  distribution: Array<{ next: string; count: number; pct: number }>;
}

interface UseRegimeStateResult {
  marketLatest: RegimeClassificationRow | null;
  marketSignals: RegimeSignalRow | null;
  perTickerLatest: Map<string, RegimeClassificationRow>;
  perTickerSignals: Map<string, RegimeSignalRow>;
  configByName: Map<string, RegimeConfigRow>;
  transitions: RegimeTransition[];                    // last 7d, classification-change only, capped 50
  analogFrequencyByPrior: Map<string, AnalogFrequencyForCurrent>;
  dataAnchor: string | null;                          // MAX(bucket_ts) seen in classifications
  ageMinutes: number | null;                          // minutes since dataAnchor
  isStale: boolean;                                   // ageMinutes > 15 RTH heuristic
  isLoading: boolean;
  isError: boolean;
}

export function useRegimeState(): UseRegimeStateResult {
  // --- 1. Latest classifications ----------------------------------------
  const classificationsQuery = useQuery<RegimeClassificationRow[]>({
    queryKey: ['ct_regime_classifications', 'latest_window'],
    refetchInterval: REFETCH_INTERVAL_MS,
    staleTime: 15_000,
    retry: false,
    queryFn: async () => {
      // Pull the most recent ~300 rows across all tickers and reduce client-
      // side. Covers 11 entities × ~25 buckets = ~2 hours of capture.
      const { data, error } = await supabase
        .from('ct_regime_classifications' as never)
        .select('ticker, bucket_ts, classification, confidence, rationale, config_priority, last_updated')
        .order('bucket_ts', { ascending: false })
        .limit(300);
      if (error) throw error;
      return (data ?? []) as unknown as RegimeClassificationRow[];
    },
  });

  // --- 2. Latest signals -------------------------------------------------
  const signalsQuery = useQuery<RegimeSignalRow[]>({
    queryKey: ['ct_regime_signals', 'latest_window'],
    refetchInterval: REFETCH_INTERVAL_MS,
    staleTime: 15_000,
    retry: false,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('ct_regime_signals' as never)
        .select('ticker, bucket_ts, momentum, breadth, trajectory, dispersion, duration_minutes, macro_proximity, last_updated')
        .order('bucket_ts', { ascending: false })
        .limit(300);
      if (error) throw error;
      return (data ?? []) as unknown as RegimeSignalRow[];
    },
  });

  // --- 3. History — last 7 days for transitions + last 30 days market-wide
  // Single query returns 7d/all-tickers (transition log) — analog frequency
  // sources from the same set when bucket_ts > 30d ago and ticker IS NULL.
  // We pull both windows in one go to keep round trips tight.
  const historyQuery = useQuery<RegimeHistoryRow[]>({
    queryKey: ['ct_regime_history', 'recent_30d'],
    refetchInterval: REFETCH_INTERVAL_MS * 4, // 2 min — slower-moving slice
    staleTime: 60_000,
    retry: false,
    queryFn: async () => {
      const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const { data, error } = await supabase
        .from('ct_regime_history' as never)
        .select('id, ticker, bucket_ts, momentum, breadth, trajectory, dispersion, duration_minutes, classification, confidence, rich_text, created_at')
        .gte('created_at', since30d)
        .order('created_at', { ascending: false })
        .limit(2000);
      if (error) throw error;
      return (data ?? []) as unknown as RegimeHistoryRow[];
    },
  });

  // --- 4. Config (rarely changes) ---------------------------------------
  const configQuery = useQuery<RegimeConfigRow[]>({
    queryKey: ['ct_regime_config'],
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
    retry: false,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('ct_regime_config' as never)
        .select('classification_name, priority, active, description')
        .eq('active', true)
        .order('priority', { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as RegimeConfigRow[];
    },
  });

  // --- Derivations ------------------------------------------------------

  const perTickerLatest = useMemo(() => {
    const map = new Map<string, RegimeClassificationRow>();
    const rows = classificationsQuery.data ?? [];
    // Rows are bucket_ts DESC — first sighting per key wins.
    for (const r of rows) {
      const key = r.ticker ?? MARKET_KEY;
      if (!map.has(key)) map.set(key, r);
    }
    return map;
  }, [classificationsQuery.data]);

  const perTickerSignals = useMemo(() => {
    const map = new Map<string, RegimeSignalRow>();
    const rows = signalsQuery.data ?? [];
    for (const r of rows) {
      const key = r.ticker ?? MARKET_KEY;
      if (!map.has(key)) map.set(key, r);
    }
    return map;
  }, [signalsQuery.data]);

  const marketLatest = perTickerLatest.get(MARKET_KEY) ?? null;
  const marketSignals = perTickerSignals.get(MARKET_KEY) ?? null;

  const configByName = useMemo(() => {
    const map = new Map<string, RegimeConfigRow>();
    for (const c of configQuery.data ?? []) {
      map.set(c.classification_name, c);
    }
    return map;
  }, [configQuery.data]);

  // Transitions: walk history rows oldest-first per ticker, emit when
  // classification changes between adjacent buckets. Only keep events from
  // the last 7 days. Cap to most-recent 50 across all tickers.
  const transitions = useMemo<RegimeTransition[]>(() => {
    const rows = historyQuery.data ?? [];
    if (rows.length === 0) return [];
    // Group by ticker key. Rows came in DESC; sort each group ASC for diffing.
    const groups = new Map<string, RegimeHistoryRow[]>();
    for (const r of rows) {
      const key = r.ticker ?? MARKET_KEY;
      const arr = groups.get(key) ?? [];
      arr.push(r);
      groups.set(key, arr);
    }
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const out: RegimeTransition[] = [];
    for (const [key, arr] of groups) {
      arr.sort((a, b) => new Date(a.bucket_ts).getTime() - new Date(b.bucket_ts).getTime());
      for (let i = 1; i < arr.length; i++) {
        const prev = arr[i - 1];
        const cur = arr[i];
        if (prev.classification === cur.classification) continue;
        if (new Date(cur.created_at).getTime() < sevenDaysAgo) continue;
        out.push({
          id: cur.id,
          ticker: cur.ticker,
          tickerKey: key,
          from_classification: prev.classification,
          to_classification: cur.classification,
          bucket_ts: cur.bucket_ts,
          created_at: cur.created_at,
          confidence: cur.confidence,
        });
      }
    }
    out.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    return out.slice(0, 50);
  }, [historyQuery.data]);

  // Analog frequency: market-wide rows over last 30d. For each prior
  // classification, count how often each next-bucket classification follows
  // it. Same shape as the SQL LEAD() in the brief but client-side over the
  // already-fetched history.
  const analogFrequencyByPrior = useMemo<Map<string, AnalogFrequencyForCurrent>>(() => {
    const rows = (historyQuery.data ?? []).filter((r) => r.ticker === null);
    if (rows.length === 0) return new Map();
    const sorted = [...rows].sort(
      (a, b) => new Date(a.bucket_ts).getTime() - new Date(b.bucket_ts).getTime(),
    );
    // prior → next → count
    const counts = new Map<string, Map<string, number>>();
    for (let i = 0; i < sorted.length - 1; i++) {
      const prior = sorted[i].classification;
      const next = sorted[i + 1].classification;
      const inner = counts.get(prior) ?? new Map<string, number>();
      inner.set(next, (inner.get(next) ?? 0) + 1);
      counts.set(prior, inner);
    }
    const out = new Map<string, AnalogFrequencyForCurrent>();
    for (const [prior, inner] of counts) {
      let total = 0;
      for (const v of inner.values()) total += v;
      const distribution = Array.from(inner.entries())
        .map(([next, count]) => ({ next, count, pct: total > 0 ? (count / total) * 100 : 0 }))
        .sort((a, b) => b.count - a.count);
      out.set(prior, { prior, totalOccurrences: total, distribution });
    }
    return out;
  }, [historyQuery.data]);

  // Data anchor — MAX bucket_ts across all classifications. Used for the
  // weekend fallback banner.
  const dataAnchor = useMemo<string | null>(() => {
    const rows = classificationsQuery.data ?? [];
    if (rows.length === 0) return null;
    let max = rows[0].bucket_ts;
    for (const r of rows) {
      if (r.bucket_ts > max) max = r.bucket_ts;
    }
    return max;
  }, [classificationsQuery.data]);

  const ageMinutes = useMemo<number | null>(() => {
    if (!dataAnchor) return null;
    return Math.round((Date.now() - new Date(dataAnchor).getTime()) / 60_000);
  }, [dataAnchor]);

  const isStale = ageMinutes != null && ageMinutes > 15;

  return {
    marketLatest,
    marketSignals,
    perTickerLatest,
    perTickerSignals,
    configByName,
    transitions,
    analogFrequencyByPrior,
    dataAnchor,
    ageMinutes,
    isStale,
    isLoading:
      classificationsQuery.isLoading ||
      signalsQuery.isLoading ||
      historyQuery.isLoading ||
      configQuery.isLoading,
    isError:
      classificationsQuery.isError ||
      signalsQuery.isError ||
      historyQuery.isError ||
      configQuery.isError,
  };
}

// ---- Display helpers (kept here so the page can stay JSX-mostly) -------

/**
 * Tailwind class palette for a classification. Encodes the brief's color
 * mapping. Returns text + bg + border tokens — caller composes.
 */
export interface ClassificationStyle {
  text: string;
  bg: string;
  border: string;
  badge: string;     // pre-baked badge style
  dot: string;       // for compact tile dots
}

export function classificationStyle(name: string): ClassificationStyle {
  const n = name.toLowerCase();
  if (n === 'trending_up_strong') {
    return {
      text: 'text-emerald-300',
      bg: 'bg-emerald-500/10',
      border: 'border-emerald-500/40',
      badge: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40',
      dot: 'bg-emerald-400',
    };
  }
  if (n === 'trending_up_steady') {
    return {
      text: 'text-emerald-200',
      bg: 'bg-emerald-500/5',
      border: 'border-emerald-500/20',
      badge: 'bg-emerald-500/10 text-emerald-200 border-emerald-500/30',
      dot: 'bg-emerald-300',
    };
  }
  if (n === 'trending_down_strong') {
    return {
      text: 'text-red-300',
      bg: 'bg-red-500/10',
      border: 'border-red-500/40',
      badge: 'bg-red-500/15 text-red-300 border-red-500/40',
      dot: 'bg-red-400',
    };
  }
  if (n === 'trending_down_steady') {
    return {
      text: 'text-red-200',
      bg: 'bg-red-500/5',
      border: 'border-red-500/20',
      badge: 'bg-red-500/10 text-red-200 border-red-500/30',
      dot: 'bg-red-300',
    };
  }
  if (n.startsWith('chop_')) {
    return {
      text: 'text-amber-200',
      bg: 'bg-amber-500/5',
      border: 'border-amber-500/20',
      badge: 'bg-amber-500/10 text-amber-200 border-amber-500/30',
      dot: 'bg-amber-300',
    };
  }
  if (n.startsWith('breaking_')) {
    return {
      text: 'text-sky-300',
      bg: 'bg-sky-500/10',
      border: 'border-sky-500/30',
      badge: 'bg-sky-500/10 text-sky-300 border-sky-500/30',
      dot: 'bg-sky-400',
    };
  }
  if (n === 'pre_event_macro') {
    return {
      text: 'text-purple-300',
      bg: 'bg-purple-500/10',
      border: 'border-purple-500/40',
      badge: 'bg-purple-500/10 text-purple-300 border-purple-500/40',
      dot: 'bg-purple-400',
    };
  }
  if (n === 'decaying') {
    return {
      text: 'text-slate-300',
      bg: 'bg-slate-500/5',
      border: 'border-slate-500/20',
      badge: 'bg-slate-500/10 text-slate-300 border-slate-500/30',
      dot: 'bg-slate-400',
    };
  }
  // unknown / fallback
  return {
    text: 'text-muted-foreground',
    bg: 'bg-muted/20',
    border: 'border-muted',
    badge: 'bg-muted/20 text-muted-foreground border-muted',
    dot: 'bg-muted-foreground',
  };
}

export function formatClassificationLabel(name: string): string {
  return name.replace(/_/g, ' ');
}

export function formatAge(minutes: number | null): string {
  if (minutes == null) return '—';
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h < 24) return m ? `${h}h ${m}m ago` : `${h}h ago`;
  const d = Math.floor(h / 24);
  const remH = h % 24;
  return remH ? `${d}d ${remH}h ago` : `${d}d ago`;
}

export function formatBucketTime(iso: string): string {
  // Render as ET HH:MM. Avoids pulling date-fns-tz; en-US 'America/New_York'
  // is good enough for a label.
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'America/New_York',
  });
}

export function formatBucketDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'America/New_York',
  });
}

/** Pick the macro-proximity flags worth surfacing as badges. */
export function macroBadges(mp: MacroProximity | null | undefined): Array<{ label: string; days: number }> {
  if (!mp) return [];
  const out: Array<{ label: string; days: number }> = [];
  if (typeof mp.fomc_days === 'number' && mp.fomc_days <= 5) out.push({ label: 'FOMC', days: mp.fomc_days });
  if (typeof mp.cpi_days === 'number' && mp.cpi_days <= 5) out.push({ label: 'CPI', days: mp.cpi_days });
  if (typeof mp.jobs_days === 'number' && mp.jobs_days <= 5) out.push({ label: 'JOBS', days: mp.jobs_days });
  return out;
}
