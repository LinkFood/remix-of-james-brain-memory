/**
 * flowButterflyContext — the 11th brain organ.
 *
 * Source: `ct_net_premium_expiry_split(ticker, p_since)` RPC, called per
 * watchlist ticker. Same data path the FlowPulseChart UI reads from. The
 * helper computes per-minute cumsums on signed net premium and detects
 * cum_all_call vs cum_all_put crossings — the captain's strongest read on
 * intraday flow accumulation per the empirical pass at
 * `docs/audits/flow-butterfly-empirical-design-pass.md` (15 RTH days × 10
 * tickers × 434 graded crosses).
 *
 * Per-ticker output captures cross_state, magnitude tertile, session phase,
 * ticker role, and a next_close_signal heuristic grounded in the empirical
 * stratification cells. Watchlist-aggregate output captures consensus + the
 * day's first-cross leader — captures the "QQQ leads slow Mag7" pattern
 * the captain has been reading intuitively.
 *
 * What this organ unlocks: every specialist read going forward sees
 * butterfly state directly. Pre-organ, specialists fired flags blind to
 * the captain's strongest indicator. The empirical pass projects ~10-15pp
 * hit-rate improvement on specialist flag quality once this composes into
 * the brain payload.
 *
 * Not in v1 scope:
 *  - 5min-delta gap (requires holding prior fetch state)
 *  - regime_hold_minutes (derivable, defer)
 *  - cumsum_now snapshot (large payload, marginal value for now)
 *  - hit-rate confidence numbers from a graded corpus (depends on Rank 1
 *    detector + grader cron sequence shipping next)
 *
 * Implements full ContextHelper<T> contract per `contextHelper.ts`. Never
 * throws; defensive-empty on error; telemetry meta + organMetadata
 * populated. Audience-gated to cotrader (initially) — paper_claude stays
 * isolated from operational tape signals per the firewall contract.
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

export type CrossState = 'pre_cross' | 'bull_crossed' | 'bear_crossed';
export type CrossTertile = 'small' | 'mid' | 'large';
export type SessionPhase = 'open_hour' | 'midday' | 'mid_afternoon' | 'close_hour';
export type TickerRole = 'fast_leader' | 'index_carrier' | 'slow_follower' | 'lone_wolf';
export type ConsensusBand = 'strong_bull' | 'strong_bear' | 'mixed' | 'no_signal';

export interface NextCloseSignal {
  direction: 'bullish' | 'bearish';
  confidence: 'high' | 'mid' | 'low';
  /** Human-readable evidence trail rooted in PR #64 § A.3 + § A.4 cells. */
  evidence: string;
}

export interface ButterflyTickerState {
  ticker: string;
  ticker_role: TickerRole;
  cross_state: CrossState;
  /** Latest cross details, null if no cross today yet. */
  last_cross_at: string | null;
  cross_minutes_into_session: number | null;
  cross_magnitude_tertile: CrossTertile | null;
  cross_magnitude_dollars: number | null;
  cross_phase: SessionPhase | null;
  /** Signed gap (cum_all_call - cum_all_put) at the latest data point. */
  gap_now: number;
  /** Empirical NextClose-direction signal per § A.3 / § A.4 stratification. */
  next_close_signal: NextCloseSignal | null;
  /** Sample-count of crosses seen today (helps captain read "noisy day"). */
  cross_count_today: number;
}

export interface ButterflyWatchlistState {
  /** Count of tickers whose latest cross is bullish (or current gap > 0 if no cross). */
  tickers_bullish: number;
  /** Count of tickers whose latest cross is bearish (or current gap < 0 if no cross). */
  tickers_bearish: number;
  /** Count with no cross yet today (pre_cross). */
  tickers_pre_cross: number;
  consensus: ConsensusBand;
  /** First-cross-of-day leader. */
  cross_leader_today: {
    ticker: string;
    minutes_into_session: number;
    direction: 'bullish' | 'bearish';
  } | null;
}

