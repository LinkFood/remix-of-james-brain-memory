/**
 * dteEligibility — per-ticker 0DTE awareness for the signature watcher and
 * specialist prompts.
 *
 * Source of truth: ct_config.ticker_dte_eligibility (jsonb keyed by ticker).
 * Three shapes:
 *   - daily_0dte: true            → always 0DTE-eligible (SPY/QQQ/IWM)
 *   - weekly_friday_0dte: true    → 0DTE only on Fridays (NVDA)
 *   - both flags false            → never 0DTE (AAPL/MSFT/GOOGL/AMZN/META/TSLA)
 *
 * See migration 20260427000050_dte_eligibility.sql.
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';

export type DteEligibility = {
  daily_0dte: boolean;
  weekly_friday_0dte?: boolean;
  label: string;
};

export type DteEligibilityMap = Record<string, DteEligibility>;

/** True iff the ticker has a 0DTE-tradable expiry on the given UTC date. */
export function ticker0DteEligibleOn(
  ticker: string,
  eligibility: DteEligibilityMap,
  date: Date,
): boolean {
  const cfg = eligibility[ticker];
  if (!cfg) return false;
  if (cfg.daily_0dte) return true;
  // UTC dayOfWeek 5 == Friday. Specialist runs and watcher both reason in UTC.
  if (cfg.weekly_friday_0dte && date.getUTCDay() === 5) return true;
  return false;
}

/** Earliest 0DTE-tradable date on/after `from` for this ticker, or null if never. */
export function nextEligible0DteDate(
  ticker: string,
  eligibility: DteEligibilityMap,
  from: Date,
): Date | null {
  const cfg = eligibility[ticker];
  if (!cfg) return null;
  if (cfg.daily_0dte) return from;
  if (cfg.weekly_friday_0dte) {
    // Walk forward to the next Friday (UTC).
    const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
    for (let i = 0; i < 7; i++) {
      if (d.getUTCDay() === 5) return d;
      d.setUTCDate(d.getUTCDate() + 1);
    }
  }
  return null;
}

/** Next Friday (UTC) on/after `from` — used for "earliest weekly expiry" messaging. */
export function nextFridayOn(from: Date): Date {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  for (let i = 0; i < 7; i++) {
    if (d.getUTCDay() === 5) return d;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return d;
}

export async function loadDteEligibility(
  supabase: SupabaseClient,
): Promise<DteEligibilityMap> {
  const { data, error } = await supabase
    .from('ct_config')
    .select('value')
    .eq('key', 'ticker_dte_eligibility')
    .maybeSingle();
  if (error || !data?.value) return {};
  return (data.value ?? {}) as DteEligibilityMap;
}
