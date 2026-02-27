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
 * Default timezone: America/Chicago (Central Time)
 */
export function now(tz = 'America/Chicago'): ClockSnapshot {
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
export function dateInTz(date: Date | string, tz = 'America/Chicago'): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/**
 * Get user's timezone from user_settings, or default to America/Chicago.
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
  return 'America/Chicago';
}