export interface FlowButterflyResult {
  per_ticker: ButterflyTickerState[];
  watchlist: ButterflyWatchlistState;
  generated_at: string;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const HELPER_NAME = 'flow_butterfly';
const HELPER_VERSION = 'v1';

/** Empirical magnitude tertile cutoffs from PR #64 § A.3. */
const TERTILE_MID_CEIL = 164_123;
const TERTILE_LARGE_CEIL = 510_149;

/** RTH bell anchor in UTC minutes (13:30 UTC = 9:30 ET during EDT). */
const RTH_BELL_UTC_MIN = 13 * 60 + 30;

/**
 * Per-ticker role assignment per PR #64 § A.7 first-cross-timing
 * empirical pattern. Static for v1; future Rank 1 grader corpus will
 * re-derive these from rolling 30d data.
 */
const TICKER_ROLE: Record<string, TickerRole> = {
  NVDA: 'fast_leader',
  MSFT: 'fast_leader',
  TSLA: 'fast_leader',
  QQQ: 'index_carrier',
  SPY: 'index_carrier',
  AAPL: 'slow_follower',
  META: 'slow_follower',
  GOOGL: 'slow_follower',
  AMZN: 'slow_follower',
  IWM: 'lone_wolf',
};

const WATCHLIST: readonly string[] = [
  'NVDA', 'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'TSLA',
  'QQQ', 'SPY', 'IWM',
];

interface NetPremiumRow {
  tick_timestamp: string;
  all_net_call: number | null;
  all_net_put: number | null;
  next_net_call: number | null;
  next_net_put: number | null;
}

interface CumPoint {
  ts: string;
  ms: number;
  cum_all_call: number;
  cum_all_put: number;
}

interface DetectedCross {
  ts: string;
  ms: number;
  direction: 'bullish' | 'bearish';
  magnitude: number;
}

function classifyTertile(mag: number): CrossTertile {
  if (mag <= TERTILE_MID_CEIL) return 'small';
  if (mag <= TERTILE_LARGE_CEIL) return 'mid';
  return 'large';
}

function classifyPhase(iso: string): SessionPhase | null {
  const d = new Date(iso);
  const utcMin = d.getUTCHours() * 60 + d.getUTCMinutes();
  const sinceBell = utcMin - RTH_BELL_UTC_MIN;
  if (sinceBell < 0) return null;
  if (sinceBell < 60) return 'open_hour';
  if (sinceBell < 240) return 'midday';
  if (sinceBell < 330) return 'mid_afternoon';
  if (sinceBell < 390) return 'close_hour';
  return null;
}

function minutesIntoSession(iso: string): number | null {
  const ph = classifyPhase(iso);
  if (ph === null) return null;
  const d = new Date(iso);
  const utcMin = d.getUTCHours() * 60 + d.getUTCMinutes();
  return utcMin - RTH_BELL_UTC_MIN;
}

function isPreMarket(iso: string): boolean {
  return classifyPhase(iso) === null && new Date(iso).getUTCHours() < 13;
}

function buildCumsum(rows: readonly NetPremiumRow[]): CumPoint[] {
  if (rows.length === 0) return [];
  // Group by tick_timestamp (defensive — some RPCs return per-ticker rows
  // that need aggregation; the org-wide split RPC is already pre-aggregated).
  const byTs = new Map<string, { ac: number; ap: number }>();
  for (const r of rows) {
    if (isPreMarket(r.tick_timestamp)) continue;
    const ac = Number.isFinite(r.all_net_call) ? Number(r.all_net_call) : 0;
    const ap = Number.isFinite(r.all_net_put) ? Number(r.all_net_put) : 0;
    const cur = byTs.get(r.tick_timestamp);
    if (cur) {
      cur.ac += ac;
      cur.ap += ap;
    } else {
      byTs.set(r.tick_timestamp, { ac, ap });
    }
  }
  const sorted = Array.from(byTs.entries()).sort(
    (a, b) => Date.parse(a[0]) - Date.parse(b[0]),
  );
  const out: CumPoint[] = [];
  let cumCall = 0;
  let cumPut = 0;
  for (const [ts, v] of sorted) {
    cumCall += v.ac;
    cumPut += v.ap;
    out.push({ ts, ms: Date.parse(ts), cum_all_call: cumCall, cum_all_put: cumPut });
  }
  return out;
}

function detectCrosses(points: readonly CumPoint[]): DetectedCross[] {
  if (points.length < 2) return [];
  const out: DetectedCross[] = [];
  let prevDiff = points[0].cum_all_call - points[0].cum_all_put;
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    const diff = p.cum_all_call - p.cum_all_put;
    const flipped = (prevDiff <= 0 && diff > 0) || (prevDiff >= 0 && diff < 0);
    const bothZero = prevDiff === 0 && diff === 0;
    if (flipped && !bothZero) {
      out.push({
        ts: p.ts,
        ms: p.ms,
        direction: diff > 0 ? 'bullish' : 'bearish',
        magnitude: Math.abs(diff),
      });
    }
    prevDiff = diff;
  }
  return out;
}

