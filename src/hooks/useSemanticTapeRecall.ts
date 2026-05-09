/**
 * useSemanticTapeRecall — semantic recall over historical ct_tape_commentary.
 *
 * Phase 4 of the audit-driven loop (2026-05-09). Activates the deepest
 * unlock per the fusion ground-truth audit Section C.4 + the iter #2 hint
 * already documented at src/components/alpha/ClaudesRead.tsx:154.
 *
 * Flow:
 *   1) Fetch the latest tape commentary row's embedding column
 *      (Phase 1 substrate, written at write-time by ct-tape-reader)
 *   2) Call match_ct_tape_commentary_by_similarity RPC with that embedding
 *      as the query, excluding rows from the same minute (avoid self-match)
 *   3) Return up to 5 most-similar prior reads
 *
 * Captain reads this as: "today at 14:32 is most similar to 2026-05-05 at
 * 11:18, 2026-05-07 at 09:48, ..." — semantic recall over setup-shape
 * (tide+vix+flag-count+flow-count + commentary prose), not chronological.
 *
 * Refetch every 90s — slower than tape-reader's 10-min cron because the
 * "similar past" set rarely changes minute-to-minute.
 */

import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface SemanticTapeMatch {
  id: number;
  created_at: string;
  session_date: string;
  trigger_kind: 'scheduled' | 'flag_interrupt' | 'manual';
  commentary: string;
  market_tide: 'bullish' | 'bearish' | 'flat' | null;
  vix_level: number | null;
  flow_id_count: number;
  flag_id_count: number;
  similarity: number;
}

interface RawMatchRow {
  id: number;
  created_at: string;
  session_date: string;
  trigger_kind: string;
  commentary: string;
  market_tide: string | null;
  vix_level: number | null;
  flow_ids: number[] | null;
  flag_ids: string[] | null;
  similarity: number;
}

function normTrigger(k: string): SemanticTapeMatch['trigger_kind'] {
  if (k === 'scheduled' || k === 'flag_interrupt' || k === 'manual') return k;
  return 'scheduled';
}

function normTide(t: string | null): SemanticTapeMatch['market_tide'] {
  if (t === 'bullish' || t === 'bearish' || t === 'flat') return t;
  return null;
}

function toMatch(r: RawMatchRow): SemanticTapeMatch {
  return {
    id: r.id,
    created_at: r.created_at,
    session_date: r.session_date,
    trigger_kind: normTrigger(r.trigger_kind),
    commentary: r.commentary,
    market_tide: normTide(r.market_tide),
    vix_level: r.vix_level == null ? null : Number(r.vix_level),
    flow_id_count: Array.isArray(r.flow_ids) ? r.flow_ids.length : 0,
    flag_id_count: Array.isArray(r.flag_ids) ? r.flag_ids.length : 0,
    similarity: Number(r.similarity),
  };
}

interface UseSemanticTapeRecallArgs {
  /** Number of matches to return. Default 5. Max 10. */
  matchCount?: number;
  /** Cosine similarity floor. Default 0.5. */
  matchThreshold?: number;
}

export function useSemanticTapeRecall(args: UseSemanticTapeRecallArgs = {}) {
  const matchCount = Math.max(1, Math.min(10, args.matchCount ?? 5));
  const matchThreshold = args.matchThreshold ?? 0.5;

  const query = useQuery<{ matches: SemanticTapeMatch[]; sourceId: number | null; sourceCreatedAt: string | null }>({
    queryKey: ['semantic-tape-recall', { matchCount, matchThreshold }],
    refetchInterval: 90_000,
    staleTime: 80_000,
    retry: false,
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sb: any = supabase;

      // Step 1: latest commentary row WITH embedding populated
      const { data: latestRows, error: latestErr } = await sb
        .from('ct_tape_commentary')
        .select('id, created_at, embedding')
        .not('embedding', 'is', null)
        .order('created_at', { ascending: false })
        .limit(1);
      if (latestErr) throw latestErr;
      const latest = Array.isArray(latestRows) && latestRows.length > 0 ? latestRows[0] : null;
      if (!latest || !latest.embedding) {
        return { matches: [], sourceId: null, sourceCreatedAt: null };
      }

      // Step 2: query the match RPC. exclude_after_ts = latest.created_at -
      // 1 min so we never self-match on the same row, even if cron lands a
      // tied timestamp.
      const exclude = new Date(Date.parse(latest.created_at) - 60_000).toISOString();
      const { data: matchData, error: matchErr } = await sb.rpc(
        'match_ct_tape_commentary_by_similarity',
        {
          query_embedding: latest.embedding,
          match_threshold: matchThreshold,
          match_count: matchCount,
          exclude_after_ts: exclude,
        },
      );
      if (matchErr) throw matchErr;

      const matches = Array.isArray(matchData)
        ? (matchData as RawMatchRow[]).map(toMatch)
        : [];

      return {
        matches,
        sourceId: latest.id as number,
        sourceCreatedAt: latest.created_at as string,
      };
    },
  });

  return {
    matches: query.data?.matches ?? [],
    sourceId: query.data?.sourceId ?? null,
    sourceCreatedAt: query.data?.sourceCreatedAt ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}
