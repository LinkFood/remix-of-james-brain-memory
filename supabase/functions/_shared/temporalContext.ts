/**
 * Shared temporal-anchor utility for Claude consumers.
 *
 * Every "model writes narrative" consumer (morning brief, EOD report,
 * tape reader, specialists, hypothesis proposer, etc.) MUST prepend
 * `temporalAnchorPreamble` to its system prompt AND pre-tag every date
 * field in its context payload with `tagRelativeDay()` or
 * `tagIsoTimestamp()`. Without this anchor Claude pattern-completes on
 * yesterday's news/data as if it were today's reality. See
 * project_co_trader_morning_brief_temporal_bug_2026_04_30.md.
 *
 * Pure module — no DB calls, no side effects, safe to import anywhere.
 * Date math runs in America/New_York via Intl.DateTimeFormat parts;
 * never `.slice(0,10)` on UTC ISO strings (that off-by-ones every
 * afternoon entry, since UTC midnight = 8pm ET previous day).
 */

const NY_TIMEZONE = 'America/New_York';

const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

export interface TemporalContext {
  /** YYYY-MM-DD in America/New_York (the operational session date). */
  session_date: string;
  /** Full English day name for session_date, e.g. 'Thursday'. */
  session_day_name: string;
  /** Current ISO 8601 timestamp in UTC. */
  now_utc: string;
  /** Current wall-clock time in New York, formatted 'HH:MM ET'. */
  now_et: string;
  /** Session-state snapshot for the model: 'PRE_MARKET' | 'OPEN' | 'POST_MARKET' | 'WEEKEND'. */
  session_state: 'PRE_MARKET' | 'OPEN' | 'POST_MARKET' | 'WEEKEND';
  /** Minutes until 16:00 ET close. Negative when post-close, null when WEEKEND or before open. */
  minutes_until_close: number | null;
  /**
   * Drop-in preamble for NARRATIVE-OUTPUT consumers (morning brief, EOD
   * report, tape reader, etc.). Prepend to system prompt before any
   * other instructions. Intentionally repetitive — Claude reads it three
   * times and still pattern-completes if you only say it once.
   */
  temporalAnchorPreamble: string;
  /**
   * Tight one-line anchor for STRUCTURED/JSON-OUTPUT consumers (Haiku
   * judges, tool-use callers). The full narrative-style preamble has
   * "your prose" / "your output" instructions that confuse small models
   * asked for strict JSON. Use this short variant when the model is
   * being asked to return JSON or call a tool. Confirmed regression on
   * ct-hypothesis-health-check 2026-04-30: full preamble caused 6/6
   * Haiku JSON parses to fail.
   */
  temporalAnchorShort: string;
}

/**
 * Format an absolute Date as YYYY-MM-DD in America/New_York.
 */
function formatNyDate(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: NY_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * Format an absolute Date as HH:MM in America/New_York (24h).
 */
function formatNyTime(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: NY_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const hour = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const minute = parts.find((p) => p.type === 'minute')?.value ?? '00';
  return `${hour}:${minute}`;
}

/**
 * Day-of-week index (0=Sun .. 6=Sat) for a given Date in America/New_York.
 */
function nyDayIndex(date: Date): number {
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: NY_TIMEZONE,
    weekday: 'short',
  }).format(date);
  // 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'
  switch (weekday) {
    case 'Sun': return 0;
    case 'Mon': return 1;
    case 'Tue': return 2;
    case 'Wed': return 3;
    case 'Thu': return 4;
    case 'Fri': return 5;
    case 'Sat': return 6;
    default: return 0;
  }
}

/**
 * Convert a YYYY-MM-DD string to an absolute Date anchored at NY noon
 * (avoids DST + UTC-midnight edge cases).
 */
function dateStringToNyNoon(yyyymmdd: string): Date | null {
  const m = yyyymmdd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d] = m;
  // NY noon ≈ 16:00 or 17:00 UTC depending on DST. We use 17:00 UTC which
  // is always the same calendar day in NY year-round (12pm or 1pm ET).
  const iso = `${y}-${mo}-${d}T17:00:00Z`;
  const date = new Date(iso);
  return isNaN(date.getTime()) ? null : date;
}

/**
 * Pull a YYYY-MM-DD calendar day from any input — accepts either a
 * date-only string or a full ISO timestamp. Always resolves in
 * America/New_York to avoid UTC off-by-one.
 */
