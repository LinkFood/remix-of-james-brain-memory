/**
 * eventRecencyContext — brain organ exposing what events have already fired,
 * what is firing today, and what is upcoming over the next 14 days.
 *
 * **P0 STRUCTURAL HALLUCINATION FIX (Phase 1).** Pairs with `temporalContext`.
 * The temporal anchor tells Claude what the date is. This helper tells Claude
 * what has *already happened* with what *outcomes* — the structural complement
 * that kills the "watching for Powell speech today" hallucination class when
 * the speech actually happened yesterday.
 *
 * Sources (read-only):
 *   • ct_events              — earnings / FDA / econ calendar
 *   • ct_earnings_moves      — historical day-after move cache (sparse)
 *   • ct_breaking_news       — Tavily / UW news watcher hits with severity
 *   • ct_central_bank_rates  — daily snapshot of central-bank state per country
 *
 * NOTE on table naming: the audit doc references "ct_central_bank_state" —
 * actual shipped table is `ct_central_bank_rates` (migration
 * 20260422000018_ct_ingester_tables_n2.sql). Spec corrected to live schema.
 *
 * Three buckets:
 *   • just_happened    — last 72h with outcome data (the hallucination shield)
 *   • happening_today  — events whose date == sessionDate (NY tz)
 *   • upcoming         — next 14 calendar days
 *
 * Audience filter: undefined (all audiences). Dependencies: none.
 *
 * Read-only. Never throws. Defensive empty `data` on any error.
 *
 * File split (architecture rule 4 — single file ≤300 lines):
 *   • eventRecencyTypes.ts      — public TS surface
 *   • eventRecencyDates.ts      — NY-tz date utilities
 *   • eventRecencyNormalize.ts  — row → RecencyEvent normalizers
 *   • eventRecencyFetch.ts      — source fetch + bucket assembly + ranking
 *   • eventRecencyFormat.ts     — formatWhatJustHappened()
 *
 * @see contextHelper.ts                    — the contract this implements
 * @see temporalContext.ts                  — sibling preamble pattern
 * @see docs/SYNTHESIS_LAYER_AUDIT.md §5f   — this helper's spec
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import type {
  ContextHelper,
  HelperDescription,
  HelperFetchContext,
  HelperOpts,
  HelperResult,
  OrganMetadata,
  OrganStatus,
} from './contextHelper.ts';
import type { EventRecencyResult } from './eventRecencyTypes.ts';
import { addCalendarDays, formatNyDate } from './eventRecencyDates.ts';
import { assembleBuckets, fetchAllSources, sortAndCap } from './eventRecencyFetch.ts';

// Re-exports — keep this module the canonical entry point.
export type { EventCategory, EventRecencyResult, RecencyEvent } from './eventRecencyTypes.ts';
export { formatWhatJustHappened } from './eventRecencyFormat.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HELPER_NAME = 'event_recency';
const HELPER_VERSION = 'v1';
/** Per-ticker per-bucket cap. Audit spec: top 5 per bucket per ticker. */
const DEFAULT_CAP = 5;
/** Market-wide per-bucket cap. Audit spec: top 10 per bucket. */
const MARKET_WIDE_CAP = 10;
/** Forward window for upcoming. */
const UPCOMING_DAYS = 14;

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function buildOrganMetadata(
  asOf: string,
  sessionDate: string,
  status: OrganStatus,
): OrganMetadata {
  return {
    as_of: asOf,
    source: '_shared/eventRecencyContext.ts / ct_events + ct_earnings_moves + ct_breaking_news + ct_central_bank_rates',
    window: `session_date=${sessionDate}, lookback 72h + happening_today + upcoming ${UPCOMING_DAYS}d`,
    status,
  };
}

function emptyResult(
  reason: string,
  latencyMs: number,
  sessionDate: string,
  status: OrganStatus = 'no_signal_detected',
): HelperResult<EventRecencyResult> {
  const asOf = new Date().toISOString();
  return {
    data: {
      session_date: sessionDate,
      per_ticker: [],
      market_wide: { just_happened: [], happening_today: [], upcoming: [] },
      generated_at: asOf,
    },
    meta: {
      helperName: HELPER_NAME,
      helperVersion: HELPER_VERSION,
      fetchedAt: asOf,
      rowCount: 0,
      cacheHit: false,
      latencyMs,
      truncated: false,
      warning: reason,
    },
    organMetadata: buildOrganMetadata(asOf, sessionDate, status),
  };
}

// ---------------------------------------------------------------------------
// fetch()
// ---------------------------------------------------------------------------

