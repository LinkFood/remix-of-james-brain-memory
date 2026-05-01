/**
 * tickerCoherenceValidator — kills the data-fabrication hallucination class.
 *
 * Caught 2026-05-01: chat answer invented "CDNS $4.5M 265 puts June" — ticker
 * not in watchlist, not in supplied context, not in our DB. Verified the
 * synthesis layer's read/write separation held (chat did not call UW MCP,
 * 0 rows of CDNS in ct_flow_alerts), so Claude fabricated the line whole-cloth.
 * Temporal anchor + event recency catch TIME hallucinations; this validator
 * catches DATA hallucinations of the form "naming a ticker that wasn't given."
 *
 * Mechanics:
 *   1. Build the legitimate-ticker universe: WATCHLIST ∪ MACRO_SYMBOLS ∪
 *      tickers that literally appear verbatim in the supplied context.
 *   2. Scan the Claude response for ticker-shaped tokens (\b[A-Z]{2,5}\b).
 *   3. Filter out a fixed denylist of common trading/English acronyms
 *      (ATM, OTM, FOMC, ET, AM, PM, USD, …) that look like tickers but aren't.
 *   4. Anything left that's NOT in the legitimate universe = a fabrication.
 *      One ValidatorWarning per distinct off-universe ticker mentioned.
 *
 * Same shape as eventCoherenceValidator. Run post-Claude, warnings persist
 * to a JSONB column on the consumer's row, Warden invariant counts the
 * rows-with-warnings.
 */
import type {
  ClaudeContext,
  ContextValidator,
  ValidatorResult,
  ValidatorWarning,
} from './contextHelper.ts';

const VALIDATOR_NAME = 'ticker_coherence';
const VALIDATOR_VERSION = 'v1';

// Single source of truth for the trading universe. Mirrors WATCHLIST in
// uwClient.ts; copied (not imported) so the validator stays decoupled from
// the UW client surface.
const WATCHLIST: ReadonlyArray<string> = [
  'SPY', 'QQQ', 'IWM',
  'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'TSLA',
];

// Macro/index symbols Claude is allowed to reference for regime context even
// if not in the watchlist. SPX is the macro GEX banner (per uwClient
// MARKET_BANNER_SYMBOL); the rest are common intraday references.
const MACRO_SYMBOLS: ReadonlyArray<string> = [
  'SPX',  'VIX',  'NDX',  'RUT',  'DJX',
  'MOVE', 'DXY',  'TNX',  'IBIT', 'BTC',
];

// Denylist: tokens shaped like tickers but functioning as English/trading
// acronyms. Anything matching the ticker regex that's also in this set is
// dropped before universe lookup. Caught by manual review of common chat
// vocabulary; expand on first false positive.
const DENYLIST: ReadonlySet<string> = new Set<string>([
  // Time
  'ET', 'EST', 'EDT', 'PT', 'PST', 'PDT', 'CT', 'CST', 'CDT', 'UTC', 'GMT',
  'AM', 'PM', 'EOD', 'EOW', 'RTH', 'AH', 'PRE',
  // Options structure
  'ATM', 'OTM', 'ITM', 'NTM', 'IV', 'IV30', 'IVR', 'IVP', 'HV',
  'GEX', 'DEX', 'CEX', 'OI', 'DTE', 'OPRA', 'NOPE', 'GAMMA', 'DELTA',
  'VEGA', 'THETA', 'RHO', 'CW', 'PW', 'CW1', 'CW2', 'CW3', 'PW1', 'PW2', 'PW3',
  // Direction / order
  'PUT', 'CALL', 'BUY', 'SELL', 'BID', 'ASK', 'LONG', 'SHORT', 'STOP',
  'LIMIT', 'BTO', 'STO', 'BTC', 'STC',
  // Currency / macro / agencies
  'USD', 'EUR', 'GBP', 'JPY', 'CNY', 'CHF', 'AUD', 'CAD', 'NZD',
  'FOMC', 'CPI', 'PCE', 'PPI', 'NFP', 'GDP', 'JOLTS', 'ECB', 'BOE', 'BOJ',
  'PBOC', 'SEC', 'IRS', 'FED', 'FDIC', 'FDA', 'EPA', 'DOJ', 'FBI', 'IPO',
  'ETF', 'NAV', 'AUM', 'LBO', 'LP', 'GP', 'MA', 'ESG', 'PEG', 'EPS', 'EBITDA',
  // Markets
  'NYSE', 'AMEX', 'OTC', 'NASDAQ',
  // Common acronyms / phrases
  'TLDR', 'FYI', 'TBD', 'TBA', 'AKA', 'POV', 'IMO', 'IMHO', 'OK', 'NO', 'YES',
  'GO', 'NA', 'NULL', 'TRUE', 'FALSE', 'MAX', 'MIN', 'AVG', 'SUM',
  // Ranges / units
  'USD$', 'BPS', 'BP', 'PCT',
  // Bias / sentiment shortcuts
  'BULL', 'BEAR', 'BULLISH', 'BEARISH', 'NEUTRAL',
  // Date pieces (months show up shouted in tape narratives)
  'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC',
  'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN',
  // English single+double-letter words that occur uppercased in prose
  'A', 'I', 'AN', 'AS', 'AT', 'BE', 'BY', 'DO', 'GO', 'HE', 'IF', 'IN',
  'IS', 'IT', 'ME', 'MY', 'OF', 'ON', 'OR', 'SO', 'TO', 'UP', 'US', 'WE',
  'AND', 'BUT', 'FOR', 'NOR', 'ALL', 'ANY', 'CAN', 'GET', 'HAS', 'HAD',
  'HER', 'HIM', 'HIS', 'HOW', 'ITS', 'NEW', 'NOT', 'NOW', 'OUR', 'OUT',
  'OWN', 'SHE', 'THE', 'TWO', 'WHO', 'WHY', 'YES', 'YOU', 'YOUR',
  'EACH', 'EVEN', 'FROM', 'INTO', 'LIKE', 'MOST', 'OVER', 'SOME', 'THAN',
  'THAT', 'THEM', 'THEN', 'THIS', 'WHAT', 'WHEN', 'WITH',
]);

