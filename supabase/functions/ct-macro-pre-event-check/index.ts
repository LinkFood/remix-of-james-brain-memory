/**
 * ct-macro-pre-event-check — hourly during RTH.
 *
 * Parallel to ct-earnings-pre-event-check, but for macro releases. For each
 * macro event in ct_events (event_type='econ') in the next 48h whose title
 * classifies as one of the 7 canonical macro types, fire the watcher at
 * 48h, 24h, and 1h thresholds (largest-first, deduped).
 *
 * Only HIGH-impact events fire watcher pings. Medium/low still show in the
 * MacroCalendar UI but don't consume watcher budget.
 *
 * Dedup: composite key 'MACRO:<event_key>:<event_date>:<threshold_hours>'
 * collides against ux_ct_wet_macro_dedupe so the same (event, threshold)
 * fires exactly once — same atomic pattern as earnings.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { isKillSwitchActive } from '../_shared/killSwitch.ts';
import { classifyMacroEvent, macroImpact, macroLabel, type MacroEventType } from '../_shared/macroEvents.ts';

// Largest → smallest. Same pattern as earnings: walk big-first so the dedupe
// index prevents us firing all three thresholds in one pass.
const THRESHOLDS_HOURS = [48, 24, 1] as const;
type ThresholdHours = typeof THRESHOLDS_HOURS[number];

interface MacroEventRow {
  id: string;
  event_date: string;
  event_time: string | null;
  title: string;
  importance: number | null;
  macro_type: MacroEventType;
}

/**
 * Macro events publish at a stated ET time. If the ingester captured
 * event_time, use it. Otherwise default to 08:30 ET which is the most
 * common BLS / Census release slot — overconservative, but better than
 * missing the 1h window because we anchored to noon.
 */
function effectiveEventMs(event_date: string, event_time: string | null): number {
  let hour = 8, minute = 30;
  if (event_time) {
    const m = event_time.match(/^(\d{2}):(\d{2})/);
    if (m) {
      hour = parseInt(m[1], 10);
      minute = parseInt(m[2], 10);
      // Times stored with "+00" suffix are UTC; times without a tz label from
      // UW are ET wall-clock. The ingester normalizes to "+00", so if we see
      // the +00 form treat as UTC directly.
      if (/\+00$/.test(event_time) || /Z$/.test(event_time)) {
        return new Date(`${event_date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`).getTime();
      }
    }
  }
  // ET wall-clock path — probe for offset on that date.
  const [y, m, d] = event_date.split('-').map((s) => parseInt(s, 10));
  const probe = new Date(Date.UTC(y, m - 1, d, hour, minute, 0));
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).formatToParts(probe);
  const get = (t: string) => parseInt(parts.find((p) => p.type === t)?.value ?? '0', 10);
  const etAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), 0);
  const offsetMs = probe.getTime() - etAsUtc;
  return probe.getTime() + offsetMs;
}

async function fetchMacroCandidates(supabase: SupabaseClient): Promise<MacroEventRow[]> {
  const now = new Date();
  const todayIso = now.toISOString().slice(0, 10);
  const plus48 = new Date(now.getTime() + 48 * 3600_000).toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from('ct_events')
    .select('id, event_date, event_time, title, importance')
    .eq('event_type', 'econ')
    .gte('event_date', todayIso)
    .lte('event_date', plus48)
    .order('event_date', { ascending: true });
  if (error) {
    console.warn('[ct-macro-pre-event-check] fetch failed:', error.message);
    return [];
  }

  const out: MacroEventRow[] = [];
  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    const title = typeof r.title === 'string' ? r.title : null;
    const macro_type = classifyMacroEvent(title);
    if (!macro_type) continue;
    // Only fire on HIGH-impact macro — med/low still show in UI but don't
    // consume watcher budget.
    const impact = macroImpact(macro_type, typeof r.importance === 'number' ? r.importance : null);
    if (impact !== 'high') continue;
    out.push({
      id: String(r.id),
      event_date: String(r.event_date),
      event_time: typeof r.event_time === 'string' ? r.event_time : null,
      title: title ?? '',
      importance: typeof r.importance === 'number' ? r.importance : null,
      macro_type,
    });
  }
  return out;
}

