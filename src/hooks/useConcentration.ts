/**
 * useConcentration — client-side concentration snapshot for the /book
 * ConcentrationPanel.
 *
 * Pulls open ct_trades + four ct_config concentration caps and computes:
 *   - ticker_pct: { SPY: 22, NVDA: 38, ... }   one row per ticker (open only)
 *   - theme_pct : { convergence: 40, ... }     underlying trades only
 *   - long_pct  : number                       sum of long underlying size_pct
 *   - short_pct : number                       sum of short underlying size_pct
 *   - options_open: count of open call+put rows
 *
 * Options contribute to ticker_pct as size_usd / book_equity * 100
 * (same logic as _shared/concentration.ts), but they do NOT count toward
 * theme / direction caps — options don't map cleanly to directional
 * dollar exposure (Greeks matter).
 *
 * Refetch every 60s. Limits are tunable via /ct-settings (ct_config
 * category 'concentration'); changes propagate within the poll window.
 */

import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export const CONCENTRATION_KEYS = [
  'concentration.max_ticker_pct',
  'concentration.max_theme_pct',
  'concentration.max_direction_pct',
  'concentration.max_concurrent_options_trades',
] as const;

export const CONCENTRATION_DEFAULTS = {
  max_ticker_pct:         40,
  max_theme_pct:          60,
  max_direction_pct:      80,
  max_concurrent_options: 2,
} as const;

const DEFAULT_BOOK_EQUITY_USD = 10_000;

export interface ConcentrationSnapshot {
  ticker_pct:   Record<string, number>;
  theme_pct:    Record<string, number>;
  long_pct:     number;
  short_pct:    number;
  options_open: number;
  book_equity:  number;
  limits: {
    max_ticker_pct:         number;
    max_theme_pct:          number;
    max_direction_pct:      number;
    max_concurrent_options: number;
  };
  // For per-ticker bars — we want side info so the bar can color long/short.
  ticker_rows: Array<{ instrument: string; pct: number; side: 'long' | 'short' | 'mixed'; is_option: boolean }>;
}

interface OpenRow {
  instrument:    string;
  side:          'long' | 'short';
  size_pct:      number | null;
  size_usd:      number | null;
  thesis_theme:  string | null;
  contract_type: 'underlying' | 'call' | 'put' | null;
}

function tradePct(r: OpenRow, bookEquity: number): number {
  const ct = (r.contract_type ?? 'underlying');
  if (ct === 'underlying') return Number(r.size_pct ?? 0);
  if (!r.size_usd || bookEquity <= 0) return 0;
  return (Number(r.size_usd) / bookEquity) * 100;
}

async function fetchConfigNumber(key: string, fallback: number): Promise<number> {
  try {
    const { data, error } = await supabase.rpc('ct_config_get', { p_key: key });
    if (error || data == null) return fallback;
    const n = Number(data);
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

async function fetchSnapshot(): Promise<ConcentrationSnapshot> {
  const today = new Date().toISOString().slice(0, 10);

  const [limits, openResult, bookResult] = await Promise.all([
    Promise.all([
      fetchConfigNumber('concentration.max_ticker_pct',            CONCENTRATION_DEFAULTS.max_ticker_pct),
      fetchConfigNumber('concentration.max_theme_pct',             CONCENTRATION_DEFAULTS.max_theme_pct),
      fetchConfigNumber('concentration.max_direction_pct',         CONCENTRATION_DEFAULTS.max_direction_pct),
      fetchConfigNumber('concentration.max_concurrent_options_trades', CONCENTRATION_DEFAULTS.max_concurrent_options),
    ]),
    supabase
      .from('ct_trades')
      .select('instrument, side, size_pct, size_usd, thesis_theme, contract_type, status')
      .in('status', ['planned', 'open']),
    supabase
      .from('ct_book')
      .select('starting_balance')
      .eq('session_date', today)
      .maybeSingle(),
  ]);

  const [maxTicker, maxTheme, maxDir, maxOpts] = limits;
  const bookEquity = Number(
    (bookResult.data as { starting_balance?: number } | null)?.starting_balance,
  ) || DEFAULT_BOOK_EQUITY_USD;

  const rows = (openResult.data ?? []) as OpenRow[];

  const ticker_pct: Record<string, number> = {};
  const theme_pct:  Record<string, number> = {};
  let long_pct  = 0;
  let short_pct = 0;
  let options_open = 0;
  // Collect side-per-ticker so the bar can show mixed books honestly.
  const tickerSides: Record<string, { long: number; short: number; hasOption: boolean }> = {};

  for (const r of rows) {
    const tkr = (r.instrument ?? '').toUpperCase();
    if (!tkr) continue;
    const ct  = r.contract_type ?? 'underlying';
    const pct = tradePct(r, bookEquity);

    if (pct > 0) {
      ticker_pct[tkr] = (ticker_pct[tkr] ?? 0) + pct;
      const bucket = (tickerSides[tkr] ||= { long: 0, short: 0, hasOption: false });
      if (ct === 'underlying') {
        if (r.side === 'long')  bucket.long  += pct;
        if (r.side === 'short') bucket.short += pct;
      } else {
        bucket.hasOption = true;
      }
    }

    if (ct === 'underlying' && pct > 0) {
      const th = r.thesis_theme ?? 'other';
      theme_pct[th] = (theme_pct[th] ?? 0) + pct;
      if (r.side === 'long')  long_pct  += pct;
      if (r.side === 'short') short_pct += pct;
    }
    if (ct === 'call' || ct === 'put') options_open += 1;
  }

  const ticker_rows = Object.entries(ticker_pct)
    .sort(([, a], [, b]) => b - a)
    .map(([instrument, pct]) => {
      const s = tickerSides[instrument] ?? { long: 0, short: 0, hasOption: false };
      const side: 'long' | 'short' | 'mixed' =
        s.long > 0 && s.short > 0 ? 'mixed'
          : s.long > 0 ? 'long'
          : s.short > 0 ? 'short'
          : 'long'; // pure-options default — display as long (could be either)
      return { instrument, pct, side, is_option: s.hasOption };
    });

  return {
    ticker_pct,
    theme_pct,
    long_pct,
    short_pct,
    options_open,
    book_equity: bookEquity,
    limits: {
      max_ticker_pct:         maxTicker,
      max_theme_pct:          maxTheme,
      max_direction_pct:      maxDir,
      max_concurrent_options: maxOpts,
    },
    ticker_rows,
  };
}

export function useConcentration() {
  return useQuery<ConcentrationSnapshot>({
    queryKey: ['ct_concentration_snapshot'],
    queryFn: fetchSnapshot,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}
