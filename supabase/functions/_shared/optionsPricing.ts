/**
 * optionsPricing — per-contract options mark-to-market helpers.
 *
 * Closes the gap left by Wave 16 (live_pnl columns populated only for
 * contract_type='underlying'). For calls/puts we need:
 *   1. Parse OCC symbols from UW's /option-contracts endpoint
 *   2. Match a ct_trades row (strike + expiry + type) to a chain row
 *   3. Compute live P&L from entry_premium → current premium
 *
 * OCC symbol format (21 chars, fixed-width):
 *   [Ticker 1-6, space-padded][YYMMDD][C|P][strike * 1000, 8-digit zero-padded]
 *   e.g. "SPY   260417C00710000" or tight "SPY260417C00710000"
 *        → ticker=SPY, expiry=2026-04-17, type=call, strike=710
 *
 * Premium quotes are PER SHARE — multiply by 100 for notional per contract.
 */

export interface ParsedOccSymbol {
  ticker: string;
  expiry: string;      // 'YYYY-MM-DD'
  type: 'call' | 'put';
  strike: number;
}

/**
 * UW /option-contracts row shape (fields we rely on).
 * UW returns more than this; we narrow to what mark-to-market needs.
 */
export interface OptionChainRow {
  option_symbol: string;
  last_price?: number | string | null;
  nbbo_bid?: number | string | null;
  nbbo_ask?: number | string | null;
}

export interface OptionTradeLike {
  instrument: string;
  contract_type: 'underlying' | 'call' | 'put';
  strike: number | null;
  expiry: string | null;          // 'YYYY-MM-DD'
  contracts: number | null;
  entry_premium: number | null;
  side: 'long' | 'short';
}

export interface OptionLivePnl {
  live_pnl_pct: number;
  live_pnl_usd: number;
  mark_premium: number;           // per-share premium used for MtM
  mark_source: 'nbbo_mid' | 'last_price' | 'zero';
}

// OCC regex — tolerates 1-6 char ticker with optional space padding.
// Capture groups: 1=ticker, 2=YY, 3=MM, 4=DD, 5=C|P, 6=strike*1000 (8-digit)
const OCC_REGEX = /^\s*([A-Z]{1,6})\s*(\d{2})(\d{2})(\d{2})([CP])(\d{8})\s*$/;

/**
 * Parse an OCC option symbol into structured fields.
 * Throws if the input doesn't match OCC format.
 */
export function parseOccSymbol(sym: string): ParsedOccSymbol {
  if (!sym || typeof sym !== 'string') {
    throw new Error(`parseOccSymbol: empty/invalid input: ${sym}`);
  }
  const m = sym.match(OCC_REGEX);
  if (!m) {
    throw new Error(`parseOccSymbol: not an OCC symbol: ${sym}`);
  }
  const [, ticker, yy, mm, dd, cp, strikeRaw] = m;
  // OCC uses 2-digit year starting in 2000. Cutoff at +50 year window — any
  // yy we'll see in practice rolls over to 20YY.
  const year = 2000 + parseInt(yy, 10);
  const expiry = `${year}-${mm}-${dd}`;
  const strike = parseInt(strikeRaw, 10) / 1000;
  return {
    ticker,
    expiry,
    type: cp === 'C' ? 'call' : 'put',
    strike,
  };
}

/**
 * Find the chain row whose parsed OCC symbol matches the trade's
 * (instrument, contract_type, strike, expiry). Returns null if no match.
 * Handles minor floating-point strike drift via <0.01 tolerance.
 */
export function matchContract(
  trade: OptionTradeLike,
  chainRows: OptionChainRow[],
): OptionChainRow | null {
  if (trade.contract_type === 'underlying') return null;
  if (trade.strike == null || !trade.expiry) return null;
  if (!Array.isArray(chainRows) || chainRows.length === 0) return null;

  const wantType = trade.contract_type; // 'call' | 'put'
  const wantStrike = trade.strike;
  const wantExpiry = trade.expiry.slice(0, 10);
  const wantTicker = trade.instrument.toUpperCase();

  for (const row of chainRows) {
    if (!row || !row.option_symbol) continue;
    let parsed: ParsedOccSymbol;
    try {
      parsed = parseOccSymbol(row.option_symbol);
    } catch {
      continue;
    }
    if (parsed.ticker !== wantTicker) continue;
    if (parsed.type !== wantType) continue;
    if (parsed.expiry !== wantExpiry) continue;
    if (Math.abs(parsed.strike - wantStrike) > 0.01) continue;
    return row;
  }
  return null;
}

function numOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Decide the per-share premium to use as "current".
 *
 * Rule:
 *   - If both nbbo_bid and nbbo_ask are present and > 0 → NBBO mid
 *     (fair two-sided market — executable price between bid and ask)
 *   - Else if last_price is present → last_price
 *     (stale but signed; happens on thin/deep-OTM contracts between ticks)
 *   - Else → 0 (deep-OTM worthless — let the loss show rather than skip)
 *
 * Deep-OTM with bid=0, ask>0 is common; mid of those would be misleading
 * (ask-only halves the ask). We require BOTH bid and ask > 0 for mid.
 */
function pickMarkPremium(
  row: OptionChainRow,
): { premium: number; source: 'nbbo_mid' | 'last_price' | 'zero' } {
  const bid = numOrNull(row.nbbo_bid);
  const ask = numOrNull(row.nbbo_ask);
  const last = numOrNull(row.last_price);

  if (bid != null && ask != null && bid > 0 && ask > 0) {
    return { premium: (bid + ask) / 2, source: 'nbbo_mid' };
  }
  if (last != null && last >= 0) {
    return { premium: last, source: 'last_price' };
  }
  return { premium: 0, source: 'zero' };
}

/**
 * Compute live P&L for an option trade.
 *
 * - cost_basis   = entry_premium * contracts * 100
 * - market_value = mark_premium  * contracts * 100
 * - Long call/put: P&L = market_value - cost_basis
 * - Short call/put (writer): P&L = cost_basis - market_value
 *
 * `currentPremiumOverride` lets callers bypass the NBBO/last pick and pass a
 * specific per-share premium (e.g. tests, fallback sources). When omitted,
 * use computeOptionLivePnlFromChainRow() which does the pick internally.
 */
export function computeOptionLivePnl(
  trade: OptionTradeLike,
  currentPremium: number,
): OptionLivePnl {
  if (trade.contract_type === 'underlying') {
    throw new Error('computeOptionLivePnl: underlying trades use unrealizedPct, not premium math');
  }
  if (trade.entry_premium == null || trade.contracts == null) {
    throw new Error('computeOptionLivePnl: missing entry_premium or contracts');
  }
  const contracts = trade.contracts;
  const entry = trade.entry_premium;
  const costBasis = entry * contracts * 100;
  const marketValue = currentPremium * contracts * 100;

  // Sign flip for short options: writer profits when premium decays.
  const rawPnl = trade.side === 'long'
    ? marketValue - costBasis
    : costBasis - marketValue;

  const pct = costBasis > 0 ? (rawPnl / costBasis) * 100 : 0;
  return {
    live_pnl_pct: +pct.toFixed(3),
    live_pnl_usd: +rawPnl.toFixed(2),
    mark_premium: currentPremium,
    mark_source: 'nbbo_mid', // caller may overwrite; we default here
  };
}

/**
 * Convenience wrapper — pick the mark from a chain row, then compute P&L.
 * Returns null if entry_premium/contracts are missing (trade data incomplete).
 */
export function computeOptionLivePnlFromChainRow(
  trade: OptionTradeLike,
  row: OptionChainRow,
): OptionLivePnl | null {
  if (trade.entry_premium == null || trade.contracts == null) return null;
  const { premium, source } = pickMarkPremium(row);
  const pnl = computeOptionLivePnl(trade, premium);
  pnl.mark_source = source;
  return pnl;
}

/**
 * True if the option has already expired (expiry < today, UTC date).
 * Expired contracts are excluded from live P&L refresh — the last mark is
 * sticky and the UI should render them as "expired" using existing close
 * logic at EOD settlement. YYYY-MM-DD string compare works because both
 * sides are ISO date strings.
 */
export function isExpired(trade: OptionTradeLike, now: Date = new Date()): boolean {
  if (!trade.expiry) return false;
  const today = now.toISOString().slice(0, 10);
  return trade.expiry.slice(0, 10) < today;
}
