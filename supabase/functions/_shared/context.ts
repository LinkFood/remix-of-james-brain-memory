/**
 * _shared/context.ts — User Context Snapshot
 *
 * Provides getUserContext() that queries the user's schedule state:
 * today's events, overdue items, upcoming (next 7 days).
 * Returns structured data + a pre-formatted contextText string
 * for injection into agent system prompts.
 *
 * All dates are calculated in the user's timezone (from user_settings),
 * defaulting to America/Chicago if not set.
 */

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';

export interface UserContext {
  todayEvents: Array<{ id: string; title: string; event_date: string; event_time: string | null }>;
  overdueItems: Array<{ id: string; title: string; event_date: string; event_time: string | null }>;
  upcomingEvents: Array<{ id: string; title: string; event_date: string; event_time: string | null }>;
  contextText: string;
}

/** Get a YYYY-MM-DD date string offset by N days from now, in a specific timezone */
function getDateInTimezone(tz: string, offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

export async function getUserContext(
  supabase: SupabaseClient,
  userId: string,
): Promise<UserContext> {
  // Get user's timezone from settings
  let userTz = 'America/Chicago';
  try {
    const { data: settings } = await supabase
      .from('user_settings')
      .select('settings')
      .eq('user_id', userId)
      .single();
    const tz = (settings?.settings as Record<string, unknown>)?.timezone as string | undefined;
    if (tz) userTz = tz;
  } catch {
    // Use default
  }

  const todayStr = getDateInTimezone(userTz);
  const tomorrowStr = getDateInTimezone(userTz, 1);
  const weekOutStr = getDateInTimezone(userTz, 7);

  const selectFields = 'id, title, event_date, event_time';

  // Run all 3 queries in parallel
  const [todayRes, overdueRes, upcomingRes] = await Promise.all([
    // Today's events
    supabase
      .from('entries')
      .select(selectFields)
      .eq('user_id', userId)
      .eq('archived', false)
      .eq('event_date', todayStr)
      .order('event_time', { ascending: true, nullsFirst: false })
      .limit(20),

    // Overdue items (past event_date, not archived)
    supabase
      .from('entries')
      .select(selectFields)
      .eq('user_id', userId)
      .eq('archived', false)
      .not('event_date', 'is', null)
      .lt('event_date', todayStr)
      .order('event_date', { ascending: false })
      .limit(20),

    // Upcoming (tomorrow through next 7 days)
    supabase
      .from('entries')
      .select(selectFields)
      .eq('user_id', userId)
      .eq('archived', false)
      .gte('event_date', tomorrowStr)
      .lte('event_date', weekOutStr)
      .order('event_date', { ascending: true })
      .limit(20),
  ]);

  const todayEvents = (todayRes.data ?? []) as UserContext['todayEvents'];
  const overdueItems = (overdueRes.data ?? []) as UserContext['overdueItems'];
  const upcomingEvents = (upcomingRes.data ?? []) as UserContext['upcomingEvents'];

  // Build contextText
  const lines: string[] = [];
  const now = new Date();
  const dateDisplay = now.toLocaleDateString('en-US', {
    timeZone: userTz,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  lines.push(`=== YOUR SCHEDULE (today: ${dateDisplay}) ===`);

  if (overdueItems.length > 0) {
    lines.push(`\nOVERDUE (${overdueItems.length} item${overdueItems.length > 1 ? 's' : ''}):`);
    for (const item of overdueItems) {
      const title = item.title || 'Untitled';
      lines.push(`- "${title}" — was due ${item.event_date}`);
    }
  }

  if (todayEvents.length > 0) {
    lines.push(`\nTODAY (${todayEvents.length} item${todayEvents.length > 1 ? 's' : ''}):`);
    for (const item of todayEvents) {
      const title = item.title || 'Untitled';
      const time = item.event_time ? ` at ${item.event_time}` : '';
      lines.push(`- "${title}"${time}`);
    }
  }

  if (upcomingEvents.length > 0) {
    lines.push(`\nTHIS WEEK (${upcomingEvents.length} upcoming):`);
    for (const item of upcomingEvents) {
      const title = item.title || 'Untitled';
      const time = item.event_time ? ` at ${item.event_time}` : '';
      lines.push(`- "${title}" — ${item.event_date}${time}`);
    }
  }

  if (overdueItems.length === 0 && todayEvents.length === 0 && upcomingEvents.length === 0) {
    lines.push('\nNo events on your schedule.');
  }

  return {
    todayEvents,
    overdueItems,
    upcomingEvents,
    contextText: lines.join('\n'),
  };
}
