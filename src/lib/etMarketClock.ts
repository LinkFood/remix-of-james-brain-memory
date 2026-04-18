/**
 * etMarketClock — ET-aware market-hours helpers.
 *
 * Uses Intl.DateTimeFormat with timeZone: 'America/New_York' so DST is
 * automatically handled (no offset math, no moment.js). All math is
 * Intl-driven minute-of-day, which survives spring-forward / fall-back.
 *
 * Shared between <PreBellChecklist /> (frontend) and ct-pre-bell-alert
 * (edge function) logic — keep pure, no React, no Supabase.
 *
 * Holiday list: NYSE full-day closures 2026–2027. We don't short-circuit
 * the half-days (Nov/Dec early closes) — pre-bell hours are unchanged on
 * those sessions. The list will need a yearly refresh; if a future year
 * is queried and not listed, we fail *open* (treat as trading day) so the
 * checklist still appears and the cron still fires — a miss here is
 * recoverable, a false-hide is invisible.
 */

const ET_TZ = 'America/New_York';

// Intl formatters (construct once, reuse — formatting is not cheap).
const etParts = new Intl.DateTimeFormat('en-US', {
  timeZone: ET_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
  weekday: 'short',
});

interface EtNow {
  year: number;
  month: number;   // 1-12
  day: number;     // 1-31
  hour: number;    // 0-23
  minute: number;  // 0-59
  second: number;  // 0-59
  /** 0=Sun, 1=Mon, ... 6=Sat */
  weekday: number;
  /** YYYY-MM-DD in ET */
  ymd: string;
  /** 'Mon' | 'Tue' | ... */
  weekdayShort: string;
  /** Minutes since midnight ET (0..1439). */
  minuteOfDay: number;
}

const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

