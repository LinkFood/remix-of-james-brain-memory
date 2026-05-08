/**
 * prevCloseContext — explicit, labeled "previous close" anchor per ticker.
 *
 * Resolves the 2026-05-07 GOOGL chat incident: chat answered
 * "GOOGL down -0.5% (398.2 → 396)" using today's RTH-open 1m bar close
 * (398.195) as the "before" anchor. True prev close was 397.91 (5/6 RTH
 * last bar) → correct % change vs prev close = -0.33% (TrendSpider showed
 * -0.22% against their slightly different reference).
 *
 * Phase A traced the bug to the LLM-prompt layer: the brain handed the LLM
 * `spot` (current value) plus active_brief rationale text containing inline
 * historical price strings, but NO structured prev_close field. The LLM
 * picked an anchor from whatever it saw and computed % change itself —
 * guessing wrong. Eliminating the guess requires giving the LLM an explicit
 * labeled prev_close.
 *
 * Source: ct_price_bars timeframe='1m', latest bar with ts < today's RTH
 * open (13:30 UTC). When called pre-13:30 UTC, the function reaches back
 * one trading day so the anchor is always the most-recent COMPLETED RTH
 * session's close.
 *
 * Bundle Phase 2 organMetadata-shape: every entry carries (value, as_of,
 * source, status) so consumers can disambiguate populated / data_missing
 * / error states without guessing.
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import type { OrganStatus } from './contextHelper.ts';

export interface PrevCloseEntry {
  /** Last close price strictly before today's RTH open (13:30 UTC). */
  value: number | null;
  /** ISO 8601 timestamp of the bar used. */
  as_of: string | null;
  /** Producer identifier for traceability. */
  source: string;
  /** Semantic state per OrganStatus enum. */
  status: OrganStatus;
}

export type PrevCloseByTicker = Record<string, PrevCloseEntry>;

const HELPER_SOURCE = 'ct_price_bars:1m@last_pre_session';

/**
 * Compute the cutoff timestamp: today's UTC midnight (00:00 UTC of current
 * UTC date). The latest 1m bar with `ts < cutoff` is the prior trading day's
 * last bar.
 *
 * Why UTC-midnight not RTH-open: filtering by RTH-open (13:30 UTC) would
 * include today's pre-market bars (8:00-13:29 UTC) which Yahoo backfills
 * at the first RTH-cron fire of the day. UTC-midnight cleanly excludes
 * everything from today's UTC calendar day. On Monday morning, this returns
 * Friday's last bar (Sat/Sun have no fires). On the day after a holiday,
 * returns the most recent trading day's last bar — same desired semantic.
 *
 * Edge case: at 00:00:00 UTC exactly, cutoff = current second; previous
 * day's last bar is still selected. Acceptable.
 */
function computePrevSessionCutoff(now: Date): Date {
  return new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    0, 0, 0,
  ));
}

export async function loadPrevCloseByTicker(
  supabase: SupabaseClient,
  tickers: readonly string[],
): Promise<PrevCloseByTicker> {
  const result: PrevCloseByTicker = {};
  if (tickers.length === 0) return result;

  const cutoffIso = computePrevSessionCutoff(new Date()).toISOString();

  await Promise.all(tickers.map(async (ticker) => {
    try {
      const { data, error } = await supabase
        .from('ct_price_bars')
        .select('ts, close')
        .eq('ticker', ticker)
        .eq('timeframe', '1m')
        .lt('ts', cutoffIso)
        .order('ts', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error || !data) {
        result[ticker] = {
          value: null,
          as_of: null,
          source: HELPER_SOURCE,
          status: 'data_missing' as OrganStatus,
        };
        return;
      }
      const closeNum = data.close == null ? null : Number(data.close);
      result[ticker] = {
        value: closeNum != null && Number.isFinite(closeNum) ? closeNum : null,
        as_of: typeof data.ts === 'string' ? data.ts : null,
        source: HELPER_SOURCE,
        status: closeNum != null && Number.isFinite(closeNum)
          ? ('populated' as OrganStatus)
          : ('data_missing' as OrganStatus),
      };
    } catch (_e) {
      result[ticker] = {
        value: null,
        as_of: null,
        source: HELPER_SOURCE,
        status: 'error' as OrganStatus,
      };
    }
  }));

  return result;
}