/**
 * Compose the next_close_signal heuristic per PR #64 § A.3 + § A.4
 * stratification cells. Returns null for noise (small magnitude); otherwise
 * grounds direction + confidence in the empirical hit rate of the matched
 * cell.
 */
function nextCloseSignalFor(
  cross: DetectedCross,
  tertile: CrossTertile,
  phase: SessionPhase | null,
): NextCloseSignal | null {
  if (tertile === 'small') return null;
  // Large bearish → strong contrarian buy (77.8% reverse-hit, n=72).
  if (tertile === 'large' && cross.direction === 'bearish') {
    return {
      direction: 'bullish',
      confidence: 'high',
      evidence: 'large-magnitude bearish cross — historically 77.8% NextClose reverse-hit (contrarian buy, n=72 per PR #64 § A.3)',
    };
  }
  // Mid bullish midday → highest-confidence cell (71.9% hit, n=66).
  if (tertile === 'mid' && cross.direction === 'bullish' && phase === 'midday') {
    return {
      direction: 'bullish',
      confidence: 'high',
      evidence: 'midday mid-magnitude bullish cross — historically 71.9% NextClose hit (n=66 per PR #64 § A.4)',
    };
  }
  // Midday bearish (mid or large) → strong contrarian (69.2% reverse-hit).
  if (cross.direction === 'bearish' && phase === 'midday') {
    return {
      direction: 'bullish',
      confidence: 'mid',
      evidence: 'midday bearish cross — historically 69.2% NextClose reverse-hit (contrarian, n=91 per PR #64 § A.4)',
    };
  }
  // General bullish (any phase, mid or large) → 63% directional.
  if (cross.direction === 'bullish') {
    return {
      direction: 'bullish',
      confidence: 'mid',
      evidence: 'bullish cross — historically 63% NextClose hit (directional, n=200 per PR #64 § A.2)',
    };
  }
  // General bearish (mid or large, non-midday) → 63% reverse-hit.
  return {
    direction: 'bullish',
    confidence: 'low',
    evidence: 'bearish cross — historically 63% NextClose reverse-hit (weak contrarian, n=207 per PR #64 § A.2)',
  };
}

function tickerRoleFor(ticker: string): TickerRole {
  return TICKER_ROLE[ticker] ?? 'lone_wolf';
}

async function fetchNetPremium(
  supabase: SupabaseClient,
  ticker: string,
  sinceMs: number,
): Promise<NetPremiumRow[]> {
  // ct_net_premium_expiry_split RPC: same source the FlowPulseChart UI uses.
  // p_since accepts an ISO timestamp; we anchor at session-bell ms.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb: any = supabase;
  const { data, error } = await sb.rpc('ct_net_premium_expiry_split', {
    p_ticker: ticker,
    p_since: new Date(sinceMs).toISOString(),
  });
  if (error || !Array.isArray(data)) return [];
  return data as NetPremiumRow[];
}

function todayBellMs(sessionDate: string): number {
  // sessionDate is YYYY-MM-DD (NY-tz). RTH bell = 13:30 UTC during EDT;
  // approximate as 13:30 UTC year-round — pre-market data is filtered out
  // anyway by the cumsum builder.
  return Date.parse(`${sessionDate}T13:30:00Z`);
}

