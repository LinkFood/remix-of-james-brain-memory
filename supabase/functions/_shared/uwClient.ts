/**
 * Unusual Whales API client
 *
 * Thin wrapper over the UW REST API. Paths below are VERIFIED against the live
 * OpenAPI spec at https://api.unusualwhales.com/api/openapi on 2026-04-18.
 *
 * Drift detection: `ct-uw-endpoint-health-check` runs daily at 05:00 UTC and
 * writes to `ct_uw_endpoint_health`. Any 4xx on a wrapper flips it to
 * 'degraded'/'broken' and surfaces in /preflight — so the next time UW renames
 * a path, we learn from telemetry instead of a silent trade-side outage.
 *
 * Mandatory headers (per SKILL.md):
 *   Authorization: Bearer <UW_API_KEY>
 *   UW-CLIENT-API-ID: 100001
 *
 * Retry policy: never retry 4xx (per CLAUDE.md gotcha). 5xx + network errors
 * retried with exponential backoff.
 *
 * Rate limit: 120 req/min on API Basic. Bulk helpers respect that.
 *
 * PHASE 2 TODO: migrate from this hand-rolled HTTP client to the UW official
 * MCP server (`@unusualwhales/mcp`). Eliminates the endpoint-maintenance loop
 * entirely — per CO-TRADER THESIS tenet 12 ("Duplicate nothing UW maintains").
 */

const UW_BASE_URL = 'https://api.unusualwhales.com';
const UW_CLIENT_API_ID = '100001';
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;

function getApiKey(): string {
  const key = Deno.env.get('UW_API_KEY');
  if (!key) throw new Error('UW_API_KEY not configured in Supabase secrets');
  return key;
}

function headers(): Record<string, string> {
  return {
    'Authorization': `Bearer ${getApiKey()}`,
    'UW-CLIENT-API-ID': UW_CLIENT_API_ID,
    'Accept': 'application/json',
    'User-Agent': 'co-trader/1.0 (linkjac.cloud)',
  };
}

export class UwError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'UwError';
    this.status = status;
  }
}

/**
 * Record a single UW response's rate-limit headers to ct_uw_usage.
 * Fire-and-forget — never blocks the UW call or throws.
 *
 * Captures all 5 UW rate-limit headers:
 *   x-uw-daily-req-count          → daily_count
 *   x-uw-token-req-limit          → daily_limit
 *   x-uw-minute-req-counter       → minute_counter
 *   x-uw-req-per-minute-remaining → minute_remaining
 *   x-uw-req-per-minute-reset     → minute_reset_at (unix seconds or iso)
 */
type UwUsageRow = {
  endpoint: string;
  daily_count: number | null;
  daily_limit: number | null;
  minute_counter: number | null;
  minute_remaining: number | null;
  minute_reset_at: string | null;
  status: number;
  ms: number;
  caller: string | null;
};
let _uwUsageBuffer: UwUsageRow[] = [];
let _uwUsageFlushPending = false;

