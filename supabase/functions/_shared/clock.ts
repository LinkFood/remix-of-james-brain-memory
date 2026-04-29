/**
 * Shared clock/timezone utilities for JAC Agent OS
 *
 * Centralizes timezone-aware date/time operations so agents
 * don't scatter `new Date()` everywhere with inconsistent handling.
 */

export interface ClockSnapshot {
  /** ISO 8601 UTC timestamp */
  iso: string;
  /** Date string in user's timezone (YYYY-MM-DD) */
  date: string;
  /** Time string in user's timezone (HH:MM) */
  time: string;
  /** Full datetime in user's timezone */
  datetime: string;
  /** Unix epoch ms */
  epoch: number;
  /** IANA timezone string */
  tz: string;
}

/**
 * Get a timezone-aware clock snapshot.
 * Default timezone: America/New_York (Eastern Time)
 */
export function now(tz = 'America/New_York'): ClockSnapshot {
  const d = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const timeFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const fullFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });

  return {
    iso: d.toISOString(),
    date: formatter.format(d), // YYYY-MM-DD
    time: timeFormatter.format(d), // HH:MM
    datetime: fullFormatter.format(d),
    epoch: d.getTime(),
    tz,
  };
}

/**
 * Get a date string in the user's timezone.
 */
export function dateInTz(date: Date | string, tz = 'America/New_York'): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/**
 * Today's date string (YYYY-MM-DD) in the given timezone. Default ET.
 * Use this anywhere you'd otherwise reach for `new Date().toISOString().slice(0,10)` —
 * that returns UTC and rolls over before midnight ET, off-by-one'ing the session date.
 */
export function todayInET(tz = 'America/New_York'): string {
  return now(tz).date;
}

/**
 * Day-of-week name for the given YYYY-MM-DD date in the given timezone.
 * e.g. todayInET() → "2026-04-29", dayNameInTz("2026-04-29") → "Wednesday"
 */
export function dayNameInTz(ymd: string, tz = 'America/New_York'): string {
  // Anchor at noon UTC to avoid timezone-edge rollover when formatting back into tz.
  const d = new Date(`${ymd}T12:00:00Z`);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'long',
  }).format(d);
}

/**
 * Days between two YYYY-MM-DD strings (b - a). Calendar-day arithmetic, no DST drift.
 * Positive = b is after a. Returns integer days.
 */
export function daysBetween(a: string, b: string): number {
  // Anchor both dates at noon UTC to avoid DST shenanigans on subtraction.
  const ta = Date.parse(`${a}T12:00:00Z`);
  const tb = Date.parse(`${b}T12:00:00Z`);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return 0;
  return Math.round((tb - ta) / 86_400_000);
}

/**
 * Pre-resolve a calendar date to a relative-time tag, anchored against today.
 *   today        → "TODAY"
 *   today + 1    → "TOMORROW"
 *   today − 1    → "YESTERDAY"
 *   today + N>1  → "+N days"
 *   today − N>1  → "-N days"
 *
 * Use this BEFORE handing event rows to an LLM. The model should never have to
 * compute "is 2026-04-29 today?" — it should see the answer pre-baked.
 */
export function relativeDayTag(eventYmd: string, todayYmd: string): string {
  const delta = daysBetween(todayYmd, eventYmd);
  if (delta === 0) return 'TODAY';
  if (delta === 1) return 'TOMORROW';
  if (delta === -1) return 'YESTERDAY';
  if (delta > 1) return `+${delta} days`;
  return `${delta} days`; // already negative
}

/**
 * Get user's timezone from user_settings, or default to America/New_York.
 */
export async function getUserTimezone(
  supabase: { from: (table: string) => any },
  userId: string
): Promise<string> {
  try {
    const { data } = await supabase
      .from('user_settings')
      .select('settings')
      .eq('user_id', userId)
      .maybeSingle();
    const settings = data?.settings as Record<string, unknown> | null;
    const tz = settings?.timezone as string | undefined;
    if (tz && typeof tz === 'string') return tz;
  } catch (err) {
    console.warn('getUserTimezone failed:', err);
  }
  return 'America/New_York';
}
