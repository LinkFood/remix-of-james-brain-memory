/**
 * concentration — portfolio concentration gate for the $10k paper book.
 *
 * checkConcentration() is called by every path that can open a new trade
 * (ct-claude-trade-open, ct-alert-book-commit, ct-chat commit_manual_trade).
 * It pulls all CURRENT open trades from ct_trades, projects what the book
 * would look like with the new trade added, and rejects if any of the
 * four ct_config thresholds would be breached:
 *
 *   concentration.max_ticker_pct            (default 40)
 *   concentration.max_theme_pct             (default 60)
 *   concentration.max_direction_pct         (default 80)
 *   concentration.max_concurrent_options_trades (default 2)
 *
 * Failure mode: { passed: false, reason } — caller is expected to SKIP
 * the insert + log + Slack. We never raise and never close existing
 * positions. If a limit is later tightened and the live book already
 * exceeds it, those trades stay open (only NEW commits are gated).
 *
 * Options sizing: option rows are inserted with size_pct=0 because the
 * RPC accounts on premium. For concentration we use size_usd / book_equity
 * * 100 so options still count against the ticker cap. They do NOT count
 * toward theme or direction caps (options positions don't map cleanly to
 * a directional dollar exposure — the Greeks matter).
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { getConfig } from './configCache.ts';

const DEFAULT_BOOK_EQUITY_USD = 10_000;
const DEFAULT_MAX_TICKER_PCT           = 40;
const DEFAULT_MAX_THEME_PCT            = 60;
const DEFAULT_MAX_DIRECTION_PCT        = 80;
const DEFAULT_MAX_CONCURRENT_OPTIONS   =  2;

export interface ProposedTrade {
  instrument:     string;
  side:           'long' | 'short';
  size_pct:       number;            // underlying: the % of book; options: 0
  thesis_theme?:  string | null;     // from classifyThesis(); 'other' if unknown
  contract_type?: 'underlying' | 'call' | 'put';
  size_usd?:      number | null;     // required for options (premium * contracts * 100)
}

export interface ConcentrationReport {
  passed:    boolean;
  reason?:   string;
  // current_* are the pre-trade state. projected_* include the new trade.
  current:   {
    ticker_pct:  Record<string, number>;
    theme_pct:   Record<string, number>;
    long_pct:    number;
    short_pct:   number;
    options_open: number;
  };
  projected: {
    ticker_pct:  Record<string, number>;
    theme_pct:   Record<string, number>;
    long_pct:    number;
    short_pct:   number;
    options_open: number;
  };
  limits: {
    max_ticker_pct:        number;
    max_theme_pct:         number;
    max_direction_pct:     number;
    max_concurrent_options: number;
  };
}

interface OpenTradeRow {
  instrument:     string;
  side:           'long' | 'short';
  size_pct:       number | null;
  size_usd:       number | null;
  thesis_theme:   string | null;
  contract_type:  string | null;
  status:         string | null;
}

/**
 * Convert a trade row into the percent-of-book it consumes for the
 * ticker cap. Underlying trades just return size_pct. Options return
 * size_usd / bookEquity * 100. Falls back to 0 on bad data.
 */
function tradePctOfBook(row: { size_pct: number | null; size_usd: number | null; contract_type: string | null }, bookEquity: number): number {
  const ct = (row.contract_type ?? 'underlying').toLowerCase();
  if (ct === 'underlying') {
    return Number(row.size_pct ?? 0);
  }
  // Options: accounted on premium.
  if (!row.size_usd || bookEquity <= 0) return 0;
  return (Number(row.size_usd) / bookEquity) * 100;
}

/**
 * Pull today's book starting balance. Falls back to $10k so this helper
 * never throws if ct_book is empty (e.g., a brand-new deployment before
 * ct-claude-trade-open has run).
 */
async function getBookEquity(supabase: SupabaseClient): Promise<number> {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const { data } = await supabase
      .from('ct_book')
      .select('starting_balance')
      .eq('session_date', today)
      .maybeSingle();
    const sb = (data as { starting_balance?: number } | null)?.starting_balance;
    return sb && sb > 0 ? Number(sb) : DEFAULT_BOOK_EQUITY_USD;
  } catch {
    return DEFAULT_BOOK_EQUITY_USD;
  }
}

/**
 * Sum a {key: pct} map by incrementing a single key.
 */
function addTo(map: Record<string, number>, key: string, pct: number): void {
  map[key] = (map[key] ?? 0) + pct;
}

/**
 * Round to 1 decimal for cleaner Slack/log messages. Internal math stays
 * full-precision; we only round for reasons strings.
 */
function r1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Main entry point. Returns a fully-populated report in both pass and
 * fail cases so callers can log "current=X, limit=Y, projected=Z".
 */