function inputToNyDate(dateOrIso: string): string | null {
  const trimmed = dateOrIso.trim();
  if (!trimmed) return null;
  // Pure date form: YYYY-MM-DD — already calendar-day, return as-is.
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  // ISO timestamp — parse and reformat in NY tz.
  const date = new Date(trimmed);
  if (isNaN(date.getTime())) return null;
  return formatNyDate(date);
}

/**
 * Day difference between two YYYY-MM-DD strings in NY calendar terms.
 * Positive = `later` is after `earlier`. Returns null on parse failure.
 */
function nyDayDelta(earlier: string, later: string): number | null {
  const a = dateStringToNyNoon(earlier);
  const b = dateStringToNyNoon(later);
  if (!a || !b) return null;
  const ms = b.getTime() - a.getTime();
  return Math.round(ms / 86400000);
}

/**
 * Build the temporal anchor context for "right now". Use at the top of
 * every Claude-narrative consumer — both for the preamble and for
 * passing `session_date` into `tagRelativeDay()`/`tagIsoTimestamp()`.
 */
export function getTemporalContext(): TemporalContext {
  const now = new Date();
  const session_date = formatNyDate(now);
  const session_day_name = DAY_NAMES[nyDayIndex(now)];
  const now_utc = now.toISOString();
  const now_et = `${formatNyTime(now)} ET`;

  // Session-state grounding. Hardcoded RTH window (09:30-16:00 ET) — no
  // half-day calendar yet; if NYSE has a 13:00 ET close, this preamble will
  // still claim 16:00 ET and the model needs to be told via per-day events.
  const dowIdx = nyDayIndex(now);
  const isWeekend = dowIdx === 0 || dowIdx === 6;
  const nyTime = formatNyTime(now); // 'HH:MM' 24h
  const [hh, mm] = nyTime.split(':').map((s) => parseInt(s, 10));
  const minutesIntoDay = hh * 60 + mm;
  const OPEN_MIN = 9 * 60 + 30;     // 09:30 ET
  const CLOSE_MIN = 16 * 60;        // 16:00 ET
  let session_state: TemporalContext['session_state'];
  let minutes_until_close: number | null;
  if (isWeekend) {
    session_state = 'WEEKEND';
    minutes_until_close = null;
  } else if (minutesIntoDay < OPEN_MIN) {
    session_state = 'PRE_MARKET';
    minutes_until_close = null;
  } else if (minutesIntoDay >= CLOSE_MIN) {
    session_state = 'POST_MARKET';
    minutes_until_close = minutesIntoDay - CLOSE_MIN; // negative-from-close, kept positive as "minutes since close"
  } else {
    session_state = 'OPEN';
    minutes_until_close = CLOSE_MIN - minutesIntoDay;
  }

  const sessionStateLine = (() => {
    if (session_state === 'WEEKEND') return `Market: WEEKEND (no RTH today). RTH window M-F 09:30-16:00 ET.`;
    if (session_state === 'PRE_MARKET') {
      const minsToOpen = OPEN_MIN - minutesIntoDay;
      return `Market: PRE_MARKET. RTH opens at 09:30 ET (${minsToOpen} min from now). RTH window 09:30-16:00 ET.`;
    }
    if (session_state === 'POST_MARKET') {
      return `Market: POST_MARKET. RTH closed at 16:00 ET (${minutes_until_close} min ago). RTH window 09:30-16:00 ET.`;
    }
    // OPEN
    const hoursLeft = Math.floor((minutes_until_close ?? 0) / 60);
    const minsLeft = (minutes_until_close ?? 0) % 60;
    const friendly = hoursLeft > 0 ? `${hoursLeft}h ${minsLeft}m` : `${minsLeft}m`;
    return `Market: OPEN. RTH 09:30-16:00 ET. Time until 16:00 ET close: **${minutes_until_close} minutes (${friendly})**.`;
  })();

  const temporalAnchorPreamble =
    `**Today is ${session_date} (${session_day_name}).** ` +
    `Current time: ${now_et} (${now_utc} UTC).\n` +
    `${sessionStateLine}\n\n` +
    `CRITICAL TEMPORAL FRAME — read carefully:\n` +
    `- ALL "today" / "tomorrow" / "yesterday" / day-name references in YOUR OUTPUT must anchor to ${session_date}. ` +
    `Tomorrow = ${session_date} + 1 day. Yesterday = ${session_date} - 1 day.\n` +
    `- ALL "minutes until close" / "final N minutes" / "N hours into the session" references in YOUR OUTPUT must use ` +
    `the **${session_state}** state and **${minutes_until_close ?? 'N/A'}** minutes-until-close value above. ` +
    `Do NOT estimate or pattern-complete time-to-close from prior text — the value above is authoritative.\n` +
    `- ANY date-relative language in input data (hypothesis claims, trade theses, news headlines, prior model output, ` +
    `grade rationales) was written on a PRIOR day or in a different context. Treat that text as HISTORICAL, not as a ` +
    `description of today. NEVER repeat its "today" framing.\n` +
    `- Where input data carries pre-resolved tags **TODAY** / **YESTERDAY** / **TOMORROW** / **+N days** / **-N days**, ` +
    `those tags are AUTHORITATIVE — use them verbatim in your prose.\n` +
    `- Do NOT compute relative dates from raw timestamps. Use the tags or anchor to ${session_date}.\n` +
    `- If you find yourself referencing "Friday gap-down" / "Monday rally" / "yesterday's earnings" / ` +
    `"final N minutes" without explicit grounding from a pre-tagged input field or the session-state line, ` +
    `STOP and re-read the temporal frame. The frame is non-negotiable.`;

  // Short variant for JSON / tool-use consumers — no narrative-style
  // instructions, just the date anchor.
  const temporalAnchorShort =
    `Reference date: ${session_date} (${session_day_name}). ` +
    `${sessionStateLine} ` +
    `Any "today/tomorrow/yesterday" or "minutes-until-close" references anchor to this frame.`;

  return {
    session_date,
    session_day_name,
    now_utc,
    now_et,
    session_state,
    minutes_until_close,
    temporalAnchorPreamble,
    temporalAnchorShort,
  };
}

