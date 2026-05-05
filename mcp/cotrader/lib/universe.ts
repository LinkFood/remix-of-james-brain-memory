// 10-ticker universe lock. Tenet 4 (CO-TRADER THESIS): "Universe lock — 10
// tickers, no exceptions." Hardcoded so the MCP can validate before touching
// the DB; mirrors the values in `ct_config` watchlist that the operational
// stack reads. If the universe ever expands, this list and the DB watchlist
// move together.

export const UNIVERSE: readonly string[] = [
  'NVDA',
  'AAPL',
  'MSFT',
  'GOOGL',
  'AMZN',
  'META',
  'TSLA',
  'QQQ',
  'SPY',
  'IWM',
] as const;

export const UNIVERSE_SET: ReadonlySet<string> = new Set(UNIVERSE);

export function isUniverseTicker(ticker: string): boolean {
  return UNIVERSE_SET.has(ticker.toUpperCase());
}

export function assertUniverseTicker(ticker: string): string {
  const t = ticker.toUpperCase();
  if (!UNIVERSE_SET.has(t)) {
    throw new Error(
      `Ticker '${ticker}' is not in the Co-Trader universe. ` +
        `Allowed: ${UNIVERSE.join(', ')}.`,
    );
  }
  return t;
}