function buildOrganMetadata(asOf: string, status: OrganStatus): OrganMetadata {
  return {
    as_of: asOf,
    source: '_shared/flowButterflyContext.ts / ct_net_premium_expiry_split RPC',
    window: 'session_open_to_now (per-minute cumsum + cross detection)',
    status,
  };
}

async function buildPerTickerState(
  supabase: SupabaseClient,
  ticker: string,
  sinceMs: number,
): Promise<ButterflyTickerState> {
  const role = tickerRoleFor(ticker);
  const rows = await fetchNetPremium(supabase, ticker, sinceMs);
  const cum = buildCumsum(rows);
  const crosses = detectCrosses(cum);

  if (cum.length === 0) {
    return {
      ticker,
      ticker_role: role,
      cross_state: 'pre_cross',
      last_cross_at: null,
      cross_minutes_into_session: null,
      cross_magnitude_tertile: null,
      cross_magnitude_dollars: null,
      cross_phase: null,
      gap_now: 0,
      next_close_signal: null,
      cross_count_today: 0,
    };
  }

  const last = cum[cum.length - 1];
  const gapNow = last.cum_all_call - last.cum_all_put;

  if (crosses.length === 0) {
    return {
      ticker,
      ticker_role: role,
      cross_state: 'pre_cross',
      last_cross_at: null,
      cross_minutes_into_session: null,
      cross_magnitude_tertile: null,
      cross_magnitude_dollars: null,
      cross_phase: null,
      gap_now: gapNow,
      next_close_signal: null,
      cross_count_today: 0,
    };
  }

  const latest = crosses[crosses.length - 1];
  const tertile = classifyTertile(latest.magnitude);
  const phase = classifyPhase(latest.ts);
  return {
    ticker,
    ticker_role: role,
    cross_state: latest.direction === 'bullish' ? 'bull_crossed' : 'bear_crossed',
    last_cross_at: latest.ts,
    cross_minutes_into_session: minutesIntoSession(latest.ts),
    cross_magnitude_tertile: tertile,
    cross_magnitude_dollars: latest.magnitude,
    cross_phase: phase,
    gap_now: gapNow,
    next_close_signal: nextCloseSignalFor(latest, tertile, phase),
    cross_count_today: crosses.length,
  };
}

function buildWatchlistState(
  perTicker: readonly ButterflyTickerState[],
): ButterflyWatchlistState {
  let bull = 0;
  let bear = 0;
  let preCross = 0;
  for (const t of perTicker) {
    if (t.cross_state === 'bull_crossed') bull += 1;
    else if (t.cross_state === 'bear_crossed') bear += 1;
    else preCross += 1;
  }

  let consensus: ConsensusBand = 'mixed';
  const fired = bull + bear;
  if (fired === 0) consensus = 'no_signal';
  else if (bull >= 7) consensus = 'strong_bull';
  else if (bear >= 7) consensus = 'strong_bear';

  // First-cross leader: among tickers with a cross today, the one with the
  // earliest cross_minutes_into_session.
  let leader: ButterflyWatchlistState['cross_leader_today'] = null;
  for (const t of perTicker) {
    if (t.cross_minutes_into_session == null || t.cross_state === 'pre_cross') continue;
    if (leader == null || t.cross_minutes_into_session < leader.minutes_into_session) {
      leader = {
        ticker: t.ticker,
        minutes_into_session: t.cross_minutes_into_session,
        direction: t.cross_state === 'bull_crossed' ? 'bullish' : 'bearish',
      };
    }
  }

  return {
    tickers_bullish: bull,
    tickers_bearish: bear,
    tickers_pre_cross: preCross,
    consensus,
    cross_leader_today: leader,
  };
}