/**
 * Map an ISO timestamp or YYYY-MM-DD date to a relative-day tag against
 * sessionDate. Returns one of:
 *   '**TODAY**' | '**YESTERDAY**' | '**TOMORROW**' | '**+N days**' |
 *   '**-N days**' | '**UNKNOWN_DATE**'
 *
 * Resolves date in America/New_York timezone — UTC midnight is 8pm ET
 * previous day, so naive UTC.slice(0,10) off-by-ones afternoon entries.
 */
export function tagRelativeDay(
  dateOrIso: string | null | undefined,
  sessionDate: string,
): string {
  if (!dateOrIso) return '**UNKNOWN_DATE**';
  const inputDate = inputToNyDate(dateOrIso);
  if (!inputDate) return '**UNKNOWN_DATE**';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sessionDate)) return '**UNKNOWN_DATE**';

  const delta = nyDayDelta(sessionDate, inputDate);
  if (delta === null) return '**UNKNOWN_DATE**';

  if (delta === 0) return '**TODAY**';
  if (delta === 1) return '**TOMORROW**';
  if (delta === -1) return '**YESTERDAY**';
  if (delta > 1) return `**+${delta} days**`;
  return `**${delta} days**`; // delta is already negative, e.g. '-3 days'
}

/**
 * Combine relative day tag with HH:MM ET. Returns e.g.
 * '**YESTERDAY 16:14 ET**' or '**TODAY 09:30 ET**' or
 * '**+3 days 14:00 ET**'. Returns '**UNKNOWN_TIME**' on null/invalid.
 */
export function tagIsoTimestamp(
  iso: string | null | undefined,
  sessionDate: string,
): string {
  if (!iso) return '**UNKNOWN_TIME**';
  const trimmed = iso.trim();
  if (!trimmed) return '**UNKNOWN_TIME**';
  // Must be a full timestamp — not a bare date.
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return '**UNKNOWN_TIME**';
  const date = new Date(trimmed);
  if (isNaN(date.getTime())) return '**UNKNOWN_TIME**';

  const dayTag = tagRelativeDay(trimmed, sessionDate);
  if (dayTag === '**UNKNOWN_DATE**') return '**UNKNOWN_TIME**';

  const hhmm = formatNyTime(date);
  // Strip trailing '**' from dayTag, append ' HH:MM ET**'.
  const inner = dayTag.replace(/^\*\*/, '').replace(/\*\*$/, '');
  return `**${inner} ${hhmm} ET**`;
}
