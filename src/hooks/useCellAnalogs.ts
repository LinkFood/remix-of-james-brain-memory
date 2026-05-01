/**
 * useCellAnalogs — Phase 6 STUB.
 *
 * Wraps a TBD `ct_cell_analogs` RPC that performs semantic similarity over
 * embedded ct_flow_alerts to find historical analogs of a given heatmap cell.
 *
 * **CURRENT STATE (Phase 5 commit):** RPC does not exist. This hook returns
 * an empty result and logs a single "Phase 6 pending" warning per page load.
 * The drill panel renders a placeholder section until Phase 6 ships.
 *
 * Once Phase 6 lands the migration `<date>_ct_cell_analogs_rpc.sql`, the
 * `queryFn` swap is one line — already shaped to match the future RPC's
 * arg list (ticker + expiry_bucket_week + math_mode + cap).
 *
 * @see docs/SYNTHESIS_LAYER_ARCHITECTURE.md § Phase 6
 * @see _shared/contextHelper.ts — HelperName 'analogs' is already reserved
 */

import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';

export interface CellAnalogRow {
  /** ct_flow_alerts id of the analog event. */
  alert_id: string;
  ticker: string;
  expiry_bucket_week: string;
  /** Cosine similarity 0..1. */
  similarity: number;
  /** Time the analog event happened. */
  occurred_at: string;
  /** What happened next — sparse, fields populated as Phase 6 builds out. */
  resolution: {
    /** Forward return at +1d (percent). */
    next_day_pct?: number | null;
    /** Forward return to expiry / +30d (percent). */
    forward_pct?: number | null;
    /** Brief outcome label: 'rip', 'fade', 'churn', 'breakout', etc. */
    label?: string | null;
  } | null;
}

export interface UseCellAnalogsArgs {
  ticker: string | null;
  expiryBucketWeek: string | null;
  /** Optional math-mode hint to bias the similarity search. */
  mathMode?: string;
  /** Cap on rows returned. Default 5. */
  cap?: number;
}

let warnedOnce = false;

export function useCellAnalogs(args: UseCellAnalogsArgs) {
  const { ticker, expiryBucketWeek } = args;
  const enabled = !!ticker && !!expiryBucketWeek;
  const cap = Math.max(1, args.cap ?? 5);
  const mathMode = args.mathMode ?? 'aggressive_directional_decay';

  const seenRef = useRef(false);
  useEffect(() => {
    if (warnedOnce || seenRef.current) return;
    if (!enabled) return;
    seenRef.current = true;
    warnedOnce = true;
    // eslint-disable-next-line no-console
    console.info(
      '[useCellAnalogs] Phase 6 pending — ct_cell_analogs RPC not yet shipped. ' +
      'Drill panel will render an empty placeholder until the migration lands.',
    );
  }, [enabled]);

  const query = useQuery<CellAnalogRow[]>({
    queryKey: ['cell-analogs', { ticker, expiryBucketWeek, mathMode, cap }],
    enabled,
    retry: false,
    // No polling — analogs are computed once per drill open.
    refetchInterval: false,
    staleTime: Infinity,
    queryFn: async () => {
      // Phase 6 will replace this body with:
      //   const { data, error } = await supabase.rpc('ct_cell_analogs', {
      //     p_ticker: ticker, p_expiry_bucket_week: expiryBucketWeek,
      //     p_math_mode: mathMode, p_cap: cap,
      //   });
      //   if (error) throw error;
      //   return (data ?? []) as CellAnalogRow[];
      return [];
    },
  });

  return {
    analogs: query.data ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    /** True until the Phase 6 RPC ships. UI uses this to render the placeholder. */
    isPending: true,
  };
}
