/**
 * useHeatmapMultiModeAgreement — fan out the 4 directional math modes and
 * compute, per cell, how many agree on a direction sign.
 *
 * The 5 modes (ct_flow_heatmap_live) are:
 *   1. total                           — non-directional (magnitude only)
 *   2. net_signed                      — directional (calls − puts, raw)
 *   3. aggressive_directional_raw      — directional (ask-aggression signed)
 *   4. aggressive_directional_decay    — directional (decay-weighted)
 *   5. voi_unusual                     — non-directional (volume / OI ratio)
 *
 * Only the 3 directional modes carry a sign that's comparable. We score
 * agreement among those 3 (net_signed, aggdir_raw, aggdir_decay) — when
 * 2 of 3 share a direction we flag agreement; 3 of 3 = strong agreement.
 *
 * The spec says "≥3 of 5" — the 3-of-3 directional rule is the strictest
 * honest interpretation given that 2 of the 5 modes are non-directional.
 * Total can contribute as a magnitude tiebreaker (only if it's high enough
 * to not be noise) — exposed via the `meta.totalMagnitude` field per cell.
 *
 * Phase 5 of the Synthesis Layer (see `docs/SYNTHESIS_LAYER_ARCHITECTURE.md`
 * § 5c — multi-mode agreement marker).
 *
 * Cost: 3 RPC roundtrips on a 60s refetch. Cheap relative to the convergence
 * value of the marker. queryKey is shared with useFlowHeatmapLive so the
 * normal-mode cache slice gets reused — only the OTHER 2 modes are net new.
 */

import { useMemo } from 'react';
import {
  useFlowHeatmapLive,
  type HeatmapMathMode,
  type HeatmapRow,
} from './useFlowHeatmap';

export type AgreementLevel = 'none' | 'mixed' | 'two_of_three' | 'three_of_three';

export interface CellAgreement {
  ticker: string;
  expiry_bucket_week: string;
  /** Sign per directional mode: -1 / 0 / +1, or null if mode missing the cell. */
  net_signed: number | null;
  aggdir_raw: number | null;
  aggdir_decay: number | null;
  /** Magnitude in `total` mode (always positive). null if missing. */
  total_magnitude: number | null;
  /** Number of directional modes voting bullish. */
  bullish_votes: number;
  /** Number of directional modes voting bearish. */
  bearish_votes: number;
  /** Net winner: 'bullish' | 'bearish' | null when no majority. */
  winner: 'bullish' | 'bearish' | null;
  level: AgreementLevel;
}

export interface UseHeatmapMultiModeAgreementArgs {
  tickers?: string[] | null;
  minPremium?: number;
  include0DTE?: boolean;
  maxExpiryDays?: number;
  lookbackHours?: number;
  /** Whether to actually fetch. Pass false to short-circuit (e.g. when
   *  the user is in a non-directional mode and the marker isn't shown). */
  enabled?: boolean;
  /** Threshold below which we treat a value as zero-vote (avoid flickering
   *  agreement on near-zero noise). Default $25k. */
  noiseFloor?: number;
}

function sign(n: number, floor: number): -1 | 0 | 1 {
  if (!Number.isFinite(n)) return 0;
  if (Math.abs(n) < floor) return 0;
  return n > 0 ? 1 : -1;
}

function valueSignFromRow(row: HeatmapRow | undefined, floor: number): number | null {
  if (!row) return null;
  if (row.value == null || !Number.isFinite(row.value)) return null;
  return sign(row.value, floor);
}

function indexRows(rows: HeatmapRow[] | undefined): Map<string, HeatmapRow> {
  const m = new Map<string, HeatmapRow>();
  if (!rows) return m;
  for (const r of rows) {
    if (!r?.ticker || !r?.expiry_bucket_week) continue;
    m.set(`${r.ticker}::${r.expiry_bucket_week}`, r);
  }
  return m;
}

function levelOf(votes: { bullish: number; bearish: number }): AgreementLevel {
  const max = Math.max(votes.bullish, votes.bearish);
  const total = votes.bullish + votes.bearish;
  if (total === 0) return 'none';
  if (max === 3) return 'three_of_three';
  if (max === 2) return 'two_of_three';
  return 'mixed';
}

