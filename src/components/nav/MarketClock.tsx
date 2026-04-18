/**
 * MarketClock — NYSE market state + countdown for the TopNav.
 *
 * Computes current market state using ET via Intl.DateTimeFormat
 * (DST-safe). No external deps, pure client-side, no API calls.
 *
 * States:
 *   OPEN            09:30–16:00 ET, weekday, not holiday
 *   PRE_MARKET      00:00–09:30 ET, weekday, not holiday
 *   AFTER_HOURS     16:00–20:00 ET, weekday, not holiday
 *   CLOSED_WEEKEND  Sat/Sun
 *   CLOSED_HOLIDAY  Full-day NYSE holiday
 *
 * Half-days (13:00 ET close) are handled by overriding the close time.
 *
 * Updates every 30s — per-second precision is unnecessary for
 * a nav widget showing hour/minute countdowns.
 */

import { useEffect, useMemo, useState } from 'react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

// ---------- NYSE 2026 Holidays ----------
// Full-day closures. Source: NYSE official 2026 calendar.
const NYSE_HOLIDAYS_2026: { date: string; name: string }[] = [
  { date: '2026-01-01', name: "New Year's Day" },
  { date: '2026-01-19', name: 'Martin Luther King Jr. Day' },
  { date: '2026-02-16', name: "Washington's Birthday" },
  { date: '2026-04-03', name: 'Good Friday' },
  { date: '2026-05-25', name: 'Memorial Day' },
  { date: '2026-06-19', name: 'Juneteenth' },
  { date: '2026-07-03', name: 'Independence Day (observed)' }, // Jul 4 = Saturday
  { date: '2026-09-07', name: 'Labor Day' },
  { date: '2026-11-26', name: 'Thanksgiving Day' },
  { date: '2026-12-25', name: 'Christmas Day' },
];

// Half-days (early close at 13:00 ET).
const NYSE_HALF_DAYS_2026: { date: string; name: string }[] = [
  { date: '2026-07-02', name: 'Day before Independence Day' }, // Jul 3 is observed holiday
  { date: '2026-11-27', name: 'Day after Thanksgiving' },
  { date: '2026-12-24', name: 'Christmas Eve' },
];

type MarketState =
  | 'OPEN'
  | 'PRE_MARKET'
  | 'AFTER_HOURS'
  | 'CLOSED_WEEKEND'
  | 'CLOSED_HOLIDAY';

interface EtParts {
  year: number;
  month: number; // 1-12
  day: number;
  weekday: number; // 0=Sun, 6=Sat
  hour: number; // 0-23
  minute: number;
  second: number;
  ymd: string; // YYYY-MM-DD
}

// Parse `now` into ET components via Intl. DST-safe.
function getEtParts(now: Date): EtParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const year = Number(get('year'));
  const month = Number(get('month'));
  const day = Number(get('day'));
  // en-US hour can be "24" at midnight — normalize to 0.
  let hour = Number(get('hour'));
  if (hour === 24) hour = 0;
  const minute = Number(get('minute'));
  const second = Number(get('second'));
  const wdMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const weekday = wdMap[get('weekday')] ?? 0;
  const ymd = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return { year, month, day, weekday, hour, minute, second, ymd };
}

function isHoliday(ymd: string): { name: string } | null {
  return NYSE_HOLIDAYS_2026.find((h) => h.date === ymd) ?? null;
}

function isHalfDay(ymd: string): { name: string } | null {
  return NYSE_HALF_DAYS_2026.find((h) => h.date === ymd) ?? null;
}

// Given an ET date (ymd) and an ET wall-clock time (h, m), return the UTC Date
// that represents that ET moment. We compute ET's UTC offset for that date
// using Intl, then back-solve. DST-safe.
function etWallClockToUtc(ymd: string, hour: number, minute: number): Date {
  const [y, mo, d] = ymd.split('-').map(Number);
  // First guess: treat the ET wall clock as if it were UTC.
  const guess = new Date(Date.UTC(y, mo - 1, d, hour, minute, 0));
  // What does that UTC instant look like in ET?
  const etOfGuess = getEtParts(guess);
  // Diff between what ET says and what we wanted (in minutes).
  const wantedMinutes = hour * 60 + minute;
  const actualMinutes = etOfGuess.hour * 60 + etOfGuess.minute;
  // Day rollover compensation: if the ET date shifted, adjust.
  const dayDelta =
    (etOfGuess.year - y) * 10000 + (etOfGuess.month - mo) * 100 + (etOfGuess.day - d);
  // Combine day delta into minutes (rough — good enough since we only need minute precision).
  const etTotalMinutes = actualMinutes + dayDelta * 24 * 60;
  const diff = wantedMinutes - etTotalMinutes;
  return new Date(guess.getTime() + diff * 60_000);
}

// Advance a YYYY-MM-DD string by N days in ET (calendar-aware).
function addDaysYmd(ymd: string, days: number): string {
  const [y, mo, d] = ymd.split('-').map(Number);
  // Build a UTC date at noon to avoid DST edge cases when adding days.
  const t = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
  t.setUTCDate(t.getUTCDate() + days);
  const ny = t.getUTCFullYear();
  const nm = String(t.getUTCMonth() + 1).padStart(2, '0');
  const nd = String(t.getUTCDate()).padStart(2, '0');
  return `${ny}-${nm}-${nd}`;
}

function weekdayOfYmd(ymd: string): number {
  const [y, mo, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d, 12)).getUTCDay();
}

