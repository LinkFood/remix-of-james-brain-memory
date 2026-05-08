/**
 * useTopActiveFlags — top-N specialist flags by score, status='active'.
 *
 * Thin snapshot-mode hook for the v2 Tape command-center Flags snapshot.
 * The full /flags page builds its query inline; this is the compact subset
 * the snapshot needs (top 3 by score, score >= floor, active only).
 *
 * Polls every 30s. Realtime subscription on new flags lives in
 * useAlarmRealtime (signature_alarm flavor); this hook's polling cadence
 * matches the /flags page so cross-section consistency is preserved.
 */

import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface TopActiveFlag {
  id: string;
  instrument: string;
  direction: 'bullish' | 'bearish' | 'neutral' | null;
  score: number;
  thesis: string | null;
  source: string;
  status: string;
  created_at: string;
  entry_price: number | null;
  target_price: number | null;
}

interface RawFlag {
  id: string;
  instrument: string;
  direction: string | null;
  score: number | string;
  thesis: string | null;
  source: string;
  status: string;
  created_at: string;
  entry_price: number | string | null;
  target_price: number | string | null;
}

function normalizeDirection(s: string | null): TopActiveFlag['direction'] {
  if (s === 'bullish' || s === 'bearish' || s === 'neutral') return s;
  return null;
}

function toNum(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export interface UseTopActiveFlagsArgs {
  limit?: number;
  minScore?: number;
}

export function useTopActiveFlags(args: UseTopActiveFlagsArgs = {}) {
  const limit = args.limit ?? 3;
  const minScore = args.minScore ?? 70;

  return useQuery<TopActiveFlag[]>({
    queryKey: ['tape-v2-top-active-flags', { limit, minScore }],
    refetchInterval: 30_000,
    staleTime: 25_000,
    retry: false,
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sb: any = supabase;
      // Pull a wider set than `limit` so we can filter to specialist sources
      // client-side (ct_flags carries james_star + signature_alarm rows that
      // belong elsewhere on the command center).
      const { data, error } = await sb.from('ct_flags')
        .select('id, instrument, direction, score, thesis, source, status, created_at, entry_price, target_price')
        .in('source', ['specialist', 'detector_alarm'])
        .eq('status', 'active')
        .gte('score', minScore)
        .order('score', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(limit * 4);
      if (error) throw error;
      const rows: RawFlag[] = Array.isArray(data) ? data : [];
      return rows.slice(0, limit).map((r) => ({
        id: r.id,
        instrument: r.instrument,
        direction: normalizeDirection(r.direction),
        score: Number(r.score),
        thesis: r.thesis,
        source: r.source,
        status: r.status,
        created_at: r.created_at,
        entry_price: toNum(r.entry_price),
        target_price: toNum(r.target_price),
      }));
    },
  });
}
