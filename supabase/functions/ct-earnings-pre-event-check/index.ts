/**
 * ct-earnings-pre-event-check — hourly during RTH.
 *
 * For each watchlist ticker:
 *   1. Look up the NEXT earnings row in ct_events (event_type='earnings',
 *      event_date >= today, ordered asc).
 *   2. Compute the effective report datetime:
 *          report_date 09:30 ET (bmo)  — before open
 *          report_date 16:00 ET (amc)  — after close
 *          report_date 12:00 ET (intraday / unknown)
 *   3. Compute hours_to_report = (effective_dt - now) / 3600s.
 *   4. For each threshold 48h, 24h, 1h (largest-first): if
 *          0 < hours_to_report <= threshold
 *      AND no prior ct_watcher_event_triggers row exists with dedupe_key
 *          '<TICKER>:<report_date>:<threshold>', fire the watcher.
 *
 * Dedup: an insert into ct_watcher_event_triggers with the composite
 * dedupe_key collides against the partial unique index
 * ux_ct_wet_earnings_dedupe, so if the row is already present the
 * insert errors and we log skip and move on — atomic, no race.
 *
 * After-hours note: if it's currently after hours (market closed) and the
 * 1h window fires for an AMC report (e.g. 15:00 ET check catches 16:00 ET
 * AMC report), the watcher still ticks — the advisory is "size smaller /
 * tighter stops" and remains valid even without an open session.
 *
 * Scope: 12 tickers × ~7 hourly RTH ticks/day = 84 DB probes/day. Trivial.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { getWatchlist } from '../_shared/watchlist.ts';
import { isKillSwitchActive } from '../_shared/killSwitch.ts';

// Largest → smallest. Order matters: if a ticker is already inside the 1h
// window, it would also satisfy 24h + 48h retroactively, but we only want
// ONE ping per threshold per (ticker, report_date). We walk largest-first
// and the dedupe index prevents duplicates.
const THRESHOLDS_HOURS = [48, 24, 1] as const;
type ThresholdHours = typeof THRESHOLDS_HOURS[number];

interface NextEarnings {
  ticker: string;
  report_date: string;         // YYYY-MM-DD
  report_time: 'bmo' | 'amc' | 'intraday' | null;
}

interface CheckResult {
  ticker: string;
  report_date: string | null;
  report_time: string | null;
  hours_to_report: number | null;
  fired: ThresholdHours[];
  skipped: Array<{ threshold: ThresholdHours; reason: string }>;
}

/** Build effective UTC ms for earnings event using ET session conventions. */
function effectiveReportMs(report_date: string, report_time: string | null): number {
  // ET→UTC offset changes across DST. The cheapest correct answer: build the
  // datetime in a known ET wall time then resolve via Date's TZ DB through a
  // formatted comparison. Instead of depending on toLocaleString round-trips,
  // we use a small helper: convert the ET wall time to a UTC instant by
  // comparing UTC vs ET presentations of the same reference Date.
  let hour = 12, minute = 0;
  if (report_time === 'bmo') { hour = 9; minute = 30; }
  else if (report_time === 'amc') { hour = 16; minute = 0; }
  // Intraday / null default to noon ET.

  // report_date in YYYY-MM-DD, ET wall clock. Build an ISO without TZ and
  // resolve by computing the ET offset (EST=-5h, EDT=-4h) for a probe date.
  const [yearStr, monthStr, dayStr] = report_date.split('-');
  const y = parseInt(yearStr, 10);
  const m = parseInt(monthStr, 10);
  const d = parseInt(dayStr, 10);

  // Probe: what UTC time does ET=y-m-d hour:minute correspond to?
  // Use Intl.DateTimeFormat to get the ET offset on that date.
  const probe = new Date(Date.UTC(y, m - 1, d, hour, minute, 0));
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const parts = fmt.formatToParts(probe);
  const get = (t: string) => parseInt(parts.find((p) => p.type === t)?.value ?? '0', 10);
  // The probe was built as UTC=(y-m-d h:m). Intl formatted it back to ET —
  // if ET shows earlier than probe we know ET = UTC - offset, and we need to
  // SHIFT the probe forward by (probe_utc - et_displayed). Compute the delta.
  const etY = get('year'), etM = get('month'), etD = get('day'), etH = get('hour'), etMin = get('minute');
  const etAsUtc = Date.UTC(etY, etM - 1, etD, etH, etMin, 0);
  const offsetMs = probe.getTime() - etAsUtc; // positive → ET is west of UTC
  return probe.getTime() + offsetMs;
}

