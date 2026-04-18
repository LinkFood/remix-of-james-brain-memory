/**
 * chartSanitize — shared guards for Recharts data and domains.
 *
 * Why it exists: decimal.js (Recharts' precision lib) throws
 * `[DecimalError] LN10 precision limit exceeded` when it tries to compute
 * log ticks on a domain that contains NaN, Infinity, or collapses to a
 * zero-width range. A single null in a dataset crashes the whole chart.
 * ChartSafe catches the crash, but the user sees "chart unavailable".
 * These helpers fix the root cause: sanitize BEFORE it reaches Recharts.
 *
 * Use `finite` to filter/coerce individual values, `finiteDomain` to build
 * safe [min, max] tuples for <YAxis domain={...}> / <XAxis domain={...}>.
 */

/** Returns the value if it is a finite number, otherwise null. */
export const finite = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/** Returns the value if finite, otherwise the fallback. */
export const finiteOr = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

/**
 * Build a safe Recharts axis domain from [min, max] candidates.
 * Guards against non-finite values AND zero-width ranges (min===max), which
 * both trigger the LN10 error. Nudges a flat range by `nudge` on each side.
 */
export function finiteDomain(
  min: unknown,
  max: unknown,
  fallback: [number, number] = [0, 1],
  nudge = 0.01,
): [number, number] {
  const lo = finite(min);
  const hi = finite(max);
  if (lo === null || hi === null) return fallback;
  if (lo === hi) return [lo - nudge, hi + nudge];
  return lo < hi ? [lo, hi] : [hi, lo];
}

/** Min over an array of unknowns, ignoring non-finite entries. */
export function safeMin(xs: readonly unknown[]): number | null {
  let m: number | null = null;
  for (const x of xs) {
    const v = finite(x);
    if (v === null) continue;
    if (m === null || v < m) m = v;
  }
  return m;
}

/** Max over an array of unknowns, ignoring non-finite entries. */
export function safeMax(xs: readonly unknown[]): number | null {
  let m: number | null = null;
  for (const x of xs) {
    const v = finite(x);
    if (v === null) continue;
    if (m === null || v > m) m = v;
  }
  return m;
}