function winnerOf(votes: { bullish: number; bearish: number }): 'bullish' | 'bearish' | null {
  if (votes.bullish > votes.bearish) return 'bullish';
  if (votes.bearish > votes.bullish) return 'bearish';
  return null;
}

const DIRECTIONAL_MODES: HeatmapMathMode[] = [
  'net_signed',
  'aggressive_directional_raw',
  'aggressive_directional_decay',
];

export function useHeatmapMultiModeAgreement(args: UseHeatmapMultiModeAgreementArgs) {
  const enabled = args.enabled !== false;
  const noiseFloor = args.noiseFloor ?? 25_000;

  // Fan out 3 directional + 1 total (for magnitude). Hooks must run in stable
  // order — useFlowHeatmapLive uses TanStack Query under the hood with its
  // own queryKey, so duplicate-mode cache slices share storage.
  const netSigned = useFlowHeatmapLive({
    tickers: args.tickers ?? undefined,
    mathMode: 'net_signed',
    minPremium: args.minPremium,
    include0DTE: args.include0DTE,
    maxExpiryDays: args.maxExpiryDays,
    lookbackHours: args.lookbackHours,
  });
  const aggdirRaw = useFlowHeatmapLive({
    tickers: args.tickers ?? undefined,
    mathMode: 'aggressive_directional_raw',
    minPremium: args.minPremium,
    include0DTE: args.include0DTE,
    maxExpiryDays: args.maxExpiryDays,
    lookbackHours: args.lookbackHours,
  });
  const aggdirDecay = useFlowHeatmapLive({
    tickers: args.tickers ?? undefined,
    mathMode: 'aggressive_directional_decay',
    minPremium: args.minPremium,
    include0DTE: args.include0DTE,
    maxExpiryDays: args.maxExpiryDays,
    lookbackHours: args.lookbackHours,
  });
  const total = useFlowHeatmapLive({
    tickers: args.tickers ?? undefined,
    mathMode: 'total',
    minPremium: args.minPremium,
    include0DTE: args.include0DTE,
    maxExpiryDays: args.maxExpiryDays,
    lookbackHours: args.lookbackHours,
  });

  const byCell = useMemo(() => {
    const m = new Map<string, CellAgreement>();
    if (!enabled) return m;

    const idxNet = indexRows(netSigned.data);
    const idxRaw = indexRows(aggdirRaw.data);
    const idxDecay = indexRows(aggdirDecay.data);
    const idxTotal = indexRows(total.data);

    // Union of cells across all 3 directional modes.
    const keys = new Set<string>();
    for (const k of idxNet.keys()) keys.add(k);
    for (const k of idxRaw.keys()) keys.add(k);
    for (const k of idxDecay.keys()) keys.add(k);

    for (const key of keys) {
      const [ticker, expiry_bucket_week] = key.split('::');
      const sNet = valueSignFromRow(idxNet.get(key), noiseFloor);
      const sRaw = valueSignFromRow(idxRaw.get(key), noiseFloor);
      const sDecay = valueSignFromRow(idxDecay.get(key), noiseFloor);
      const totalRow = idxTotal.get(key);
      const totalMag = totalRow && totalRow.value != null && Number.isFinite(totalRow.value)
        ? Math.abs(totalRow.value)
        : null;

      let bullish = 0; let bearish = 0;
      for (const s of [sNet, sRaw, sDecay]) {
        if (s === 1) bullish++;
        else if (s === -1) bearish++;
      }

      m.set(key, {
        ticker,
        expiry_bucket_week,
        net_signed: sNet,
        aggdir_raw: sRaw,
        aggdir_decay: sDecay,
        total_magnitude: totalMag,
        bullish_votes: bullish,
        bearish_votes: bearish,
        winner: winnerOf({ bullish, bearish }),
        level: levelOf({ bullish, bearish }),
      });
    }
    return m;
  }, [enabled, netSigned.data, aggdirRaw.data, aggdirDecay.data, total.data, noiseFloor]);

  const isLoading = netSigned.isLoading || aggdirRaw.isLoading || aggdirDecay.isLoading;

  return {
    byCell,
    /** Convenience lookup keyed by `${ticker}::${expiry_bucket_week}`. */
    get: (ticker: string, expiry_bucket_week: string): CellAgreement | undefined =>
      byCell.get(`${ticker}::${expiry_bucket_week}`),
    isLoading,
  };
}
