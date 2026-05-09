/**
 * gexInferenceContext — the 13th brain organ.
 *
 * Source: `ct_gex_timeseries` (per-strike gamma timeseries; the live substrate
 * after `ct_gex_snapshots` was dropped via migration 20260417000001). For each
 * watchlist ticker, reads the most-recent snapshot's ATM-band strike ladder
 * and computes structured-numeric inference: `gamma_flip_strike`,
 * `call_wall_strike`, `put_floor_strike`, `dealer_net_direction`,
 * `price_vs_flip`, `pin_attractor_strikes`, plus a watchlist-wide consensus.
 *
 * NO narrative artifacts — pure structured numerics. Captain composes the
 * read; the organ supplies the dimensions. PR-B `/heatmap` redesign and PR-C
 * `/alpha` snapshot card consume this surface.
 *
 * The 5 inline-inference edge functions (`ct-ticker-snapshot-builder`,
 * `ct-hypothesis-proposer`, `ct-custom-rule-eval`, `ct-regime-watch`,
 * `ct-eod-report`) are NOT touched in this PR — caller refactor is iter
 * #3.5, out of scope.
 *
 * Implements the full ContextHelper<T> contract per `contextHelper.ts`.
 * Never throws; defensive-empty on error; telemetry meta + organMetadata
 * populated. Audience: ['cotrader', 'analyst', 'agent_internal'] —
 * paper_claude stays isolated per the firewall contract (D3).
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import type {
  ContextHelper,
  HelperDescription,
  HelperFetchContext,
  HelperOpts,
  HelperResult,
  OrganMetadata,
  OrganStatus,
} from './contextHelper.ts';

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export type DealerNetDirection = 'positive_gamma' | 'negative_gamma' | 'flat';
export type PriceVsFlip = 'above' | 'below' | 'at';
export type ConsensusDirection =
  | 'broad_positive_gamma'
  | 'broad_negative_gamma'
  | 'mixed'
  | 'no_signal';

export interface PinAttractor {
  strike: number;
  /** Magnitude = abs(net_gex). Sign carried via `signed_net_gex`. */
  magnitude: number;
  signed_net_gex: number;
}

export interface GexInferencePerTicker {
  ticker: string;
  /** ISO timestamp of the snapshot read for this ticker. */
  snapshot_at: string;
  /** Most-recent underlying price from the snapshot. */
  underlying_price: number | null;
  /** Strike where net_gex crosses zero in the ATM band, signed-interpolated. */
  gamma_flip_strike: number | null;
  /** Strike with maximum call_gex above spot in the ATM band. */
  call_wall_strike: number | null;
  /** Strike with most-negative put_gex (largest |put_gex|) below spot in the ATM band. */
  put_floor_strike: number | null;
  /** Sign of total net_gex across ATM-band strikes. */
  dealer_net_direction: DealerNetDirection;
  /** Sum of net_gex across the ATM band (numeric — captain may want the magnitude). */
  dealer_net_total: number;
  /** Underlying vs flip strike with ε tolerance; null when either input missing. */
  price_vs_flip: PriceVsFlip | null;
  /** Top-3 strikes by abs(net_gex) within the ATM band — pin magnets. */
  pin_attractor_strikes: PinAttractor[];
  /** Count of ATM-band strike rows used for inference. */
  atm_strike_count: number;
}

export interface GexInferenceWatchlistAggregate {
  consensus_direction: ConsensusDirection;
  tickers_above_flip: number;
  tickers_below_flip: number;
  tickers_at_flip: number;
  tickers_no_flip: number;
  /** Median percent distance from underlying to flip (signed: + above flip, - below). */
  median_price_vs_flip_pct: number | null;
}

export interface GexInferenceResult {
  per_ticker: GexInferencePerTicker[];
  watchlist: GexInferenceWatchlistAggregate;
  generated_at: string;
}

// ---------------------------------------------------------------------------
// Constants — kept in-file for v1 simplicity. Move to ct_config when first
// caller asks for per-consumer overrides (mirrors flowHeatmapHelper's
// migration path).
// ---------------------------------------------------------------------------

const HELPER_NAME = 'gex_inference';
const HELPER_VERSION = 'v1';