export async function checkConcentration(
  supabase: SupabaseClient,
  newTrade: ProposedTrade,
): Promise<ConcentrationReport> {
  // Pull limits + book equity in parallel — all have fallbacks so we never
  // throw on missing config.
  const [
    maxTickerPct,
    maxThemePct,
    maxDirectionPct,
    maxConcurrentOptions,
    bookEquity,
  ] = await Promise.all([
    getConfig<number>('concentration.max_ticker_pct',            DEFAULT_MAX_TICKER_PCT),
    getConfig<number>('concentration.max_theme_pct',             DEFAULT_MAX_THEME_PCT),
    getConfig<number>('concentration.max_direction_pct',         DEFAULT_MAX_DIRECTION_PCT),
    getConfig<number>('concentration.max_concurrent_options_trades', DEFAULT_MAX_CONCURRENT_OPTIONS),
    getBookEquity(supabase),
  ]);

  const limits = {
    max_ticker_pct:        maxTickerPct,
    max_theme_pct:         maxThemePct,
    max_direction_pct:     maxDirectionPct,
    max_concurrent_options: maxConcurrentOptions,
  };

  // Pull all open trades — planned and open both count against the book.
  // cancelled/closed do not.
  const { data: openRows, error } = await supabase
    .from('ct_trades')
    .select('instrument, side, size_pct, size_usd, thesis_theme, contract_type, status')
    .in('status', ['planned', 'open']);

  const rows = (error ? [] : (openRows ?? [])) as OpenTradeRow[];

  // Build current state.
  const current = {
    ticker_pct:   {} as Record<string, number>,
    theme_pct:    {} as Record<string, number>,
    long_pct:     0,
    short_pct:    0,
    options_open: 0,
  };
  for (const r of rows) {
    const instrument = (r.instrument ?? '').toUpperCase();
    const ct = (r.contract_type ?? 'underlying').toLowerCase();
    const pct = tradePctOfBook(r, bookEquity);
    if (instrument && pct > 0) addTo(current.ticker_pct, instrument, pct);
    // Theme + direction caps apply only to underlying trades (options don't
    // map cleanly to directional dollar exposure — the Greeks matter).
    if (ct === 'underlying' && pct > 0) {
      const theme = r.thesis_theme ?? 'other';
      addTo(current.theme_pct, theme, pct);
      if (r.side === 'long')  current.long_pct  += pct;
      if (r.side === 'short') current.short_pct += pct;
    }
    if (ct === 'call' || ct === 'put') current.options_open += 1;
  }

  // Project the new trade onto that state.
  const projected = {
    ticker_pct:   { ...current.ticker_pct },
    theme_pct:    { ...current.theme_pct },
    long_pct:     current.long_pct,
    short_pct:    current.short_pct,
    options_open: current.options_open,
  };

  const newInstrument   = (newTrade.instrument ?? '').toUpperCase();
  const newContractType = (newTrade.contract_type ?? 'underlying').toLowerCase();
  const newTheme        = newTrade.thesis_theme ?? 'other';

  let newPct = 0;
  if (newContractType === 'underlying') {
    newPct = Number(newTrade.size_pct ?? 0);
  } else if (newTrade.size_usd && bookEquity > 0) {
    newPct = (Number(newTrade.size_usd) / bookEquity) * 100;
  }

  if (newInstrument && newPct > 0) addTo(projected.ticker_pct, newInstrument, newPct);
  if (newContractType === 'underlying' && newPct > 0) {
    addTo(projected.theme_pct, newTheme, newPct);
    if (newTrade.side === 'long')  projected.long_pct  += newPct;
    if (newTrade.side === 'short') projected.short_pct += newPct;
  }
  if (newContractType === 'call' || newContractType === 'put') {
    projected.options_open += 1;
  }

  // Check — fail on first breach.

  // 1. Options count cap (cheapest check first).
  if (projected.options_open > limits.max_concurrent_options) {
    return {
      passed: false,
      reason: `would breach max_concurrent_options_trades: ${projected.options_open} > ${limits.max_concurrent_options} limit`,
      current, projected, limits,
    };
  }

  // 2. Ticker cap — any instrument above the ticker limit after the new trade.
  for (const [tkr, pct] of Object.entries(projected.ticker_pct)) {
    if (pct > limits.max_ticker_pct) {
      return {
        passed: false,
        reason: `would breach max_ticker_pct: ${tkr} at ${r1(pct)}% > ${limits.max_ticker_pct}% limit`,
        current, projected, limits,
      };
    }
  }

  // 3. Theme cap.
  for (const [theme, pct] of Object.entries(projected.theme_pct)) {
    if (pct > limits.max_theme_pct) {
      return {
        passed: false,
        reason: `would breach max_theme_pct: ${theme} at ${r1(pct)}% > ${limits.max_theme_pct}% limit`,
        current, projected, limits,
      };
    }
  }

  // 4. Direction cap — long OR short (whichever the new trade leans toward
  // matters first, but we check both so a mixed book is still enforced).
  if (projected.long_pct > limits.max_direction_pct) {
    return {
      passed: false,
      reason: `would breach max_direction_pct: long at ${r1(projected.long_pct)}% > ${limits.max_direction_pct}% limit`,
      current, projected, limits,
    };
  }
  if (projected.short_pct > limits.max_direction_pct) {
    return {
      passed: false,
      reason: `would breach max_direction_pct: short at ${r1(projected.short_pct)}% > ${limits.max_direction_pct}% limit`,
      current, projected, limits,
    };
  }

  return { passed: true, current, projected, limits };
}
