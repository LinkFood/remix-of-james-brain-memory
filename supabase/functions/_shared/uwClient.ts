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
 */
let _uwUsageBuffer: Array<{ endpoint: string; daily_count: number | null; daily_limit: number | null; status: number; ms: number }> = [];
let _uwUsageFlushPending = false;

function recordUwUsage(path: string, res: Response, ms: number): void {
  const dc = Number(res.headers.get('x-uw-daily-req-count') ?? '');
  const dl = Number(res.headers.get('x-uw-token-req-limit') ?? '');
  _uwUsageBuffer.push({
    endpoint: path,
    daily_count: Number.isFinite(dc) ? dc : null,
    daily_limit: Number.isFinite(dl) ? dl : null,
    status: res.status,
    ms,
  });
  if (!_uwUsageFlushPending) {
    _uwUsageFlushPending = true;
    // Flush 500ms after first call — batches a burst into one insert.
    setTimeout(flushUwUsage, 500);
  }
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

/** Unusual options flow alerts (market-wide, filter by ticker via param) */
export function getFlowAlerts(params: {
  ticker_symbol?: string;
  limit?: number;
  is_call?: boolean;
  is_put?: boolean;
  is_otm?: boolean;
  min_premium?: number;
  size_greater_oi?: boolean;
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
 * The 12-instrument per-ticker watchlist.
 *
 * ES futures not included — UW doesn't cover futures. Macro S&P read is
 * handled separately via SPX for the market banner. GLD/USO serve as gold/oil
 * proxies.
 */
export const WATCHLIST = [
  // Indexes
  'SPY', 'QQQ', 'IWM',
  // Mag 7
  'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'TSLA',
  // Macro proxies
  'GLD', 'USO',
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
];