/** Tolerance in percent for `price_vs_flip='at'` classification. */
const FLIP_PROXIMITY_PCT = 0.001; // 0.1% — tight but non-zero

/** How far back to look for "most-recent snapshot" before declaring stale. */
const SNAPSHOT_LOOKBACK_HOURS = 72;

/**
 * Threshold for `dealer_net_direction='flat'`. ATM-band sum below this
 * absolute magnitude is considered noise. Calibrated from sample data
 * (single-strike net_gex values are typically 0.001-100; ATM-band sums
 * range widely, so use 1.0 as a conservative noise floor).
 */
const DEALER_FLAT_THRESHOLD = 1.0;

/** Top N pin-attractors per ticker. */
const PIN_ATTRACTOR_TOP_N = 3;

/** Watchlist-wide thresholds for consensus_direction. */
const CONSENSUS_BROAD_MIN = 7; // 7 of 10 = broad

/** Per-ticker fetch concurrency cap (Promise.all over 10 tickers). */
const PER_TICKER_LIMIT = 200; // ATM band strikes per snapshot — generous cap

interface GexRow {
  snapshot_at: string;
  strike: number;
  call_gex: number | null;
  put_gex: number | null;
  net_gex: number | null;
  underlying_price: number | null;
}

// ---------------------------------------------------------------------------
// Inference math — mirrors ct-gex-radar / ct-linkgex-deep semantics
// ---------------------------------------------------------------------------

