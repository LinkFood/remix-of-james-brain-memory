/**
 * ct-slack-push-flag — poll-and-push Slack notifier for Co-Trader v2 specialist flags.
 *
 * Runs every minute via cron. For each eligible unslacked flag:
 *   1. Score gate (`score.slack_threshold`, default 80) — skip below.
 *   2. Status filter — only `active` or `conviction`; graded/invalidated are skipped.
 *   3. Same-day vs multi-day gate:
 *        - Same-day (horizon_hours <= slack.flag_same_day_horizon_hours): push now.
 *        - Multi-day: push now if `slack.flag_require_confirmation = false`,
 *          otherwise wait until status flips to `conviction` (T+1 OI confirm).
 *   4. Resolve per-specialist pattern context (top hit-rate pattern w/ n>=3).
 *   5. ctSlackPushDirect() with Block Kit payload. No dedupe at the helper
 *      layer — the `slacked_at` write is our dedupe.
 *   6. Stamp `slacked_at = now()` on success. Leave null on failure; next
 *      sweep retries (with natural rate-limit from the 1/min cadence).
 *
 * Auth: service role only. No UW calls, no Claude calls — pure DB + Slack.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { ctSlackPushDirect } from '../_shared/ctSlack.ts';
import { getConfig } from '../_shared/configCache.ts';

// ---- helpers ---------------------------------------------------------------

function fmtNum(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return 'n/a';
  return n.toFixed(digits);
}

function fmtPct(n: number | null | undefined, digits = 0): string {
  if (n == null || !Number.isFinite(n)) return 'n/a';
  return `${(n * 100).toFixed(digits)}%`;
}

function directionEmoji(direction: string | null | undefined): string {
  if (direction === 'bullish') return ':large_green_circle:';
  if (direction === 'bearish') return ':red_circle:';
  return ':white_circle:';
}

// Resolve the display ticker. Detector-portfolio flags (signature/cluster/
// whale/etc.) write specialist_ticker=NULL because they don't belong to any
// per-ticker specialist; fall back to instrument, then derive from the OCC
// option_symbol prefix. Without this, headers render the literal "null".
function resolveTicker(flag: Flag): string {
  if (flag.specialist_ticker && flag.specialist_ticker !== 'null') return flag.specialist_ticker;
  if (flag.instrument && flag.instrument !== 'null') return flag.instrument;
  if (flag.option_symbol) {
    const m = flag.option_symbol.match(/^([A-Z]+)\d/);
    if (m) return m[1];
  }
  return 'UNKNOWN';
}

interface Flag {
  id: string;
  specialist_ticker: string | null;
  instrument: string | null;
  option_symbol: string | null;
  strike: number | null;
  expiry: string | null;
  side: string | null;
  direction: string;
  score: number;
  tags: string[] | null;
  thesis: string | null;
  invalidation: string | null;
  horizon_hours: number;
  entry_price: number | null;
  target_price: number | null;
  status: string;
  created_at: string;
}

interface TopPattern {
  hit_rate: number | null;
  n_observations: number;
  avg_alpha_pct: number | null;
}

// ---- handler ---------------------------------------------------------------

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

  // Single-user model (same as ct-slack-digest) — first profile wins.
  const { data: users } = await supabase.from('profiles').select('id').limit(1);
  const userId = users?.[0]?.id as string | undefined;
  if (!userId) {
    return new Response(JSON.stringify({ skipped: true, reason: 'no_user' }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Config — all tunable, no hardcoded thresholds.
  const scoreThreshold = await getConfig<number>('score.slack_threshold', 80);
  const requireConfirm = await getConfig<boolean>('slack.flag_require_confirmation', false);
  const sameDayHorizonH = await getConfig<number>('slack.flag_same_day_horizon_hours', 24);

  // Load unslacked flags above threshold.
  // Cap at 10 per sweep so one bad burst doesn't starve later flags — the
  // cron runs every minute, so backlog drains quickly in steady state.
  const { data: flagsData, error: flagsErr } = await supabase
    .from('ct_flags')
    .select('id, specialist_ticker, instrument, option_symbol, strike, expiry, side, direction, score, tags, thesis, invalidation, horizon_hours, entry_price, target_price, status, created_at')
    .is('slacked_at', null)
    .gte('score', scoreThreshold)
    .in('status', ['active', 'conviction'])
    .order('created_at', { ascending: true })
    .limit(10);

  if (flagsErr) {
    console.error('[ct-slack-push-flag] load failed:', flagsErr.message);
    return new Response(JSON.stringify({ ok: false, error: flagsErr.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const flags = (flagsData ?? []) as Flag[];
  if (flags.length === 0) {
    return new Response(JSON.stringify({ ok: true, pushed: 0, skipped: 0, reason: 'no_eligible_flags' }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // ---- Cluster dedup ------------------------------------------------------
  // Same contract + direction + minute → multiple detectors firing on the
  // same signal. Push only the highest-score flag; suppress the rest.
  // Bucket key: prefer option_symbol when present (canonical OCC). Fall back
  // to (instrument|side|strike|expiry) for flags that didn't set it.
  function clusterKey(f: Flag): string {
    const minute = (f.created_at || '').slice(0, 16); // YYYY-MM-DDTHH:MM
    const dir = f.direction ?? 'neutral';
    if (f.option_symbol) return `os:${f.option_symbol}|${dir}|${minute}`;
    return `cmp:${f.instrument ?? ''}|${f.side ?? ''}|${f.strike ?? ''}|${f.expiry ?? ''}|${dir}|${minute}`;
  }

  const groups = new Map<string, Flag[]>();
  for (const f of flags) {
    const k = clusterKey(f);
    const arr = groups.get(k);
    if (arr) arr.push(f); else groups.set(k, [f]);
  }

  const leaderIds = new Set<string>();
  const suppressed: Array<{ flag: Flag; leaderId: string; leaderScore: number }> = [];
  for (const [, members] of groups) {
    if (members.length === 1) {
      leaderIds.add(members[0].id);
      continue;
    }
    // Highest score wins; tie → earliest created_at (first-fired) wins.
    const sorted = [...members].sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return Date.parse(a.created_at) - Date.parse(b.created_at);
    });
    const leader = sorted[0];
    leaderIds.add(leader.id);
    for (let i = 1; i < sorted.length; i++) {
      suppressed.push({ flag: sorted[i], leaderId: leader.id, leaderScore: leader.score });
    }
  }

  // Write suppression audit + stamp slacked_at so the loser flags don't
  // re-enter next sweep. ct_slack_log row = audit; slacked_at = the dedupe
  // floor (same convention the rest of this function uses).
  const nowIso = new Date().toISOString();
  for (const { flag, leaderId, leaderScore } of suppressed) {
    try {
      await supabase.from('ct_slack_log').insert({
        source: 'flag',
        state: flag.status === 'conviction' ? 'CONVICTION' : 'FLAG',
        instruments: flag.instrument ? [flag.instrument] : [],
        direction: flag.direction ?? null,
        alert_trigger: null,
        conviction: Math.round(flag.score),
        event_id: flag.id,
        summary: `cluster_dedup: leader=${leaderId.slice(0, 8)} leader_score=${Math.round(leaderScore)} suppressed_score=${Math.round(flag.score)} contract=${flag.option_symbol ?? 'underlying'}`.slice(0, 300),
        pushed: false,
        skip_reason: 'cluster_dedup_lower_score',
      });
    } catch (e) {
      console.warn(`[ct-slack-push-flag] cluster log insert failed for ${flag.id}:`, e instanceof Error ? e.message : e);
    }
    const { error: updErr } = await supabase
      .from('ct_flags')
      .update({ slacked_at: nowIso })
      .eq('id', flag.id);
    if (updErr) {
      console.warn(`[ct-slack-push-flag] cluster slacked_at update failed for ${flag.id}:`, updErr.message);
    }
  }

  // Continue with leaders only — order preserved from the original sort.
  const leaders = flags.filter(f => leaderIds.has(f.id));

  let pushed = 0;
  let skippedMultiDay = 0;
  let failed = 0;
  const clusterSuppressed = suppressed.length;
  const decisions: Array<{ id: string; decision: 'pushed' | 'skip_multi_day_wait_conviction' | 'push_failed' | 'cluster_dedup_suppressed'; cluster_leader_id?: string }> = [];
  for (const s of suppressed) {
    decisions.push({ id: s.flag.id, decision: 'cluster_dedup_suppressed', cluster_leader_id: s.leaderId });
  }

  for (const flag of leaders) {
    // Same-day vs multi-day gate.
    const isMultiDay = flag.horizon_hours > sameDayHorizonH;
    if (requireConfirm && isMultiDay && flag.status !== 'conviction') {
      // Leave slacked_at null — grader can flip status to 'conviction' later,
      // at which point a future sweep picks it up.
      skippedMultiDay++;
      decisions.push({ id: flag.id, decision: 'skip_multi_day_wait_conviction' });
      continue;
    }

    // Pattern context: top-performing signature for this specialist with n>=3.
    // Best-effort — missing pattern isn't a reason to skip the push.
    let topPattern: TopPattern | null = null;
    try {
      const { data: patterns } = await supabase
        .from('ct_flag_patterns')
        .select('hit_rate, n_observations, avg_alpha_pct')
        .eq('specialist_ticker', flag.specialist_ticker)
        .gte('n_observations', 3)
        .order('hit_rate', { ascending: false, nullsFirst: false })
        .limit(1);
      if (patterns && patterns.length > 0) topPattern = patterns[0] as TopPattern;
    } catch (e) {
      console.warn('[ct-slack-push-flag] pattern load failed:', e instanceof Error ? e.message : e);
    }

    // Build Block Kit payload. Header carries the ticker + direction + score;
    // body carries contract + thesis + invalidation + priors.
    const emoji = directionEmoji(flag.direction);
    const convBadge = flag.status === 'conviction' ? ' · [CONVICTION]' : '';
    const dirUpper = (flag.direction ?? 'neutral').toUpperCase();

    const ticker = resolveTicker(flag);
    const headerText =
      `${emoji} ${ticker}${convBadge} — ${dirUpper} · score ${Math.round(flag.score)}`;

    const contractLine = flag.option_symbol
      ? `\`${flag.option_symbol}\` · strike ${fmtNum(flag.strike)} · exp ${flag.expiry ?? 'n/a'}`
      : `underlying · horizon ${flag.horizon_hours}h`;

    const priceLine =
      `*Entry:* ${fmtNum(flag.entry_price)} · *Target:* ${fmtNum(flag.target_price)} · *Horizon:* ${flag.horizon_hours}h`;

    const bodyLines: string[] = [contractLine, priceLine];
    if (flag.thesis) bodyLines.push(`*Thesis:* ${flag.thesis.slice(0, 500)}`);
    if (flag.invalidation) bodyLines.push(`*Invalidation:* ${flag.invalidation.slice(0, 300)}`);
    if (flag.tags && flag.tags.length > 0) {
      bodyLines.push(`*Tags:* ${flag.tags.map(t => `#${t}`).join(' ')}`);
    }
    if (topPattern && topPattern.n_observations >= 3) {
      const hr = fmtPct(topPattern.hit_rate, 0);
      const alpha = topPattern.avg_alpha_pct != null ? `${topPattern.avg_alpha_pct.toFixed(2)}%` : 'n/a';
      bodyLines.push(`:bar_chart: Similar pattern: ${hr} hit (n=${topPattern.n_observations}), avg alpha ${alpha}`);
    }

    const fallbackText =
      `${ticker} ${dirUpper} flag score ${Math.round(flag.score)}${convBadge} — ${flag.option_symbol ?? 'underlying'}`;

    const blocks: Array<Record<string, unknown>> = [
      { type: 'header', text: { type: 'plain_text', text: headerText.slice(0, 150), emoji: true } },
      { type: 'section', text: { type: 'mrkdwn', text: bodyLines.join('\n') } },
    ];

    // Push. ctSlackPushDirect is best-effort: silent no-op if SLACK_BOT_TOKEN
    // or slack_channel_id missing, logs on HTTP failure. Never throws.
    let pushOk = true;
    try {
      await ctSlackPushDirect(supabase, userId, fallbackText, 'flag', blocks);
    } catch (e) {
      pushOk = false;
      console.warn(`[ct-slack-push-flag] push threw for ${flag.id}:`, e instanceof Error ? e.message : e);
    }

    // ctSlackPushDirect logs success/failure to ct_slack_log. We check that
    // log to decide whether to stamp slacked_at — a silent no-op (no token /
    // no channel) gets NO log row, which should NOT count as a real push.
    // Without an insert, we leave slacked_at null so the next sweep retries
    // once Slack is configured.
    if (pushOk) {
      let didLog = false;
      try {
        const { data: logRow } = await supabase
          .from('ct_slack_log')
          .select('pushed, created_at')
          .eq('source', 'flag')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        // A log row within the last 30 seconds means ctSlackPushDirect ran.
        // `pushed = true` means Slack accepted it; false = http error.
        if (logRow) {
          const logAge = Date.now() - Date.parse(logRow.created_at as string);
          if (logAge < 30_000) {
            didLog = true;
            pushOk = logRow.pushed === true;
          }
        }
      } catch (e) {
        console.warn('[ct-slack-push-flag] log check failed:', e instanceof Error ? e.message : e);
      }

      if (!didLog) {
        // Silent no-op (token/channel missing). Leave slacked_at null.
        failed++;
        decisions.push({ id: flag.id, decision: 'push_failed' });
        continue;
      }
    }

    if (pushOk) {
      const { error: updErr } = await supabase
        .from('ct_flags')
        .update({ slacked_at: new Date().toISOString() })
        .eq('id', flag.id);
      if (updErr) {
        console.warn(`[ct-slack-push-flag] slacked_at update failed for ${flag.id}:`, updErr.message);
        failed++;
        decisions.push({ id: flag.id, decision: 'push_failed' });
      } else {
        pushed++;
        decisions.push({ id: flag.id, decision: 'pushed' });
      }
    } else {
      failed++;
      decisions.push({ id: flag.id, decision: 'push_failed' });
    }
  }

  return new Response(JSON.stringify({
    ok: true,
    pushed,
    skipped_multi_day: skippedMultiDay,
    cluster_suppressed: clusterSuppressed,
    failed,
    threshold: scoreThreshold,
    require_confirmation: requireConfirm,
    same_day_horizon_hours: sameDayHorizonH,
    decisions,
  }), {
    status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