async function fetchNextEarnings(
  supabase: SupabaseClient,
  todayIso: string,
  watchlist: readonly string[],
): Promise<Map<string, NextEarnings>> {
  const { data, error } = await supabase
    .from('ct_events')
    .select('ticker, event_date, report_time')
    .eq('event_type', 'earnings')
    .in('ticker', watchlist as string[])
    .gte('event_date', todayIso)
    .order('event_date', { ascending: true })
    .limit(500);
  if (error) {
    console.warn('[ct-earnings-pre-event-check] fetch ct_events failed:', error.message);
    return new Map();
  }

  // First row per ticker = soonest upcoming (ORDER BY event_date ASC).
  const map = new Map<string, NextEarnings>();
  for (const r of (data ?? []) as Array<{ ticker: string; event_date: string; report_time: string | null }>) {
    if (!map.has(r.ticker)) {
      map.set(r.ticker, {
        ticker: r.ticker,
        report_date: r.event_date,
        report_time: (r.report_time as 'bmo' | 'amc' | 'intraday' | null) ?? null,
      });
    }
  }
  return map;
}

/**
 * Try to claim a (ticker, report_date, threshold) ping by inserting an audit
 * row. Relies on the partial unique index ux_ct_wet_earnings_dedupe. Returns
 * claim result so caller can decide whether to fire the watcher.
 */
async function claimAndFire(
  supabase: SupabaseClient,
  supabaseUrl: string,
  serviceRoleKey: string,
  ticker: string,
  report_date: string,
  report_time: string | null,
  threshold: ThresholdHours,
  hours_to_report: number,
): Promise<{ claimed: boolean; reason?: string }> {
  const dedupe_key = `${ticker}:${report_date}:${threshold}`;
  const reason = `${ticker} reports in ${hours_to_report.toFixed(1)}h${report_time ? ` (${report_time.toUpperCase()})` : ''} — threshold ${threshold}h`;

  const insertPayload = {
    source: 'earnings_approach' as const,
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
    console.warn('[ct-earnings-pre-event-check] audit insert failed:', error.message);
    return { claimed: false, reason: 'insert_failed' };
  }

  const trigger_id = (data?.id as string | undefined) ?? null;

  // Fire-and-forget POST to ct-watcher with the new source tag so the watcher
  // threads triggered_by through and the prompt picks up the earnings addendum.
  fetch(`${supabaseUrl}/functions/v1/ct-watcher`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      trigger: reason,
      triggered_by: 'earnings_approach',
      reason,
      priority: 'high',
      trigger_id,
      // Context for the watcher's prompt addendum:
      earnings_ticker: ticker,
      earnings_report_date: report_date,
      earnings_report_time: report_time,
      earnings_threshold_hours: threshold,
      earnings_hours_remaining: hours_to_report,
    }),
  }).catch((e) => console.warn('[ct-earnings-pre-event-check] fire failed:', e instanceof Error ? e.message : String(e)));

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
  const todayIso = new Date().toISOString().slice(0, 10);
  const nowMs = Date.now();

  // One ct_config read per tick — passed into fetchNextEarnings and used
  // for the per-ticker loop below.
  const watchlist = await getWatchlist(supabase);
  const nextByTicker = await fetchNextEarnings(supabase, todayIso, watchlist);
  const results: CheckResult[] = [];

  for (const ticker of watchlist) {
    const next = nextByTicker.get(ticker);
    if (!next) {
      results.push({ ticker, report_date: null, report_time: null, hours_to_report: null, fired: [], skipped: [] });
      continue;
    }

    const effMs = effectiveReportMs(next.report_date, next.report_time);
    const hoursRemaining = (effMs - nowMs) / (1000 * 60 * 60);
    const result: CheckResult = {
      ticker,
      report_date: next.report_date,
      report_time: next.report_time,
      hours_to_report: Number(hoursRemaining.toFixed(2)),
      fired: [],
      skipped: [],
    };

    // Already passed — skip all thresholds.
    if (hoursRemaining <= 0) {
      results.push(result);
      continue;
    }

    for (const threshold of THRESHOLDS_HOURS) {
      if (hoursRemaining > threshold) {
        result.skipped.push({ threshold, reason: 'outside_window' });
        continue;
      }
      // hoursRemaining <= threshold → inside window.
      const claim = await claimAndFire(
        supabase,
        supabaseUrl,
        serviceRoleKey,
        ticker,
        next.report_date,
        next.report_time,
        threshold,
        hoursRemaining,
      );
      if (claim.claimed) {
        result.fired.push(threshold);
      } else {
        result.skipped.push({ threshold, reason: claim.reason ?? 'unknown' });
      }
    }

    results.push(result);
  }

  const firedCount = results.reduce((a, r) => a + r.fired.length, 0);

  return new Response(JSON.stringify({
    success: true,
    now_iso: new Date(nowMs).toISOString(),
    fired_count: firedCount,
    results,
    duration_ms: Date.now() - startedAt,
  }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});