function parseMinuteReset(v: string | null): string | null {
  if (!v) return null;
  const n = Number(v);
  if (Number.isFinite(n)) {
    // UW sends unix seconds; if it's large enough to be ms, treat as ms.
    const ms = n > 1e12 ? n : n * 1000;
    return new Date(ms).toISOString();
  }
  // Maybe already ISO.
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function headerNum(res: Response, key: string): number | null {
  const raw = res.headers.get(key);
  if (raw === null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function recordUwUsage(path: string, res: Response, ms: number): void {
  const daily_count = headerNum(res, 'x-uw-daily-req-count');
  const daily_limit = headerNum(res, 'x-uw-token-req-limit');
  // UW currently only sends the 2 daily headers on REST responses; minute-level
  // headers may appear later. Skip recording rows that carry no rate signal
  // at all — those pollute ct_uw_usage_latest and poison budget decisions.
  if (daily_count === null && daily_limit === null) return;
  _uwUsageBuffer.push({
    endpoint: path,
    daily_count,
    daily_limit,
    minute_counter: headerNum(res, 'x-uw-minute-req-counter'),
    minute_remaining: headerNum(res, 'x-uw-req-per-minute-remaining'),
    minute_reset_at: parseMinuteReset(res.headers.get('x-uw-req-per-minute-reset')),
    status: res.status,
    ms,
    caller: _callerTag,
  });
  if (!_uwUsageFlushPending) {
    _uwUsageFlushPending = true;
    setTimeout(flushUwUsage, 500);
  }
}

/**
 * Opt-in caller tag. Edge functions call `setUwCaller("ct-flow-ingester")`
 * at startup and every recorded usage row gets attributed to them. Safe to
 * leave unset — caller defaults to null.
 */
let _callerTag: string | null = null;
export function setUwCaller(tag: string): void {
  _callerTag = tag.slice(0, 64);
}

async function flushUwUsage(): Promise<void> {
  const rows = _uwUsageBuffer;
  _uwUsageBuffer = [];
  _uwUsageFlushPending = false;
  if (rows.length === 0) return;
  try {
    const url = Deno.env.get('SUPABASE_URL');
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !key) return;
    await fetch(`${url}/rest/v1/ct_uw_usage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': key,
        'Authorization': `Bearer ${key}`,
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify(rows),
    });
  } catch { /* swallow */ }
}

/**
 * Non-critical callers can check UW's budget before firing a cycle.
 * Returns true unless we're ≥95% of daily limit OR minute_remaining <10.
 * Reads ct_uw_budget_ok() RPC — empty cache returns true (fail-open).
 *
 * Specialists + grader should NOT call this. Backfills, screener sweeps,
 * endpoint health probes, and other expendable traffic SHOULD.
 */
export async function uwBudgetOk(opts: { dailyThreshold?: number; minuteFloor?: number } = {}): Promise<boolean> {
  try {
    const url = Deno.env.get('SUPABASE_URL');
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !key) return true;
    const res = await fetch(`${url}/rest/v1/rpc/ct_uw_budget_ok`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': key,
        'Authorization': `Bearer ${key}`,
      },
      body: JSON.stringify({
        daily_threshold: opts.dailyThreshold ?? 0.95,
        minute_floor: opts.minuteFloor ?? 10,
      }),
    });
    if (!res.ok) return true;
    const raw = await res.json();
    return raw === true || raw === 'true';
  } catch {
    return true;
  }
}

/**
 * GET with retry on 5xx only.
 */
async function uwGet<T = unknown>(
  path: string,
  params?: Record<string, string | number | boolean | Array<string | number> | undefined>
): Promise<T> {
  const url = new URL(UW_BASE_URL + path);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) {
        for (const item of v) url.searchParams.append(k, String(item));
      } else {
        url.searchParams.set(k, String(v));
      }
    }
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const startMs = Date.now();
    const res = await fetch(url.toString(), { method: 'GET', headers: headers() });
    // Fire-and-forget usage snapshot. Don't block the request on this.
    try { recordUwUsage(path, res, Date.now() - startMs); } catch { /* ignore */ }

    if (res.ok) {
      return (await res.json()) as T;
    }

    const errorText = await res.text().catch(() => '');

    // 4xx — never retry
    if (res.status < 500) {
      console.error(`[uwClient] ${path} → ${res.status}: ${errorText.slice(0, 300)}`);
      throw new UwError(`UW ${res.status} on ${path}: ${errorText.slice(0, 120)}`, res.status);
    }

    // 5xx — retry with exponential backoff
    if (attempt < MAX_RETRIES) {
      const delay = BASE_DELAY_MS * Math.pow(2, attempt);
      console.warn(`[uwClient] ${path} → ${res.status}, retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
      continue;
    }

    throw new UwError(`UW ${res.status} on ${path} after ${MAX_RETRIES + 1} attempts`, res.status);
  }

  throw new UwError(`UW request failed: unknown error on ${path}`, 500);
}

// ============================================================================
// Flow & Market-wide
// ============================================================================

/** Unusual options flow alerts (market-wide, filter by ticker via param).
 *  REST supports `older_than` cursor pagination (ISO timestamp) — the MCP
 *  equivalent does not. `newer_than` is silently clamped to UW's ~24-day
 *  rolling retention; enforce the real lower bound client-side. */
export function getFlowAlerts(params: {
  ticker_symbol?: string;
  limit?: number;
  is_call?: boolean;
  is_put?: boolean;
  is_otm?: boolean;
  min_premium?: number;
  size_greater_oi?: boolean;
  older_than?: string;
  newer_than?: string;
} = {}): Promise<unknown> {
  return uwGet('/api/option-trades/flow-alerts', params);
}

/** Options screener / hottest chains */
export function getOptionScreener(params: {
  limit?: number;
  min_premium?: number;
  type?: 'Calls' | 'Puts';
  is_otm?: boolean;
  min_volume?: number;
  min_volume_oi_ratio?: number;
  min_sweep_volume_ratio?: number;
  vol_greater_oi?: boolean;
  max_dte?: number;
  'issue_types[]'?: string[];
} = {}): Promise<unknown> {
  return uwGet('/api/screener/option-contracts', params);
}

/** Recent flow for a specific ticker */
export function getRecentFlowForTicker(ticker: string): Promise<unknown> {
  return uwGet(`/api/stock/${ticker}/flow-recent`);
}

/** Market Tide — net call/put premium, sentiment */
export function getMarketTide(params: { interval_5m?: boolean } = {}): Promise<unknown> {
  return uwGet('/api/market/market-tide', params);
}

/** Per-ticker net premium ticks (intraday sentiment) */
export function getNetPremiumTicks(ticker: string): Promise<unknown> {
  return uwGet(`/api/stock/${ticker}/net-prem-ticks`);
}

/** NOPE — Net Options Pricing Effect per minute. Regime classifier. */
export function getNope(ticker: string): Promise<unknown> {
  return uwGet(`/api/stock/${ticker}/nope`);
}

/** Per-minute dealer delta/vega hedging flow */
export function getGreekFlow(ticker: string): Promise<unknown> {
  return uwGet(`/api/stock/${ticker}/greek-flow`);
}

/** Max pain across all expiries */
export function getMaxPain(ticker: string): Promise<unknown> {
  return uwGet(`/api/stock/${ticker}/max-pain`);
}

/** Top bullish/bearish tickers market-wide by net premium */
export function getTopNetImpact(): Promise<unknown> {
  return uwGet('/api/market/top-net-impact');
}

/**
 * Canonical unusual-sweep screener. Filters hardcoded for retail "flow":
 * sweep volume ratio ≥0.7, vol > OI, minimum $100K premium.
 */
export function getSweepScreener(limit = 50): Promise<unknown> {
  return getOptionScreener({
    limit,
    min_premium: 100_000,
    min_sweep_volume_ratio: 0.7,
    vol_greater_oi: true,
    is_otm: true,
  });
}

/** IV rank time series */
export function getIvRank(ticker: string): Promise<unknown> {
  return uwGet(`/api/stock/${ticker}/iv-rank`);
}

// ============================================================================
// Dark Pool
// ============================================================================

/** Dark pool prints per ticker */
export function getDarkPool(ticker: string): Promise<unknown> {
  return uwGet(`/api/darkpool/${ticker}`);
}

/** Recent market-wide dark pool prints */
export function getDarkPoolRecent(): Promise<unknown> {
  return uwGet('/api/darkpool/recent');
}

// ============================================================================
// Options, Greeks, GEX
// ============================================================================

/** Option contracts list and details */
export function getOptionContracts(ticker: string): Promise<unknown> {
  return uwGet(`/api/stock/${ticker}/option-contracts`);
}

/** Greeks per strike + expiry */
export function getGreeks(ticker: string): Promise<unknown> {
  return uwGet(`/api/stock/${ticker}/greeks`);
}

/** "Static" GEX by strike — OI-weighted gamma exposure */
export function getStaticGexByStrike(ticker: string): Promise<unknown> {
  return uwGet(`/api/stock/${ticker}/greek-exposure/strike`);
}

/**
 * Spot GEX by strike — THE key endpoint for live dealer positioning.
 * Returns call wall, put wall, gamma flip, zero gamma via the strike-level
 * gamma distribution. Used by memory recall + command station SPX banner.
 */
export function getSpotGexByStrike(ticker: string): Promise<unknown> {
  return uwGet(`/api/stock/${ticker}/spot-exposures/strike`);
}

/** Interpolated IV + percentiles */
export function getInterpolatedIV(ticker: string): Promise<unknown> {
  return uwGet(`/api/stock/${ticker}/interpolated-iv`);
}

/** Options volume + put/call ratio */
export function getOptionsVolume(ticker: string): Promise<unknown> {
  return uwGet(`/api/stock/${ticker}/options-volume`);
}

// ============================================================================
// Event Calendars
// ============================================================================

/** Post-market earnings announcements */
export function getEarningsAfterhours(): Promise<unknown> {
  return uwGet('/api/earnings/afterhours');
}

/** Pre-market earnings announcements */
export function getEarningsPremarket(): Promise<unknown> {
  return uwGet('/api/earnings/premarket');
}

/** FDA calendar — drug approvals, PDUFA dates, etc. */
export function getFdaCalendar(): Promise<unknown> {
  return uwGet('/api/market/fda-calendar');
}

/** Economic calendar — CPI, FOMC, jobs, etc. */
export function getEconomicCalendar(): Promise<unknown> {
  return uwGet('/api/market/economic-calendar');
}

// ============================================================================
// News, Insider, Congress
// ============================================================================

/** News headlines (optionally filtered by ticker) */
export function getNewsHeadlines(params: { limit?: number; ticker?: string } = {}): Promise<unknown> {
  return uwGet('/api/news/headlines', params);
}

/** Insider transactions */
export function getInsiderTransactions(): Promise<unknown> {
  return uwGet('/api/insider/transactions');
}

/** Politician / congress trades */
export function getCongressTrades(): Promise<unknown> {
  return uwGet('/api/congress/recent-trades');
}

/**
 * Analyst rating changes (verified path 2026-04-18: `/api/screener/analysts`).
 * OpenAPI: PublicApi.ScreenerController.analyst_ratings.
 *
 * Response row fields: { action, analyst_name, firm, recommendation, sector,
 * target, ticker, timestamp }.
 *
 * `action` param enum is not documented — UW accepts `recommendation` as a
 * filter (buy/hold/sell) but not a free-form action. We pull unfiltered and
 * classify in-memory.
 */
export function getAnalystRatings(params: {
  limit?: number;
  ticker?: string;
  recommendation?: 'buy' | 'hold' | 'sell';
} = {}): Promise<unknown> {
  return uwGet('/api/screener/analysts', params);
}

/**
 * Short interest vs float (bi-monthly settlement + days-to-cover).
 * Verified path 2026-04-18: `/api/shorts/{ticker}/interest-float/v2`.
 * OpenAPI: PublicApi.ShortController.short_interest_and_float_v2.
 *
 * Response fields: { short_interest, si_float, days_to_cover, market_date,
 * total_float, short_shares_available, fee_rate, rebate_rate, symbol }.
 * The payload returns a single object in `data` (not an array).
 */
export function getShortInterestFloat(ticker: string): Promise<unknown> {
  return uwGet(`/api/shorts/${ticker}/interest-float/v2`);
}

/**
 * Short volume + ratio time series. Verified path 2026-04-18:
 * `/api/shorts/{ticker}/volume-and-ratio`.
 * OpenAPI: PublicApi.ShortController.short_volume_and_ratio.
 *
 * Response row fields: { market_date, short_volume, short_volume_ratio,
 * total_volume, close_price }. Daily observations, most recent last.
 */
export function getShortVolumeRatio(ticker: string): Promise<unknown> {
  return uwGet(`/api/shorts/${ticker}/volume-and-ratio`);
}

/**
 * The 11 UW sectors (from `Single sector` schema). Used by getSectorTide()
 * to loop — UW's sector-tide is per-sector, not market-wide.
 */
export const UW_SECTORS = [
  'Basic Materials',
  'Communication Services',
  'Consumer Cyclical',
  'Consumer Defensive',
  'Energy',
  'Financial Services',
  'Healthcare',
  'Industrials',
  'Real Estate',
  'Technology',
  'Utilities',
] as const;
export type UwSector = typeof UW_SECTORS[number];

/**
 * Sector tide for one sector. Verified path 2026-04-18:
 * `/api/market/{sector}/sector-tide`.
 * OpenAPI: PublicApi.MarketController.sec_indst.
 *
 * Returns `Daily Market Tide` shape: time series of rows with
 * net_call_premium, net_put_premium, timestamp.
 *
 * Optional `date` param for historical snapshot.
 */
export function getSectorTideForSector(sector: UwSector, date?: string): Promise<unknown> {
  return uwGet(`/api/market/${encodeURIComponent(sector)}/sector-tide`, date ? { date } : undefined);
}

/**
 * Pulls sector tide for all 11 UW sectors sequentially. 11 requests. Replaces
 * the market-wide `/api/market/sector-tide` which does NOT exist in UW's API —
 * sector-tide is always per-sector.
 *
 * Returns { sector: raw[] } map plus a flat errors list. Partial failure is
 * tolerated — one bad sector does not crash the batch.
 */
export async function getSectorTide(): Promise<{
  per_sector: Record<string, unknown>;
  errors: Array<{ sector: string; error: string }>;
}> {
  const per_sector: Record<string, unknown> = {};
  const errors: Array<{ sector: string; error: string }> = [];
  for (const sector of UW_SECTORS) {
    try {
      per_sector[sector] = await getSectorTideForSector(sector);
    } catch (e) {
      errors.push({ sector, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { per_sector, errors };
}

/**
 * Risk-reversal skew (25-delta call IV minus 25-delta put IV, per expiry).
 * Pre-earnings / pre-event vol edge — divergent skew = crowded directional
 * positioning.
 */
export function getRiskReversalSkew(ticker: string): Promise<unknown> {
  return uwGet(`/api/stock/${ticker}/historical-risk-reversal-skew`);
}

// ============================================================================
// Financials
// ============================================================================

export function getFinancials(ticker: string): Promise<unknown> {
  return uwGet(`/api/stock/${ticker}/financials`);
}

export function getIncomeStatements(ticker: string, report_type?: string): Promise<unknown> {
  return uwGet(`/api/stock/${ticker}/income-statements`, report_type ? { report_type } : undefined);
}

export function getBalanceSheets(ticker: string, report_type?: string): Promise<unknown> {
  return uwGet(`/api/stock/${ticker}/balance-sheets`, report_type ? { report_type } : undefined);
}

export function getCashFlows(ticker: string, report_type?: string): Promise<unknown> {
  return uwGet(`/api/stock/${ticker}/cash-flows`, report_type ? { report_type } : undefined);
}

export function getEarnings(ticker: string, report_type?: string): Promise<unknown> {
  return uwGet(`/api/stock/${ticker}/earnings`, report_type ? { report_type } : undefined);
}

// ============================================================================
// Technical Indicators
// ============================================================================

/**
 * Technical indicator series. Verified path 2026-04-18:
 * `/api/stock/{ticker}/technical-indicator/{function}`.
 * OpenAPI: PublicApi.AvFundamentalController.technical_indicator.
 *
 * IMPORTANT:
 *  - `fn` MUST be UPPERCASE (RSI, SMA, MACD, BBANDS, VWAP, ATR, ...).
 *    Lowercase returns 422.
 *  - `interval` enum: 1min | 5min | 15min | 30min | 60min | daily | weekly |
 *    monthly. NOT `5m` — that's an AlphaVantage-style shorthand that 422s.
 *  - `month` (YYYY-MM) only matters for intraday intervals.
 *
 * Supported functions (per spec): SMA, EMA, WMA, DEMA, TEMA, TRIMA, KAMA, MAMA,
 * T3, MACD, MACDEXT, STOCH, STOCHF, RSI, STOCHRSI, WILLR, ADX, ADXR, APO, PPO,
 * MOM, BOP, CCI, CMO, ROC, ROCR, AROON, AROONOSC, MFI, TRIX, ULTOSC, DX,
 * MINUS_DI, PLUS_DI, MINUS_DM, PLUS_DM, BBANDS, MIDPOINT, MIDPRICE, SAR,
 * TRANGE, ATR, NATR, AD, ADOSC, OBV, HT_TRENDLINE, HT_SINE, HT_TRENDMODE,
 * HT_DCPERIOD, HT_DCPHASE, HT_PHASOR, VWAP.
 */
export type TechnicalInterval = '1min' | '5min' | '15min' | '30min' | '60min' | 'daily' | 'weekly' | 'monthly';
export function getTechnicalIndicator(
  ticker: string,
  fn: string,
  params: { interval?: TechnicalInterval; time_period?: number; series_type?: 'close' | 'open' | 'high' | 'low'; month?: string } = {}
): Promise<unknown> {
  return uwGet(`/api/stock/${ticker}/technical-indicator/${fn.toUpperCase()}`, params);
}

// ============================================================================
// Watchlist bulk helper
// ============================================================================

/**
 * The 10-instrument per-ticker watchlist (v2).
 *
 * Options-flow-rich names only. GLD/USO/ES removed in Co-Trader v2 scrub —
 * day trader wants names with liquid options flow for specialist model.
 * ES futures not included — UW doesn't cover futures. Macro S&P read is
 * handled separately via SPX for the market banner.
 */
export const WATCHLIST = [
  // Indexes
  'SPY', 'QQQ', 'IWM',
  // Mag 7
  'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'TSLA',
] as const;

/** SPX used for the macro GEX banner. NOT in per-ticker loop. */
export const MARKET_BANNER_SYMBOL = 'SPX';

export type WatchlistTicker = typeof WATCHLIST[number];

// ============================================================================
// VIX — volatility index
// ============================================================================

/**
 * VIX spot read with ETF fallback.
 *
 * UW is options-centric and does not guarantee VIX (the CBOE index itself) is
 * queryable via the standard stock endpoints — VIX options trade on VIX
 * futures, not on the index, so spot-exposures may return empty. We try VIX
 * first (cheap if it works), then fall back to VIXY (1x short-term VIX ETF,
 * imperfect proxy but always available).
 *
 * Returns null if BOTH calls fail — watcher treats null as "VIX unavailable"
 * and the _snapshot.vix field is omitted, not crashed.
 *
 * 1 additional UW call per watcher tick (2 only on fallback). At 120 req/min
 * we have headroom.
 */
export async function getVixSpot(): Promise<{
  level: number;
  source: 'VIX' | 'VIXY';
  endpoint: string;
} | null> {
  // Attempt 1: VIX direct. Use spot-exposures — it returns `price` at the top
  // of the payload even when strike data is thin.
  try {
    const raw = await getSpotGexByStrike('VIX');
    const level = extractSpotPrice(raw);
    if (level !== null && level > 0) {
      return { level, source: 'VIX', endpoint: 'spot-exposures/strike' };
    }
  } catch {
    // fall through — UW may 4xx on VIX (no options chain under this path)
  }

  // Attempt 2: VIXY ETF fallback. Actual VIX level ≠ VIXY price, but VIXY's
  // % change tracks short-term VIX futures; caller treats the proxy level as
  // an advisory-only scalar and relies on change_pct for the real signal.
  try {
    const raw = await getSpotGexByStrike('VIXY');
    const level = extractSpotPrice(raw);
    if (level !== null && level > 0) {
      return { level, source: 'VIXY', endpoint: 'spot-exposures/strike' };
    }
  } catch {
    // fall through
  }

  return null;
}

/** Dig the underlying price out of a spot-exposures payload. Defensive. */
function extractSpotPrice(raw: unknown): number | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const candidates = ['price', 'spot', 'underlying_price', 'last_price', 'close'];
  for (const k of candidates) {
    const v = r[k];
    if (v === undefined || v === null) continue;
    const n = typeof v === 'number' ? v : Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const data = (r as { data?: unknown }).data;
  if (Array.isArray(data) && data.length > 0) {
    const first = data[0] as Record<string, unknown>;
    for (const k of candidates) {
      const v = first[k];
      if (v === undefined || v === null) continue;
      const n = typeof v === 'number' ? v : Number(v);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return extractSpotPrice(data);
  }
  return null;
}

/**
 * Pull a full watcher-cycle state bundle.
 *
 * Per ticker, three calls:
 *  - spot-exposures/strike — real-time dealer positioning, has underlying price
 *    (used for price + spot totals; strike coverage is narrow, not used for walls)
 *  - greek-exposure/strike — static GEX across 100+ strikes (used for wall
 *    detection since spot-exposures often clips to ~50 sub-ATM strikes)
 *  - options-volume — P/C ratio, volume
 *
 * Macro: SPX spot + greek exposure, market tide.
 *
 * 3 calls × 12 tickers + 3 macro = 39 req/cycle. At 120 req/min limit,
 * each cycle fits inside a minute with headroom.
 *
 * Logs per-ticker errors but continues. Returns whatever it got.
 */
export async function pullWatcherState(tickers: readonly string[] = WATCHLIST): Promise<{
  spot_gex: Record<string, unknown>;
  greek_exposure: Record<string, unknown>;
  options_volume: Record<string, unknown>;
  spx_spot_gex: unknown | null;
  spx_greek_exposure: unknown | null;
  market_tide: unknown | null;
  vix: { level: number; source: 'VIX' | 'VIXY'; endpoint: string } | null;
  errors: Array<{ ticker: string; endpoint: string; error: string }>;
}> {
  const spot_gex: Record<string, unknown> = {};
  const greek_exposure: Record<string, unknown> = {};
  const options_volume: Record<string, unknown> = {};
  const errors: Array<{ ticker: string; endpoint: string; error: string }> = [];

  // Macro: SPX spot + static GEX (banner)
  let spx_spot_gex: unknown | null = null;
  let spx_greek_exposure: unknown | null = null;
  try {
    spx_spot_gex = await getSpotGexByStrike(MARKET_BANNER_SYMBOL);
  } catch (e) {
    errors.push({ ticker: MARKET_BANNER_SYMBOL, endpoint: 'spot-exposures/strike', error: e instanceof Error ? e.message : String(e) });
  }
  try {
    spx_greek_exposure = await getStaticGexByStrike(MARKET_BANNER_SYMBOL);
  } catch (e) {
    errors.push({ ticker: MARKET_BANNER_SYMBOL, endpoint: 'greek-exposure/strike', error: e instanceof Error ? e.message : String(e) });
  }

  // Macro: market tide
  let market_tide: unknown | null = null;
  try {
    market_tide = await getMarketTide();
  } catch (e) {
    errors.push({ ticker: 'MARKET', endpoint: 'market-tide', error: e instanceof Error ? e.message : String(e) });
  }

  // Macro: VIX level (or VIXY fallback). Defensive — null on failure, never
  // crashes the cycle.
  let vix: { level: number; source: 'VIX' | 'VIXY'; endpoint: string } | null = null;
  try {
    vix = await getVixSpot();
    if (vix === null) {
      errors.push({ ticker: 'VIX', endpoint: 'spot-exposures/strike', error: 'VIX + VIXY both returned no usable price' });
    }
  } catch (e) {
    errors.push({ ticker: 'VIX', endpoint: 'spot-exposures/strike', error: e instanceof Error ? e.message : String(e) });
  }

  // Per-ticker loop
  for (const ticker of tickers) {
    try {
      spot_gex[ticker] = await getSpotGexByStrike(ticker);
    } catch (e) {
      errors.push({ ticker, endpoint: 'spot-exposures/strike', error: e instanceof Error ? e.message : String(e) });
    }
    try {
      greek_exposure[ticker] = await getStaticGexByStrike(ticker);
    } catch (e) {
      errors.push({ ticker, endpoint: 'greek-exposure/strike', error: e instanceof Error ? e.message : String(e) });
    }
    try {
      options_volume[ticker] = await getOptionsVolume(ticker);
    } catch (e) {
      errors.push({ ticker, endpoint: 'options-volume', error: e instanceof Error ? e.message : String(e) });
    }
  }

  return { spot_gex, greek_exposure, options_volume, spx_spot_gex, spx_greek_exposure, market_tide, vix, errors };
}

// ============================================================================
// Per-option-contract — intraday bars / daily history / per-print flow
// ============================================================================
//
// Foundation for the contract-grading layer (Co-Trader edge attribution v2).
// Live-probed against UW REST 2026-04-24 with SHEL260515C00095000:
//
//   /api/option-contract/{symbol}/intraday  → { data: [bar...] }
//     bar fields: start_time (ISO Z), open, high, low, close, avg_price,
//     iv_low, iv_high, premium_{bid,ask,mid,no}_side, volume_{bid,ask,mid,no}_side,
//     volume_multi, volume_stock_multi.   NO bid/ask/mid quotes — only
//     premium-side breakdowns. Bars are returned newest-first.
//
//   /api/option-contract/{symbol}/historic  → { chains: [row...], etf_holdings: [...] }
//     row fields: date (YYYY-MM-DD), last_price, nbbo_bid, nbbo_ask,
//     open_price, high_price, low_price, avg_price, iv_low, iv_high,
//     volume, open_interest, bid_volume, ask_volume, mid_volume,
//     trades, sweep_volume, floor_volume, cross_volume, last_tape_time.
//     Top-level key is `chains`, NOT `data` (anomaly vs. rest of UW REST).
//
//   /api/option-contract/{symbol}/flow      → { data: [print...], date }
//     print fields: id, executed_at, price, size, premium, nbbo_bid,
//     nbbo_ask, ask_vol, bid_vol, mid_vol, no_side_vol, tags ([bullish|
//     bearish|bid_side|ask_side|...]), exchange, option_type, strike,
//     expiry, theo, delta, gamma, theta, vega, rho, implied_volatility,
//     underlying_price, sector, marketcap, full_name, report_flags,
//     option_chain_id, flow_alert_id, upstream_condition_detail.
//
// MCP coverage (per ct-uw-mcp-scout 2026-04-24): only `get_historic_chains`
// covers per-contract daily history (cap 50 rows). No MCP equivalent for
// intraday or per-contract flow — REST is the only path. Sticking with REST
// for all three keeps the call shape uniform and the rate-limit accounting
// in one place.
//
// Rate cost: 1 UW request unit per call. Daily budget 20,000 (per
// x-uw-token-req-limit header observed); minute budget 120.

export type UwResultBase = {
  ok: boolean;
  error?: string;
  status?: number;
};

/** Normalized intraday bar — what callers consume. Premium fields are dollars. */
export type UwOptionBar = {
  ts: string;          // ISO 8601 (start of bar)
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  avg_price: number | null;
  iv_low: number | null;
  iv_high: number | null;
  premium_bid_side: number | null;
  premium_ask_side: number | null;
  premium_mid_side: number | null;
  volume_bid_side: number | null;
  volume_ask_side: number | null;
  volume_mid_side: number | null;
};

export type UwIntradayResult = UwResultBase & {
  bars: UwOptionBar[];
  /** Most-recent bar first if true (UW default). */
  newest_first: boolean;
};

/** Normalized daily-history row. */
export type UwOptionDaily = {
  date: string;                 // YYYY-MM-DD
  last_price: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  avg_price: number | null;
  nbbo_bid: number | null;
  nbbo_ask: number | null;
  iv_low: number | null;
  iv_high: number | null;
  volume: number | null;
  open_interest: number | null;
  bid_volume: number | null;
  ask_volume: number | null;
  mid_volume: number | null;
  trades: number | null;
  sweep_volume: number | null;
  floor_volume: number | null;
  cross_volume: number | null;
  last_tape_time: string | null;
};

export type UwHistoricResult = UwResultBase & {
  rows: UwOptionDaily[];
};

/** Normalized per-print row. Keeps the raw payload for callers that need extras. */
export type UwOptionPrint = {
  id: string | null;
  executed_at: string | null;
  price: number | null;
  size: number | null;
  premium: number | null;
  nbbo_bid: number | null;
  nbbo_ask: number | null;
  ask_vol: number | null;
  bid_vol: number | null;
  mid_vol: number | null;
  no_side_vol: number | null;
  tags: string[];
  exchange: string | null;
  option_type: 'call' | 'put' | null;
  strike: number | null;
  expiry: string | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  rho: number | null;
  implied_volatility: number | null;
  underlying_price: number | null;
  report_flags: string[];
  raw: Record<string, unknown>;
};

export type UwContractFlowResult = UwResultBase & {
  prints: UwOptionPrint[];
};

function _n(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function _str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s.length === 0 ? null : s;
}

function _strArr(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter(x => typeof x === 'string') as string[];
}

/**
 * Intraday bars for one contract through the current session.
 *
 * Note: UW returns bars NEWEST-FIRST. We surface that via `newest_first: true`
 * and do not reverse — callers that want oldest-first can `.reverse()`. No
 * server-side `since` / `timeframe` params are documented; UW returns whatever
 * granularity it sees fit (~5m equivalent observed in live probe). The opts
 * here are placeholders for the published surface; we forward them so a future
 * UW change can add server-side filtering without a wrapper signature break.
 */
export async function getOptionContractIntraday(
  optionSymbol: string,
  opts: { timeframe?: '1m' | '5m'; sinceISO?: string } = {},
): Promise<UwIntradayResult> {
  if (!optionSymbol) return { ok: false, bars: [], newest_first: true, error: 'option_symbol required' };
  try {
    const params: Record<string, string | undefined> = {};
    if (opts.timeframe) params.timeframe = opts.timeframe;
    if (opts.sinceISO) params.since = opts.sinceISO;
    const raw = await uwGet<{ data?: unknown[] }>(`/api/option-contract/${optionSymbol}/intraday`, params);
    const data = Array.isArray(raw?.data) ? raw.data : [];
    const bars: UwOptionBar[] = data.map((r) => {
      const x = r as Record<string, unknown>;
      const volume = (() => {
        const direct = _n(x.volume);
        if (direct !== null) return direct;
        // Sum side breakdowns when the top-level volume is absent (observed shape).
        const sides = [_n(x.volume_bid_side), _n(x.volume_ask_side), _n(x.volume_mid_side), _n(x.volume_no_side)];
        const sum = sides.reduce((acc, v) => acc + (v ?? 0), 0);
        return sides.some(v => v !== null) ? sum : null;
      })();
      return {
        ts: _str(x.start_time) ?? _str(x.ts) ?? '',
        open: _n(x.open),
        high: _n(x.high),
        low: _n(x.low),
        close: _n(x.close),
        volume,
        avg_price: _n(x.avg_price),
        iv_low: _n(x.iv_low),
        iv_high: _n(x.iv_high),
        premium_bid_side: _n(x.premium_bid_side),
        premium_ask_side: _n(x.premium_ask_side),
        premium_mid_side: _n(x.premium_mid_side),
        volume_bid_side: _n(x.volume_bid_side),
        volume_ask_side: _n(x.volume_ask_side),
        volume_mid_side: _n(x.volume_mid_side),
      };
    }).filter(b => b.ts);
    return { ok: true, bars, newest_first: true };
  } catch (e) {
    const status = e instanceof UwError ? e.status : 500;
    return { ok: false, bars: [], newest_first: true, error: e instanceof Error ? e.message : String(e), status };
  }
}

/**
 * Daily OHLC + IV + OI history for one contract.
 *
 * UW shape gotcha: top-level key is `chains`, not `data`. Returns an
 * `etf_holdings` block too (irrelevant for grading; ignored).
 */
export async function getOptionContractHistoric(
  optionSymbol: string,
  opts: { sinceDate?: string; limit?: number } = {},
): Promise<UwHistoricResult> {
  if (!optionSymbol) return { ok: false, rows: [], error: 'option_symbol required' };
  try {
    const params: Record<string, string | number | undefined> = {};
    if (opts.sinceDate) params.since = opts.sinceDate;
    if (opts.limit) params.limit = opts.limit;
    const raw = await uwGet<{ chains?: unknown[]; data?: unknown[] }>(`/api/option-contract/${optionSymbol}/historic`, params);
    // Defensive: prefer `chains`, fall back to `data` in case UW normalizes later.
    const list = Array.isArray(raw?.chains) ? raw.chains : (Array.isArray(raw?.data) ? raw.data : []);
    const rows: UwOptionDaily[] = list.map((r) => {
      const x = r as Record<string, unknown>;
      return {
        date: _str(x.date) ?? '',
        last_price: _n(x.last_price ?? x.close ?? x.close_price),
        open: _n(x.open_price ?? x.open),
        high: _n(x.high_price ?? x.high),
        low: _n(x.low_price ?? x.low),
        avg_price: _n(x.avg_price),
        nbbo_bid: _n(x.nbbo_bid),
        nbbo_ask: _n(x.nbbo_ask),
        iv_low: _n(x.iv_low),
        iv_high: _n(x.iv_high),
        volume: _n(x.volume),
        open_interest: _n(x.open_interest),
        bid_volume: _n(x.bid_volume),
        ask_volume: _n(x.ask_volume),
        mid_volume: _n(x.mid_volume),
        trades: _n(x.trades),
        sweep_volume: _n(x.sweep_volume),
        floor_volume: _n(x.floor_volume),
        cross_volume: _n(x.cross_volume),
        last_tape_time: _str(x.last_tape_time),
      };
    }).filter(r => r.date);
    return { ok: true, rows };
  } catch (e) {
    const status = e instanceof UwError ? e.status : 500;
    return { ok: false, rows: [], error: e instanceof Error ? e.message : String(e), status };
  }
}

/**
 * Recent prints on one specific contract — ground truth for grading and the
 * fallback source for live mid extraction (the flow rows carry NBBO; intraday
 * bars do not).
 */
export async function getOptionContractFlow(
  optionSymbol: string,
  opts: { limit?: number } = {},
): Promise<UwContractFlowResult> {
  if (!optionSymbol) return { ok: false, prints: [], error: 'option_symbol required' };
  try {
    const params: Record<string, string | number> = { limit: opts.limit ?? 50 };
    const raw = await uwGet<{ data?: unknown[] }>(`/api/option-contract/${optionSymbol}/flow`, params);
    const data = Array.isArray(raw?.data) ? raw.data : [];
    const prints: UwOptionPrint[] = data.map((r) => {
      const x = r as Record<string, unknown>;
      const optType = _str(x.option_type);
      return {
        id: _str(x.id),
        executed_at: _str(x.executed_at),
        price: _n(x.price),
        size: _n(x.size),
        premium: _n(x.premium),
        nbbo_bid: _n(x.nbbo_bid),
        nbbo_ask: _n(x.nbbo_ask),
        ask_vol: _n(x.ask_vol),
        bid_vol: _n(x.bid_vol),
        mid_vol: _n(x.mid_vol),
        no_side_vol: _n(x.no_side_vol),
        tags: _strArr(x.tags),
        exchange: _str(x.exchange),
        option_type: (optType === 'call' || optType === 'put') ? optType : null,
        strike: _n(x.strike),
        expiry: _str(x.expiry),
        delta: _n(x.delta),
        gamma: _n(x.gamma),
        theta: _n(x.theta),
        vega: _n(x.vega),
        rho: _n(x.rho),
        implied_volatility: _n(x.implied_volatility),
        underlying_price: _n(x.underlying_price),
        report_flags: _strArr(x.report_flags),
        raw: x,
      };
    });
    return { ok: true, prints };
  } catch (e) {
    const status = e instanceof UwError ? e.status : 500;
    return { ok: false, prints: [], error: e instanceof Error ? e.message : String(e), status };
  }
}

/**
 * Latest-mid extraction. ONE UW call. Used by the contract poller for live
 * tracking. Calls `/flow?limit=1` because flow rows carry true `nbbo_bid` and
 * `nbbo_ask` — intraday bars don't.
 *
 * The `spreadPct` is `(ask - bid) / mid`. Caller decides whether to skip the
 * update (recommended cutoffs from the spec: skip if `mid < 0.05` OR
 * `spreadPct > 0.30`). We DO NOT null-out the price ourselves — surfacing the
 * spread metric lets the poller decide per-contract.
 *
 * Returns nulls everywhere on failure / no-print rather than throwing — the
 * poller treats null as "no quote available this tick", not a hard error.
 */
export async function getOptionContractLatestMid(
  optionSymbol: string,
): Promise<{
  mid: number | null;
  bid: number | null;
  ask: number | null;
  last: number | null;
  ts: string | null;
  spreadPct: number | null;
  ok: boolean;
  error?: string;
}> {
  const flow = await getOptionContractFlow(optionSymbol, { limit: 1 });
  if (!flow.ok || flow.prints.length === 0) {
    return {
      mid: null, bid: null, ask: null, last: null, ts: null, spreadPct: null,
      ok: false, error: flow.error ?? 'no_prints',
    };
  }
  const p = flow.prints[0];
  const bid = p.nbbo_bid;
  const ask = p.nbbo_ask;
  const last = p.price;
  const mid = (bid !== null && ask !== null) ? (bid + ask) / 2 : last;
  let spreadPct: number | null = null;
  if (bid !== null && ask !== null && mid !== null && mid > 0) {
    spreadPct = (ask - bid) / mid;
  }
  return {
    mid,
    bid,
    ask,
    last,
    ts: p.executed_at,
    spreadPct,
    ok: true,
  };
}

// ============================================================================
// Endpoint registry — consumed by ct-uw-endpoint-health-check
// ============================================================================

/**
 * Every UW endpoint this codebase touches, paired with a minimal probe that
 * verifies the wrapper still works. Each probe is a no-side-effect GET that
 * returns quickly and uses a low-limit / single-ticker call.
 *
 * The health-check cron iterates this registry daily and flips entries to
 * 'degraded' / 'broken' in `ct_uw_endpoint_health`. When UW renames a path,
 * the health-check catches it before the ingester cron silently starves.
 *
 * Adding a new wrapper? Add it here too — otherwise drift detection is blind
 * to it.
 */
export const UW_ENDPOINT_REGISTRY: Array<{
  wrapper: string;
  path_template: string;
  probe: () => Promise<unknown>;
}> = [
  { wrapper: 'getFlowAlerts',            path_template: '/api/option-trades/flow-alerts',                        probe: () => getFlowAlerts({ limit: 1 }) },
  { wrapper: 'getOptionScreener',        path_template: '/api/screener/option-contracts',                        probe: () => getOptionScreener({ limit: 1 }) },
  { wrapper: 'getMarketTide',            path_template: '/api/market/market-tide',                               probe: () => getMarketTide() },
  { wrapper: 'getTopNetImpact',          path_template: '/api/market/top-net-impact',                            probe: () => getTopNetImpact() },
  { wrapper: 'getDarkPoolRecent',        path_template: '/api/darkpool/recent',                                  probe: () => getDarkPoolRecent() },
  { wrapper: 'getDarkPool',              path_template: '/api/darkpool/{ticker}',                                probe: () => getDarkPool('SPY') },
  { wrapper: 'getSpotGexByStrike',       path_template: '/api/stock/{ticker}/spot-exposures/strike',             probe: () => getSpotGexByStrike('SPY') },
  { wrapper: 'getStaticGexByStrike',     path_template: '/api/stock/{ticker}/greek-exposure/strike',             probe: () => getStaticGexByStrike('SPY') },
  { wrapper: 'getOptionsVolume',         path_template: '/api/stock/{ticker}/options-volume',                    probe: () => getOptionsVolume('SPY') },
  { wrapper: 'getGreeks',                path_template: '/api/stock/{ticker}/greeks',                            probe: () => getGreeks('SPY') },
  { wrapper: 'getOptionContracts',       path_template: '/api/stock/{ticker}/option-contracts',                  probe: () => getOptionContracts('SPY') },
  { wrapper: 'getInterpolatedIV',        path_template: '/api/stock/{ticker}/interpolated-iv',                   probe: () => getInterpolatedIV('SPY') },
  { wrapper: 'getNetPremiumTicks',       path_template: '/api/stock/{ticker}/net-prem-ticks',                    probe: () => getNetPremiumTicks('SPY') },
  { wrapper: 'getNope',                  path_template: '/api/stock/{ticker}/nope',                              probe: () => getNope('SPY') },
  { wrapper: 'getGreekFlow',             path_template: '/api/stock/{ticker}/greek-flow',                        probe: () => getGreekFlow('SPY') },
  { wrapper: 'getMaxPain',               path_template: '/api/stock/{ticker}/max-pain',                          probe: () => getMaxPain('SPY') },
  { wrapper: 'getIvRank',                path_template: '/api/stock/{ticker}/iv-rank',                           probe: () => getIvRank('SPY') },
  { wrapper: 'getRecentFlowForTicker',   path_template: '/api/stock/{ticker}/flow-recent',                       probe: () => getRecentFlowForTicker('SPY') },
  { wrapper: 'getEarningsAfterhours',    path_template: '/api/earnings/afterhours',                              probe: () => getEarningsAfterhours() },
  { wrapper: 'getEarningsPremarket',     path_template: '/api/earnings/premarket',                               probe: () => getEarningsPremarket() },
  { wrapper: 'getFdaCalendar',           path_template: '/api/market/fda-calendar',                              probe: () => getFdaCalendar() },
  { wrapper: 'getEconomicCalendar',      path_template: '/api/market/economic-calendar',                         probe: () => getEconomicCalendar() },
  { wrapper: 'getNewsHeadlines',         path_template: '/api/news/headlines',                                   probe: () => getNewsHeadlines({ limit: 1 }) },
  { wrapper: 'getInsiderTransactions',   path_template: '/api/insider/transactions',                             probe: () => getInsiderTransactions() },
  { wrapper: 'getCongressTrades',        path_template: '/api/congress/recent-trades',                           probe: () => getCongressTrades() },
  { wrapper: 'getAnalystRatings',        path_template: '/api/screener/analysts',                                probe: () => getAnalystRatings({ limit: 1 }) },
  { wrapper: 'getShortInterestFloat',    path_template: '/api/shorts/{ticker}/interest-float/v2',                probe: () => getShortInterestFloat('SPY') },
  { wrapper: 'getShortVolumeRatio',      path_template: '/api/shorts/{ticker}/volume-and-ratio',                 probe: () => getShortVolumeRatio('SPY') },
  { wrapper: 'getSectorTideForSector',   path_template: '/api/market/{sector}/sector-tide',                      probe: () => getSectorTideForSector('Technology') },
  { wrapper: 'getRiskReversalSkew',      path_template: '/api/stock/{ticker}/historical-risk-reversal-skew',     probe: () => getRiskReversalSkew('SPY') },
  { wrapper: 'getFinancials',            path_template: '/api/stock/{ticker}/financials',                        probe: () => getFinancials('SPY') },
  { wrapper: 'getTechnicalIndicator',    path_template: '/api/stock/{ticker}/technical-indicator/{function}',    probe: () => getTechnicalIndicator('SPY', 'RSI', { interval: 'daily', time_period: 14 }) },
  // Per-contract endpoints. Probe symbol is a long-dated SPY call deep ATM —
  // pick something with reliable activity so the probe rarely returns empty.
  // Expiry / strike will need rolling forward periodically (or move to a
  // dynamic SELECT-from-ct_sweeps probe in a follow-up wave).
  { wrapper: 'getOptionContractIntraday', path_template: '/api/option-contract/{symbol}/intraday', probe: () => getOptionContractIntraday('SPY260918C00650000') },
  { wrapper: 'getOptionContractHistoric', path_template: '/api/option-contract/{symbol}/historic', probe: () => getOptionContractHistoric('SPY260918C00650000', { limit: 5 }) },
  { wrapper: 'getOptionContractFlow',     path_template: '/api/option-contract/{symbol}/flow',     probe: () => getOptionContractFlow('SPY260918C00650000', { limit: 1 }) },
];
