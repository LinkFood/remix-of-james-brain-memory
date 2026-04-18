/**
 * useEffectiveSessionDate — returns the date whose session data charts should
 * render. During the regular session (Mon-Fri 09:30-16:00 ET) it's "today"
 * (live). Otherwise it's the date of the most recent ct_heartbeats row — i.e.
 * the last trading day that actually produced data. This lets CommandStation
 * charts fall back to Friday's data over the weekend / pre-market / after
 * hours instead of showing blank "no ticks yet" panels.
 *
 * Returns:
 *   sessionDateET  - YYYY-MM-DD in America/New_York
 *   sessionStartISO - ISO timestamp at 00:00 ET of that date (for .gte() queries)
 *   sessionEndISO   - ISO timestamp at 24:00 ET of that date (for .lt() queries)
 *   isLive          - true if inside RTH AND today has heartbeats; false otherwise
 *
 * 60s stale time — cheap on DB, still reacts within a minute of market open.
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface EffectiveSessionDate {
  sessionDateET: string;      // 'YYYY-MM-DD'
  sessionStartISO: string;    // UTC ISO at 00:00 ET of sessionDateET
  sessionEndISO: string;      // UTC ISO at 00:00 ET of the following day
  isLive: boolean;
}

function nyParts(date: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (k: string) => parts.find(p => p.type === k)?.value ?? '';
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    weekday: get('weekday'),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
  };
}

function isRegularTradingHours(date: Date = new Date()): boolean {
  const p = nyParts(date);
  if (p.weekday === 'Sat' || p.weekday === 'Sun') return false;
  const mins = p.hour * 60 + p.minute;
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

/** Convert a YYYY-MM-DD ET date to the UTC ISO at 00:00 ET of that day. */
function etMidnightISO(dateET: string, offsetDaysET = 0): string {
  // Build "YYYY-MM-DDT00:00:00" as if UTC, then shift by the current NY offset.
  // Good enough for Postgres timestamptz comparisons — DST transitions land at
  // 07:00 UTC on those two days a year, far outside the session.
  const [y, m, d] = dateET.split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1, d + offsetDaysET, 0, 0, 0));
  // Measure the NY offset at `base` and shift.
  const nyWallClock = new Date(base.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const utcWallClock = new Date(base.toLocaleString('en-US', { timeZone: 'UTC' }));
  const offsetMs = utcWallClock.getTime() - nyWallClock.getTime();
  return new Date(base.getTime() + offsetMs).toISOString();
}

export function useEffectiveSessionDate() {
  return useQuery<EffectiveSessionDate>({
    queryKey: ['effective_session_date'],
    staleTime: 60_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const now = new Date();
      const rth = isRegularTradingHours(now);

      // Grab the timestamp of the most recent heartbeat — the ground truth of
      // "when did data last flow." One-row fetch, indexed by created_at desc.
      const { data, error } = await supabase
        .from('ct_heartbeats')
        .select('created_at')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;

      const latestHbISO = (data as { created_at: string } | null)?.created_at ?? null;
      const latestHbDate = latestHbISO ? new Date(latestHbISO) : null;

      // Derive today's date in ET for comparison.
      const todayParts = nyParts(now);
      const todayET = `${todayParts.year}-${todayParts.month}-${todayParts.day}`;

      // If RTH AND the latest heartbeat is today in ET → live.
      let isLive = false;
      if (rth && latestHbDate) {
        const hbParts = nyParts(latestHbDate);
        const hbET = `${hbParts.year}-${hbParts.month}-${hbParts.day}`;
        if (hbET === todayET) isLive = true;
      }

      // Pick the session date.
      let sessionDateET: string;
      if (isLive) {
        sessionDateET = todayET;
      } else if (latestHbDate) {
        const hbParts = nyParts(latestHbDate);
        sessionDateET = `${hbParts.year}-${hbParts.month}-${hbParts.day}`;
      } else {
        // Cold start / empty table — default to today; consumers will just show
        // empty charts, same as before.
        sessionDateET = todayET;
      }

      const sessionStartISO = etMidnightISO(sessionDateET, 0);
      const sessionEndISO = etMidnightISO(sessionDateET, 1);
      return { sessionDateET, sessionStartISO, sessionEndISO, isLive };
    },
  });
}

/** Tiny label helper used by the "market closed" badge on chart headers. */
export function formatClosedSessionLabel(dateET: string): string {
  // dateET is YYYY-MM-DD. Render as "Fri Apr 17 (market closed)".
  const [y, m, d] = dateET.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0)); // noon UTC, safely inside the ET day
  const label = dt.toLocaleDateString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  return `${label} (market closed)`;
}
