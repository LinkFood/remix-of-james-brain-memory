/**
 * useClaudeBook — data hooks for Claude-as-autonomous-trader UI (Wave D).
 *
 * Claude runs its own paper book in parallel with James. Every ct_* table
 * scoped by trader now has a `trader` column ('james' | 'claude'). These
 * hooks target Claude rows specifically, feeding the Workspace tabs:
 *   - Trade Log          — ct_trade_ideas + ct_trades (trader='claude')
 *   - Claude's Book      — ct_book equity curve (trader='claude')
 *   - Divergence         — ct_book for both traders
 *
 * Tables ct_trade_ideas / ct_trades.trader / ct_book.trader are not yet in
 * the generated supabase types — we cast to `any` the same way useHypotheses
 * does. Migration 20260422000004 is the source of truth for shapes.
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { CtBookRow, CtTradeRow } from './useCoTraderData';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb = supabase as any;

// ---------------------------------------------------------------------------
// Types — ct_trade_ideas is post-types.ts, hand-typed here.
// ---------------------------------------------------------------------------
export type TradeIdeaStatus =
  | 'armed' | 'triggered' | 'filled' | 'expired' | 'cancelled' | 'rejected';

export interface CtTradeIdeaRow {
  id: string;
  hypothesis_id: string | null;
  trader: 'claude' | 'james';
  instrument: string;
  contract_type: 'stock' | 'call' | 'put';
  strike: number | null;
  expiry: string | null;
  direction: 'long' | 'short';
  entry_trigger: Record<string, unknown>;
  entry_price_target: number | null;
  stop_pct: number;
  target_pct: number;
  size_pct: number;
  horizon: 'intraday' | 'session' | 'swing' | 'multi_day';
  rationale: string;
  status: TradeIdeaStatus;
  armed_at: string;
  triggered_at: string | null;
  filled_at: string | null;
  trade_id: string | null;
  cancelled_reason: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

export type TradeIdeaFilter = 'all' | TradeIdeaStatus;

// ---------------------------------------------------------------------------
// Claude's trade ideas (armed / triggered / filled / etc).
// ---------------------------------------------------------------------------
export function useClaudeTradeIdeas(filter: TradeIdeaFilter = 'all') {
  return useQuery<CtTradeIdeaRow[]>({
    queryKey: ['ct_trade_ideas_claude', filter],
    refetchInterval: 30_000,
    queryFn: async () => {
      let q = sb
        .from('ct_trade_ideas')
        .select('*')
        .eq('trader', 'claude')
        .order('armed_at', { ascending: false })
        .limit(200);
      if (filter !== 'all') q = q.eq('status', filter);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as CtTradeIdeaRow[];
    },
  });
}

// ---------------------------------------------------------------------------
// Claude's trades (open / closed / planned). Status filter optional.
// ---------------------------------------------------------------------------
export function useClaudeTrades(status?: CtTradeRow['status']) {
  return useQuery<CtTradeRow[]>({
    queryKey: ['ct_trades_claude', status ?? 'all'],
    refetchInterval: 30_000,
    queryFn: async () => {
      let q = sb
        .from('ct_trades')
        .select('*')
        .eq('trader', 'claude')
        .order('created_at', { ascending: false })
        .limit(200);
      if (status) q = q.eq('status', status);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as CtTradeRow[];
    },
  });
}

// ---------------------------------------------------------------------------
// Claude's equity curve — ct_book rows ASC by session_date.
// ---------------------------------------------------------------------------
export function useClaudeBook() {
  return useQuery<CtBookRow[]>({
    queryKey: ['ct_book_claude'],
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await sb
        .from('ct_book')
        .select('*')
        .eq('trader', 'claude')
        .order('session_date', { ascending: true })
        .limit(500);
      if (error) throw error;
      return (data ?? []) as CtBookRow[];
    },
  });
}

// ---------------------------------------------------------------------------
// James's equity curve — same shape, for divergence overlay.
// ---------------------------------------------------------------------------
export function useJamesBook() {
  return useQuery<CtBookRow[]>({
    queryKey: ['ct_book_james'],
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await sb
        .from('ct_book')
        .select('*')
        .eq('trader', 'james')
        .order('session_date', { ascending: true })
        .limit(500);
      if (error) throw error;
      return (data ?? []) as CtBookRow[];
    },
  });
}