function emptyResult(
  startedAt: number,
  warning?: string,
  status: OrganStatus = 'no_signal_detected',
): HelperResult<FlowButterflyResult> {
  const asOf = new Date().toISOString();
  return {
    data: {
      per_ticker: [],
      watchlist: {
        tickers_bullish: 0,
        tickers_bearish: 0,
        tickers_pre_cross: 0,
        consensus: 'no_signal',
        cross_leader_today: null,
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
    organMetadata: buildOrganMetadata(asOf, status),
  };
}

// ---------------------------------------------------------------------------
// Convenience function — caller-friendly wrapper
// ---------------------------------------------------------------------------

export async function getFlowButterflyContext(
  supabase: SupabaseClient,
  sessionDate: string,
  opts: HelperOpts = {},
): Promise<HelperResult<FlowButterflyResult>> {
  const startedAt = Date.now();
  const focus = typeof opts.tickerFocus === 'string' && opts.tickerFocus.length > 0
    ? [opts.tickerFocus]
    : WATCHLIST;
  const sinceMs = todayBellMs(sessionDate);

  try {
    const perTicker = await Promise.all(
      focus.map((ticker) => buildPerTickerState(supabase, ticker, sinceMs)),
    );
    const watchlist = buildWatchlistState(perTicker);
    const asOf = new Date().toISOString();
    const populated = perTicker.some((t) => t.cross_state !== 'pre_cross' || t.gap_now !== 0);

    return {
      data: { per_ticker: perTicker, watchlist, generated_at: asOf },
      meta: {
        helperName: HELPER_NAME,
        helperVersion: HELPER_VERSION,
        fetchedAt: asOf,
        rowCount: perTicker.length,
        cacheHit: false,
        latencyMs: Date.now() - startedAt,
        truncated: false,
      },
      organMetadata: buildOrganMetadata(
        asOf,
        populated ? 'populated' : 'no_signal_detected',
      ),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown_error';
    return emptyResult(startedAt, `exception:${msg}`, 'error');
  }
}

// ---------------------------------------------------------------------------
// ContextHelper instance — default export
// ---------------------------------------------------------------------------

const flowButterflyHelper: ContextHelper<FlowButterflyResult> = {
  name: HELPER_NAME,
  version: HELPER_VERSION,
  defaultCap: 10, // 10 tickers in the watchlist
  isExpensive: true, // 10 RPC calls in parallel; cache-friendly but real cost
  // Cumsum + cross detection on per-minute data; 60s freshness covers one
  // ingester tick reliably without hammering the RPC.
  minRefreshSeconds: 60,
  dependencies: [],
  // Audience-gated to cotrader (initially) — paper_claude stays isolated
  // from operational tape signals per the firewall contract.
  audienceFilter: ['cotrader', 'analyst', 'agent_internal'],

  async fetch(
    ctx: HelperFetchContext,
    opts: HelperOpts,
  ): Promise<HelperResult<FlowButterflyResult>> {
    return await getFlowButterflyContext(ctx.supabase, ctx.sessionDate, opts);
  },

  describe(): HelperDescription {
    return {
      name: HELPER_NAME,
      version: HELPER_VERSION,
      defaultCap: 10,
      expensive: true,
      minRefreshSeconds: 60,
      dependencies: [],
      outputShape:
        'Per-ticker butterfly state (cross_state, magnitude tertile, session phase, ticker role, next_close_signal heuristic) + watchlist consensus + first-cross leader.',
      exampleResult: {
        per_ticker: [{
          ticker: 'NVDA',
          ticker_role: 'fast_leader',
          cross_state: 'bull_crossed',
          last_cross_at: '2026-05-08T14:42:00.000Z',
          cross_minutes_into_session: 72,
          cross_magnitude_tertile: 'mid',
          cross_magnitude_dollars: 320_500,
          cross_phase: 'midday',
          gap_now: 412_000,
          next_close_signal: {
            direction: 'bullish',
            confidence: 'high',
            evidence: 'midday mid-magnitude bullish cross — historically 71.9% NextClose hit (n=66 per PR #64 § A.4)',
          },
          cross_count_today: 2,
        }],
        watchlist: {
          tickers_bullish: 7,
          tickers_bearish: 2,
          tickers_pre_cross: 1,
          consensus: 'strong_bull',
          cross_leader_today: { ticker: 'NVDA', minutes_into_session: 18, direction: 'bullish' },
        },
        generated_at: '2026-05-08T15:30:00.000Z',
      },
    };
  },
};

export default flowButterflyHelper;