function num(v: unknown, fallback = 0): number {
  if (v === null || v === undefined) return fallback;
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Gamma flip = the strike where net_gex crosses zero. Linear-interpolate
 * between the two adjacent strikes that bracket the sign change. Returns
 * null if no sign change exists across the ATM band.
 *
 * Strikes must be sorted ascending before calling.
 */
function findGammaFlip(rows: readonly GexRow[]): number | null {
  if (rows.length < 2) return null;
  for (let i = 0; i < rows.length - 1; i++) {
    const a = rows[i];
    const b = rows[i + 1];
    const an = num(a.net_gex);
    const bn = num(b.net_gex);
    if (an === 0 || bn === 0) continue;
    if ((an > 0) !== (bn > 0)) {
      // Linear interpolation for the zero-crossing strike.
      const t = an / (an - bn);
      return a.strike + t * (b.strike - a.strike);
    }
  }
  return null;
}

/**
 * Call wall = strike above spot with max call_gex.
 * Returns null if spot is unknown or no qualifying strike found.
 */
function findCallWall(rows: readonly GexRow[], spot: number | null): number | null {
  if (spot === null) return null;
  let best = -Infinity;
  let strike: number | null = null;
  for (const r of rows) {
    if (r.strike <= spot) continue;
    const cg = num(r.call_gex);
    if (cg > best) {
      best = cg;
      strike = r.strike;
    }
  }
  return strike;
}

/**
 * Put floor = strike below spot with most-negative put_gex (largest |put_gex|).
 * Returns null if spot is unknown or no qualifying strike found.
 */
function findPutFloor(rows: readonly GexRow[], spot: number | null): number | null {
  if (spot === null) return null;
  let bestAbs = -Infinity;
  let strike: number | null = null;
  for (const r of rows) {
    if (r.strike >= spot) continue;
    const pg = num(r.put_gex);
    const abs = Math.abs(pg);
    if (abs > bestAbs) {
      bestAbs = abs;
      strike = r.strike;
    }
  }
  return strike;
}

function classifyDealerNet(total: number): DealerNetDirection {
  if (Math.abs(total) < DEALER_FLAT_THRESHOLD) return 'flat';
  return total > 0 ? 'positive_gamma' : 'negative_gamma';
}

function classifyPriceVsFlip(
  price: number | null,
  flip: number | null,
): PriceVsFlip | null {
  if (price === null || flip === null) return null;
  const epsilon = Math.abs(flip) * FLIP_PROXIMITY_PCT;
  if (Math.abs(price - flip) <= epsilon) return 'at';
  return price > flip ? 'above' : 'below';
}

function topPinAttractors(rows: readonly GexRow[]): PinAttractor[] {
  const scored = rows.map((r) => {
    const ng = num(r.net_gex);
    return { strike: r.strike, signed_net_gex: ng, magnitude: Math.abs(ng) };
  });
  scored.sort((a, b) => b.magnitude - a.magnitude);
  return scored.slice(0, PIN_ATTRACTOR_TOP_N);
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

// ---------------------------------------------------------------------------
// DB read — most-recent snapshot per ticker
// ---------------------------------------------------------------------------

/**
 * Two-step read: (1) find the most-recent snapshot_at for this ticker within
 * SNAPSHOT_LOOKBACK_HOURS, (2) pull all ATM-band strikes for that snapshot.
 *
 * Defensive on error — returns empty array, never throws.
 */
async function readLatestSnapshotRows(
  supabase: SupabaseClient,
  ticker: string,
): Promise<GexRow[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb: any = supabase;
  const lookbackIso = new Date(
    Date.now() - SNAPSHOT_LOOKBACK_HOURS * 3600 * 1000,
  ).toISOString();
  try {
    const { data: latest, error: latestErr } = await sb
      .from('ct_gex_timeseries')
      .select('snapshot_at')
      .eq('ticker', ticker)
      .gte('snapshot_at', lookbackIso)
      .order('snapshot_at', { ascending: false })
      .limit(1);
    if (latestErr || !Array.isArray(latest) || latest.length === 0) return [];
    const snapshotAt = latest[0].snapshot_at as string;

    const { data: rows, error: rowsErr } = await sb
      .from('ct_gex_timeseries')
      .select('snapshot_at, strike, call_gex, put_gex, net_gex, underlying_price')
      .eq('ticker', ticker)
      .eq('snapshot_at', snapshotAt)
      .eq('is_atm_band', true)
      .order('strike', { ascending: true })
      .limit(PER_TICKER_LIMIT);
    if (rowsErr || !Array.isArray(rows)) return [];
    return rows as GexRow[];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Per-ticker assembly
// ---------------------------------------------------------------------------

function emptyTickerInference(ticker: string, asOf: string): GexInferencePerTicker {
  return {
    ticker,
    snapshot_at: asOf,
    underlying_price: null,
    gamma_flip_strike: null,
    call_wall_strike: null,
    put_floor_strike: null,
    dealer_net_direction: 'flat',
    dealer_net_total: 0,
    price_vs_flip: null,
    pin_attractor_strikes: [],
    atm_strike_count: 0,
  };
}

async function buildPerTickerInference(
  supabase: SupabaseClient,
  ticker: string,
  fallbackAsOf: string,
): Promise<GexInferencePerTicker> {
  const rows = await readLatestSnapshotRows(supabase, ticker);
  if (rows.length === 0) return emptyTickerInference(ticker, fallbackAsOf);

  // Spot — first non-null underlying_price (all rows in one snapshot share it,
  // but defensive against partial nulls).
  let spot: number | null = null;
  for (const r of rows) {
    if (r.underlying_price !== null && r.underlying_price !== undefined) {
      const s = num(r.underlying_price, NaN);
      if (Number.isFinite(s) && s > 0) {
        spot = s;
        break;
      }
    }
  }

  const flip = findGammaFlip(rows);
  const callWall = findCallWall(rows, spot);
  const putFloor = findPutFloor(rows, spot);
  const dealerTotal = rows.reduce((acc, r) => acc + num(r.net_gex), 0);
  const dealerDir = classifyDealerNet(dealerTotal);
  const priceVsFlip = classifyPriceVsFlip(spot, flip);
  const pins = topPinAttractors(rows);

  return {
    ticker,
    snapshot_at: rows[0].snapshot_at,
    underlying_price: spot,
    gamma_flip_strike: flip,
    call_wall_strike: callWall,
    put_floor_strike: putFloor,
    dealer_net_direction: dealerDir,
    dealer_net_total: dealerTotal,
    price_vs_flip: priceVsFlip,
    pin_attractor_strikes: pins,
    atm_strike_count: rows.length,
  };
}

// ---------------------------------------------------------------------------
// Watchlist aggregate
// ---------------------------------------------------------------------------

function buildWatchlistAggregate(
  perTicker: readonly GexInferencePerTicker[],
): GexInferenceWatchlistAggregate {
  let above = 0;
  let below = 0;
  let at = 0;
  let noFlip = 0;
  let pos = 0;
  let neg = 0;
  const flipDistances: number[] = [];

  for (const t of perTicker) {
    if (t.price_vs_flip === 'above') above += 1;
    else if (t.price_vs_flip === 'below') below += 1;
    else if (t.price_vs_flip === 'at') at += 1;
    else noFlip += 1;

    if (t.dealer_net_direction === 'positive_gamma') pos += 1;
    else if (t.dealer_net_direction === 'negative_gamma') neg += 1;

    if (
      t.underlying_price !== null &&
      t.gamma_flip_strike !== null &&
      t.gamma_flip_strike !== 0
    ) {
      const pct = ((t.underlying_price - t.gamma_flip_strike) / t.gamma_flip_strike) * 100;
      flipDistances.push(pct);
    }
  }

  let consensus: ConsensusDirection;
  const inferred = pos + neg;
  if (inferred === 0) consensus = 'no_signal';
  else if (pos >= CONSENSUS_BROAD_MIN) consensus = 'broad_positive_gamma';
  else if (neg >= CONSENSUS_BROAD_MIN) consensus = 'broad_negative_gamma';
  else consensus = 'mixed';

  return {
    consensus_direction: consensus,
    tickers_above_flip: above,
    tickers_below_flip: below,
    tickers_at_flip: at,
    tickers_no_flip: noFlip,
    median_price_vs_flip_pct: median(flipDistances),
  };
}

// ---------------------------------------------------------------------------
// Helper result wiring
// ---------------------------------------------------------------------------

function buildOrganMetadata(
  asOf: string,
  status: OrganStatus,
  oldestSnapshot: string | null,
): OrganMetadata {
  return {
    as_of: oldestSnapshot ?? asOf,
    source: '_shared/gexInferenceContext.ts / ct_gex_timeseries (most-recent snapshot per ticker)',
    window: 'most_recent_snapshot',
    status,
  };
}

function emptyResult(
  startedAt: number,
  warning?: string,
  status: OrganStatus = 'no_signal_detected',
): HelperResult<GexInferenceResult> {
  const asOf = new Date().toISOString();
  return {
    data: {
      per_ticker: [],
      watchlist: {
        consensus_direction: 'no_signal',
        tickers_above_flip: 0,
        tickers_below_flip: 0,
        tickers_at_flip: 0,
        tickers_no_flip: 0,
        median_price_vs_flip_pct: null,
      },
      generated_at: asOf,
    },
    meta: {
      helperName: HELPER_NAME,
      helperVersion: HELPER_VERSION,
      fetchedAt: asOf,
      rowCount: 0,
      cacheHit: false,
      latencyMs: Date.now() - startedAt,
      truncated: false,
      ...(warning ? { warning } : {}),
    },
    organMetadata: buildOrganMetadata(asOf, status, null),
  };
}

// ---------------------------------------------------------------------------
// Convenience function — caller-friendly wrapper
// ---------------------------------------------------------------------------

export async function getGexInferenceContext(
  supabase: SupabaseClient,
  watchlist: readonly string[],
  opts: HelperOpts = {},
): Promise<HelperResult<GexInferenceResult>> {
  const startedAt = Date.now();
  const focus = typeof opts.tickerFocus === 'string' && opts.tickerFocus.length > 0
    ? [opts.tickerFocus]
    : Array.from(watchlist);

  if (focus.length === 0) {
    return emptyResult(startedAt, 'empty_watchlist');
  }

  const asOf = new Date().toISOString();

  try {
    const perTicker = await Promise.all(
      focus.map((ticker) => buildPerTickerInference(supabase, ticker, asOf)),
    );
    const watchlistAgg = buildWatchlistAggregate(perTicker);

    // Identify the oldest as_of across populated tickers — that becomes the
    // organMetadata.as_of since it's the floor of "this is fresh through".
    let oldestAsOf: string | null = null;
    for (const t of perTicker) {
      if (t.atm_strike_count === 0) continue;
      if (oldestAsOf === null || t.snapshot_at < oldestAsOf) {
        oldestAsOf = t.snapshot_at;
      }
    }

    const populatedCount = perTicker.filter((t) => t.atm_strike_count > 0).length;
    const totalRowCount = perTicker.reduce((acc, t) => acc + t.atm_strike_count, 0);

    let status: OrganStatus;
    if (populatedCount === 0) status = 'no_signal_detected';
    else if (populatedCount < focus.length) status = 'data_missing';
    else status = 'populated';

    return {
      data: {
        per_ticker: perTicker,
        watchlist: watchlistAgg,
        generated_at: asOf,
      },
      meta: {
        helperName: HELPER_NAME,
        helperVersion: HELPER_VERSION,
        fetchedAt: asOf,
        rowCount: totalRowCount,
        cacheHit: false,
        latencyMs: Date.now() - startedAt,
        truncated: false,
        ...(populatedCount === 0
          ? { warning: 'no_recent_snapshots' }
          : populatedCount < focus.length
          ? { warning: 'partial_coverage' }
          : {}),
      },
      organMetadata: buildOrganMetadata(asOf, status, oldestAsOf),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown_error';
    return emptyResult(startedAt, `exception:${msg}`, 'error');
  }
}

// ---------------------------------------------------------------------------
// ContextHelper instance — default export
// ---------------------------------------------------------------------------

const gexInferenceHelper: ContextHelper<GexInferenceResult> = {
  name: HELPER_NAME,
  version: HELPER_VERSION,
  defaultCap: 10, // 10 watchlist tickers
  isExpensive: true, // 2 queries × 10 tickers = 20 round-trips when uncached
  // Each ingester writes ct_gex_timeseries every ~5 min; 60s freshness covers
  // one tick comfortably without thrash.
  minRefreshSeconds: 60,
  dependencies: [],
  // Same audience scope as flow_butterfly / flow_heatmap — paper_claude stays
  // isolated per the firewall contract (D3).
  audienceFilter: ['cotrader', 'analyst', 'agent_internal'],
  cacheTtlSeconds: 60,

  async fetch(
    ctx: HelperFetchContext,
    opts: HelperOpts,
  ): Promise<HelperResult<GexInferenceResult>> {
    return await getGexInferenceContext(ctx.supabase, ctx.watchlist, opts);
  },

  describe(): HelperDescription {
    return {
      name: HELPER_NAME,
      version: HELPER_VERSION,
      defaultCap: 10,
      expensive: true,
      minRefreshSeconds: 60,
      dependencies: [],
      audienceFilter: ['cotrader', 'analyst', 'agent_internal'],
      outputShape:
        'Per-ticker GEX inference (gamma_flip_strike, call_wall_strike, put_floor_strike, ' +
        'dealer_net_direction, price_vs_flip, top-3 pin_attractor_strikes) computed from the ' +
        'most-recent ct_gex_timeseries ATM-band snapshot. Watchlist aggregate carries ' +
        'consensus_direction + above/below/at-flip counts + median_price_vs_flip_pct.',
      exampleResult: {
        per_ticker: [{
          ticker: 'SPY',
          snapshot_at: '2026-05-09T15:30:00.000Z',
          underlying_price: 737.58,
          gamma_flip_strike: 730.42,
          call_wall_strike: 745,
          put_floor_strike: 720,
          dealer_net_direction: 'positive_gamma',
          dealer_net_total: 1843.21,
          price_vs_flip: 'above',
          pin_attractor_strikes: [
            { strike: 740, magnitude: 502.3, signed_net_gex: 502.3 },
            { strike: 730, magnitude: 412.1, signed_net_gex: -412.1 },
            { strike: 745, magnitude: 388.6, signed_net_gex: 388.6 },
          ],
          atm_strike_count: 31,
        }],
        watchlist: {
          consensus_direction: 'broad_positive_gamma',
          tickers_above_flip: 7,
          tickers_below_flip: 2,
          tickers_at_flip: 0,
          tickers_no_flip: 1,
          median_price_vs_flip_pct: 0.42,
        },
        generated_at: '2026-05-09T15:30:00.000Z',
      } satisfies GexInferenceResult,
    };
  },
};

export default gexInferenceHelper;
