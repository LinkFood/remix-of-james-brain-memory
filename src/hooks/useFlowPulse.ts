/**
 * useFlowPulse — per-ticker directional imbalance over a rolling window.
 *
 * Reads the `ct_flow_pulse` RPC (being built in parallel by the backend agent).
 * Returns one row per watchlist ticker with call/put counts, OTM/ITM breakdown,
 * premium totals, C:P ratio, net premium bias, and 30d baseline deviation.
 *
 * The hook ALSO computes a client-side market aggregate: sum counts + premium
 * across all returned rows, plus a premium-weighted C:P ratio. The aggregate
 * is the always-visible summary line in <FlowPulse>.
 *
 * Behavior when the RPC doesn't exist yet (pre-deploy): query returns an error;
 * we swallow it into isError so the UI renders a skeleton / inline retry text
 * instead of an error banner. `retry: false` — we don't want 3x retries hammer-
 * ing a 404 endpoint. Next 30s poll will pick it up cleanly once deployed.
 */

import { useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface FlowPulseRow {
  ticker: string;
  calls_count: number;
  puts_count: number;
  calls_otm_count: number;
  calls_itm_count: number;
  puts_otm_count: number;
  puts_itm_count: number;
  calls_premium: number;
  puts_premium: number;
  call_put_ratio: number;             // calls / max(puts, 1)
  premium_net: number;                 // calls_prem - puts_prem (+ = bullish)
  cp_ratio_baseline_30d: number | null;
  cp_ratio_deviation: number | null;   // ratio vs baseline (null = no baseline)
  is_unusual: boolean;                 // deviation >= 2x or <= 0.5x
}

export interface AggregatedTotals {
  calls_count: number;
  puts_count: number;
  calls_otm_count: number;
  calls_itm_count: number;
  puts_otm_count: number;
  puts_itm_count: number;
  calls_premium: number;
  puts_premium: number;
  call_put_ratio: number;   // premium-weighted across rows
  premium_net: number;      // sum of row-level premium_net
  ticker_count: number;
}

const EMPTY_TOTALS: AggregatedTotals = {
  calls_count: 0,
  puts_count: 0,
  calls_otm_count: 0,
  calls_itm_count: 0,
  puts_otm_count: 0,
  puts_itm_count: 0,
  calls_premium: 0,
  puts_premium: 0,
  call_put_ratio: 0,
  premium_net: 0,
  ticker_count: 0,
};

export function useFlowPulse(windowMin: number) {
  const query = useQuery<FlowPulseRow[]>({
    queryKey: ['flow-pulse', windowMin],
    staleTime: 30_000,
    refetchInterval: 30_000,
    retry: false,
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.rpc as any)('ct_flow_pulse', {
        p_window_min: windowMin,
        p_ticker: null,
      });
      if (error) throw error;
      return (Array.isArray(data) ? data : []) as FlowPulseRow[];
    },
  });

  // Client-computed market aggregate across all returned tickers. Counts +
  // premium totals are simple sums. The headline C:P ratio is premium-weighted
  // (calls_premium / puts_premium when puts_premium > 0, else falls back to
  // count ratio) — count-weighting would let a spray of cheap 0-DTE puts
  // dominate the read over a single mega call block. Premium-weighting keeps
  // the aggregate directionally honest.
  const marketTotal: AggregatedTotals = useMemo(() => {
    const rows = query.data;
    if (!rows || rows.length === 0) return EMPTY_TOTALS;
    const t: AggregatedTotals = { ...EMPTY_TOTALS, ticker_count: rows.length };
    for (const r of rows) {
      t.calls_count += r.calls_count || 0;
      t.puts_count += r.puts_count || 0;
      t.calls_otm_count += r.calls_otm_count || 0;
      t.calls_itm_count += r.calls_itm_count || 0;
      t.puts_otm_count += r.puts_otm_count || 0;
      t.puts_itm_count += r.puts_itm_count || 0;
      t.calls_premium += r.calls_premium || 0;
      t.puts_premium += r.puts_premium || 0;
      t.premium_net += r.premium_net || 0;
    }
    if (t.puts_premium > 0) {
      t.call_put_ratio = t.calls_premium / t.puts_premium;
    } else if (t.puts_count > 0) {
      t.call_put_ratio = t.calls_count / Math.max(t.puts_count, 1);
    } else {
      t.call_put_ratio = t.calls_count > 0 ? Infinity : 0;
    }
    return t;
  }, [query.data]);

  return {
    rows: query.data ?? [],
    marketTotal,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}

