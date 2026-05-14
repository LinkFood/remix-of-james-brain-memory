/**
 * useTapeReader — frontend mirror of the `tapeContext` brain organ.
 *
 * Source: `ct_tape_commentary` (one paragraph per row, written by
 * ct-tape-reader every 10min RTH + on conviction-flag interrupts). Returns
 * the latest commentary plus a few prior rows for continuity. Mirrors
 * `getTapeContext` shape so any UI built against this hook stays aligned
 * with what Claude consumers see.
 *
 * Phase 5 of the Synthesis Layer (see `docs/SYNTHESIS_LAYER_ARCHITECTURE.md`
 * § 5a). queryKey starts with `'tape-reader-'` (NOT `ct_*`) so the
 * bell-ring useMarketHoursTrigger invalidator picks it up cleanly at the
 * 09:30/16:00 ET crossing. Refetch every 60s — tape commentary writes on
 * a 10-min cadence so 30s would be wasteful; 60s still surfaces a new
 * paragraph within one cron interval of it landing.
 *
 * Defensive on every error path. retry:false so a missing column / table
 * doesn't hammer 4xx.
 */

import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface TapeCommentaryRow {
  id: number;
  created_at: string;
  session_date: string;
  trigger_kind: 'scheduled' | 'flag_interrupt' | 'manual';
  commentary: string;
  vix_level: number | null;
  market_tide: 'bullish' | 'bearish' | 'flat' | null;
  window_start: string | null;
  window_end: string | null;
  flag_ids: string[];
  flow_ids: number[];
}

export interface UseTapeReaderArgs {
  /** Number of *prior* rows (in addition to latest). Default 3, max 20. */
  priorCount?: number;
}

const DEFAULT_PRIOR = 3;
const MAX_PRIOR = 20;

interface RawTapeRow {
  id: number;
  created_at: string;
  session_date: string;
  trigger_kind: string;
  commentary: string;
  vix_level: number | null;
  market_tide: string | null;
  window_start: string | null;
  window_end: string | null;
  flag_ids: string[] | null;
  flow_ids: number[] | null;
}

function normalizeTriggerKind(k: string): TapeCommentaryRow['trigger_kind'] {
  if (k === 'scheduled' || k === 'flag_interrupt' || k === 'manual') return k;
  return 'scheduled';
}

function normalizeTide(t: string | null): TapeCommentaryRow['market_tide'] {
  if (t === 'bullish' || t === 'bearish' || t === 'flat') return t;
  return null;
}

function toRow(r: RawTapeRow): TapeCommentaryRow {
  return {
    id: r.id,
    created_at: r.created_at,
    session_date: r.session_date,
    trigger_kind: normalizeTriggerKind(r.trigger_kind),
    commentary: r.commentary,
    vix_level: r.vix_level == null ? null : Number(r.vix_level),
    market_tide: normalizeTide(r.market_tide),
    window_start: r.window_start,
    window_end: r.window_end,
    flag_ids: Array.isArray(r.flag_ids) ? r.flag_ids : [],
    flow_ids: Array.isArray(r.flow_ids) ? r.flow_ids : [],
  };
}

export function useTapeReader(args: UseTapeReaderArgs = {}) {
  const priorCount = Math.max(0, Math.min(MAX_PRIOR, args.priorCount ?? DEFAULT_PRIOR));
  const totalNeeded = 1 + priorCount;

  const query = useQuery<TapeCommentaryRow[]>({
    queryKey: ['tape-reader', { priorCount }],
    refetchInterval: 60_000,
    staleTime: 55_000,
    retry: false,
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sb: any = supabase;
      const { data, error } = await sb.from('ct_tape_commentary')
        .select('id, created_at, session_date, trigger_kind, commentary, vix_level, market_tide, window_start, window_end, flag_ids, flow_ids')
        .order('created_at', { ascending: false })
        .limit(totalNeeded);
      if (error) throw error;
      const rows = Array.isArray(data) ? (data as RawTapeRow[]) : [];
      return rows.map(toRow);
    },
  });

  const rows = query.data ?? [];
  const latest = rows[0] ?? null;
  const prior = rows.slice(1);

  return {
    latest,
    prior,
    rows,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}
