/**
 * eventRecencyFetch — internal source-fetch + bucket-assembly for
 * `eventRecencyContext`. Split out to keep the main helper file ≤300 lines
 * per architecture rule 4.
 *
 * Read-only consumer of:
 *   • ct_events, ct_earnings_moves, ct_breaking_news, ct_central_bank_rates
 *
 * @internal — only `eventRecencyContext.ts` should import from this file.
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import type { RecencyEvent } from './eventRecencyTypes.ts';
import { daysBetween, nyMidday } from './eventRecencyDates.ts';
import {
  type CtBreakingNewsRow,
  type CtCentralBankRateRow,
  type CtEarningsMoveRow,
  type CtEventRow,
  normalizeBreakingNews,
  normalizeCentralBankRate,
  normalizeCtEvent,
  normalizeEarningsMove,
} from './eventRecencyNormalize.ts';

const JUST_HAPPENED_HOURS = 72;
const UPCOMING_DAYS = 14;

export interface Buckets {
  just_happened: RecencyEvent[];
  happening_today: RecencyEvent[];
  upcoming: RecencyEvent[];
}

const emptyBuckets = (): Buckets => ({
  just_happened: [],
  happening_today: [],
  upcoming: [],
});

// ---------------------------------------------------------------------------
// Bucket classification + ranking
// ---------------------------------------------------------------------------

export function classifyBucket(
  e: RecencyEvent,
  sessionDate: string,
  nowMs: number,
): 'just_happened' | 'happening_today' | 'upcoming' | null {
  if (!e.event_date) return null;
  if (e.event_date === sessionDate) return 'happening_today';
  const delta = daysBetween(sessionDate, e.event_date);
  if (delta === null) return null;
  if (delta < 0) {
    const cutoff = nowMs - JUST_HAPPENED_HOURS * 3600 * 1000;
    const evtMs = e.event_iso ? Date.parse(e.event_iso) : nyMidday(e.event_date)?.getTime() ?? NaN;
    return Number.isFinite(evtMs) && evtMs >= cutoff ? 'just_happened' : null;
  }
  if (delta > 0 && delta <= UPCOMING_DAYS) return 'upcoming';
  return null;
}

export function rankEvent(e: RecencyEvent): number {
  let score = 0;
  if (e.has_outcome) score += 50;
  if (typeof e.importance === 'number') score += e.importance * 10;
  if (e.category === 'earnings' && e.outcome?.actual_eps != null) score += 30;
  if (e.category === 'central_bank') score += 20;
  if (e.category === 'news') score += (e.importance ?? 0) * 5;
  return score;
}

export function sortAndCap(
  arr: RecencyEvent[],
  cap: number,
): { capped: RecencyEvent[]; truncated: boolean } {
  const sorted = [...arr].sort((a, b) => rankEvent(b) - rankEvent(a));
  const seen = new Set<string>();
  const deduped: RecencyEvent[] = [];
  for (const e of sorted) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    deduped.push(e);
  }
  return { capped: deduped.slice(0, cap), truncated: deduped.length > cap };
}

// ---------------------------------------------------------------------------
// Source fetch
// ---------------------------------------------------------------------------

export async function fetchAllSources(
  supabase: SupabaseClient,
  lookbackDate: string,
  upcomingDate: string,
  sessionDate: string,
): Promise<RecencyEvent[]> {
  const newsCutoffIso = new Date(Date.now() - 96 * 3600 * 1000).toISOString();
  const [eventsRes, earningsRes, newsRes, cbRes] = await Promise.all([
    supabase
      .from('ct_events')
      .select('id, event_type, ticker, event_date, event_time, title, importance, raw')
      .gte('event_date', lookbackDate)
      .lte('event_date', upcomingDate)
      .order('event_date', { ascending: true })
      .limit(400),
    supabase
      .from('ct_earnings_moves')
      .select('id, ticker, report_date, move_pct, move_direction, beat_miss, surprise_pct, reason, captured_at')
      .gte('report_date', lookbackDate)
      .lte('report_date', sessionDate)
      .order('report_date', { ascending: false })
      .limit(60),
    supabase
      .from('ct_breaking_news')
      .select('id, headline, severity, sentiment, tickers_affected, macro_wide, category, summary, published_at, ingested_at')
      .gte('ingested_at', newsCutoffIso)
      .order('severity', { ascending: false })
      .order('ingested_at', { ascending: false })
      .limit(60),
    supabase
      .from('ct_central_bank_rates')
      .select('id, capture_date, country_code, rate, direction_trend, next_meeting_date, expected_move_bps')
      .gte('capture_date', lookbackDate)
      .order('capture_date', { ascending: false })
      .limit(40),
  ]);

  const all: RecencyEvent[] = [];
  if (!eventsRes.error && Array.isArray(eventsRes.data)) {
    for (const r of eventsRes.data as CtEventRow[]) all.push(normalizeCtEvent(r));
  }
  if (!earningsRes.error && Array.isArray(earningsRes.data)) {
    for (const r of earningsRes.data as CtEarningsMoveRow[]) all.push(normalizeEarningsMove(r));
  }
  if (!newsRes.error && Array.isArray(newsRes.data)) {
    for (const r of newsRes.data as CtBreakingNewsRow[]) all.push(normalizeBreakingNews(r));
  }
  if (!cbRes.error && Array.isArray(cbRes.data)) {
    const seenCountries = new Set<string>();
    for (const r of cbRes.data as CtCentralBankRateRow[]) {
      if (seenCountries.has(r.country_code)) continue;
      seenCountries.add(r.country_code);
      all.push(normalizeCentralBankRate(r));
    }
  }
  return all;
}

// ---------------------------------------------------------------------------
// Bucket assembly (per-ticker + market-wide)
// ---------------------------------------------------------------------------

export function assembleBuckets(
  allEvents: RecencyEvent[],
  sessionDate: string,
  tickersInScope: string[] | null,
): { perTicker: Map<string, Buckets>; market: Buckets } {
  const nowMs = Date.now();
  const perTicker = new Map<string, Buckets>();
  const market = emptyBuckets();

  for (const evt of allEvents) {
    const bucket = classifyBucket(evt, sessionDate, nowMs);
    if (!bucket) continue;

    const isMacroEcon = evt.category === 'econ' || evt.category === 'central_bank';
    const isMarketWideNews =
      evt.source === 'ct_breaking_news' &&
      (evt.tickers_affected.length === 0 || evt.tickers_affected.length >= 4);
    const goesMarketWide = isMacroEcon || isMarketWideNews;
    if (goesMarketWide) market[bucket].push(evt);

    const targets = evt.tickers_affected.filter(
      (t) => !tickersInScope || tickersInScope.includes(t),
    );
    const macroFanout = goesMarketWide && tickersInScope ? tickersInScope : [];
    const allTargets = new Set<string>([...targets, ...macroFanout]);
    if (allTargets.size === 0 && evt.tickers_affected.length > 0 && !tickersInScope) {
      for (const t of evt.tickers_affected) allTargets.add(t);
    }

    for (const t of allTargets) {
      if (!perTicker.has(t)) perTicker.set(t, emptyBuckets());
      perTicker.get(t)![bucket].push(evt);
    }
  }
  return { perTicker, market };
}
