/**
 * marketClock — single source of truth for "is the market open" and trading-time
 * arithmetic on the edge-function side. Mirrors the SQL functions in migration
 * 20260424000060_market_clock.sql (public.market_open, public.add_trading_hours,
 * public.next_market_open, public.last_market_close).
 *
 * Co-Trader's pre-clock code treated calendar time as trading time, which let
 * weekend hours count as trading hours and produced flag horizons that landed
 * Saturday with frozen Friday-close spot. Use this module wherever an edge
 * function does timestamp arithmetic that the trader's intent expects to skip
 * non-trading time.
 *
 * NYSE RTH 09:30–16:00 America/New_York, Mon-Fri. DST handled via the
 * America/New_York timezone formatter. Holidays are an empty list — populate
 * as they approach (memorial day, July 4, etc.).
 */

const NY_TZ = 'America/New_York';
const HOLIDAYS: ReadonlySet<string> = new Set<string>([
  // YYYY-MM-DD strings in NY-local date. Currently empty stub — add as needed.
]);

interface NyParts {
  year: number;
  month: number;  // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  dow: number;    // 0=Sun, 1=Mon, ... 6=Sat
}

function partsInNy(d: Date): NyParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: NY_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(d)) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) === 24 ? 0 : Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    dow: dowMap[parts.weekday] ?? 0,
  };
}

function dateKey(p: NyParts): string {
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function isTradingDay(p: NyParts): boolean {
  if (p.dow === 0 || p.dow === 6) return false;
  if (HOLIDAYS.has(dateKey(p))) return false;
  return true;
}

function withinRth(p: NyParts): boolean {
  const minutes = p.hour * 60 + p.minute;
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}

/**
 * Build a Date for a given NY-local Y-M-D H:M (assuming the timezone offset at
 * that moment). Uses a binary-search-like guess: format a UTC candidate, read
 * back the NY parts, and adjust until they match. One iteration is enough in
 * practice (DST transitions are the only edge case and we only build times in
 * RTH which never lands on a transition boundary).
 */
function buildNyDate(year: number, month: number, day: number, hour: number, minute: number): Date {
  // Initial guess assumes UTC offset of -4 (EDT). DST will be corrected in the
  // adjustment pass. month is 1-12 here, JS Date wants 0-11.
  let guess = new Date(Date.UTC(year, month - 1, day, hour + 4, minute, 0));
  for (let i = 0; i < 3; i++) {
    const p = partsInNy(guess);
    if (
      p.year === year && p.month === month && p.day === day &&
      p.hour === hour && p.minute === minute
    ) {
      return guess;
    }
    // Compute drift in minutes and correct
    const target = year * 525600 + (month - 1) * 43800 + day * 1440 + hour * 60 + minute;
    const got = p.year * 525600 + (p.month - 1) * 43800 + p.day * 1440 + p.hour * 60 + p.minute;
    const driftMin = target - got;
    guess = new Date(guess.getTime() + driftMin * 60_000);
  }
  return guess;
}

export function isMarketOpen(ts: Date | string = new Date()): boolean {
  const d = typeof ts === 'string' ? new Date(ts) : ts;
  const p = partsInNy(d);
  return isTradingDay(p) && withinRth(p);
}

/**
 * Returns the next market-open instant at or after `ts`. If `ts` already lies
 * inside a trading session this returns the SAME-day open (so callers can
 * snap-forward without losing time).
 */
export function nextMarketOpen(ts: Date | string = new Date()): Date {
  const d = typeof ts === 'string' ? new Date(ts) : ts;
  const p = partsInNy(d);

  // If today is a trading day and we're at-or-before 09:30, today's open works.
  if (isTradingDay(p)) {
    const minutes = p.hour * 60 + p.minute;
    if (minutes <= 9 * 60 + 30) {
      return buildNyDate(p.year, p.month, p.day, 9, 30);
    }
  }

  // Walk day-by-day until we hit a trading day.
  let cur = new Date(d.getTime());
  for (let i = 0; i < 14; i++) {
    cur = new Date(cur.getTime() + 24 * 3600 * 1000);
    const cp = partsInNy(cur);
    if (isTradingDay(cp)) {
      return buildNyDate(cp.year, cp.month, cp.day, 9, 30);
    }
  }
  throw new Error('nextMarketOpen: no trading day found within 14 days');
}

export function lastMarketClose(ts: Date | string = new Date()): Date {
  const d = typeof ts === 'string' ? new Date(ts) : ts;
  const p = partsInNy(d);

  // Same-day case: weekday with time >= 16:00 → today's close
  if (isTradingDay(p) && (p.hour > 16 || (p.hour === 16 && p.minute >= 0))) {
    return buildNyDate(p.year, p.month, p.day, 16, 0);
  }

  // Walk back day-by-day until we hit a trading day
  let cur = new Date(d.getTime());
  for (let i = 0; i < 14; i++) {
    cur = new Date(cur.getTime() - 24 * 3600 * 1000);
    const cp = partsInNy(cur);
    if (isTradingDay(cp)) {
      return buildNyDate(cp.year, cp.month, cp.day, 16, 0);
    }
  }
  throw new Error('lastMarketClose: no trading day found within 14 days');
}

/**
 * Add `hours` of trading time to `start`. Skips weekends, holidays, and
 * non-RTH portions of the day. If `start` is outside RTH it snaps forward to
 * the next open before counting.
 *
 * Used by the specialist runner when computing horizon_ts from horizon_hours
 * (so a 24-hour horizon written Friday lands Wednesday afternoon, not Saturday).
 */
export function addTradingHours(start: Date | string, hours: number): Date {
  if (hours <= 0) return typeof start === 'string' ? new Date(start) : new Date(start.getTime());

  let cur = typeof start === 'string' ? new Date(start) : new Date(start.getTime());
  let remaining = hours;

  for (let safety = 0; safety < 365; safety++) {
    const p = partsInNy(cur);

    if (!isTradingDay(p)) {
      cur = nextMarketOpen(cur);
      continue;
    }

    const minutes = p.hour * 60 + p.minute;
    if (minutes < 9 * 60 + 30) {
      cur = buildNyDate(p.year, p.month, p.day, 9, 30);
      continue;
    }
    if (minutes >= 16 * 60) {
      cur = nextMarketOpen(new Date(cur.getTime() + 60_000));
      continue;
    }

    const closeOfDay = buildNyDate(p.year, p.month, p.day, 16, 0);
    const hoursLeftToday = (closeOfDay.getTime() - cur.getTime()) / 3_600_000;

    if (hoursLeftToday >= remaining) {
      return new Date(cur.getTime() + remaining * 3_600_000);
    }
    remaining -= hoursLeftToday;
    cur = nextMarketOpen(new Date(closeOfDay.getTime() + 60_000));
  }
  throw new Error('addTradingHours: safety loop exhausted');
}

/**
 * Convenience snapshot for logs/debugging — same shape as the SQL
 * market_clock_state RPC.
 */
export function marketClockState(ts: Date = new Date()): Record<string, unknown> {
  return {
    now_utc: ts.toISOString(),
    is_open: isMarketOpen(ts),
    next_open: nextMarketOpen(ts).toISOString(),
    last_close: lastMarketClose(ts).toISOString(),
    plus_4h: addTradingHours(ts, 4).toISOString(),
    plus_24h: addTradingHours(ts, 24).toISOString(),
  };
}
