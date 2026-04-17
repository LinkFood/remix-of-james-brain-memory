/**
 * ct-slack-digest — scheduled state-of-market Slack push.
 *
 * Cron: every 30min during market hours (0,30 13-20 * * 1-5).
 * Purpose: guaranteed baseline ping regardless of event activity.
 * James: "give me a heartbeat every 30min no matter what, and leave
 * Claude free to ping more if something actually new happens."
 *
 * Payload: 5-bullet summary of current tape state, convergence read,
 * open positions, latest Claude take, and any kill conditions.
 *
 * Auth: service role only.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { ctSlackPushDirect } from '../_shared/ctSlack.ts';

function relTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 1 ? 'now' : m < 60 ? `${m}m` : `${Math.round(m / 60)}h`;
}

serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  const corsHeaders = getCorsHeaders(req);

  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // Get the single user
  const { data: users } = await supabase.from('profiles').select('id').limit(1);
  const userId = users?.[0]?.id as string | undefined;
  if (!userId) {
    return new Response(JSON.stringify({ skipped: true, reason: 'no_user' }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const sessionDate = new Date().toISOString().slice(0, 10);
  const [latestHb, latestObs, latestFlag, latestAlert, openTrades, book] = await Promise.all([
    supabase.from('ct_heartbeats').select('status_line, created_at').order('created_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('ct_observations').select('direction, glance, created_at, instruments').order('created_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('ct_flags').select('direction, conviction, glance, created_at').gte('created_at', `${sessionDate}T00:00:00Z`).order('created_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('ct_alerts').select('direction, alert_trigger, glance, created_at').gte('created_at', `${sessionDate}T00:00:00Z`).order('created_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('ct_trades').select('instrument, side, size_pct, entry_price, thesis').eq('session_date', sessionDate).eq('status', 'open'),
    supabase.from('ct_book').select('starting_balance, realized_pnl, trades_count, wins, losses').eq('session_date', sessionDate).maybeSingle(),
  ]);

  const hb = latestHb.data;
  const obs = latestObs.data;
  const flag = latestFlag.data;
  const alert = latestAlert.data;
  const trades = (openTrades.data ?? []) as Array<{ instrument: string; side: string; size_pct: number; entry_price: number | null; thesis: string }>;
  const bk = book.data;

  const now = new Date();
  const etHour = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }).format(now);
  const etMin = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', minute: '2-digit' }).format(now);

  const lines: string[] = [];
  lines.push(`:clipboard: *Co-Trader 30min digest* · ${etHour}:${etMin} ET`);

  // 1. Current read
  if (obs) {
    const glance0 = (obs.glance as string[] | null)?.[0] ?? '';
    const tickers = (obs.instruments as string[] | null)?.join('/') ?? '';
    lines.push(`• *Read* (${relTime(obs.created_at as string)}): ${obs.direction}${tickers ? ` on ${tickers}` : ''} — ${glance0.slice(0, 160)}`);
  } else if (hb) {
    lines.push(`• *Heartbeat* (${relTime(hb.created_at as string)}): ${(hb.status_line as string).slice(0, 180)}`);
  } else {
    lines.push(`• *Read*: no observation yet today`);
  }

  // 2. Latest flag/alert today
  if (alert) {
    const g0 = (alert.glance as string[] | null)?.[0] ?? '';
    lines.push(`• *Last ALERT* (${relTime(alert.created_at as string)}): ${alert.direction} · ${alert.alert_trigger} — ${g0.slice(0, 140)}`);
  } else if (flag) {
    const g0 = (flag.glance as string[] | null)?.[0] ?? '';
    lines.push(`• *Last FLAG* (${relTime(flag.created_at as string)}): ${flag.direction} conv ${flag.conviction} — ${g0.slice(0, 140)}`);
  } else {
    lines.push(`• *No FLAG/ALERT today* — all reads at OBSERVATION tier`);
  }

  // 3. Book status
  if (bk) {
    const pnl = bk.realized_pnl ?? 0;
    const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
    lines.push(`• *Book*: ${pnlStr} realized · ${bk.trades_count ?? 0} trades (${bk.wins ?? 0}W/${bk.losses ?? 0}L)`);
  }

  // 4. Open positions
  if (trades.length > 0) {
    const tradeLines = trades.slice(0, 3).map(t => `${t.instrument} ${t.side} ${t.size_pct}% @ ${t.entry_price?.toFixed(2) ?? '—'}`).join(' · ');
    lines.push(`• *Open*: ${tradeLines}`);
  } else {
    lines.push(`• *Open*: flat`);
  }

  // 5. Quick guidance
  lines.push(`• Next watcher tick in <15min · digests every 30min · ad-hoc pings still fire on material changes`);

  const text = lines.join('\n');
  await ctSlackPushDirect(supabase, userId, text, 'digest');

  return new Response(JSON.stringify({ ok: true, bullets: lines.length }), {
    status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
