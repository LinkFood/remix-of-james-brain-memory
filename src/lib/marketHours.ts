/**
 * marketHours — single source of truth for US equity-market RTH detection.
 *
 * Uses `Intl.DateTimeFormat` with `America/New_York` so DST is handled
 * without a date-util dependency. RTH = 09:30-16:00 ET, Mon-Fri.
 *
 * History: this lived inline in `useNetPremiumCumulative`. Extracted
 * 2026-04-29 so the bell-ring trigger (`useMarketHoursTrigger`) and every
 * gated hook share one definition. If you change the boundary you change
 * it once, everywhere.
 */

/** True if the NY clock is inside the regular trading session right now. */
export function isMarketHoursET(now: Date = new Date()): boolean {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  const parts = fmt.formatToParts(now);
  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? '';
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  const mins = hour * 60 + minute;
  // 09:30 ET = 570, 16:00 ET = 960.
  return mins >= 570 && mins < 960;
}
