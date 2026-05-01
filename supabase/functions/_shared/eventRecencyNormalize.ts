/**
 * eventRecencyNormalize — row → RecencyEvent normalizers for the four
 * source tables consumed by `eventRecencyContext.ts`.
 *
 * Source tables (read-only):
 *   • ct_events              — earnings / FDA / econ calendar
 *   • ct_earnings_moves      — historical day-after move cache (sparse)
 *   • ct_breaking_news       — Tavily / UW news watcher hits with severity
 *   • ct_central_bank_rates  — daily snapshot of central-bank state per country
 *
 * NOTE: spec doc references `ct_central_bank_state` — actual shipped table is
 * `ct_central_bank_rates` (migration 20260422000018_ct_ingester_tables_n2.sql).
 *
 * Pure module — no DB, no side effects.
 *
 * @internal — only `eventRecencyContext.ts` should import from this file.
 */

import type { EventCategory, RecencyEvent } from './eventRecencyTypes.ts';
import { buildEventIso, nyDateFromIso } from './eventRecencyDates.ts';

// ---------------------------------------------------------------------------
// Source row types (PostgREST shape)
// ---------------------------------------------------------------------------

export interface CtEventRow {
  id: string;
  event_type: string | null;
  ticker: string | null;
  event_date: string;
  event_time: string | null;
  title: string | null;
  importance: number | null;
  raw: Record<string, unknown> | null;
}

export interface CtEarningsMoveRow {
  id: string;
  ticker: string;
  report_date: string;
  move_pct: number | null;
  move_direction: string | null;
  beat_miss: string | null;
  surprise_pct: number | null;
  reason: string | null;
  captured_at: string;
}

export interface CtBreakingNewsRow {
  id: string;
  headline: string;
  severity: number;
  sentiment: string | null;
  tickers_affected: string[] | null;
  macro_wide: boolean;
  category: string | null;
  summary: string | null;
  published_at: string | null;
  ingested_at: string;
}

export interface CtCentralBankRateRow {
  id: string;
  capture_date: string;
  country_code: string;
  rate: number | null;
  direction_trend: string | null;
  next_meeting_date: string | null;
  expected_move_bps: number | null;
}

// Macro/event types that are market-wide regardless of `ticker` column.
const MACRO_EVENT_TYPES = new Set([
  'econ',
  'macro',
  'fomc',
  'fed',
  'cpi',
  'ppi',
  'nfp',
  'gdp',
  'retail_sales',
]);

// ---------------------------------------------------------------------------
// Normalizers
// ---------------------------------------------------------------------------

export function normalizeCtEvent(row: CtEventRow): RecencyEvent {
  const eventType = (row.event_type ?? 'other').toLowerCase();
  const isMacro = MACRO_EVENT_TYPES.has(eventType);
  const category: EventCategory =
    eventType === 'earnings' ? 'earnings'
      : eventType === 'fda' ? 'fda'
        : isMacro ? 'econ'
          : 'other';
  const raw = row.raw ?? {};
  const outcome: Record<string, unknown> = {};
  if (category === 'earnings') {
    if (raw.actual_eps != null) outcome.actual_eps = raw.actual_eps;
    if (raw.street_mean_est != null) outcome.street_mean_est = raw.street_mean_est;
    if (raw.reaction != null) outcome.reaction = raw.reaction;
    if (raw.session != null) outcome.session = raw.session;
    if (raw.expected_move_perc != null) outcome.expected_move_perc = raw.expected_move_perc;
  } else if (category === 'econ') {
    const r = raw as Record<string, unknown>;
    if (r.actual != null) outcome.actual = r.actual;
    if (r.forecast != null) outcome.forecast = r.forecast;
    if (r.prev != null) outcome.prev = r.prev;
  }
  const hasOutcome = Object.keys(outcome).length > 0;
  return {
    id: row.id,
    source: 'ct_events',
    category,
    ticker: row.ticker,
    tickers_affected: row.ticker ? [row.ticker] : [],
    event_date: row.event_date,
    event_iso: buildEventIso(row.event_date, row.event_time),
    title: row.title ?? `${eventType} event`,
    outcome: hasOutcome ? outcome : null,
    importance: row.importance,
    has_outcome: hasOutcome,
  };
}

export function normalizeEarningsMove(row: CtEarningsMoveRow): RecencyEvent {
  const outcome: Record<string, unknown> = {};
  if (row.move_pct != null) outcome.move_pct = row.move_pct;
  if (row.move_direction) outcome.move_direction = row.move_direction;
  if (row.beat_miss) outcome.beat_miss = row.beat_miss;
  if (row.surprise_pct != null) outcome.surprise_pct = row.surprise_pct;
  if (row.reason) outcome.reason = row.reason;
  const hasOutcome = Object.keys(outcome).length > 0;
  return {
    id: row.id,
    source: 'ct_earnings_moves',
    category: 'earnings',
    ticker: row.ticker,
    tickers_affected: [row.ticker],
    event_date: row.report_date,
    event_iso: row.captured_at ?? `${row.report_date}T17:00:00Z`,
    title: `${row.ticker} earnings`,
    outcome: hasOutcome ? outcome : null,
    importance: null,
    has_outcome: hasOutcome,
  };
}

export function normalizeBreakingNews(row: CtBreakingNewsRow): RecencyEvent {
  const date = nyDateFromIso(row.published_at) ?? nyDateFromIso(row.ingested_at) ?? '';
  const tickers = Array.isArray(row.tickers_affected) ? row.tickers_affected : [];
  const outcome: Record<string, unknown> = {
    severity: row.severity,
    sentiment: row.sentiment,
    category: row.category,
  };
  if (row.summary) outcome.summary = row.summary;
  return {
    id: row.id,
    source: 'ct_breaking_news',
    category: 'news',
    ticker: tickers.length === 1 ? tickers[0] : null,
    tickers_affected: tickers,
    event_date: date,
    event_iso: row.published_at ?? row.ingested_at ?? null,
    title: row.headline,
    outcome,
    importance: row.severity,
    has_outcome: true, // news IS its own outcome
  };
}

export function normalizeCentralBankRate(row: CtCentralBankRateRow): RecencyEvent {
  const outcome: Record<string, unknown> = { country_code: row.country_code };
  if (row.rate != null) outcome.rate = row.rate;
  if (row.direction_trend) outcome.direction_trend = row.direction_trend;
  if (row.expected_move_bps != null) outcome.expected_move_bps = row.expected_move_bps;
  if (row.next_meeting_date) outcome.next_meeting_date = row.next_meeting_date;
  return {
    id: row.id,
    source: 'ct_central_bank_rates',
    category: 'central_bank',
    ticker: null,
    tickers_affected: [],
    event_date: row.capture_date,
    event_iso: `${row.capture_date}T17:00:00Z`,
    title: `${row.country_code} central bank: ${row.direction_trend ?? 'rate snapshot'} @ ${row.rate ?? 'n/a'}%`,
    outcome,
    importance: null,
    has_outcome: row.rate != null || !!row.direction_trend,
  };
}