// Find the next trading day (skips weekends + holidays).
// Pseudocode for weekend → Monday roll:
//   candidate = today + 1 day
//   while candidate is Sat/Sun OR holiday:
//     candidate += 1 day
//   return candidate
function nextTradingDay(fromYmd: string): string {
  let candidate = addDaysYmd(fromYmd, 1);
  // Safety cap — never loop more than 14 days.
  for (let i = 0; i < 14; i++) {
    const wd = weekdayOfYmd(candidate);
    const holiday = isHoliday(candidate);
    if (wd !== 0 && wd !== 6 && !holiday) return candidate;
    candidate = addDaysYmd(candidate, 1);
  }
  return candidate;
}

function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

function weekdayName(wd: number): string {
  return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][wd];
}

interface MarketInfo {
  state: MarketState;
  label: string; // Short nav label.
  detail: string; // Full tooltip detail.
  tone: 'open' | 'pre' | 'after' | 'closed';
  etTime: string; // Current ET time for tooltip.
}

function computeMarketInfo(now: Date): MarketInfo {
  const et = getEtParts(now);
  const etTime = `${String(et.hour).padStart(2, '0')}:${String(et.minute).padStart(2, '0')} ET`;
  const isWeekend = et.weekday === 0 || et.weekday === 6;
  const holiday = isHoliday(et.ymd);
  const halfDay = isHalfDay(et.ymd);

  // ---------- Holiday ----------
  if (holiday && !isWeekend) {
    const nextDay = nextTradingDay(et.ymd);
    const nextOpen = etWallClockToUtc(nextDay, 9, 30);
    const until = nextOpen.getTime() - now.getTime();
    return {
      state: 'CLOSED_HOLIDAY',
      label: `Closed · ${holiday.name}`,
      detail: `${holiday.name} — opens ${weekdayName(weekdayOfYmd(nextDay))} 9:30 ET (${formatDuration(until)})`,
      tone: 'closed',
      etTime,
    };
  }

  // ---------- Weekend ----------
  if (isWeekend) {
    const nextDay = nextTradingDay(et.ymd);
    const nextOpen = etWallClockToUtc(nextDay, 9, 30);
    const until = nextOpen.getTime() - now.getTime();
    const nextWd = weekdayName(weekdayOfYmd(nextDay));
    return {
      state: 'CLOSED_WEEKEND',
      label: `Closed · ${nextWd} 9:30 ET (${formatDuration(until)})`,
      detail: `Market closed for the weekend. Opens ${nextWd} 9:30 ET (${formatDuration(until)}).`,
      tone: 'closed',
      etTime,
    };
  }

  // ---------- Weekday: compute today's boundaries ----------
  const openMs = etWallClockToUtc(et.ymd, 9, 30).getTime();
  const closeHour = halfDay ? 13 : 16;
  const closeMs = etWallClockToUtc(et.ymd, closeHour, 0).getTime();
  const afterHoursEndMs = etWallClockToUtc(et.ymd, 20, 0).getTime();
  const nowMs = now.getTime();

  if (nowMs < openMs) {
    // PRE_MARKET
    const until = openMs - nowMs;
    return {
      state: 'PRE_MARKET',
      label: `Opens in ${formatDuration(until)}`,
      detail: `Pre-market. NYSE opens at 9:30 ET (${formatDuration(until)}).`,
      tone: 'pre',
      etTime,
    };
  }

  if (nowMs < closeMs) {
    // OPEN
    const until = closeMs - nowMs;
    const closeLabel = halfDay ? '13:00 ET (half-day)' : '16:00 ET';
    return {
      state: 'OPEN',
      label: `Market OPEN · ${formatDuration(until)} until close`,
      detail: `Market is open. Closes at ${closeLabel} (${formatDuration(until)}).`,
      tone: 'open',
      etTime,
    };
  }

  if (nowMs < afterHoursEndMs) {
    // AFTER_HOURS — next open is next trading day 9:30 ET
    const nextDay = nextTradingDay(et.ymd);
    const nextOpen = etWallClockToUtc(nextDay, 9, 30);
    const until = nextOpen.getTime() - nowMs;
    return {
      state: 'AFTER_HOURS',
      label: `After-hours · opens in ${formatDuration(until)}`,
      detail: `After-hours trading. Regular session opens ${weekdayName(weekdayOfYmd(nextDay))} 9:30 ET (${formatDuration(until)}).`,
      tone: 'after',
      etTime,
    };
  }

  // After 20:00 ET — treat as closed, same path as after-hours for countdown.
  const nextDay = nextTradingDay(et.ymd);
  const nextOpen = etWallClockToUtc(nextDay, 9, 30);
  const until = nextOpen.getTime() - nowMs;
  return {
    state: 'AFTER_HOURS',
    label: `Closed · opens in ${formatDuration(until)}`,
    detail: `Market closed. Opens ${weekdayName(weekdayOfYmd(nextDay))} 9:30 ET (${formatDuration(until)}).`,
    tone: 'closed',
    etTime,
  };
}

export function MarketClock() {
  const [now, setNow] = useState<Date>(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);

  const info = useMemo(() => computeMarketInfo(now), [now]);

  const toneClass =
    info.tone === 'open'
      ? 'text-emerald-400'
      : info.tone === 'pre'
      ? 'text-amber-400'
      : info.tone === 'after'
      ? 'text-muted-foreground'
      : 'text-muted-foreground';

  // Dot color for the leading status indicator.
  const dotClass =
    info.tone === 'open'
      ? 'bg-emerald-400'
      : info.tone === 'pre'
      ? 'bg-amber-400'
      : 'bg-muted-foreground/50';

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className={`hidden md:flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-medium whitespace-nowrap max-w-[220px] truncate ${toneClass}`}
            aria-label={info.detail}
          >
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotClass}`} />
            <span className="truncate">{info.label}</span>
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">
          <div className="font-medium">{info.detail}</div>
          <div className="text-muted-foreground mt-1">Now: {info.etTime}</div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
