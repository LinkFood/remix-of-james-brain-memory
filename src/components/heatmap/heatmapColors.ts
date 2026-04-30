/**
 * heatmapColors — shared color logic for all FlowHeatmap* components.
 *
 * 11-step diverging gradient for directional modes (orange = bearish,
 * slate = flat, blue = bullish). 6-step single-hue ramp (sky-blue) for
 * non-directional modes (total, voi_unusual).
 *
 * Two anchor modes:
 *   - 'per_row'  → percentile rank within row's non-null absolute values
 *   - 'global'   → percentile rank within entire grid's non-null absolute values
 *
 * Step assignment (directional, 11 buckets):
 *   index 0..4   → bearish (orange-700 deepest → orange-300 lightest)
 *   index 5      → flat (slate-300/400)
 *   index 6..10  → bullish (blue-300 lightest → blue-700 deepest)
 *
 * Step assignment (non-directional, 6 buckets):
 *   index 0..5   → sky-200 → sky-700
 *
 * Text color flips white on the deepest shades (top + bottom 2-3 buckets).
 */
import type { HeatmapMathMode } from '@/hooks/useFlowHeatmap';

export type HeatmapColorAnchorInternal = 'per_row' | 'global';

/** Tailwind bg classes, deepest bearish → flat → deepest bullish (length 11). */
export const DIVERGING_BG_CLASSES: readonly string[] = [
  'bg-orange-700',
  'bg-orange-600',
  'bg-orange-500',
  'bg-orange-400',
  'bg-orange-300',
  'bg-slate-300 dark:bg-slate-400',
  'bg-blue-300',
  'bg-blue-400',
  'bg-blue-500',
  'bg-blue-600',
  'bg-blue-700',
];

/** Tailwind text classes paired with each bg above (white on deepest, dark mid). */
export const DIVERGING_TEXT_CLASSES: readonly string[] = [
  'text-white',         // orange-700
  'text-white',         // orange-600
  'text-white',         // orange-500
  'text-orange-950',    // orange-400
  'text-orange-950',    // orange-300
  'text-slate-700 dark:text-slate-900', // slate flat
  'text-blue-950',      // blue-300
  'text-blue-950',      // blue-400
  'text-white',         // blue-500
  'text-white',         // blue-600
  'text-white',         // blue-700
];

/** Single-hue sky ramp for non-directional modes (length 6). */
export const SEQUENTIAL_BG_CLASSES: readonly string[] = [
  'bg-sky-200',
  'bg-sky-300',
  'bg-sky-400',
  'bg-sky-500',
  'bg-sky-600',
  'bg-sky-700',
];

export const SEQUENTIAL_TEXT_CLASSES: readonly string[] = [
  'text-sky-950',
  'text-sky-950',
  'text-sky-950',
  'text-white',
  'text-white',
  'text-white',
];

/** Empty/null cell — neutral muted style. */
export const EMPTY_CELL_BG = 'bg-muted/20';
export const EMPTY_CELL_TEXT = 'text-muted-foreground/40';

/** Mid (zero / near-zero) bucket index for the diverging ramp. */
const DIVERGING_FLAT_INDEX = 5;
const DIVERGING_LAST_INDEX = DIVERGING_BG_CLASSES.length - 1; // 10
const SEQUENTIAL_LAST_INDEX = SEQUENTIAL_BG_CLASSES.length - 1; // 5

/** Math modes that produce signed (diverging) values. */
export function isDirectionalMode(mode: HeatmapMathMode | string): boolean {
  return mode === 'net_signed'
    || mode === 'aggressive_directional_raw'
    || mode === 'aggressive_directional_decay';
}

/**
 * Percentile rank of `abs(value)` within a sorted ascending array of
 * non-null absolute values. Returns a value in [0, 1].
 *
 * Empty pool → 0. Single element → 1.
 */
function percentileRank(absVal: number, sortedAbs: number[]): number {
  const n = sortedAbs.length;
  if (n === 0) return 0;
  if (n === 1) return 1;
  // Binary-search the count of elements <= absVal.
  let lo = 0, hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sortedAbs[mid] <= absVal) lo = mid + 1;
    else hi = mid;
  }
  // lo = count of elements <= absVal. Map to [0, 1] avoiding division-by-(n-1)
  // edge case at n=1 (handled above).
  return Math.max(0, Math.min(1, (lo - 1) / (n - 1)));
}

/**
 * Returns Tailwind classes for a single heatmap cell.
 *
 * - `value === null` (or NaN) → empty cell classes.
 * - Directional mode → 11-step diverging gradient. Bucket index by sign × percentile.
 * - Non-directional mode → 6-step sequential gradient. Bucket index by percentile.
 *
 * The caller passes the row pool (for per-row anchor) AND the grid pool
 * (for global anchor). Internally we sort the chosen pool's non-null
 * absolute values once per call — fast enough for grid sizes <10k.
 */
export function getCellColorClasses(
  value: number | null | undefined,
  anchor: HeatmapColorAnchorInternal,
  mathMode: HeatmapMathMode | string,
  allValuesInRow: ReadonlyArray<number | null | undefined>,
  allValuesInGrid: ReadonlyArray<number | null | undefined>,
): { bg: string; text: string } {
  if (value == null || !Number.isFinite(value)) {
    return { bg: EMPTY_CELL_BG, text: EMPTY_CELL_TEXT };
  }

  const pool = (anchor === 'global' ? allValuesInGrid : allValuesInRow) ?? [];
  const sortedAbs: number[] = [];
  for (const v of pool) {
    if (v != null && Number.isFinite(v)) sortedAbs.push(Math.abs(v as number));
  }
  sortedAbs.sort((a, b) => a - b);

  const absVal = Math.abs(value);
  const pct = percentileRank(absVal, sortedAbs);

  if (isDirectionalMode(mathMode)) {
    // Diverging — sign decides side, percentile decides intensity within side.
    if (value === 0 || sortedAbs.length === 0) {
      return {
        bg: DIVERGING_BG_CLASSES[DIVERGING_FLAT_INDEX],
        text: DIVERGING_TEXT_CLASSES[DIVERGING_FLAT_INDEX],
      };
    }
    if (value > 0) {
      // bullish: indices 6..10 (5 shades)
      const stepsAway = Math.round(pct * 5); // 0..5
      const idx = Math.min(DIVERGING_LAST_INDEX, DIVERGING_FLAT_INDEX + Math.max(1, stepsAway));
      return { bg: DIVERGING_BG_CLASSES[idx], text: DIVERGING_TEXT_CLASSES[idx] };
    }
    // bearish: indices 4..0 (5 shades, deeper as pct→1)
    const stepsAway = Math.round(pct * 5); // 0..5
    const idx = Math.max(0, DIVERGING_FLAT_INDEX - Math.max(1, stepsAway));
    return { bg: DIVERGING_BG_CLASSES[idx], text: DIVERGING_TEXT_CLASSES[idx] };
  }

  // Sequential — 6 buckets
  const idx = Math.min(SEQUENTIAL_LAST_INDEX, Math.round(pct * SEQUENTIAL_LAST_INDEX));
  return { bg: SEQUENTIAL_BG_CLASSES[idx], text: SEQUENTIAL_TEXT_CLASSES[idx] };
}

/** Convenience for legends — returns canonical anchor labels. */
export function anchorLabel(anchor: HeatmapColorAnchorInternal): string {
  return anchor === 'per_row' ? 'per-row' : 'global';
}
