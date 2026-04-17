/**
 * Unusual Whales API client
 *
 * Thin wrapper over the UW REST API. Strictly follows the endpoint whitelist
 * from https://unusualwhales.com/skill.md to avoid hallucinated paths.
 *
 * Mandatory headers (per SKILL.md):
 *   Authorization: Bearer <UW_API_KEY>
 *   UW-CLIENT-API-ID: 100001
 *
 * Retry policy: never retry 4xx (per CLAUDE.md gotcha). 5xx + network errors
 * retried with exponential backoff.
 *
 * Rate limit: 120 req/min on API Basic. Bulk helpers respect that.
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
    const res = await fetch(url.toString(), { method: 'GET', headers: headers() });

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
 * Technical indicator series.
 * Functions: SMA, EMA, RSI, MACD, BBANDS, STOCH, ADX, ATR, OBV, VWAP, CCI,
 * WILLR, AROON, MFI (14 supported).
 */
export function getTechnicalIndicator(
  ticker: string,
  fn: string,
  params: { interval?: string; time_period?: number; series_type?: string } = {}
): Promise<unknown> {
  return uwGet(`/api/stock/${ticker}/technical-indicator/${fn}`, params);
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

/**
 * Pull a full watcher-cycle state bundle.
 *
 * Per ticker: spot GEX by strike + options volume (P/C ratio, volume)
 * Market-wide: SPX spot GEX, market tide
 *
 * Logs per-ticker errors but continues. Returns whatever it got.
 */
export async function pullWatcherState(tickers: readonly string[] = WATCHLIST): Promise<{
  spot_gex: Record<string, unknown>;
  options_volume: Record<string, unknown>;
  spx_spot_gex: unknown | null;
  market_tide: unknown | null;
  errors: Array<{ ticker: string; endpoint: string; error: string }>;
}> {
  const spot_gex: Record<string, unknown> = {};
  const options_volume: Record<string, unknown> = {};
  const errors: Array<{ ticker: string; endpoint: string; error: string }> = [];

  // Macro: SPX spot GEX (banner)
  let spx_spot_gex: unknown | null = null;
  try {
    spx_spot_gex = await getSpotGexByStrike(MARKET_BANNER_SYMBOL);
  } catch (e) {
    errors.push({
      ticker: MARKET_BANNER_SYMBOL,
      endpoint: 'spot-exposures/strike',
      error: e instanceof Error ? e.message : String(e),
    });
  }

  // Macro: market tide
  let market_tide: unknown | null = null;
  try {
    market_tide = await getMarketTide();
  } catch (e) {
    errors.push({ ticker: 'MARKET', endpoint: 'market-tide', error: e instanceof Error ? e.message : String(e) });
  }

  // Per-ticker loop (sequential — respects rate limit, 2 calls × 12 tickers = 24/min, well under 120)
  for (const ticker of tickers) {
    try {
      spot_gex[ticker] = await getSpotGexByStrike(ticker);
    } catch (e) {
      errors.push({ ticker, endpoint: 'spot-exposures/strike', error: e instanceof Error ? e.message : String(e) });
    }
    try {
      options_volume[ticker] = await getOptionsVolume(ticker);
    } catch (e) {
      errors.push({ ticker, endpoint: 'options-volume', error: e instanceof Error ? e.message : String(e) });
    }
  }

  return { spot_gex, options_volume, spx_spot_gex, market_tide, errors };
}
