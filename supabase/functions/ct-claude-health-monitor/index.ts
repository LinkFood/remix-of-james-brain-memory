/**
 * ct-claude-health-monitor — "is Claude alive" heartbeat.
 *
 * Every 10 min, we check how long it has been since the last ct_claude_decisions
 * row. During RTH (weekday 9:30-16:00 ET), long silence = Claude is asleep and
 * something is broken — we trip a 'heartbeat_stale' circuit breaker. Outside
 * RTH we log status='off_hours' and never trip.
 *
 * Status ladder (RTH only):
 *   - alive:  minutes_since_decision < threshold
 *   - stale:  threshold <= minutes_since_decision < 2*threshold
 *   - dead:   minutes_since_decision >= 2*threshold
 *
 * stale + dead both trip the 'heartbeat_stale' breaker (idempotent — at most
 * one open row per session).
 *
 * Auth: service role only. Called by pg_cron every 10 min (inc. off-hours so we
 * always have a heartbeat row to diagnose from).
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { getConfig } from '../_shared/configCache.ts';

type Status = 'alive' | 'stale' | 'dead' | 'off_hours';

function nySessionDate(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
}

/** Weekday 9:30-16:00 America/New_York. Does NOT check market holidays. */
function isRegularTradingHours(now: Date): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday:  'short',
    hour12:   false,
    hour:     '2-digit',
    minute:   '2-digit',
  }).formatToParts(now);
  const weekday = parts.find((p) => p.type === 'weekday')?.value;
  const hour = Number(parts.find((p) => p.type === 'hour')?.value);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value);
  if (!weekday || !Number.isFinite(hour) || !Number.isFinite(minute)) return false;
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  const totalMin = hour * 60 + minute;
  const openMin = 9 * 60 + 30;
  const closeMin = 16 * 60;
  return totalMin >= openMin && totalMin < closeMin;
}

/** Check if a heartbeat-stale breaker is already open today. */
async function hasActiveHeartbeatBreaker(supabase: SupabaseClient, sessionDate: string): Promise<boolean> {
  const { count } = await supabase
    .from('ct_claude_circuit_breakers')
    .select('id', { count: 'exact', head: true })
    .eq('session_date', sessionDate)
    .eq('breaker_type', 'heartbeat_stale')
    .is('cleared_at', null);
  return (count ?? 0) > 0;
}

serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  const corsHeaders = getCorsHeaders(req);

  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'Service role required' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
  const startedAt = Date.now();

  const now = new Date();
  const rth = isRegularTradingHours(now);
  const thresholdMin = Number(await getConfig<number>('claude_heartbeat_stale_minutes', 30));

  // Latest decision-journal entry.
  const { data: latest, error: latestErr } = await supabase
    .from('ct_claude_decisions')
    .select('id, created_at')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestErr) {
    console.warn('[ct-claude-health-monitor] decisions query error:', latestErr.message);
  }

  const lastDecisionAt = latest?.created_at ? new Date(latest.created_at as string) : null;
  const minutesSince = lastDecisionAt
    ? +((now.getTime() - lastDecisionAt.getTime()) / 60_000).toFixed(2)
    : null;

  let status: Status;
  let note: string;
  if (!rth) {
    status = 'off_hours';
    note = lastDecisionAt
      ? `off_hours; last decision ${minutesSince}m ago`
      : 'off_hours; no decisions yet';
  } else if (minutesSince == null) {
    // RTH but no decisions ever — treat as dead.
    status = 'dead';
    note = `RTH; no decisions on record`;
  } else if (minutesSince < thresholdMin) {
    status = 'alive';
    note = `RTH; last decision ${minutesSince}m ago (threshold ${thresholdMin}m)`;
  } else if (minutesSince < 2 * thresholdMin) {
    status = 'stale';
    note = `RTH; last decision ${minutesSince}m ago (threshold ${thresholdMin}m) — stale`;
  } else {
    status = 'dead';
    note = `RTH; last decision ${minutesSince}m ago (threshold ${thresholdMin}m) — dead`;
  }

  // Write heartbeat row.
  const { data: hbRow, error: hbErr } = await supabase
    .from('ct_claude_heartbeat')
    .insert({
      status,
      last_decision_at:       lastDecisionAt ? lastDecisionAt.toISOString() : null,
      minutes_since_decision: minutesSince,
      note,
    })
    .select('id')
    .single();
  if (hbErr) {
    console.warn('[ct-claude-health-monitor] heartbeat insert error:', hbErr.message);
  }

  // Trip 'heartbeat_stale' breaker if RTH + stale|dead + not already tripped.
  const sessionDate = nySessionDate();
  let breakerTripped: { id?: string; reason?: string } | null = null;
  if (rth && (status === 'stale' || status === 'dead')) {
    const alreadyTripped = await hasActiveHeartbeatBreaker(supabase, sessionDate);
    if (!alreadyTripped) {
      const reason = `heartbeat ${status}: ${note}`;
      const { data: inserted, error: brErr } = await supabase
        .from('ct_claude_circuit_breakers')
        .insert({
          session_date:  sessionDate,
          breaker_type:  'heartbeat_stale',
          trigger_value: minutesSince,
          threshold:     thresholdMin,
          reason,
        })
        .select('id')
        .single();
      if (brErr) {
        console.warn('[ct-claude-health-monitor] breaker insert error:', brErr.message);
      } else {
        breakerTripped = { id: inserted?.id as string, reason };
        await supabase.from('ct_claude_decisions').insert({
          decision_type: 'circuit_breaker_tripped',
          model_tier:    'none',
          reasoning:     reason,
          outcome:       `breaker=heartbeat_stale trigger=${minutesSince}m threshold=${thresholdMin}m`,
          context_snapshot: {
            breaker_type:     'heartbeat_stale',
            session_date:     sessionDate,
            status,
            minutes_since:    minutesSince,
            threshold:        thresholdMin,
          },
        });
      }
    }
  }

  const body = {
    ok: true,
    rth,
    status,
    minutes_since_decision: minutesSince,
    threshold_minutes:      thresholdMin,
    last_decision_at:       lastDecisionAt ? lastDecisionAt.toISOString() : null,
    heartbeat_row_id:       hbRow?.id ?? null,
    breaker_tripped:        breakerTripped,
    session_date:           sessionDate,
    note,
    duration_ms:            Date.now() - startedAt,
  };
  console.log('[ct-claude-health-monitor]', JSON.stringify(body));
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
