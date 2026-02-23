/**
 * calendar-reminder-check — Reminder Delivery for JAC Agent OS
 *
 * Called by pg_cron (2x/day + every 15min for timed events).
 * Finds entries with pending reminders that are now due and sends Slack notifications.
 *
 * Logic:
 * 1. Query entries where reminder is due but not yet sent
 * 2. For each: send Slack notification with bell emoji
 * 3. Mark reminder_sent = true
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';

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

    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];

    // Query entries with pending reminders
    let query = supabase
      .from('entries')
      .select('id, user_id, title, content, event_date, event_time, reminder_minutes')
      .eq('reminder_sent', false)
      .not('event_date', 'is', null)
      .not('reminder_minutes', 'is', null)
      .gte('event_date', todayStr) // Event hasn't passed
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
      return new Response(JSON.stringify({ sent: 0, message: 'No pending reminders' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    let sentCount = 0;

    for (const entry of entries) {
      // Calculate when the reminder should fire
      const eventDate = new Date(entry.event_date);
      if (entry.event_time) {
        const [hours, minutes] = entry.event_time.split(':').map(Number);
        eventDate.setHours(hours, minutes, 0, 0);
      } else {
        // Date-only events: treat as start of day (9 AM default)
        eventDate.setHours(9, 0, 0, 0);
      }

      const reminderTime = new Date(eventDate.getTime() - entry.reminder_minutes * 60 * 1000);

      // Is the reminder due? (reminder time is in the past, but event hasn't passed)
      if (now >= reminderTime && now < eventDate) {
        // For timed-only checks, only fire if reminder is due within the next 15 minutes window
        if (timedOnly) {
          const fifteenMinAgo = new Date(now.getTime() - 15 * 60 * 1000);
          if (reminderTime < fifteenMinAgo) continue; // Already missed this window
        }

        // Find user's Slack channel from their most recent agent_tasks entry
        let slackChannel: string | undefined;
        if (botToken) {
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

        // Calculate time until event
        const msUntil = eventDate.getTime() - now.getTime();
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
              if (!resData.ok) {
                console.warn(`[reminder-check] Slack API error for entry ${entry.id}:`, resData.error);
              }
            }
          } catch (err) {
            console.warn(`[reminder-check] Slack send failed for entry ${entry.id}:`, err);
          }
        }

        // Mark as sent regardless of Slack success (avoid re-sending on next cycle)
        await supabase
          .from('entries')
          .update({ reminder_sent: true })
          .eq('id', entry.id);

        sentCount++;
        console.log(`[reminder-check] Sent reminder for "${title}" (entry ${entry.id})`);
      }
    }

    return new Response(JSON.stringify({
      sent: sentCount,
      checked: entries.length,
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
