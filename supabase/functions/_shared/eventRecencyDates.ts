/**
 * eventRecencyDates — small NY-tz date utilities for eventRecencyContext.
 *
 * Mirrors the patterns in `temporalContext.ts` (which is the canonical home
 * for shared date logic) but is deliberately scoped to this helper to avoid
 * editing other files during the Phase 1 build. If/when the temporalContext
 * exposes these as named exports, this file should be deleted in favor of
 * those imports.
 *
 * Pure module — no DB, no side effects.
 *
 * @internal — only `eventRecencyContext.ts` should import from this file.
 */

const NY_TIMEZONE = 'America/New_York';

/** Format a Date as YYYY-MM-DD in America/New_York. */
export function formatNyDate(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: NY_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Anchor a YYYY-MM-DD at NY-noon equivalent (17:00 UTC, same day year-round). */
export function nyMidday(yyyymmdd: string): Date | null {
  const m = yyyymmdd?.match?.(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T17:00:00Z`);
  return isNaN(d.getTime()) ? null : d;
}

/** Add `days` calendar days to YYYY-MM-DD; returns null on parse failure. */
export function addCalendarDays(yyyymmdd: string, days: number): string | null {
  const d = nyMidday(yyyymmdd);
  if (!d) return null;
  d.setUTCDate(d.getUTCDate() + days);
  return formatNyDate(d);
}

/** Day delta between two YYYY-MM-DD strings (b - a). Positive = later. */
export function daysBetween(earlier: string, later: string): number | null {
  const a = nyMidday(earlier);
  const b = nyMidday(later);
  if (!a || !b) return null;
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

/** Pull the NY-tz YYYY-MM-DD calendar day from any ISO timestamp. */
export function nyDateFromIso(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return formatNyDate(d);
}

/**
 * Time-relative phrasing anchored to sessionDate. e.g. "yesterday 16:14 ET",
 * "today 09:30 ET", "2 days ago", "at 2026-04-26 14:00 ET".
 */
export function relativeTimePhrase(eventIso: string | null, sessionDate: string): string {
  if (!eventIso) return 'recently';
  const d = new Date(eventIso);
  if (isNaN(d.getTime())) return 'recently';
  const eventDate = formatNyDate(d);
  const delta = daysBetween(sessionDate, eventDate);
  const hhmm = new Intl.DateTimeFormat('en-GB', {
    timeZone: NY_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
  if (delta === 0) return `today ${hhmm} ET`;
  if (delta === -1) return `yesterday ${hhmm} ET`;
  if (delta !== null && delta < 0) return `${Math.abs(delta)} days ago`;
  return `at ${eventDate} ${hhmm} ET`;
}

/**
 * Build an ISO timestamp from a YYYY-MM-DD plus optional timetz string.
 * Falls back to NY-noon-equivalent (17:00 UTC) when time is missing.
 */
export function buildEventIso(eventDate: string, eventTime: string | null): string | null {
  if (!eventDate) return null;
  if (!eventTime) return `${eventDate}T17:00:00Z`;
  const cleanTime = eventTime.includes('+') || eventTime.includes('-')
    ? eventTime
    : `${eventTime}+00`;
  const composed = `${eventDate}T${cleanTime}`;
  const d = new Date(composed);
  return isNaN(d.getTime()) ? `${eventDate}T17:00:00Z` : d.toISOString();
}
