/**
 * monteCarlo — pure-math forward simulator for Claude's paper book.
 *
 * Hedge funds run this on their win rate + R distribution to answer
 * "if I keep trading like this, what does the 30-day equity curve
 * distribution look like?" Expected return, 95% worst-case drawdown,
 * probability of busting.
 *
 *   For each path: simulate `days` days. Each day runs `tradesPerDay`
 *   trades. Each trade samples an R multiple from `rDistribution`,
 *   which becomes P&L via (R × riskPerTrade × startingEquity).
 *   Track per-step equity, final equity, max drawdown per path.
 *
 * Sampling: cumulative-weighted draw. For ~4 buckets this is O(4) per
 * sample and allocation-free — no reason to reach for the alias method.
 *
 * Determinism: if `seed` is passed, uses a mulberry32 PRNG so the same
 * inputs reproduce the same paths. Unseeded uses Math.random.
 *
 * Scale budget: 10,000 paths × 30 days × 3 trades = 900k sample+multiply
 * ops. Runs in <1s on a modern laptop. We cap paths at 10k (see
 * `MAX_PATHS`); the panel warns the user if they ask for more.
 */

export interface RWeighted {
  /** R multiple — negative for losses, positive for wins. */
  r: number;
  /** Relative weight — does not need to sum to 1; we normalize. */
  weight: number;
}

export interface MCInputs {
  startingEquity: number;
  /** Not used directly when `rDistribution` is provided — included for
   *  symmetry with hedge-fund MC conventions. The distribution encodes
   *  the hit rate implicitly. */
  winRate?: number;
  rDistribution: RWeighted[];
  tradesPerDay: number;
  days: number;
  paths: number;
  /** Fraction of starting equity risked per trade. 0.01 = 1% risk. */
  riskPerTrade: number;
  /** Optional deterministic seed. */
  seed?: number;
  /** Equity level below which the path is considered ruined. Default $1k. */
  ruinThreshold?: number;
  /** Max sample paths to return for rendering. Default 100. */
  sampleSize?: number;
}

export interface MCPath {
  /** Equity after each day (length = days + 1, includes starting equity at index 0). */
  equity: number[];
}

export interface MCResult {
  /** Inputs echoed back so the panel can label the chart. */
  inputs: Pick<
    MCInputs,
    'startingEquity' | 'days' | 'paths' | 'tradesPerDay' | 'riskPerTrade'
  > & {
    pathsRequested: number;
    pathsCapped: boolean;
  };
  /** Per-day percentile bands across all paths. length = days + 1. */
  percentileBands: {
    p5: number[];
    p50: number[];
    p95: number[];
  };
  /** Summary scalars. */
  median_final_equity: number;
  p5_final_equity: number;
  p95_final_equity: number;
  mean_final_equity: number;
  expected_max_dd_pct: number;     // mean — as a fraction, e.g. -0.12 = -12%
  p95_max_dd_pct: number;           // 95th-percentile-worst drawdown (most-negative tail)
  prob_ruin_pct: number;             // % of paths that hit ruin threshold at any point
  prob_profit_pct: number;           // % of paths ending above starting equity
  /** Small sample of path trajectories (for rendering a fan chart). */
  paths: MCPath[];
}

/** Hard cap — 10k paths is already pushing it for weak CPUs on 90-day horizons. */
export const MAX_PATHS = 10000;

/** Default ruin threshold — $1k of the $10k book. */
const DEFAULT_RUIN = 1000;