/** Compact dollar formatter: $9.6M / $467M / $1.2B / $0. */
export function formatPulseDollars(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '$0';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

/** Signed dollar with explicit +/− prefix — for the "net" column. */
export function formatPulseDollarsSigned(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '$0';
  if (n === 0) return '$0';
  const sign = n > 0 ? '+' : '';
  return `${sign}${formatPulseDollars(n)}`;
}

/** Thousands-separated integer. */
export function formatPulseInt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '0';
  return Math.round(n).toLocaleString('en-US');
}

export interface FlowPulseSeriesPoint {
  tick_time: string;
  ticker: string;
  premium_net: number;
  call_put_ratio: number | null;
  is_unusual: boolean;
}

/**
 * Pulls today's per-ticker time-series + a synthesized 'MARKET' aggregate
 * row at each tick. Returns a Map keyed by ticker → array of points sorted
 * by tick_time asc — feed each array straight into the FlowPulseSparkline.
 *
 * Single RPC call covers all tickers + market line. RPC handles the today-
 * floor (NY-tz midnight) and market aggregation server-side.
 */
export function useFlowPulseSeries() {
  const query = useQuery<FlowPulseSeriesPoint[]>({
    queryKey: ['flow-pulse-series'],
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: false,
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.rpc as any)('ct_flow_pulse_series', {});
      if (error) throw error;
      return (Array.isArray(data) ? data : []) as FlowPulseSeriesPoint[];
    },
  });

  const seriesByTicker = useMemo(() => {
    const map = new Map<string, FlowPulseSeriesPoint[]>();
    const points = query.data;
    if (!points) return map;
    for (const p of points) {
      const arr = map.get(p.ticker) ?? [];
      arr.push(p);
      map.set(p.ticker, arr);
    }
    for (const [, arr] of map) {
      arr.sort((a, b) => new Date(a.tick_time).getTime() - new Date(b.tick_time).getTime());
    }
    return map;
  }, [query.data]);

  return {
    seriesByTicker,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}

export interface FlowPulseChartPoint {
  bucket_time: string;
  // Mode 1: Calls vs Puts — every contract on the side it was struck
  calls_all: number;
  calls_short: number;   // 0-7 DTE
  calls_long: number;    // 30+ DTE
  puts_all: number;
  puts_short: number;
  puts_long: number;
  // Mode 2: Bullish vs Bearish — directional aggression
  // bullish = bought calls + sold puts; bearish = bought puts + sold calls.
  // Backend may return null/0 for these if `side` isn't yet on ct_flow_alerts;
  // the chart renders an empty-state message in that case.
  bullish_all?: number | null;
  bullish_short?: number | null;
  bullish_long?: number | null;
  bearish_all?: number | null;
  bearish_short?: number | null;
  bearish_long?: number | null;
}

/**
 * Multi-series time-bucketed premium for the FlowPulseChart.
 *
 * Calls server-side ct_flow_pulse_chart, which buckets ct_flow_alerts on-
 * demand into p_bucket_min slots and returns 6 numeric series per bucket.
 * Pass ticker=undefined for the watchlist aggregate, or a specific symbol.
 * sinceMin → server interprets as "now() - sinceMin minutes"; if undefined,
 * server defaults to NY-tz midnight (today).
 */
export function useFlowPulseChart(ticker?: string, sinceMin?: number) {
  const query = useQuery<FlowPulseChartPoint[]>({
    queryKey: ['flow-pulse-chart', ticker ?? 'MARKET', sinceMin ?? 'today'],
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: false,
    queryFn: async () => {
      const params: Record<string, unknown> = {
        p_ticker: ticker ?? null,
        p_bucket_min: 5,
      };
      if (sinceMin && sinceMin > 0) {
        const since = new Date(Date.now() - sinceMin * 60_000).toISOString();
        params.p_since = since;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.rpc as any)('ct_flow_pulse_chart', params);
      if (error) throw error;
      return (Array.isArray(data) ? data : []) as FlowPulseChartPoint[];
    },
  });

  return {
    points: query.data ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
  };
}