const TICKER_PATTERN = /\b[A-Z]{2,5}\b/g;

/**
 * Extract tickers that literally appear in the JSON-stringified context.
 * If a token is in the supplied data, Claude is grounding, not fabricating.
 */
function extractContextTickers(context: ClaudeContext): Set<string> {
  const json = JSON.stringify(context);
  const matches = json.match(TICKER_PATTERN) ?? [];
  return new Set(matches);
}

export async function validateTickerCoherence(
  outputText: string,
  context: ClaudeContext,
): Promise<ValidatorResult> {
  if (!outputText || outputText.length === 0) {
    return { ok: true, warnings: [] };
  }

  // Build the legitimate universe.
  const contextTickers = extractContextTickers(context);
  const legitimate = new Set<string>([
    ...WATCHLIST,
    ...MACRO_SYMBOLS,
    ...contextTickers,
  ]);

  // Scan the output. Track first match position for citation snippet.
  const offending = new Map<string, { firstIdx: number }>();
  let m: RegExpExecArray | null;
  // Reset lastIndex (regex is /g and reused).
  TICKER_PATTERN.lastIndex = 0;
  while ((m = TICKER_PATTERN.exec(outputText)) !== null) {
    const tok = m[0];
    if (DENYLIST.has(tok)) continue;
    if (legitimate.has(tok)) continue;
    if (!offending.has(tok)) offending.set(tok, { firstIdx: m.index });
  }

  if (offending.size === 0) {
    return { ok: true, warnings: [] };
  }

  const warnings: ValidatorWarning[] = [];
  for (const [ticker, { firstIdx }] of offending.entries()) {
    const start = Math.max(0, firstIdx - 60);
    const end = Math.min(outputText.length, firstIdx + ticker.length + 60);
    const quote = outputText.slice(start, end).replace(/\s+/g, ' ').trim();
    warnings.push({
      validator: VALIDATOR_NAME,
      severity: 'critical',
      quote,
      issue: `Off-universe ticker "${ticker}" mentioned. Not in watchlist (SPY, QQQ, IWM, AAPL, MSFT, GOOGL, AMZN, META, NVDA, TSLA), not in macro symbols, and not present verbatim in the supplied context. Likely fabricated.`,
    });
  }

  return { ok: false, warnings };
}

const tickerCoherenceValidator: ContextValidator = {
  name: VALIDATOR_NAME,
  version: VALIDATOR_VERSION,
  validate: validateTickerCoherence,
};

export default tickerCoherenceValidator;
