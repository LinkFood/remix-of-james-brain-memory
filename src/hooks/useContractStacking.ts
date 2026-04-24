/**
 * useContractStacking — leaderboard of contracts hit repeatedly in the
 * configured window. Stacking = the same OCC contract printing 3+ times
 * for >= $100k cumulative premium. That's institutional repetition, the
 * kind of thing a single row on /tape can hide when it's really 12 hits
 * on one strike.
 *
 * RPC: ct_contract_stacking (built in parallel by the backend agent).
 * Handle RPC-not-ready gracefully — skeleton + retry on next poll,
 * never bubble an error banner. retry: false on the query so we don't
 * spam logs while the migration is in flight.
 *
 * Returns the raw row list plus a bySymbol Map for O(1) lookup from
 * the /tape row-level badge renderer.
 */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface StackRow {
  option_symbol: string;
  ticker: string;
  strike: number | null;
  expiry: string | null;      // YYYY-MM-DD
  side: string;                // 'C' or 'P'
  prints_count: number;
  first_ts: string;
  last_ts: string;
  premium_total: number;
  avg_score: number | null;
  max_score: number | null;
  ask_dominant_pct: number | null;
  opening_buy_count: number;
  opening_sell_count: number;
  last_15min_prints: number;
  is_accelerating: boolean;
}

export interface UseContractStackingResult {
  rows: StackRow[];
  bySymbol: Map<string, StackRow>;
  isLoading: boolean;
  isError: boolean;
}

export function useContractStacking(windowMin = 360, limit = 50): UseContractStackingResult {
  const { data, isLoading, isError } = useQuery<StackRow[]>({
    queryKey: ['ct_contract_stacking', windowMin, limit],
    staleTime: 30_000,
    refetchInterval: 30_000,
    retry: false,
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.rpc as any)('ct_contract_stacking', {
        p_window_min: windowMin,
        p_min_prints: 3,
        p_min_premium: 100_000,
        p_ticker: null,
        p_limit: limit,
      });
      if (error) throw error;
      return (Array.isArray(data) ? data : []) as StackRow[];
    },
  });

  const rows = useMemo<StackRow[]>(() => data ?? [], [data]);

  const bySymbol = useMemo(() => {
    const m = new Map<string, StackRow>();
    for (const r of rows) m.set(r.option_symbol, r);
    return m;
  }, [rows]);

  return { rows, bySymbol, isLoading, isError };
}

/** Compact print-count formatter: 12 → "×12". */
export function formatStackCount(n: number): string {
  if (!Number.isFinite(n)) return '×0';
  return `×${Math.round(n)}`;
}

/** Compact premium formatter: 4_234_000 → "$4.2M", 890_000 → "$890K". */
export function formatStackPremium(n: number): string {
  if (!Number.isFinite(n)) return '-';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${Math.round(abs / 1_000)}K`;
  return `${sign}$${Math.round(abs)}`;
}

/**
 * interpretStack — translate raw (buy/sell/ask_pct/side) counts into a
 * directional read at a glance. Raw data can mislead: QQQ $609P with 0 buys,
 * 29 sells, 13% ask looks like "bearish puts" but is actually BULLISH put
 * writing (someone collecting premium betting QQQ stays above 609). This
 * function does the mental math so the UI can color the row by what the
 * flow MEANS, not what contract type it is.
 */
export type StackSignalColor = 'bullish' | 'bearish' | 'mixed';

export interface StackSignal {
  color: StackSignalColor;
  label: string;        // short, for chip
  mechanism: string;    // longer, for tooltip
  thin: boolean;        // true when total prints < 5 — signal is weak
}

export function interpretStack(r: {
  side: string;
  opening_buy_count: number;
  opening_sell_count: number;
  ask_dominant_pct: number | null;
  prints_count: number;
}): StackSignal {
  const side = (r.side || '').toUpperCase().startsWith('C') ? 'C' : 'P';
  const total = Math.max(1, r.opening_buy_count + r.opening_sell_count);
  const buyShare = r.opening_buy_count / total;
  const sellShare = r.opening_sell_count / total;
  const ask = r.ask_dominant_pct;
  const thin = r.prints_count < 5;

  const buyDominant = buyShare >= 0.8;
  const sellDominant = sellShare >= 0.8;

  // Accumulation: buy-dominant regardless of ask% (ask% just dials conviction)
  if (buyDominant) {
    if (side === 'C') {
      return {
        color: 'bullish',
        label: 'call accumulation',
        mechanism: `${r.opening_buy_count}/${total} opening_buy · ask ${ask == null ? 'n/a' : ask + '%'} — someone is accumulating calls = bullish`,
        thin,
      };
    }
    return {
      color: 'bearish',
      label: 'put accumulation',
      mechanism: `${r.opening_buy_count}/${total} opening_buy · ask ${ask == null ? 'n/a' : ask + '%'} — someone is accumulating puts = bearish (hedge or directional bet)`,
      thin,
    };
  }

  // Sell-dominant: split by ask% to separate "writing" (low ask, collecting
  // premium) from "distribution / unwinding" (high ask, aggressive unload).
  if (sellDominant) {
    const askLow = ask != null && ask < 30;
    if (askLow) {
      if (side === 'P') {
        return {
          color: 'bullish',
          label: 'put writing',
          mechanism: `${r.opening_sell_count}/${total} opening_sell · ask ${ask}% — selling puts at the bid = collecting premium, betting underlying holds above strike (bullish)`,
          thin,
        };
      }
      return {
        color: 'bearish',
        label: 'call writing',
        mechanism: `${r.opening_sell_count}/${total} opening_sell · ask ${ask}% — selling calls at the bid = collecting premium, betting underlying stays below strike (bearish / resistance)`,
        thin,
      };
    }
    // Sell-dominant but not at the bid — distribution / aggressive unload.
    return {
      color: 'mixed',
      label: side === 'C' ? 'call distribution' : 'put distribution',
      mechanism: `${r.opening_sell_count}/${total} opening_sell · ask ${ask == null ? 'n/a' : ask + '%'} — aggressive selling without bid-side dominance: could be unwind, inventory flush, or hedged spread. Read with context.`,
      thin,
    };
  }

  // Neither dominant — two-sided flow. Could be a spread / hedge / split view.
  return {
    color: 'mixed',
    label: '2-sided',
    mechanism: `${r.opening_buy_count} buy vs ${r.opening_sell_count} sell · ask ${ask == null ? 'n/a' : ask + '%'} — mixed flow, no clear direction`,
    thin,
  };
}

/** "3m ago" / "42m ago" / "2h ago" — short relative time for leaderboard. */
export function formatTimeAgo(iso: string): string {
  try {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '-';
    const diffMs = Date.now() - t;
    const sec = Math.max(0, Math.round(diffMs / 1000));
    if (sec < 60) return `${sec}s ago`;
    const min = Math.round(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const d = Math.round(hr / 24);
    return `${d}d ago`;
  } catch {
    return '-';
  }
}
