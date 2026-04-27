/**
 * ct-cron-health-check — proactive ct-* cron alerting, fires every 10m.
 *
 * Queries get_cron_status RPC, filters to ct-* jobs, classifies each into
 * one of four buckets, writes non-healthy rows to ct_cron_failures, and
 * pushes a single bundled Slack message for everything that flipped to
 * unhealthy since the last push.
 *
 * Classification (mirrors usePreflightChecks so Preflight and health-check
 * agree on what "healthy" means):
 *
 *   healthy   — last_run_status = 'succeeded' AND last_run_at within 1.33x
 *               expected cadence (single tardy tick is tolerated)
 *   failed    — last_run_status = 'failed'
 *   stale     — last_run_status = 'succeeded' but last_run_at > 1.33x cadence
 *               (cron stopped ticking)
 *   never_ran — last_run_at IS NULL AND scheduled >1h ago (fresh crons that
 *               simply haven't reached their first tick don't trip this)
 *
 * RTH-only cron carve-out: crons whose schedule explicitly restricts to
 * market-hours weekdays (e.g. `* 12-21 * * 1-5`) are skipped from stale
 * detection outside regular trading hours or on weekends/holidays. They
 * legitimately don't tick then. Failed status is always reported regardless.
 *
 * Dedupe: per (cron_name, status), we push Slack at most once per hour.
 * Look up last row where slack_pushed_at is within the last 60 minutes for
 * this (cron_name, status) — if found, skip push but still insert the audit
 * row with slack_pushed_at NULL.
 *
 * Never auto-restarts a cron. Alerts only.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { isKillSwitchActive } from '../_shared/killSwitch.ts';
import { ctSlackPushDirect } from '../_shared/ctSlack.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CronStatus = 'healthy' | 'failed' | 'stale' | 'never_ran' | 'skipped_off_hours';

interface CronRow {
  jobid: number;
  jobname: string;
  schedule: string;
  command: string;
  active: boolean;
  last_run_status: string | null;
  last_run_at: string | null;
}

interface Classification {
  jobname: string;
  status: CronStatus;
  last_run_at: string | null;
  last_run_status: string | null;
  ageMin: number;          // minutes since last_run_at, Infinity if never
  cadenceMin: number;      // parsed expected cadence
  note: string;            // human-readable summary line
}

// ---------------------------------------------------------------------------
// Schedule parsing — lifted verbatim from usePreflightChecks so the two
// surfaces agree on every classification decision. Keep these in sync.
// ---------------------------------------------------------------------------

function expectedCadenceMinutes(schedule: string): number {
  const s = (schedule ?? '').trim();
  if (!s) return 60;

  const parts = s.split(/\s+/);
  if (parts.length !== 5) return 60;
  const [minute, hour, dom, month, dow] = parts;

  // `*/N * * * *` → every N minutes (works with restricted hour ranges too,
  // e.g. `*/5 13-20 * * 1-5` — intraday cadence is still 5m when active)
  const everyNMinMatch = minute.match(/^\*\/(\d+)$/);
  if (everyNMinMatch) {
    return Math.max(1, parseInt(everyNMinMatch[1], 10));
  }

  // `* 12-21 * * 1-5` → once a minute during window
  if (minute === '*') return 1;

  // `N */H * * *` → every H hours at minute N. This is the form the
  // ingester family uses (e.g. `0 */4 * * *` = every 4h on the hour).
  // Must come BEFORE the `N * * * *` check so `hour === '*'` doesn't
  // swallow the `*/H` case incorrectly.
  const everyNHourMatch = hour.match(/^\*\/(\d+)$/);
  if (/^\d+$/.test(minute) && everyNHourMatch) {
    return Math.max(60, parseInt(everyNHourMatch[1], 10) * 60);
  }

  // `N * * * *` → once an hour
  if (/^\d+$/.test(minute) && hour === '*') return 60;

  // Specific hour(s) — daily-ish cadence.
  if (
    /^\d+$/.test(minute) &&
    /^[\d,-]+$/.test(hour) &&
    dom === '*' &&
    month === '*' &&
    (dow === '*' || /^[\d,-]+$/.test(dow))
  ) {
    const hours = hour.split(',').filter(Boolean).length || 1;
    let baseCadence = Math.max(60, Math.floor((24 * 60) / hours));
    // Weekday-only daily crons (e.g. `0 22 * * 1-5`) skip Sat+Sun. The
    // gap between Fri's last fire and Mon's next fire is 72h, so a 24h-
    // cadence threshold would alarm every Monday morning on every such
    // cron. Triple the base cadence to absorb the weekend gap. Hit live
    // 2026-04-27 — 13 weekday-daily crons (ct-spy-capture, ct-vix-capture,
    // ct-eod-positioning, etc.) all flared "stale 63-71h" simultaneously.
    if (/^1-5$/.test(dow) || /^[1-5](,[1-5])+$/.test(dow)) {
      baseCadence *= 3;
    }
    return baseCadence;
  }

  // Weekly-ish schedule (specific dow).
  if (/^\d+$/.test(dow)) return 7 * 24 * 60;

  return 60;
}

function stalenessThresholdMinutes(cadenceMin: number): number {
  // Cadence-aware threshold: 2× cadence, floored at 90min so sub-hour
  // crons still get a generous tail. A 4h cron alerts at 8h; a 5min cron
  // still alerts at 90min minimum. Raised from 1.25× → 2× because
  // Monday-morning Slack kept flaring `stale 1.3h` on 60-min-cadence
  // ingesters that were simply one-tick late coming back from weekend
  // idle. The alert is for breakage, not tardiness.
  return Math.max(90, Math.ceil(cadenceMin * 2));
}

// ---------------------------------------------------------------------------
// Market hours — RTH-only cron carve-out
// ---------------------------------------------------------------------------

/** Is the given wall-clock time during regular NYSE trading hours (approx)?
 *  Uses 9:30-16:00 ET weekdays, no holiday calendar. Cheaper than querying
 *  ct_events for a full holiday check — we err on the side of SKIPPING stale
 *  classification for RTH-only crons, so a missed holiday just means we
 *  stay quiet instead of making noise. Same failure mode as any under-
 *  reporting bug — not actively wrong.
 */
function isRthNow(d: Date = new Date()): boolean {
  const et = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins >= (9 * 60 + 30) && mins <= (16 * 60);
}

/** Is the given wall-clock time within the extended ct-* pipeline window
 *  (12-22 UTC weekdays — approximates 07-18 ET, covering premarket +
 *  extended hours). This is the window the bulk of ct-* crons restrict to.
 */
function isExtendedPipelineActive(d: Date = new Date()): boolean {
  const et = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins >= 4 * 60 && mins <= 20 * 60;
}

/** True if the cron schedule explicitly restricts to weekday market hours
 *  (any hour range < 24h AND dow restricted to 1-5). Examples:
 *    `* 12-21 * * 1-5`       → RTH-extended
 *    `*\/5 13-20 * * 1-5`    → RTH only (5m cadence)
 *    `30 13 * * 1-5`         → daily weekday (not RTH-gated by hour)
 *
 *  We only flag the hour-restricted ones here. Daily weekday crons
 *  (`30 13 * * 1-5`) should still fire on a weekday — if they don't, that's
 *  a real failure regardless of market hours.
 */
function isRthRestrictedSchedule(schedule: string): boolean {
  const parts = (schedule ?? '').trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [, hour, , , dow] = parts;

  const hourRestricted = /^\d+-\d+$/.test(hour) || /^\d+(,\d+)+$/.test(hour);
  const dowRestricted = /^1-5$/.test(dow) || /^[1-5](,[1-5])+$/.test(dow);
  return hourRestricted && dowRestricted;
}

/** Parse the dow field into a set of day-of-week numbers.
 *  Returns null when the field is `*`, a step expression, or otherwise
 *  unparseable — callers should treat null as "not restricted".
 */
function parseDowSet(schedule: string): Set<number> | null {
  const parts = (schedule ?? '').trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const dow = parts[4];
  if (!dow || dow === '*') return null;
  const days = new Set<number>();
  for (const seg of dow.split(',')) {
    const rangeMatch = seg.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const lo = parseInt(rangeMatch[1], 10);
      const hi = parseInt(rangeMatch[2], 10);
      for (let d = lo; d <= hi; d++) days.add(d);
      continue;
    }
    if (/^\d+$/.test(seg)) {
      days.add(parseInt(seg, 10));
      continue;
    }
    return null;
  }
  return days.size > 0 ? days : null;
}

/** True if the schedule's day-of-week field restricts to weekdays only
 *  (i.e. excludes 0 and 6). `30 13 * * 1-5` → true; `30 13 * * *` → false.
 */
function isWeekdayOnlySchedule(schedule: string): boolean {
  const days = parseDowSet(schedule);
  if (!days) return false;
  if (days.has(0) || days.has(6)) return false;
  for (const d of days) if (d >= 1 && d <= 5) return true;
  return false;
}

/** True if the schedule's day-of-week field restricts to weekends only
 *  (i.e. contains only Saturday and/or Sunday). Mirrors isWeekdayOnlySchedule
 *  so Monday-morning alerts don't scream about `ct-news-ingester-weekend`
 *  being stale — by design it won't tick again until Saturday.
 */
function isWeekendOnlySchedule(schedule: string): boolean {
  const days = parseDowSet(schedule);
  if (!days) return false;
  for (const d of days) if (d !== 0 && d !== 6) return false;
  return days.has(0) || days.has(6);
}

/** Is a cron's declared day-of-week active *right now* in UTC (pg_cron's
 *  scheduling clock)? Returns true when the schedule's dow field isn't
 *  restricted or today matches one of the listed days.
 */
function isCronDayActive(schedule: string, d: Date = new Date()): boolean {
  const days = parseDowSet(schedule);
  if (!days) return true;
  return days.has(d.getUTCDay());
}

/** True if today (in UTC — pg_cron uses UTC) is Saturday or Sunday. */
function isWeekendUtc(d: Date = new Date()): boolean {
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}

/** Best-effort "is this schedule's window currently open?" — used to suppress
 *  stale alerts for crons outside their declared hour window.
 *
 *  Handles three cases:
 *   1. RTH-restricted (hour AND dow restricted) — original case
 *   2. Hour-only-restricted (any hour gap, dow=*) — added 2026-04-27 after
 *      my own grader/detector cron splits created off-hours lanes like
 *      `0,30 0-12,21-23 * * *` that legitimately don't fire during RTH but
 *      were flaring stale every RTH. Schedule-aware suppression had to
 *      generalize beyond just RTH-tagged schedules.
 *   3. Otherwise — return true (treat as always-open).
 */
function isScheduleWindowOpen(schedule: string, d: Date = new Date()): boolean {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return true;
  const hour = parts[1];
  const dow = parts[4];
  const utcHour = d.getUTCHours();
  const utcDay = d.getUTCDay();

  // Hour field is `*` — any hour fits → always open (defer to dow check
  // elsewhere via isCronDayActive).
  if (hour === '*') return true;

  // RTH-style: weekend on dow=1-5 → window closed.
  if (/^1-5$/.test(dow) && (utcDay === 0 || utcDay === 6)) return false;

  // Range form `lo-hi`.
  const rangeMatch = hour.match(/^(\d+)-(\d+)$/);
  if (rangeMatch) {
    const lo = parseInt(rangeMatch[1], 10);
    const hi = parseInt(rangeMatch[2], 10);
    return utcHour >= lo && utcHour <= hi;
  }

  // List form `H1,H2,H3` OR list of ranges `H1-H2,H3-H4`. Both supported.
  // Common case for off-hours crons: `0-12,21-23` excludes RTH window.
  const tokens = hour.split(',');
  for (const tok of tokens) {
    const r = tok.match(/^(\d+)-(\d+)$/);
    if (r) {
      const lo = parseInt(r[1], 10);
      const hi = parseInt(r[2], 10);
      if (utcHour >= lo && utcHour <= hi) return true;
      continue;
    }
    const single = tok.match(/^\d+$/);
    if (single && parseInt(tok, 10) === utcHour) return true;
  }
  // Hour field is restricted but current hour matched none — window closed.
  if (/^[\d,-]+$/.test(hour)) return false;

  // Fallback — unparseable hour → conservatively treat as open.
  return true;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

function minutesAgo(iso: string | null): number {
  if (!iso) return Infinity;
  return (Date.now() - new Date(iso).getTime()) / 60_000;
}

function classify(row: CronRow, now: Date): Classification {
  const cadenceMin = expectedCadenceMinutes(row.schedule);
  const threshold = stalenessThresholdMinutes(cadenceMin);
  const ageMin = minutesAgo(row.last_run_at);
  const rthRestricted = isRthRestrictedSchedule(row.schedule);
  const windowOpen = isScheduleWindowOpen(row.schedule, now);
  const weekdayOnly = isWeekdayOnlySchedule(row.schedule);
  const weekendOnly = isWeekendOnlySchedule(row.schedule);
  const dayActiveNow = isCronDayActive(row.schedule, now);
  const weekendNow = isWeekendUtc(now);
  // Off-hours for THIS cron specifically — covers weekday-only-on-weekend,
  // weekend-only-on-weekday, RTH-hour-restricted-outside-window, AND any
  // hour-list gap schedule (e.g. `0-12,21-23` off-hours lanes). The
  // !windowOpen branch used to be gated on `rthRestricted` (hour AND dow
  // restricted), which excluded my own grader/detector off-hours splits
  // that have dow=*. Generalized 2026-04-27 (later that day) — windowOpen
  // already understands hour-list gaps, so just trusting it.
  const offHoursForCron = !dayActiveNow || !windowOpen;

  // failed: trumps everything. Even an off-hours cron that failed should
  // alert — the failure happened, regardless of current hour.
  if ((row.last_run_status ?? '') === 'failed') {
    return {
      jobname: row.jobname,
      status: 'failed',
      last_run_at: row.last_run_at,
      last_run_status: row.last_run_status,
      ageMin,
      cadenceMin,
      note: `failed ${Math.round(ageMin)}m ago`,
    };
  }

  // never_ran: null last_run_at AND scheduled more than 1h ago. Brand-new
  // crons whose first tick hasn't landed yet stay quiet.
  if (!row.last_run_at) {
    // Off-hours for this cron (weekday-only on weekend, weekend-only on
    // weekday, or RTH-hour-restricted outside the window). pg_cron won't
    // fire it right now, so absence of a run is expected. Suppress.
    if (offHoursForCron) {
      const reason = weekdayOnly && weekendNow ? 'weekday-only cron, weekend'
        : weekendOnly && !weekendNow ? 'weekend-only cron, weekday'
        : 'schedule window closed';
      return {
        jobname: row.jobname,
        status: 'skipped_off_hours',
        last_run_at: null,
        last_run_status: row.last_run_status,
        ageMin,
        cadenceMin,
        note: `no run yet (${reason} — suppressed)`,
      };
    }
    // We can't tell from the RPC when the cron was created, so use a
    // simple rule: if the expected cadence < 60m AND the cron is active,
    // it should've ticked by now. For longer-cadence crons, err on quiet —
    // we'll pick it up once last_run_at arrives or a day passes.
    if (row.active && cadenceMin <= 60) {
      return {
        jobname: row.jobname,
        status: 'never_ran',
        last_run_at: null,
        last_run_status: row.last_run_status,
        ageMin,
        cadenceMin,
        note: `never_ran (cadence ~${cadenceMin}m)`,
      };
    }
    // Disabled or slow-cadence + no run yet → treat as healthy-ish; we'll
    // surface it as 'skipped_off_hours' so the writer knows not to alert.
    return {
      jobname: row.jobname,
      status: 'skipped_off_hours',
      last_run_at: null,
      last_run_status: row.last_run_status,
      ageMin,
      cadenceMin,
      note: 'no run yet (long cadence or disabled)',
    };
  }

  // stale: succeeded, but the tick is older than the cadence-scaled
  // threshold. Any off-hours state for this cron suppresses the alert —
  // the silence is expected.
  if (ageMin > threshold) {
    if (offHoursForCron) {
      const reason = weekdayOnly && weekendNow ? 'weekday-only cron, weekend'
        : weekendOnly && !weekendNow ? 'weekend-only cron, weekday'
        : 'schedule window closed';
      return {
        jobname: row.jobname,
        status: 'skipped_off_hours',
        last_run_at: row.last_run_at,
        last_run_status: row.last_run_status,
        ageMin,
        cadenceMin,
        note: `stale ${Math.round(ageMin)}m (${reason} — suppressed)`,
      };
    }
    return {
      jobname: row.jobname,
      status: 'stale',
      last_run_at: row.last_run_at,
      last_run_status: row.last_run_status,
      ageMin,
      cadenceMin,
      note: `stale ${Math.round(ageMin)}m (cadence ~${cadenceMin}m)`,
    };
  }

  return {
    jobname: row.jobname,
    status: 'healthy',
    last_run_at: row.last_run_at,
    last_run_status: row.last_run_status,
    ageMin,
    cadenceMin,
    note: `healthy ${Math.round(ageMin)}m ago`,
  };
}

// ---------------------------------------------------------------------------
// Dedupe — don't re-push same (cron_name, status) within 1h
// ---------------------------------------------------------------------------

async function shouldPushForCron(
  supabase: SupabaseClient,
  cronName: string,
  status: CronStatus,
): Promise<boolean> {
  const cutoff = new Date(Date.now() - 60 * 60_000).toISOString();
  const { data, error } = await supabase
    .from('ct_cron_failures')
    .select('id')
    .eq('cron_name', cronName)
    .eq('status', status)
    .not('slack_pushed_at', 'is', null)
    .gte('slack_pushed_at', cutoff)
    .limit(1);

  if (error) {
    console.warn('[ct-cron-health-check] dedupe lookup failed:', error.message);
    // Fail open: push rather than risk missing an alert.
    return true;
  }
  return (data?.length ?? 0) === 0;
}

// ---------------------------------------------------------------------------
// Slack formatting — bundled digest of newly-degraded crons
// ---------------------------------------------------------------------------

function fmtAge(ageMin: number): string {
  if (!isFinite(ageMin)) return 'never';
  if (ageMin < 1) return '<1m';
  if (ageMin < 60) return `${Math.round(ageMin)}m`;
  return `${(ageMin / 60).toFixed(1)}h`;
}

function buildSlackBundle(entries: Classification[]): string {
  if (entries.length === 0) return '';
  const n = entries.length;
  const header = `:warning: *${n} cron${n === 1 ? '' : 's'} degraded:*`;
  const lines = entries.map((e) => {
    const suffix =
      e.status === 'failed'   ? `failed ${fmtAge(e.ageMin)} ago`
    : e.status === 'stale'    ? `stale ${fmtAge(e.ageMin)}`
    : e.status === 'never_ran'? 'never ran'
    : e.status;
    return `• \`${e.jobname}\` — ${suffix}`;
  });
  // Compact summary if 3+: prepend a one-liner then the list.
  if (n >= 3) {
    const names = entries.slice(0, 3).map((e) => `${e.jobname} (${e.status})`).join(', ');
    const more = n > 3 ? `, +${n - 3} more` : '';
    return `${header} ${names}${more}\n${lines.join('\n')}`;
  }
  // 1-2: inline summary in the header-ish form the spec calls for:
  // "⚠️ 2 crons degraded: ct-watcher (stale 45m), ct-news-ingester (failed 1h ago)"
  const inline = entries.map((e) => {
    const s =
      e.status === 'failed'   ? `failed ${fmtAge(e.ageMin)} ago`
    : e.status === 'stale'    ? `stale ${fmtAge(e.ageMin)}`
    : e.status === 'never_ran'? 'never ran'
    : e.status;
    return `${e.jobname} (${s})`;
  }).join(', ');
  return `${header} ${inline}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

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

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // Kill switch still suppresses Slack pushes — but we DO still run the
  // classification and write audit rows. The UI "Cron health" section
  // should reflect reality even if we're not alerting James.
  const killed = await isKillSwitchActive(supabase);

  const startedAt = Date.now();
  const now = new Date();

  try {
    // 1) Pull cron status.
    const { data: cronData, error: cronErr } = await supabase.rpc('get_cron_status');
    if (cronErr) throw cronErr;
    const rows = (cronData as CronRow[] | null) ?? [];

    // 2) Filter to ct-* jobs. (Accept 'ct_' prefix too — matches Preflight.)
    const ctRows = rows.filter((r) => {
      const n = (r.jobname ?? '').toLowerCase();
      return n.startsWith('ct-') || n.startsWith('ct_');
    });

    // 3) Classify.
    const results = ctRows.map((r) => classify(r, now));
    const unhealthy = results.filter((r) =>
      r.status === 'failed' || r.status === 'stale' || r.status === 'never_ran',
    );

    // 3b) Auto-resolve legacy false positives. When a cron's current state is
    // healthy OR skipped_off_hours, clear any prior `never_ran` / `stale`
    // rows for that cron whose resolved_at is still NULL. Keeps real
    // `failed` rows alone — those stand until a successful tick reliably
    // indicates recovery. Fixes the "14 unresolved failures in last 6h"
    // Preflight card that's reflecting weekend-only crons tagged on Monday
    // morning by the pre-schedule-awareness classifier.
    const nowResolvable = results.filter(
      (r) => r.status === 'healthy' || r.status === 'skipped_off_hours',
    );
    if (nowResolvable.length > 0) {
      const names = nowResolvable.map((r) => r.jobname);
      const { error: resolveErr } = await supabase
        .from('ct_cron_failures')
        .update({ resolved_at: now.toISOString() })
        .is('resolved_at', null)
        .in('cron_name', names)
        .in('status', ['never_ran', 'stale']);
      if (resolveErr) {
        console.warn('[ct-cron-health-check] auto-resolve failed:', resolveErr.message);
      }
    }

    // 4) Insert audit rows for each unhealthy cron. We always write a row
    //    per detection pass — dedupe is *only* on the Slack push side.
    const insertedIds: Record<string, string> = {};
    for (const u of unhealthy) {
      const { data: ins, error: insErr } = await supabase
        .from('ct_cron_failures')
        .insert({
          cron_name: u.jobname,
          status: u.status,
          last_run_at: u.last_run_at,
          last_run_status: u.last_run_status,
          detected_at: now.toISOString(),
        })
        .select('id')
        .single();
      if (insErr) {
        console.warn(`[ct-cron-health-check] insert failed for ${u.jobname}:`, insErr.message);
        continue;
      }
      if (ins?.id) insertedIds[u.jobname] = ins.id as string;
    }

    // 5) Decide which unhealthy rows deserve a Slack push (not deduped).
    const toPush: Classification[] = [];
    for (const u of unhealthy) {
      // Always run the dedupe check so we know whether to stamp
      // slack_pushed_at on the audit row, even if kill switch blocks Slack.
      const ok = await shouldPushForCron(supabase, u.jobname, u.status);
      if (ok) toPush.push(u);
    }

    // 6) Bundle + push one Slack message. Kill switch suppresses the post
    //    but we still stamp slack_pushed_at so the dedupe window advances
    //    (we don't want to spam the minute the switch lifts).
    let slackPushed = false;
    if (toPush.length > 0) {
      const text = buildSlackBundle(toPush);
      if (!killed && text) {
        // Resolve userId (single-user pattern — same as ct-macro-event-slack).
        const { data: users } = await supabase.from('profiles').select('id').limit(1);
        const userId = (users?.[0]?.id as string | undefined) ?? null;
        if (userId) {
          await ctSlackPushDirect(supabase, userId, text, 'cron_health');
          slackPushed = true;
        }
      }

      // Stamp slack_pushed_at on each row we included in the bundle.
      const stampAt = new Date().toISOString();
      for (const u of toPush) {
        const rowId = insertedIds[u.jobname];
        if (!rowId) continue;
        await supabase
          .from('ct_cron_failures')
          .update({ slack_pushed_at: stampAt })
          .eq('id', rowId);
      }
    }

    return new Response(JSON.stringify({
      success: true,
      scanned: ctRows.length,
      healthy: results.filter((r) => r.status === 'healthy').length,
      failed: results.filter((r) => r.status === 'failed').length,
      stale: results.filter((r) => r.status === 'stale').length,
      never_ran: results.filter((r) => r.status === 'never_ran').length,
      skipped_off_hours: results.filter((r) => r.status === 'skipped_off_hours').length,
      pushed_to_slack: slackPushed,
      bundle_size: toPush.length,
      kill_switch_active: killed,
      duration_ms: Date.now() - startedAt,
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[ct-cron-health-check] fatal:', err);
    return new Response(JSON.stringify({
      error: err instanceof Error ? err.message : 'failed',
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
