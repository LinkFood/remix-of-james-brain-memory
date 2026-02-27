/**
 * calendar-reminder-check — Reminder Delivery for JAC Agent OS
 *
 * Called by pg_cron (2x/day + every 15min for timed events).
 * Finds entries with pending reminders that are now due and sends Slack notifications.
 *
 * All date/time calculations use the user's timezone (from user_settings),
 * defaulting to America/Chicago if not set.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';

/** Get today's date string (YYYY-MM-DD) in a specific timezone */
function getTodayInTimezone(tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** Get current time-of-day in a timezone as total minutes since midnight */
function getCurrentMinutesInTimezone(tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(new Date());
  const hour = parseInt(parts.find(p => p.type === 'hour')?.value || '0');
  const minute = parseInt(parts.find(p => p.type === 'minute')?.value || '0');
  return hour * 60 + minute;
}

/**
 * Build a Date object for an event_date + optional event_time in the user's timezone.
 * Returns epoch ms so we can compare with "now" correctly.
 */
function getEventEpochMs(eventDate: string, eventTime: string | null, tz: string): number {
  const [year, month, day] = eventDate.split('-').map(Number);
  let hours = 9, minutes = 0; // Default: 9 AM for date-only events
  if (eventTime) {
    const parts = eventTime.split(':').map(Number);
    hours = parts[0];
    minutes = parts[1];
  }
  // Create a date string that we interpret in the user's timezone
  // Use Intl to figure out the UTC offset for this specific date+time in the user's tz
  const naive = new Date(year, month - 1, day, hours, minutes, 0, 0);
  const utcStr = naive.toLocaleString('en-US', { timeZone: 'UTC' });
  const tzStr = naive.toLocaleString('en-US', { timeZone: tz });
  const utcDate = new Date(utcStr);
  const tzDate = new Date(tzStr);
  const offsetMs = utcDate.getTime() - tzDate.getTime();
  return naive.getTime() + offsetMs;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204 });
  }

  // Accept service role key OR anon key (for pg_cron calls via net.http_post)
  const authHeader = req.headers.get('authorization');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const token = authHeader?.replace('Bearer ', '');

  if (!token || (token !== serviceRoleKey && token !== anonKey)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const botToken = Deno.env.get('SLACK_BOT_TOKEN');
  const supabase = createClient(supabaseUrl, serviceKey);

  try {
    const body = await req.json().catch(() => ({}));
    const timedOnly = body.timed_only === true;

    // Get the single user's timezone from settings (default: Central)
    let userTz = 'America/Chicago';
    try {
      const { data: profile } = await supabase
        .from('profiles')
        .select('id')
        .limit(1)
        .single();
      if (profile) {
        const { data: settings } = await supabase
          .from('user_settings')
          .select('settings')
          .eq('user_id', profile.id)
          .single();
        const tz = (settings?.settings as Record<string, unknown>)?.timezone as string | undefined;
        if (tz) userTz = tz;
      }
    } catch {
      // Use default timezone
    }

    const now = Date.now();
    const todayStr = getTodayInTimezone(userTz);

    // Query entries with pending reminders
    // Use yesterday as floor to catch events that span the UTC boundary
    const yesterdayDate = new Date(now - 24 * 60 * 60 * 1000);
    const yesterdayStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: userTz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(yesterdayDate);

    let query = supabase
      .from('entries')
      .select('id, user_id, title, content, event_date, event_time, reminder_minutes')
      .eq('reminder_sent', false)
      .not('event_date', 'is', null)
      .not('reminder_minutes', 'is', null)
      .gte('event_date', yesterdayStr) // Include yesterday to handle timezone boundary
      .limit(50);

    // For the frequent (15-min) check, only look at entries with event_time set
    if (timedOnly) {
      query = query.not('event_time', 'is', null);
    }

    const { data: entries, error } = await query;

    if (error) {
      console.error('[reminder-check] Query error:', error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (!entries || entries.length === 0) {
      return new Response(JSON.stringify({ sent: 0, message: 'No pending reminders', timezone: userTz }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    let sentCount = 0;

    for (const entry of entries) {
      // Calculate event time in user's timezone
      const eventMs = getEventEpochMs(entry.event_date, entry.event_time, userTz);
      const reminderMs = eventMs - entry.reminder_minutes * 60 * 1000;

      // Skip events that have already passed
      if (now >= eventMs) continue;

      // Is the reminder due? (reminder time is in the past, but event hasn't passed)
      if (now >= reminderMs) {
        // For timed-only checks, only fire if reminder became due within the last 15 min
        if (timedOnly) {
          const fifteenMinAgo = now - 15 * 60 * 1000;
          if (reminderMs < fifteenMinAgo) continue;
        }

        // Find user's Slack channel
        let slackChannel: string | undefined;
        if (botToken) {
          try {
            const { data: settings } = await supabase
              .from('user_settings')
              .select('settings')
              .eq('user_id', entry.user_id)
              .single();
            slackChannel = (settings?.settings as Record<string, unknown>)?.slack_channel_id as string | undefined;
          } catch {}

          if (!slackChannel) {
            const { data: recentTask } = await supabase
              .from('agent_tasks')
              .select('input')
              .eq('user_id', entry.user_id)
              .not('input->slack_channel', 'is', null)
              .order('created_at', { ascending: false })
              .limit(1)
              .single();
            slackChannel = (recentTask?.input as Record<string, unknown>)?.slack_channel as string | undefined;
          }
        }

        // Calculate time until event
        const msUntil = eventMs - now;
        const hoursUntil = Math.floor(msUntil / (1000 * 60 * 60));
        const minsUntil = Math.floor((msUntil % (1000 * 60 * 60)) / (1000 * 60));
        let timeUntil = '';
        if (hoursUntil >= 24) {
          const days = Math.floor(hoursUntil / 24);
          timeUntil = `${days} day${days > 1 ? 's' : ''}`;
        } else if (hoursUntil > 0) {
          timeUntil = `${hoursUntil}h ${minsUntil}m`;
        } else {
          timeUntil = `${minsUntil} minute${minsUntil !== 1 ? 's' : ''}`;
        }

        const title = entry.title || 'Untitled event';
        const dateDisplay = entry.event_time
          ? `${entry.event_date} at ${entry.event_time}`
          : entry.event_date;
        const message = `:bell: *Reminder:* ${title}\n:calendar: ${dateDisplay} (in ${timeUntil})`;

        // Send Slack notification
        let slackSuccess = false;
        if (slackChannel && botToken) {
          try {
            const res = await fetch('https://slack.com/api/chat.postMessage', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${botToken}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                channel: slackChannel,
                text: message,
              }),
            });

            if (res.ok) {
              const resData = await res.json();
              if (resData.ok) {
                slackSuccess = true;
              } else {
                console.warn(`[reminder-check] Slack API error for entry ${entry.id}:`, resData.error);
              }
            }
          } catch (err) {
            console.warn(`[reminder-check] Slack send failed for entry ${entry.id}:`, err);
          }
        } else {
          console.warn(`[reminder-check] No Slack channel or bot token for entry ${entry.id}`);
        }

        // Mark as sent regardless of Slack success (avoid re-sending on next cycle)
        await supabase
          .from('entries')
          .update({ reminder_sent: true })
          .eq('id', entry.id);

        sentCount++;
        console.log(`[reminder-check] ${slackSuccess ? 'Sent' : 'Marked (no Slack)'} reminder for "${title}" (entry ${entry.id}, tz: ${userTz})`);
      }
    }

    return new Response(JSON.stringify({
      sent: sentCount,
      checked: entries.length,
      timezone: userTz,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('[reminder-check] Error:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Unknown error',
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
