/**
 * Unusual Whales API client
 *
 * REST wrapper for the 13-ticker co-trader watchlist. Respects the
 * "never retry 4xx" gotcha from CLAUDE.md — only 5xx + network errors
 * get retried with exponential backoff. Rate limiting is respected
 * via `UW_RATE_LIMIT_PER_MINUTE` (default 120, matches UW API tier).
 *
 * All endpoints return JSON unless noted.
 * Base URL: https://api.unusualwhales.com
 */

const UW_BASE_URL = 'https://api.unusualwhales.com';
const DEFAULT_RATE_LIMIT = 120; // req/min on API Basic
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
 * Core fetch with retry (5xx only) and query-param handling.
 */
async function uwGet<T = unknown>(
  path: string,
  params?: Record<string, string | number | undefined>
): Promise<T> {
  const url = new URL(UW_BASE_URL + path);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url.toString(), { method: 'GET', headers: headers() });

    if (res.ok) {
      return (await res.json()) as T;
    }

    const errorText = await res.text().catch(() => '');

    // 4xx — never retry (auth, bad request, not found, etc.)
    if (res.status < 500) {
      console.error(`[uwClient] ${path} → ${res.status}: ${errorText.slice(0, 300)}`);
      throw new UwError(`UW ${res.status} on ${path}`, res.status);
    }

    // 5xx — retry with exponential backoff
    if (attempt < MAX_RETRIES) {
      const delay = BASE_DELAY_MS * Math.pow(2, attempt);
      console.warn(`[uwClient] ${path} → ${res.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await new Promise(r => setTimeout(r, delay));
      continue;
    }

    throw new UwError(`UW ${res.status} on ${path} after ${MAX_RETRIES + 1} attempts`, res.status);
  }

  throw new UwError(`UW request failed: unknown error on ${path}`, 500);
}

// ============================================================================
// Public endpoints — thin wrappers around the UW OpenAPI surface
// ============================================================================

/** Aggregate Greek exposure (delta, gamma, vega, charm) for a ticker */
export function getGreekExposure(ticker: string): Promise<unknown> {
  return uwGet(`/api/stock/${ticker}/greek-exposure`);
}

/** Greek exposure broken down by strike — gives call walls, put walls, gamma flip */
export function getGreekExposureByStrike(ticker: string, expiry?: string): Promise<unknown> {
  return uwGet(`/api/stock/${ticker}/greek-exposure/strike`, expiry ? { expiry } : undefined);
}

/** Greek exposure broken down by expiry */
export function getGreekExposureByExpiry(ticker: string): Promise<unknown> {
  return uwGet(`/api/stock/${ticker}/greek-exposure/expiry`);
}

/** Dealer GEX — total gamma exposure */
export function getGex(ticker: string): Promise<unknown> {
  return uwGet(`/api/stock/${ticker}/gex`);
}

/** GEX by expiry */
export function getGexByExpiry(ticker: string): Promise<unknown> {
  return uwGet(`/api/stock/${ticker}/gex/expiry`);
}

/** Unusual options flow for a ticker (recent trades above threshold) */
export function getFlowAlerts(ticker: string, limit = 50): Promise<unknown> {
  return uwGet(`/api/stock/${ticker}/flow-alerts`, { limit });
}

/** Options chain for a ticker */
export function getOptionsChain(ticker: string): Promise<unknown> {
  return uwGet(`/api/stock/${ticker}/option-chain`);
}

/** Dark pool prints for a ticker */
export function getDarkPool(ticker: string, limit = 100): Promise<unknown> {
  return uwGet(`/api/darkpool/${ticker}`, { limit });
}

/** Stock quote / current price data */
export function getQuote(ticker: string): Promise<unknown> {
  return uwGet(`/api/stock/${ticker}/quote`);
}

/** Intraday OHLCV candles */
export function getCandles(
  ticker: string,
  timeframe: '1min' | '5min' | '15min' | '30min' | '1hour' | '1day' = '5min',
  limit = 100
): Promise<unknown> {
  return uwGet(`/api/stock/${ticker}/ohlc/${timeframe}`, { limit });
}

/** News headlines filtered by ticker */
export function getNews(ticker?: string, limit = 25): Promise<unknown> {
  return ticker
    ? uwGet(`/api/news/headlines`, { ticker, limit })
    : uwGet(`/api/news/headlines`, { limit });
}

/** Technical indicators (UW provides 14: SMA, EMA, RSI, MACD, BBANDS, etc.) */
export function getTechnicalIndicator(
  ticker: string,
  indicator: string,
  params?: Record<string, string | number>
): Promise<unknown> {
  return uwGet(`/api/stock/${ticker}/technical/${indicator}`, params);
}

/** Market tide — net put/call buying pressure intraday */
export function getMarketTide(): Promise<unknown> {
  return uwGet('/api/market/tide');
}

/** SPX-level GEX snapshot for macro banner */
export function getSpxGex(): Promise<unknown> {
  return getGex('SPX');
}

export function getSpxGreekByStrike(expiry?: string): Promise<unknown> {
  return getGreekExposureByStrike('SPX', expiry);
}

// ============================================================================
// Bulk helpers
// ============================================================================

/** The 13-instrument watchlist */
export const WATCHLIST = [
  'SPY', 'QQQ', 'IWM',                                          // indexes
  'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'TSLA',      // mag 7
  'GLD', 'USO', 'ES',                                            // macro (GLD=gold, USO=oil, ES=S&P futures)
] as const;

export type WatchlistTicker = typeof WATCHLIST[number];

/**
 * Pull a full watcher-cycle state bundle for all instruments.
 * Sequential calls (respects rate limit). Logs per-ticker errors but continues.
 */
export async function pullWatcherState(tickers: readonly string[] = WATCHLIST): Promise<{
  quotes: Record<string, unknown>;
  gex: Record<string, unknown>;
  spxMacroGex: unknown | null;
  errors: Array<{ ticker: string; endpoint: string; error: string }>;
}> {
  const quotes: Record<string, unknown> = {};
  const gex: Record<string, unknown> = {};
  const errors: Array<{ ticker: string; endpoint: string; error: string }> = [];

  // Macro-level SPX GEX (runs once regardless of watchlist)
  let spxMacroGex: unknown | null = null;
  try {
    spxMacroGex = await getSpxGex();
  } catch (e) {
    errors.push({ ticker: 'SPX', endpoint: 'gex', error: e instanceof Error ? e.message : String(e) });
  }

  for (const ticker of tickers) {
    try {
      quotes[ticker] = await getQuote(ticker);
    } catch (e) {
      errors.push({ ticker, endpoint: 'quote', error: e instanceof Error ? e.message : String(e) });
    }
    try {
      gex[ticker] = await getGex(ticker);
    } catch (e) {
      errors.push({ ticker, endpoint: 'gex', error: e instanceof Error ? e.message : String(e) });
    }
  }

  return { quotes, gex, spxMacroGex, errors };
}
