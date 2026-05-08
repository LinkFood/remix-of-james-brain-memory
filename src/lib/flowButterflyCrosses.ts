/**
 * flowButterflyCrosses — pure helpers detecting "cross events" on Flow
 * Butterfly cumsum series.
 *
 * A cross is the moment one cumulative series flips above/below another.
 * For mode 'cp' (4-series): primary cross = cum_all_call vs cum_all_put.
 * For mode 'bb' (mirrored area): cross = top_bb_abs vs bottom_bb_abs.
 *
 * Phase 1 captures primary crosses only; secondary (NextExpiry) is a queued
 * enhancement (`cum_next_call vs cum_next_put`) — not detected here.
 *
 * Captured 2026-05-08 from Phase A of the cross-annotation ship: detection
 * runs at render-time inside chart components via useMemo. The helpers are
 * pure (no side effects) so calling them on every data update is safe + cheap.
 *
 * Used by:
 *   - FlowPulseChart's ButterflyCp / ButterflyBb (single-ticker, full chart)
 *   - MiniFlowButterfly (multi-panel /butterflies grid, compact)
 */

export type CrossDirection = 'bullish' | 'bearish';

/**
 * Magnitude tertile per PR #64 empirical pass (15 RTH days × 10 tickers ×
 * 434 graded crosses):
 *   small ≤ $164,123 — noise (~50% NextClose hit)
 *   mid   ≤ $510,149 — bullish-midday cell hits 71.9%
 *   large > $510,149 — bearish reverse-hit 77.8%, the contrarian-buy cell
 */
export type CrossTertile = 's' | 'm' | 'L';

const TERTILE_MID_CEIL = 164_123;
const TERTILE_LARGE_CEIL = 510_149;

export function magnitudeTertile(mag: number): CrossTertile {
  if (mag <= TERTILE_MID_CEIL) return 's';
  if (mag <= TERTILE_LARGE_CEIL) return 'm';
  return 'L';
}

export interface CrossEvent {
  /** Display label from the data point (e.g. "9:32 AM"). */
  time: string;
  /** ISO timestamp of the bar at which the cross becomes true. */
  bucket_time: string;
  /** bullish = call/bull series rose above put/bear; bearish = opposite. */
  direction: CrossDirection;
  /** Absolute gap |a-b| at the cross moment, in dollars. */
  magnitude: number;
  /** Magnitude tertile per empirical thresholds. Drives visual hierarchy. */
  tertile: CrossTertile;
}

interface CpPoint {
  time: string;
  bucket_time: string;
  cum_all_call: number;
  cum_all_put: number;
}

interface BbPoint {
  time: string;
  bucket_time: string;
  top_bb_abs: number | null;
  bottom_bb_abs: number | null;
}

/**
 * Find primary cross events on the CP-mode 4-series cumsum.
 * Cross = sign of (cum_all_call - cum_all_put) flips between consecutive points.
 * The cross is attributed to the LATER point's time (when it became true).
 */
export function findCpCrosses<T extends CpPoint>(data: readonly T[]): CrossEvent[] {
  const out: CrossEvent[] = [];
  if (data.length < 2) return out;
  let prevDiff = data[0].cum_all_call - data[0].cum_all_put;
  for (let i = 1; i < data.length; i++) {
    const d = data[i];
    const diff = d.cum_all_call - d.cum_all_put;
    // Cross detected only on a strict sign-flip; skip pure-zero idle.
    const flipped = (prevDiff <= 0 && diff > 0) || (prevDiff >= 0 && diff < 0);
    const both_zero = prevDiff === 0 && diff === 0;
    if (flipped && !both_zero) {
      const magnitude = Math.abs(diff);
      out.push({
        time: d.time,
        bucket_time: d.bucket_time,
        direction: diff > 0 ? 'bullish' : 'bearish',
        magnitude,
        tertile: magnitudeTertile(magnitude),
      });
    }
    prevDiff = diff;
  }
  return out;
}

/**
 * Find primary cross events on the BB-mode mirrored cumsum.
 * Cross = sign of (top_bb_abs - bottom_bb_abs) flips between consecutive points.
 * Sentinel rows (multi-day boundary nulls) skip gracefully.
 */
export function findBbCrosses<T extends BbPoint>(data: readonly T[]): CrossEvent[] {
  const out: CrossEvent[] = [];
  if (data.length < 2) return out;
  // Find the first non-null pair to seed prev.
  let prev: number | null = null;
  for (const d of data) {
    if (d.top_bb_abs == null || d.bottom_bb_abs == null) {
      prev = null;
      continue;
    }
    const diff = d.top_bb_abs - d.bottom_bb_abs;
    if (prev !== null) {
      const flipped = (prev <= 0 && diff > 0) || (prev >= 0 && diff < 0);
      const both_zero = prev === 0 && diff === 0;
      if (flipped && !both_zero) {
        const magnitude = Math.abs(diff);
        out.push({
          time: d.time,
          bucket_time: d.bucket_time,
          direction: diff > 0 ? 'bullish' : 'bearish',
          magnitude,
          tertile: magnitudeTertile(magnitude),
        });
      }
    }
    prev = diff;
  }
  return out;
}
