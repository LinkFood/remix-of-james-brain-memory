/**
 * slack-incoming — Receive messages from Slack, dispatch to JAC
 *
 * Handles:
 * - Slack URL verification challenge
 * - Event callbacks (message.im, app_mention)
 * - Signature verification via SLACK_SIGNING_SECRET
 * - Fire-and-forget dispatch to jac-dispatcher
 * - Returns 200 within 3 seconds (Slack requirement)
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';

async function verifySlackSignature(
  body: string,
  timestamp: string,
  signature: string,
  signingSecret: string
): Promise<boolean> {
  console.log('[slack-incoming] Signature check — timestamp:', timestamp, 'signature present:', !!signature, 'secret length:', signingSecret.length);

  // Reject requests older than 5 minutes (replay protection)
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp)) > 300) {
    console.warn('[slack-incoming] Request too old, delta:', Math.abs(now - parseInt(timestamp)));
    return false;
  }

  const sigBasestring = `v0:${timestamp}:${body}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(signingSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(sigBasestring));
  const hexSig = 'v0=' + Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  console.log('[slack-incoming] Computed sig prefix:', hexSig.slice(0, 15), 'Received sig prefix:', signature.slice(0, 15));
  return hexSig === signature;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204 });
  }

  try {
    const signingSecret = Deno.env.get('SLACK_SIGNING_SECRET');
    if (!signingSecret) {
      console.error('[slack-incoming] SLACK_SIGNING_SECRET not configured');
      return new Response('Server configuration error', { status: 500 });
    }

    const rawBody = await req.text();
    const payload = JSON.parse(rawBody);

    const timestamp = req.headers.get('x-slack-request-timestamp') || '';
    const slackSignature = req.headers.get('x-slack-signature') || '';

    // Verify signature for ALL requests (including url_verification)
    const isValid = await verifySlackSignature(rawBody, timestamp, slackSignature, signingSecret);
    if (!isValid) {
      console.warn('[slack-incoming] Invalid signature');
      return new Response('Invalid signature', { status: 401 });
    }

    // Handle URL verification challenge (after signature check)
    if (payload.type === 'url_verification') {
      return new Response(JSON.stringify({ challenge: payload.challenge }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Handle event callbacks
    if (payload.type === 'event_callback') {
      // Slack retries events up to 3x if it doesn't get a 200 within 3s.
      // Drop retries to prevent duplicate tasks/messages.
      const retryNum = req.headers.get('x-slack-retry-num');
      if (retryNum && parseInt(retryNum) > 0) {
        console.log(`[slack-incoming] Dropping Slack retry #${retryNum}`);
        return new Response('ok', { status: 200 });
      }

      const event = payload.event;

      // Ignore bot messages (prevent loops)
      if (event.bot_id || event.subtype === 'bot_message') {
        return new Response('ok', { status: 200 });
      }

      // Only handle message events
      if (event.type !== 'message' && event.type !== 'app_mention') {
        return new Response('ok', { status: 200 });
      }

      const messageText = event.text;
      if (!messageText || messageText.trim().length === 0) {
        return new Response('ok', { status: 200 });
      }

      // Strip bot mention from message (e.g., "<@U12345> research AI" → "research AI")
      const cleanMessage = messageText.replace(/<@[A-Z0-9]+>/g, '').trim();
      if (cleanMessage.length === 0) {
        return new Response('ok', { status: 200 });
      }

      const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
      const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
      const supabase = createClient(supabaseUrl, serviceKey);

      // Look up the single user (this is a personal app)
      const { data: profile } = await supabase
        .from('profiles')
        .select('id')
        .limit(1)
        .single();

      if (!profile) {
        console.error('[slack-incoming] No user profile found');
        return new Response('ok', { status: 200 });
      }

      const userId = profile.id;
      const botToken = Deno.env.get('SLACK_BOT_TOKEN');

      // Kill switch: intercept stop commands before dispatching
      const stopWords = ['stop', 'halt', 'cancel', 'kill', 'stop all', 'kill switch'];
      if (stopWords.includes(cleanMessage.toLowerCase())) {
        const now = new Date().toISOString();
        const { data: cancelled } = await supabase
          .from('agent_tasks')
          .update({
            status: 'cancelled',
            cancelled_at: now,
            updated_at: now,
            error: 'Cancelled via Slack',
          })
          .eq('user_id', userId)
          .in('status', ['running', 'queued', 'pending'])
          .select('id');

        const cancelCount = cancelled?.length ?? 0;
        const replyText = cancelCount > 0
          ? `Stopped ${cancelCount} task${cancelCount > 1 ? 's' : ''}. JAC is standing by.`
          : 'No active tasks to stop. JAC is standing by.';

        if (botToken) {
          fetch('https://slack.com/api/chat.postMessage', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${botToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ channel: event.channel, text: replyText }),
          }).catch(() => {});
        }

        return new Response('ok', { status: 200 });
      }

      // Post "thinking" placeholder, then pass its ts to dispatcher so agents
      // can UPDATE this message with the real response (like Claude/ChatGPT do)
      let thinkingTs: string | undefined;
      if (botToken) {
        try {
          const thinkRes = await fetch('https://slack.com/api/chat.postMessage', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${botToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              channel: event.channel,
              text: '_Thinking..._',
            }),
          });
          if (thinkRes.ok) {
            const thinkData = await thinkRes.json();
            if (thinkData.ok && thinkData.ts) {
              thinkingTs = thinkData.ts;
            } else {
              console.warn('[slack-incoming] Slack postMessage ok:false —', thinkData.error);
            }
          }
        } catch {}
      }

      // Fire-and-forget dispatch to jac-dispatcher
      const dispatchUrl = `${supabaseUrl}/functions/v1/jac-dispatcher`;
      console.log('[slack-incoming] Dispatching to jac-dispatcher, userId:', userId, 'message:', cleanMessage.slice(0, 50));
      fetch(dispatchUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: cleanMessage,
          userId,
          slack_channel: event.channel,
          slack_thinking_ts: thinkingTs,
          source: 'slack',
        }),
      }).catch(err => {
        console.error('[slack-incoming] Dispatch failed:', err);
      });

      // Return immediately (within 3 seconds)
      return new Response('ok', { status: 200 });
    }

    return new Response('ok', { status: 200 });

  } catch (error) {
    console.error('[slack-incoming] Error:', error);
    return new Response('ok', { status: 200 }); // Always return 200 to Slack
  }
});