/** mulberry32 — tiny, fast, good-enough PRNG. Deterministic given seed. */
function makePrng(seed?: number): () => number {
  if (seed == null) return Math.random;
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Prebuild a cumulative-weight sampler. Returns a function that consumes a
 * [0,1) random and returns an R multiple. O(n) per draw where n = number
 * of buckets — fine for the 4-ish buckets we get from rMultipleDistribution.
 */
function buildSampler(dist: RWeighted[]): (u: number) => number {
  const positive = dist.filter(d => d.weight > 0 && Number.isFinite(d.r));
  if (positive.length === 0) {
    // Degenerate — always return 0R. Caller should have guarded upstream.
    return () => 0;
  }
  const totalWeight = positive.reduce((s, d) => s + d.weight, 0);
  const rs: number[] = new Array(positive.length);
  const cum: number[] = new Array(positive.length);
  let acc = 0;
  for (let i = 0; i < positive.length; i++) {
    acc += positive[i].weight / totalWeight;
    rs[i] = positive[i].r;
    cum[i] = acc;
  }
  // Guard floating-point drift — last bucket always covers up to 1.
  cum[cum.length - 1] = 1;
  return (u: number) => {
    for (let i = 0; i < cum.length; i++) {
      if (u < cum[i]) return rs[i];
    }
    return rs[rs.length - 1];
  };
}

/**
 * Percentile on a pre-sorted ascending array. Linear interpolation.
 * p ∈ [0, 1].
 */
function percentileSorted(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0];
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const w = idx - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

export function runMonteCarlo(inputs: MCInputs): MCResult {
  const {
    startingEquity,
    rDistribution,
    tradesPerDay,
    days,
    riskPerTrade,
    seed,
    ruinThreshold = DEFAULT_RUIN,
    sampleSize = 100,
  } = inputs;

  const pathsRequested = inputs.paths;
  const paths = Math.min(Math.max(1, Math.floor(pathsRequested)), MAX_PATHS);
  const pathsCapped = pathsRequested > MAX_PATHS;

  const rand = makePrng(seed);
  const sample = buildSampler(rDistribution);
  const riskDollar = startingEquity * riskPerTrade;

  // Per-day equity grid. Columns are paths, rows are day indices 0..days.
  // We keep each day's equities in a separate typed array so we can sort
  // day-by-day without a transpose pass.
  const equityByDay: Float64Array[] = new Array(days + 1);
  for (let d = 0; d <= days; d++) {
    equityByDay[d] = new Float64Array(paths);
  }
  for (let p = 0; p < paths; p++) equityByDay[0][p] = startingEquity;

  const finalEquities = new Float64Array(paths);
  const maxDDs = new Float64Array(paths);
  const sampleTrajectories: MCPath[] = [];
  const sampleEvery = Math.max(1, Math.floor(paths / sampleSize));

  let ruinCount = 0;
  let profitCount = 0;
  let ddSum = 0;

  for (let p = 0; p < paths; p++) {
    let equity = startingEquity;
    let peak = startingEquity;
    let worstDD = 0; // fraction, ≤ 0
    let ruined = false;
    let trajectory: number[] | null = null;
    if (p % sampleEvery === 0 && sampleTrajectories.length < sampleSize) {
      trajectory = new Array(days + 1);
      trajectory[0] = startingEquity;
    }

    for (let d = 1; d <= days; d++) {
      for (let t = 0; t < tradesPerDay; t++) {
        const r = sample(rand());
        equity += r * riskDollar;
      }
      if (equity > peak) peak = equity;
      if (peak > 0) {
        const dd = (equity - peak) / peak;
        if (dd < worstDD) worstDD = dd;
      }
      if (!ruined && equity <= ruinThreshold) ruined = true;
      equityByDay[d][p] = equity;
      if (trajectory) trajectory[d] = equity;
    }

    finalEquities[p] = equity;
    maxDDs[p] = worstDD;
    ddSum += worstDD;
    if (ruined) ruinCount++;
    if (equity > startingEquity) profitCount++;

    if (trajectory) sampleTrajectories.push({ equity: trajectory });
  }

  // Sorted copies for percentiles. Float64Array has .sort that works fine.
  const sortedFinal = Float64Array.from(finalEquities).sort();
  const sortedDD = Float64Array.from(maxDDs).sort(); // ascending; most-negative at index 0

  const p5Final = percentileSorted(Array.from(sortedFinal), 0.05);
  const medianFinal = percentileSorted(Array.from(sortedFinal), 0.5);
  const p95Final = percentileSorted(Array.from(sortedFinal), 0.95);
  const meanFinal = finalEquities.reduce((s, v) => s + v, 0) / paths;

  // "95th-percentile-worst" drawdown = the DD such that only 5% of paths
  // had a worse (more negative) one. That's the 5th percentile of the
  // ascending sorted DD array.
  const p95DD = percentileSorted(Array.from(sortedDD), 0.05);
  const expectedDD = ddSum / paths;

  const percentileBands = {
    p5: new Array(days + 1),
    p50: new Array(days + 1),
    p95: new Array(days + 1),
  };
  for (let d = 0; d <= days; d++) {
    const row = Array.from(equityByDay[d]).sort((a, b) => a - b);
    percentileBands.p5[d] = percentileSorted(row, 0.05);
    percentileBands.p50[d] = percentileSorted(row, 0.5);
    percentileBands.p95[d] = percentileSorted(row, 0.95);
  }

  return {
    inputs: {
      startingEquity,
      days,
      paths,
      tradesPerDay,
      riskPerTrade,
      pathsRequested,
      pathsCapped,
    },
    percentileBands,
    median_final_equity: medianFinal,
    p5_final_equity: p5Final,
    p95_final_equity: p95Final,
    mean_final_equity: meanFinal,
    expected_max_dd_pct: expectedDD,
    p95_max_dd_pct: p95DD,
    prob_ruin_pct: (ruinCount / paths) * 100,
    prob_profit_pct: (profitCount / paths) * 100,
    paths: sampleTrajectories,
  };
}
