/**
 * eventRecencyFormat — preamble formatter for `eventRecencyContext`.
 *
 * Builds the `whatJustHappened` string the orchestrator drops into
 * `ClaudeContext.preamble.whatJustHappened`. Header line + per-event bullets
 * with time-relative phrasing and outcome data.
 *
 * Re-exported as `formatWhatJustHappened` from `eventRecencyContext.ts`.
 *
 * Pure module — no DB, no side effects.
 */

import type { EventRecencyResult, RecencyEvent } from './eventRecencyTypes.ts';
import { relativeTimePhrase } from './eventRecencyDates.ts';

function formatOutcome(e: RecencyEvent): string {
  const o = e.outcome ?? {};
  if (e.category === 'earnings') {
    const bits: string[] = [];
    if (o.beat_miss) bits.push(String(o.beat_miss));
    if (o.move_pct != null) {
      const dir = o.move_direction ? ` ${o.move_direction}` : '';
      bits.push(`${(Number(o.move_pct) * 100).toFixed(1)}%${dir}`);
    }
    if (o.actual_eps != null) bits.push(`actual EPS ${o.actual_eps}`);
    if (o.reaction != null) bits.push(`reaction ${o.reaction}`);
    return bits.length > 0 ? ` (${bits.join(', ')})` : '';
  }
  if (e.category === 'central_bank') {
    const country = o.country_code ?? '';
    const trend = o.direction_trend ?? '';
    const rate = o.rate != null ? `${o.rate}%` : '';
    return ` (${[country, trend, rate].filter(Boolean).join(' ')})`;
  }
  if (e.category === 'econ') {
    const bits: string[] = [];
    if (o.actual != null) bits.push(`actual ${o.actual}`);
    if (o.forecast != null) bits.push(`forecast ${o.forecast}`);
    if (o.prev != null) bits.push(`prev ${o.prev}`);
    return bits.length > 0 ? ` (${bits.join(', ')})` : '';
  }
  if (e.category === 'news') {
    const bits: string[] = [];
    if (o.severity != null) bits.push(`sev ${o.severity}`);
    if (o.sentiment) bits.push(String(o.sentiment));
    return bits.length > 0 ? ` (${bits.join(', ')})` : '';
  }
  return '';
}

function bulletForEvent(e: RecencyEvent, sessionDate: string): string {
  const when = relativeTimePhrase(e.event_iso, sessionDate);
  const tickerTag = e.ticker
    ? `[${e.ticker}]`
    : e.tickers_affected.length > 0 && e.tickers_affected.length <= 3
      ? `[${e.tickers_affected.join(',')}]`
      : '[mkt]';
  const outcomeStr = formatOutcome(e);
  return `- ${tickerTag} ${e.title} — ${when}${outcomeStr}`;
}

/**
 * Build the preamble bullet string the orchestrator drops into
 * `ClaudeContext.preamble.whatJustHappened`. Includes time-relative phrasing
 * (yesterday 16:14 ET / 2 days ago) plus outcome data per bullet.
 */
export function formatWhatJustHappened(
  result: EventRecencyResult,
  sessionDate: string,
): string {
  const seen = new Set<string>();
  const lines: string[] = [];

  const pushUnique = (e: RecencyEvent) => {
    if (seen.has(e.id)) return;
    seen.add(e.id);
    lines.push(bulletForEvent(e, sessionDate));
  };

  // Market-wide events (FOMC, big earnings reactions, geopol) lead.
  for (const e of result.market_wide.just_happened) pushUnique(e);
  // Then per-ticker just_happened — already material because has_outcome=true.
  for (const t of result.per_ticker) {
    for (const e of t.just_happened) pushUnique(e);
  }

  if (lines.length === 0) {
    return 'WHAT JUST HAPPENED (last 72h):\n- (no material events with outcomes in the last 72 hours — proceed with regular context, but verify any "ahead of"/"watching for" phrasing against the calendar)';
  }

  return [
    `WHAT JUST HAPPENED (last 72h, anchor=${sessionDate}):`,
    ...lines,
    '',
    '↑ Treat the above as already-happened facts. Do not phrase any of these events as upcoming, awaited, or "watching for". They have fired.',
  ].join('\n');
}