async function fetchEventRecency(
  ctx: HelperFetchContext,
  opts: HelperOpts,
): Promise<HelperResult<EventRecencyResult>> {
  const start = Date.now();
  const sessionDate = ctx.sessionDate;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sessionDate)) {
    return emptyResult('invalid_session_date', Date.now() - start, sessionDate || '', 'error');
  }

  const perTickerCap = Math.max(1, opts.cap ?? DEFAULT_CAP);
  const lookbackDate = addCalendarDays(sessionDate, -3) ?? sessionDate;
  const upcomingDate = addCalendarDays(sessionDate, UPCOMING_DAYS) ?? sessionDate;
  const watchlistUpper = ctx.watchlist.map((t: string) => t.toUpperCase());
  const tickerFocus = opts.tickerFocus?.toUpperCase();
  const tickersInScope = tickerFocus
    ? [tickerFocus]
    : watchlistUpper.length > 0
      ? watchlistUpper
      : null;

  try {
    const allEvents = await fetchAllSources(ctx.supabase, lookbackDate, upcomingDate, sessionDate);
    const { perTicker, market } = assembleBuckets(allEvents, sessionDate, tickersInScope);

    let truncated = false;
    const per_ticker: EventRecencyResult['per_ticker'] = [];
    const orderedTickers = tickersInScope ?? Array.from(perTicker.keys()).sort();
    for (const t of orderedTickers) {
      const b = perTicker.get(t);
      if (!b) continue;
      const jh = sortAndCap(b.just_happened, perTickerCap);
      const ht = sortAndCap(b.happening_today, perTickerCap);
      const up = sortAndCap(b.upcoming, perTickerCap);
      truncated = truncated || jh.truncated || ht.truncated || up.truncated;
      per_ticker.push({ ticker: t, just_happened: jh.capped, happening_today: ht.capped, upcoming: up.capped });
    }
    const mwJh = sortAndCap(market.just_happened, MARKET_WIDE_CAP);
    const mwHt = sortAndCap(market.happening_today, MARKET_WIDE_CAP);
    const mwUp = sortAndCap(market.upcoming, MARKET_WIDE_CAP);
    truncated = truncated || mwJh.truncated || mwHt.truncated || mwUp.truncated;

    const totalRows =
      per_ticker.reduce(
        (s, p) => s + p.just_happened.length + p.happening_today.length + p.upcoming.length,
        0,
      ) +
      mwJh.capped.length + mwHt.capped.length + mwUp.capped.length;

    const asOf = new Date().toISOString();
    return {
      data: {
        session_date: sessionDate,
        per_ticker,
        market_wide: { just_happened: mwJh.capped, happening_today: mwHt.capped, upcoming: mwUp.capped },
        generated_at: asOf,
      },
      meta: {
        helperName: HELPER_NAME,
        helperVersion: HELPER_VERSION,
        fetchedAt: asOf,
        rowCount: totalRows,
        cacheHit: false,
        latencyMs: Date.now() - start,
        truncated,
      },
      organMetadata: buildOrganMetadata(
        asOf,
        sessionDate,
        totalRows > 0 ? 'populated' : 'no_signal_detected',
      ),
    };
  } catch (e) {
    return emptyResult(
      `exception:${e instanceof Error ? e.message : String(e)}`,
      Date.now() - start,
      sessionDate,
      'error',
    );
  }
}

// ---------------------------------------------------------------------------
// Default export — ContextHelper instance
// ---------------------------------------------------------------------------

const eventRecencyContextHelper: ContextHelper<EventRecencyResult> = {
  name: HELPER_NAME,
  version: HELPER_VERSION,
  defaultCap: DEFAULT_CAP,
  isExpensive: false,
  minRefreshSeconds: 300,
  dependencies: [],
  // audienceFilter undefined — every audience needs to know what just happened.
  fetch: fetchEventRecency,
  describe(): HelperDescription {
    return {
      name: HELPER_NAME,
      version: HELPER_VERSION,
      defaultCap: DEFAULT_CAP,
      expensive: false,
      minRefreshSeconds: 300,
      dependencies: [],
      outputShape:
        'Three temporal buckets per ticker AND market-wide: just_happened (last 72h with outcomes — earnings prints, FOMC decisions, CPI/jobs prints, breaking news), happening_today (events on session_date), upcoming (next 14d). Each event carries source + category + outcome blob. Structural complement to temporalContext: kills the "watching for Powell speech today" hallucination class when the event already fired.',
    };
  },
};

export default eventRecencyContextHelper;

// ---------------------------------------------------------------------------
// Named convenience export
// ---------------------------------------------------------------------------

export interface GetEventRecencyContextOpts extends HelperOpts {
  watchlist?: readonly string[];
  audience?: HelperFetchContext['audience'];
  sessionDate?: string;
  consumerName?: string;
}

/** Direct invoke. Wraps the helper's fetch + returns the unwrapped data. */
export async function getEventRecencyContext(
  supabase: SupabaseClient,
  opts: GetEventRecencyContextOpts = {},
): Promise<EventRecencyResult> {
  const ctx: HelperFetchContext = {
    supabase,
    audience: opts.audience ?? 'cotrader',
    sessionDate: opts.sessionDate ?? formatNyDate(new Date()),
    watchlist: opts.watchlist ?? [],
    consumerName: opts.consumerName ?? 'unknown',
  };
  const result = await eventRecencyContextHelper.fetch(ctx, opts);
  return result.data;
}
