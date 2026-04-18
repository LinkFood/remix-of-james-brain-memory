/**
 * ct-macro-event-slack — hourly Slack digest for macro events inside 24h.
 *
 * For every ct_events row (event_type='econ') whose title classifies as one
 * of the 7 canonical macro types AND lands within the next 24h AND we have
 * not yet pushed about today, post a single Slack line including Claude's
 * current pre-event posture (latest index alert/flag in the last 24h).
 *
 * Dedupe: mark last_slack_pushed_at on the row after a successful push.
 * The filter "no push today" uses last_slack_pushed_at >= today_start_utc.
 * One macro event → at most one push per day.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { isKillSwitchActive } from '../_shared/killSwitch.ts';
import { ctSlackPushDirect } from '../_shared/ctSlack.ts';
import { classifyMacroEvent, macroImpact, macroLabel, type MacroEventType } from '../_shared/macroEvents.ts';

interface Candidate {
  id: string;
  event_date: string;
  event_time: string | null;
  title: string;
  importance: number | null;
  macro_type: MacroEventType;
}

interface Posture {
  kind: 'alert' | 'flag';
  direction: string;
  instruments: string[];
  conviction: number;
  horizon: string;
  glance: string[];
  created_at: string;
}

async function fetchCandidates(supabase: SupabaseClient): Promise<Candidate[]> {
  const now = new Date();
  const todayIso = now.toISOString().slice(0, 10);
  const plus24 = new Date(now.getTime() + 24 * 3600_000).toISOString().slice(0, 10);
  // "Pushed today" window = since 00:00 UTC of current day. Good enough for
  // a single-user app — not worrying about user's local midnight.
  const todayStartUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();

  const { data, error } = await supabase
    .from('ct_events')
    .select('id, event_date, event_time, title, importance, last_slack_pushed_at')
    .eq('event_type', 'econ')
    .gte('event_date', todayIso)
    .lte('event_date', plus24)
    .order('event_date', { ascending: true });
  if (error) {
    console.warn('[ct-macro-event-slack] fetch failed:', error.message);
    return [];
  }

  const out: Candidate[] = [];
  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    const title = typeof r.title === 'string' ? r.title : null;
    const macro_type = classifyMacroEvent(title);
    if (!macro_type) continue;
    // Only HIGH / MEDIUM impact get Slack pushes. Fed-speak lands on LOW and
    // would spam the channel (one per Fed governor event).
    const impact = macroImpact(macro_type, typeof r.importance === 'number' ? r.importance : null);
    if (impact === 'low') continue;
    // Dedupe: already pushed since today-start UTC?
    const lastPushed = typeof r.last_slack_pushed_at === 'string' ? r.last_slack_pushed_at : null;
    if (lastPushed && lastPushed >= todayStartUtc) continue;
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

async function fetchPosture(supabase: SupabaseClient): Promise<Posture | null> {
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const indexInstruments = ['SPY', 'QQQ', 'IWM', 'SPX'];

  const [alerts, flags] = await Promise.all([
    supabase
      .from('ct_alerts')
      .select('id, created_at, instruments, direction, conviction, horizon, glance')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(10),
    supabase
      .from('ct_flags')
      .select('id, created_at, instruments, direction, conviction, horizon, glance')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(10),
  ]);

  type Row = { id: string; created_at: string; instruments: string[]; direction: string; conviction: number; horizon: string; glance: string[] | null };
  const filter = (rows: Row[]) => rows.filter(r => (r.instruments ?? []).some(t => indexInstruments.includes(t)));

  const alertRows = filter((alerts.data ?? []) as Row[]).map(r => ({ ...r, kind: 'alert' as const }));
  const flagRows = filter((flags.data ?? []) as Row[]).map(r => ({ ...r, kind: 'flag' as const }));
  const all = [...alertRows, ...flagRows].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
  if (all.length === 0) return null;

  const top = all[0];
  // Prefer alert at same timestamp
  const tiedAlert = all.find(r => r.kind === 'alert' && r.created_at === top.created_at);
  const pick = tiedAlert ?? top;
  return {
    kind: pick.kind,
    direction: pick.direction,
    instruments: pick.instruments,
    conviction: pick.conviction,
    horizon: pick.horizon,
    glance: (pick.glance ?? []).filter((g): g is string => typeof g === 'string'),
    created_at: pick.created_at,
  };
}

function hoursUntil(event_date: string, event_time: string | null): number {
  let hour = 8, minute = 30;
  if (event_time) {
    const m = event_time.match(/^(\d{2}):(\d{2})/);
    if (m) { hour = parseInt(m[1], 10); minute = parseInt(m[2], 10); }
  }
  // ET→UTC resolve (same probe trick as pre-event-check)
  const [y, mo, d] = event_date.split('-').map((s) => parseInt(s, 10));
  const probe = new Date(Date.UTC(y, mo - 1, d, hour, minute, 0));
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).formatToParts(probe);
  const get = (t: string) => parseInt(parts.find(p => p.type === t)?.value ?? '0', 10);
  const etAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), 0);
  const offsetMs = probe.getTime() - etAsUtc;
  const ms = probe.getTime() + offsetMs;
  return (ms - Date.now()) / 3_600_000;
}

function buildSlackText(c: Candidate, posture: Posture | null): string {
  const label = macroLabel(c.macro_type);
  const hrs = hoursUntil(c.event_date, c.event_time);
  const when = hrs < 1
    ? `in ${Math.round(hrs * 60)}m`
    : hrs < 24
      ? `in ${hrs.toFixed(1)}h`
      : 'tomorrow';
  const timePart = c.event_time ? ` ${c.event_time.slice(0, 5)} ET` : '';
  const header = `:calendar: *${label}* ${when}${timePart}`;

  let postureLine = '_Claude posture: no recent index read in 24h_';
  if (posture) {
    const mins = Math.round((Date.now() - new Date(posture.created_at).getTime()) / 60_000);
    const ageStr = mins < 60 ? `${mins}m ago` : `${(mins / 60).toFixed(1)}h ago`;
    const summary = posture.glance[0] ?? `${posture.direction} ${posture.instruments.join('/')}`;
    postureLine = `Claude posture: *${posture.direction}* ${posture.instruments.slice(0, 2).join('/')} · conv ${posture.conviction} · ${posture.horizon} (${ageStr} ${posture.kind}) — ${summary}`;
  }
  const titleLine = c.title && c.title !== label ? `\n_${c.title}_` : '';
  return `${header}${titleLine}\n${postureLine}`;
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

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  if (await isKillSwitchActive(supabase)) {
    return new Response(JSON.stringify({ success: true, skipped: 'kill_switch' }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const startedAt = Date.now();

  try {
    const candidates = await fetchCandidates(supabase);
    if (candidates.length === 0) {
      return new Response(JSON.stringify({ success: true, pushed: 0, candidates: 0, duration_ms: Date.now() - startedAt }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const posture = await fetchPosture(supabase);

    // Single-user lookup — same pattern as ct-watcher for userId resolution.
    const { data: users } = await supabase.from('profiles').select('id').limit(1);
    const userId = (users?.[0]?.id as string | undefined) ?? null;

    const pushed: Array<{ id: string; macro_type: string; text: string }> = [];
    for (const c of candidates) {
      const text = buildSlackText(c, posture);
      if (userId) {
        await ctSlackPushDirect(supabase, userId, text, 'macro_event');
      }
      // Mark pushed regardless — if Slack is down we still don't want to
      // spam hourly. The dedupe sentinel is "attempted today", not
      // "delivered today". ctSlackPushDirect logs failures to ct_slack_log.
      await supabase
        .from('ct_events')
        .update({ last_slack_pushed_at: new Date().toISOString() })
        .eq('id', c.id);
      pushed.push({ id: c.id, macro_type: c.macro_type, text: text.slice(0, 200) });
    }

    return new Response(JSON.stringify({
      success: true,
      candidates: candidates.length,
      pushed: pushed.length,
      posture: posture ? { direction: posture.direction, conviction: posture.conviction, kind: posture.kind } : null,
      results: pushed,
      duration_ms: Date.now() - startedAt,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    console.error('[ct-macro-event-slack] fatal:', err);
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : 'failed' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
