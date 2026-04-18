/**
 * correlation — inline Pearson correlation helpers.
 *
 * Used by:
 *   - ct-correlation-compute (edge) to build ct_ticker_correlation_cache
 *   - CorrelationMatrix (frontend) to compute portfolio-wide correlation
 *     from the cache
 *
 * Zero dependencies — formula expanded inline so we don't pull in
 * simple-statistics or similar for ~10 lines of math.
 */

/** Pearson correlation coefficient between two equal-length numeric series.
 *
 * Returns NaN when:
 *   - arrays differ in length
 *   - arrays have fewer than 2 observations
 *   - either series has zero variance (all-same values — e.g. flat price)
 *
 * Formula (expanded single-pass form):
 *
 *              n·Σxy − Σx·Σy
 *   r = ────────────────────────────────
 *       √[ (n·Σx² − (Σx)²) · (n·Σy² − (Σy)²) ]
 */
export function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n !== ys.length || n < 2) return NaN;

  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    const x = xs[i];
    const y = ys[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) return NaN;
    sx  += x;
    sy  += y;
    sxx += x * x;
    syy += y * y;
    sxy += x * y;
  }

  const denomX = n * sxx - sx * sx;
  const denomY = n * syy - sy * sy;
  // Zero variance in either series → correlation undefined.
  if (denomX <= 0 || denomY <= 0) return NaN;

  const num = n * sxy - sx * sy;
  const den = Math.sqrt(denomX * denomY);
  return num / den;
}

/** Convert a daily-close series into a daily simple-return series.
 *
 *   return[i] = (close[i] − close[i−1]) / close[i−1]
 *
 * Correlation on returns (not levels) is the right thing for risk
 * analysis — correlating raw price levels inflates r for any two series
 * that share a common trend. Returned array has length N−1.
 */
export function toReturns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1];
    const curr = closes[i];
    if (!Number.isFinite(prev) || !Number.isFinite(curr) || prev === 0) continue;
    out.push((curr - prev) / prev);
  }
  return out;
}

/** Pairwise Pearson over the last `window` paired observations of xs/ys.
 *  Returns NaN if fewer than `window` observations exist. */
export function rollingPearson(xs: number[], ys: number[], window: number): number {
  const n = Math.min(xs.length, ys.length);
  if (n < window) return NaN;
  return pearson(xs.slice(n - window), ys.slice(n - window));
}
