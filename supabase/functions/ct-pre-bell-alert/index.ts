/**
 * ct-pre-bell-alert — 09:15 ET readiness check with Slack escalation.
 *
 * Cron: 13:15 UTC Mon-Fri (09:15 ET during DST; 08:15 ET outside DST —
 * the cron runs 15 min before the bell in daylight-saving months, which
 * is the window where James actually trades. If the OS is live through a
 * standard-time winter, revisit the schedule.)
 *
 * Mirrors the eight checks from src/hooks/usePreBellReadiness.ts exactly —
 * if you change one, change both. Slack push fires ONLY when at least one
 * check is in 'fail' state. Pending rows are not alerts (still upstream,
 * might land in the next 15 minutes).
 *
 * Auth: service role only, no new UW calls.
 * On holidays: returns early with `{ skipped: 'holiday' }` and does not
 * push to Slack.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { ctSlackPushDirect } from '../_shared/ctSlack.ts';

// ---------------------------------------------------------------------------
// ET / holiday helpers (local copy — edge runtime can't import src/lib).
// Keep in sync with src/lib/etMarketClock.ts.
// ---------------------------------------------------------------------------

const ET_TZ = 'America/New_York';

const NYSE_HOLIDAYS: ReadonlySet<string> = new Set([
  // 2026
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
  '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  // 2027
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31',
  '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
]);

function etYmd(now: Date = new Date()): string {
  // en-CA yields YYYY-MM-DD, which is exactly what we want.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: ET_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

function etWeekday(now: Date = new Date()): number {
  const short = new Intl.DateTimeFormat('en-US', { timeZone: ET_TZ, weekday: 'short' }).format(now);
  return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[short as 'Mon'] ?? 0;
}

function isTradingDay(now: Date = new Date()): boolean {
  const wd = etWeekday(now);
  if (wd === 0 || wd === 6) return false;
  return !NYSE_HOLIDAYS.has(etYmd(now));
}

// ---------------------------------------------------------------------------
// Check results
// ---------------------------------------------------------------------------

type Status = 'ok' | 'pending' | 'fail';

interface Check {
  id: string;
  label: string;
  status: Status;
  detail: string;
}

async function run(supabase: SupabaseClient): Promise<Check[]> {
  const today = etYmd();
  const sixHoursAgoIso = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const dayStartUtc = new Date(`${today}T00:00:00-05:00`).toISOString();

  // Kick off everything in parallel — this endpoint should finish in <2s.
  const [
    morningBrief,
    premarketScanCount,
    book,
    killSwitchActive,
    uwUsage,
    uiErrorCount,
    openTrades,
    biasesCount,
  ] = await Promise.all([
    supabase.from('ct_reports')
      .select('id, created_at')
      .eq('report_type', 'morning_brief')
      .gte('created_at', dayStartUtc)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase.from('ct_premarket_gaps')
      .select('*', { count: 'estimated', head: true })
      .eq('session_date', today),
    supabase.from('ct_book')
      .select('starting_balance')
      .eq('session_date', today)
      .maybeSingle(),
    supabase.rpc('ct_killswitch_active'),
    supabase.from('ct_uw_usage_latest')
      .select('pct, session_date, daily_count, daily_limit')
      .order('session_date', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase.from('ct_ui_errors')
      .select('*', { count: 'estimated', head: true })
      .gte('created_at', sixHoursAgoIso),
    supabase.from('ct_trades')
      .select('size_pct')
      .eq('status', 'open'),
    supabase.from('ct_biases')
      .select('*', { count: 'estimated', head: true })
      .eq('active', true),
  ]);

  const checks: Check[] = [];

  // 1. Morning brief landed
  if (morningBrief.error) {
    checks.push({ id: 'morning_brief', label: 'Morning brief landed', status: 'pending', detail: `read error: ${morningBrief.error.message}` });
  } else if (!morningBrief.data) {
    checks.push({ id: 'morning_brief', label: 'Morning brief landed', status: 'pending', detail: 'not yet published' });
  } else {
    checks.push({ id: 'morning_brief', label: 'Morning brief landed', status: 'ok', detail: `landed ${hhmm(morningBrief.data.created_at)}` });
  }

  // 2. Pre-market scan complete
  if (premarketScanCount.error) {
    checks.push({ id: 'premarket_scan', label: 'Pre-market scan complete', status: 'pending', detail: `read error: ${premarketScanCount.error.message}` });
  } else {
    const n = premarketScanCount.count ?? 0;
    if (n === 0) checks.push({ id: 'premarket_scan', label: 'Pre-market scan complete', status: 'pending', detail: 'scan has not run yet' });
    else if (n < 10) checks.push({ id: 'premarket_scan', label: 'Pre-market scan complete', status: 'fail', detail: `only ${n} tickers scanned` });
    else checks.push({ id: 'premarket_scan', label: 'Pre-market scan complete', status: 'ok', detail: `${n} tickers` });
  }

  // 3. Book seeded
  if (book.error) {
    checks.push({ id: 'book_seeded', label: 'Book seeded', status: 'pending', detail: `read error: ${book.error.message}` });
  } else if (!book.data) {
    checks.push({ id: 'book_seeded', label: 'Book seeded', status: 'fail', detail: 'no book row for today' });
  } else {
    const sb = Number(book.data.starting_balance ?? 0);
    if (!Number.isFinite(sb) || sb <= 0) {
      checks.push({ id: 'book_seeded', label: 'Book seeded', status: 'fail', detail: `starting_balance=${sb}` });
    } else {
      checks.push({ id: 'book_seeded', label: 'Book seeded', status: 'ok', detail: `$${sb.toLocaleString()} seed` });
    }
  }

  // 4. Kill switch disarmed
  if (killSwitchActive.error) {
    checks.push({ id: 'killswitch_disarmed', label: 'Kill switch disarmed', status: 'pending', detail: `rpc error: ${killSwitchActive.error.message}` });
  } else if (killSwitchActive.data === true) {
    checks.push({ id: 'killswitch_disarmed', label: 'Kill switch disarmed', status: 'fail', detail: 'kill switch is ENGAGED' });
  } else {
    checks.push({ id: 'killswitch_disarmed', label: 'Kill switch disarmed', status: 'ok', detail: 'disarmed' });
  }

  // 5. UW usage reset
  if (uwUsage.error) {
    checks.push({ id: 'uw_usage_reset', label: 'UW usage reset', status: 'pending', detail: `read error: ${uwUsage.error.message}` });
  } else if (!uwUsage.data) {
    checks.push({ id: 'uw_usage_reset', label: 'UW usage reset', status: 'pending', detail: 'no usage row yet' });
  } else {
    const pct = Number(uwUsage.data.pct ?? 0);
    if (!Number.isFinite(pct)) {
      checks.push({ id: 'uw_usage_reset', label: 'UW usage reset', status: 'pending', detail: 'pct null' });
    } else if (pct >= 20) {
      checks.push({ id: 'uw_usage_reset', label: 'UW usage reset', status: 'fail', detail: `UW ${pct}% used already` });
    } else {
      checks.push({ id: 'uw_usage_reset', label: 'UW usage reset', status: 'ok', detail: `UW ${pct}% used` });
    }
  }

  // 6. UI errors in last 6h
  if (uiErrorCount.error) {
    checks.push({ id: 'ui_errors_clean', label: 'No UI errors in last 6h', status: 'pending', detail: `read error: ${uiErrorCount.error.message}` });
  } else {
    const n = uiErrorCount.count ?? 0;
    checks.push({
      id: 'ui_errors_clean',
      label: 'No UI errors in last 6h',
      status: n === 0 ? 'ok' : 'fail',
      detail: n === 0 ? 'clean 6h' : `${n} UI error(s)`,
    });
  }

  // 7. Concentration headroom
  if (openTrades.error) {
    checks.push({ id: 'concentration_headroom', label: 'Concentration headroom', status: 'pending', detail: `read error: ${openTrades.error.message}` });
  } else {
    const rows = (openTrades.data ?? []) as Array<{ size_pct: number | null }>;
    const total = rows.reduce((s, r) => s + (Number(r.size_pct) || 0), 0);
    if (total >= 40) {
      checks.push({ id: 'concentration_headroom', label: 'Concentration headroom', status: 'fail', detail: `already ${total.toFixed(0)}% deployed` });
    } else {
      checks.push({ id: 'concentration_headroom', label: 'Concentration headroom', status: 'ok', detail: `${(40 - total).toFixed(0)}% headroom` });
    }
  }

  // 8. Active biases loaded
  if (biasesCount.error) {
    checks.push({ id: 'biases_loaded', label: 'Active biases loaded', status: 'pending', detail: `read error: ${biasesCount.error.message}` });
  } else {
    const n = biasesCount.count ?? 0;
    checks.push({
      id: 'biases_loaded',
      label: 'Active biases loaded',
      status: n === 0 ? 'fail' : 'ok',
      detail: n === 0 ? 'no active biases' : `${n} active`,
    });
  }

  return checks;
}

function hhmm(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: ET_TZ, hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(iso));
  } catch {
    return '—';
  }
}

function statusEmoji(s: Status): string {
  if (s === 'ok') return ':white_check_mark:';
  if (s === 'pending') return ':hourglass:';
  return ':rotating_light:';
}

function buildSlackPayload(checks: Check[], overall: 'ready' | 'degraded' | 'not-ready') {
  const headerText = `Pre-bell ${overall === 'not-ready' ? 'NOT READY' : overall === 'degraded' ? 'DEGRADED' : 'READY'} · T-15 min`;
  const lines = checks.map(c => `${statusEmoji(c.status)} *${c.label}* — ${c.detail}`);

  const blocks: Array<Record<string, unknown>> = [
    { type: 'header', text: { type: 'plain_text', text: headerText, emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } },
  ];

  const failed = checks.filter(c => c.status === 'fail');
  if (failed.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Action needed before 09:30 ET:* ${failed.map(f => f.label).join(' · ')}`,
      },
    });
  }

  const fallback = `Pre-bell ${overall} — ${failed.length} fail / ${checks.filter(c => c.status === 'pending').length} pending`;
  return { blocks, fallback };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  const corsHeaders = getCorsHeaders(req);

  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (!isTradingDay()) {
    return new Response(JSON.stringify({ skipped: 'holiday_or_weekend', date: etYmd() }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const checks = await run(supabase);
  const failed = checks.filter(c => c.status === 'fail');
  const pending = checks.filter(c => c.status === 'pending');
  const overall: 'ready' | 'degraded' | 'not-ready' =
    failed.length > 0 ? 'not-ready' : pending.length > 0 ? 'degraded' : 'ready';

  let pushed = false;
  if (failed.length > 0) {
    // Single-user model — first profile wins, same as ct-slack-digest.
    const { data: users } = await supabase.from('profiles').select('id').limit(1);
    const userId = users?.[0]?.id as string | undefined;
    if (userId) {
      const { blocks, fallback } = buildSlackPayload(checks, overall);
      await ctSlackPushDirect(supabase, userId, fallback, 'pre-bell-alert', blocks);
      pushed = true;
    }
  }

  return new Response(JSON.stringify({
    ok: true,
    overall,
    pushed,
    checks,
  }), {
    status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