/**
 * useNetPremiumSeries — live signed net call/put premium ticks.
 *
 * Powers the live (non-cumulative) Flow Butterfly. Reads the ct_net_premium_series
 * RPC which streams per-minute ticks from ct_net_premium_ticks. Values are SIGNED:
 *   net_call_premium > 0 → call buying (bullish);  < 0 → call selling
 *   net_put_premium  > 0 → put buying (bearish);   < 0 → put selling
 *
 * Plot raw — no cumsum, no mirror. Lines cross when the tape flips.
 *
 * Realtime: subscribes to INSERT on ct_net_premium_ticks and invalidates the
 * React Query cache. Fallback poll every 30s in case Realtime drops an event.
 * staleTime 10s so a focus-refetch after backgrounding is cheap.
 *
 * Pre-deploy behavior: if the RPC isn't live yet, query errors → isError true.
 * `retry: false` to avoid hammering a missing endpoint; the 30s interval will
 * pick it up cleanly once deployed.
 */
export interface NetPremiumSeriesPoint {
  tick_timestamp: string;
  ticker: string;
  net_call_premium: number;
  net_put_premium: number;
}

export function useNetPremiumSeries(ticker?: string, sinceMin?: number) {
  const qc = useQueryClient();
  const queryKey = ['net-premium-series', ticker ?? 'MARKET', sinceMin ?? 'today'] as const;

  // Realtime invalidation on new ticks. We can't filter server-side by ticker
  // in the postgres_changes payload reliably (tick rows are written per-ticker
  // for every watchlist symbol every minute), so subscribe broadly and let the
  // RPC filter on requery. Volume is low — one INSERT per ticker per minute.
  useEffect(() => {
    const chan = supabase
      .channel(`ct_net_premium_ticks_${ticker ?? 'MARKET'}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'ct_net_premium_ticks' },
        (payload) => {
          // Client-side ticker filter to skip irrelevant invalidations when a
          // single ticker is selected. MARKET mode invalidates on every tick.
          if (ticker) {
            const row = (payload as { new?: { ticker?: string } }).new;
            if (row?.ticker && row.ticker !== ticker) return;
          }
          qc.invalidateQueries({ queryKey });
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(chan);
    };
    // queryKey is derived from ticker+sinceMin, so those deps cover it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qc, ticker, sinceMin]);

  const query = useQuery<NetPremiumSeriesPoint[]>({
    queryKey: [...queryKey],
    staleTime: 10_000,
    refetchInterval: 30_000,
    retry: false,
    queryFn: async () => {
      const params: Record<string, unknown> = {
        p_ticker: ticker ?? null,
      };
      if (sinceMin && sinceMin > 0) {
        params.p_since = new Date(Date.now() - sinceMin * 60_000).toISOString();
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.rpc as any)('ct_net_premium_series', params);
      if (error) throw error;
      return (Array.isArray(data) ? data : []) as NetPremiumSeriesPoint[];
    },
  });

  return {
    points: query.data ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
  };
}

/**
 * Compute the default "Today" window in minutes — from today's 13:30 UTC
 * (RTH open ≈ 09:30 ET during EDT) to now. Falls back to 360 when we're
 * pre-market or off-hours so we still show something useful on a pre-open
 * read. Caveat: during EST (Nov-Mar) 13:30 UTC is actually 08:30 ET — off
 * by an hour. For a window-minute calc that's fine.
 */
export function computeTodayWindowMin(): number {
  const now = new Date();
  const openUtc = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    13, 30, 0, 0,
  ));
  const diffMin = Math.floor((now.getTime() - openUtc.getTime()) / 60_000);
  if (diffMin <= 0) return 360;   // pre-market — show last 6h
  if (diffMin > 480) return 480;  // after close — cap at 8h so we show RTH only
  return diffMin;
}