export function getEtNow(now: Date = new Date()): EtNow {
  const parts = etParts.formatToParts(now);
  let year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0;
  let weekdayShort = 'Sun';
  for (const p of parts) {
    switch (p.type) {
      case 'year':    year = parseInt(p.value, 10); break;
      case 'month':   month = parseInt(p.value, 10); break;
      case 'day':     day = parseInt(p.value, 10); break;
      case 'hour':    hour = p.value === '24' ? 0 : parseInt(p.value, 10); break;
      case 'minute':  minute = parseInt(p.value, 10); break;
      case 'second':  second = parseInt(p.value, 10); break;
      case 'weekday': weekdayShort = p.value; break;
    }
  }
  const ymd = `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
  return {
    year, month, day, hour, minute, second,
    weekday: WEEKDAY_MAP[weekdayShort] ?? 0,
    ymd,
    weekdayShort,
    minuteOfDay: hour * 60 + minute,
  };
}

// ---------------------------------------------------------------------------
// NYSE full-day closures. Source: nyse.com market holiday schedule.
// Keep sorted ascending. Extend yearly.
// ---------------------------------------------------------------------------
const NYSE_HOLIDAYS: ReadonlySet<string> = new Set([
  // 2026
  '2026-01-01', // New Year's Day
  '2026-01-19', // MLK Jr. Day
  '2026-02-16', // Presidents' Day
  '2026-04-03', // Good Friday
  '2026-05-25', // Memorial Day
  '2026-06-19', // Juneteenth
  '2026-07-03', // Independence Day (observed — Jul 4 is Sat)
  '2026-09-07', // Labor Day
  '2026-11-26', // Thanksgiving
  '2026-12-25', // Christmas
  // 2027
  '2027-01-01', // New Year's Day
  '2027-01-18', // MLK Jr. Day
  '2027-02-15', // Presidents' Day
  '2027-03-26', // Good Friday
  '2027-05-31', // Memorial Day
  '2027-06-18', // Juneteenth (observed — Jun 19 is Sat)
  '2027-07-05', // Independence Day (observed — Jul 4 is Sun)
  '2027-09-06', // Labor Day
  '2027-11-25', // Thanksgiving
  '2027-12-24', // Christmas (observed — Dec 25 is Sat)
]);

/** Full-day NYSE closure. Half-days (1pm ET early close) are NOT included — pre-bell hours behave normally on those days. */
export function isMarketHoliday(now: Date = new Date()): boolean {
  const { ymd } = getEtNow(now);
  return NYSE_HOLIDAYS.has(ymd);
}

/** Mon–Fri and not a full-day NYSE holiday. */
export function isTradingDay(now: Date = new Date()): boolean {
  const { weekday } = getEtNow(now);
  if (weekday === 0 || weekday === 6) return false;
  return !isMarketHoliday(now);
}

// Pre-bell window: 04:00 ET (240 min) through 09:30 ET (570 min) inclusive of 09:30
// and hides after 09:31 ET (571 min) per spec.
const PRE_BELL_START_MIN = 4 * 60;   // 240
const PRE_BELL_END_MIN   = 9 * 60 + 31; // 571  — component hides once minuteOfDay >= 571
const MARKET_OPEN_MIN    = 9 * 60 + 30; // 570

/** True iff today is a trading day AND ET clock is in [04:00, 09:31). */
export function isPreMarket(now: Date = new Date()): boolean {
  if (!isTradingDay(now)) return false;
  const { minuteOfDay } = getEtNow(now);
  return minuteOfDay >= PRE_BELL_START_MIN && minuteOfDay < PRE_BELL_END_MIN;
}

/**
 * Milliseconds until today's 09:30 ET open. Returns a negative number if the
 * open has already passed today; callers should guard before rendering a
 * countdown. Non-trading days return the next trading day's open.
 */
export function msUntilMarketOpen(now: Date = new Date()): number {
  const { minuteOfDay } = getEtNow(now);

  // If we're on a trading day and before 09:30 ET, subtract inside today.
  if (isTradingDay(now) && minuteOfDay < MARKET_OPEN_MIN) {
    const nowMs = now.getTime();
    const { year, month, day } = getEtNow(now);
    const openMs = etWallClockToUtcMs(year, month, day, 9, 30, 0);
    return openMs - nowMs;
  }

  // Otherwise: walk day-by-day until we find the next trading day.
  // Cap at 10 calendar days to avoid pathological loops (should never hit).
  for (let i = 1; i <= 10; i++) {
    const probe = new Date(now.getTime() + i * 24 * 60 * 60 * 1000);
    // Anchor probe to mid-day UTC to dodge DST edges when adding 24h.
    probe.setUTCHours(12, 0, 0, 0);
    if (isTradingDay(probe)) {
      const probeEt = getEtNow(probe);
      const openMs = etWallClockToUtcMs(probeEt.year, probeEt.month, probeEt.day, 9, 30, 0);
      return openMs - now.getTime();
    }
  }
  return -1;
}

/**
 * Convert an ET wall-clock time into a UTC timestamp (ms). Handles DST via
 * Intl — we format a candidate UTC into ET and iteratively adjust until the
 * ET wall-clock matches the desired one. Two passes is enough for any DST
 * transition (fall-back is the only ambiguous case and we bias to the later
 * UTC instant, which matches how brokers treat 09:30 ET on a fall-back day).
 */
function etWallClockToUtcMs(
  year: number, month: number, day: number,
  hour: number, minute: number, second: number,
): number {
  // First pass: pretend ET is UTC-5 (standard) and refine.
  let guess = Date.UTC(year, month - 1, day, hour + 5, minute, second);
  for (let i = 0; i < 2; i++) {
    const et = getEtNow(new Date(guess));
    const etMin = et.hour * 60 + et.minute;
    const wantMin = hour * 60 + minute;
    const delta = (wantMin - etMin) * 60_000;
    if (delta === 0) break;
    guess += delta;
  }
  return guess;
}

/** Format an ms duration as `H:MM:SS` or `M:SS` if under an hour. */
export function fmtCountdown(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0:00';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