async function claimAndFire(
  supabase: SupabaseClient,
  supabaseUrl: string,
  serviceRoleKey: string,
  ev: MacroEventRow,
  threshold: ThresholdHours,
  hours_remaining: number,
): Promise<{ claimed: boolean; reason?: string }> {
  const dedupe_key = `MACRO:${ev.macro_type}:${ev.event_date}:${threshold}`;
  const label = macroLabel(ev.macro_type);
  const reason = `${label} in ~${hours_remaining.toFixed(1)}h (${ev.event_date}) — threshold ${threshold}h`;

  const insertPayload = {
    source: 'macro_event_approach' as const,
    reason,
    priority: 'high' as const,
    trigger_fired: true,
    skip_reason: null as string | null,
    ticks_since_last_trigger: 0,
    dedupe_key,
  };

  const { data, error } = await supabase
    .from('ct_watcher_event_triggers')
    .insert(insertPayload)
    .select('id')
    .maybeSingle();

  if (error) {
    if (/duplicate|unique/i.test(error.message)) {
      return { claimed: false, reason: 'already_fired' };
    }
    console.warn('[ct-macro-pre-event-check] audit insert failed:', error.message);
    return { claimed: false, reason: 'insert_failed' };
  }

  const trigger_id = (data?.id as string | undefined) ?? null;

  fetch(`${supabaseUrl}/functions/v1/ct-watcher`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      trigger: reason,
      triggered_by: 'macro_event_approach',
      reason,
      priority: 'high',
      trigger_id,
      macro_type: ev.macro_type,
      macro_label: label,
      macro_event_date: ev.event_date,
      macro_event_time: ev.event_time,
      macro_threshold_hours: threshold,
      macro_hours_remaining: hours_remaining,
      macro_title: ev.title,
    }),
  }).catch((e) =>
    console.warn('[ct-macro-pre-event-check] fire failed:', e instanceof Error ? e.message : String(e)),
  );

  return { claimed: true };
}

serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  const corsHeaders = getCorsHeaders(req);
  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  if (await isKillSwitchActive(supabase)) {
    return new Response(JSON.stringify({ success: true, skipped: 'kill_switch' }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const startedAt = Date.now();
  const nowMs = Date.now();

  const candidates = await fetchMacroCandidates(supabase);
  const results: Array<{
    macro_type: MacroEventType;
    event_date: string;
    hours_to_event: number;
    fired: ThresholdHours[];
    skipped: Array<{ threshold: ThresholdHours; reason: string }>;
  }> = [];

  for (const ev of candidates) {
    const effMs = effectiveEventMs(ev.event_date, ev.event_time);
    const hoursRemaining = (effMs - nowMs) / (1000 * 60 * 60);
    const r: (typeof results)[number] = {
      macro_type: ev.macro_type,
      event_date: ev.event_date,
      hours_to_event: Number(hoursRemaining.toFixed(2)),
      fired: [],
      skipped: [],
    };
    if (hoursRemaining <= 0) {
      results.push(r);
      continue;
    }
    for (const threshold of THRESHOLDS_HOURS) {
      if (hoursRemaining > threshold) {
        r.skipped.push({ threshold, reason: 'outside_window' });
        continue;
      }
      const claim = await claimAndFire(supabase, supabaseUrl, serviceRoleKey, ev, threshold, hoursRemaining);
      if (claim.claimed) r.fired.push(threshold);
      else r.skipped.push({ threshold, reason: claim.reason ?? 'unknown' });
    }
    results.push(r);
  }

  const fired_count = results.reduce((a, r) => a + r.fired.length, 0);

  return new Response(JSON.stringify({
    success: true,
    now_iso: new Date(nowMs).toISOString(),
    candidates: candidates.length,
    fired_count,
    results,
    duration_ms: Date.now() - startedAt,
  }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});
