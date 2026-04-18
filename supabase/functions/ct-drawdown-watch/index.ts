/**
 * ct-drawdown-watch — kill-switch-level guardrail for the $10k paper book.
 *
 * Runs every 10min during RTH (cron: `*&#47;10 13-20 * * 1-5`).
 *
 * Thresholds live in ct_config (keys: book.drawdown.warn_pct,
 * book.drawdown.urgent_pct, book.drawdown.hwm_urgent_pct). Tune via
 * /ct-settings. 60s cache TTL — changes propagate within ~1 minute.
 *
 * Reads the current session's ct_book row (no UW calls — ct-book-manager
 * already refreshed realized_pnl / unrealized_pnl on the 15min tick), then:
 *   live_equity        = starting_balance + realized_pnl + unrealized_pnl
 *   intraday_pnl_pct   = (live_equity - starting_balance) / starting_balance * 100
 *   drawdown_from_hwm  = (live_equity - high_water_mark) / high_water_mark * 100
 *
 * Tiers (defaults; overridable via ct_config):
 *   WARN   — intraday_pnl_pct <= warn_pct (-1%)
 *   URGENT — intraday_pnl_pct <= urgent_pct (-2%)  OR  drawdown_from_hwm <= hwm_urgent_pct (-3%)
 *
 * Dedupe is done BY THE TABLE CONSTRAINT (session_date, tier) UNIQUE —
 * we attempt INSERT; a 23505 unique violation is caught and treated as
 * "already alerted this tier today, skip." Tier upgrades (warn → urgent)
 * fire naturally because they INSERT under a different tier key.
 *
 * We push via `ctSlackPushDirect` (our constraint is the dedupe, not the
 * 30-min flag-dedupe window).
 *
 * Auth: service role only. No auto-kill — James decides.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { ctSlackPushDirect } from '../_shared/ctSlack.ts';
import { getConfig } from '../_shared/configCache.ts';

interface BookRow {
  session_date: string;
  starting_balance: number;
  realized_pnl: number | null;
  unrealized_pnl: number | null;
  high_water_mark: number | null;
}

type Tier = 'warn' | 'urgent';

function fmtUsd(n: number, signed = false): string {
  const v = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  if (!signed) return `$${v}`;
  return n >= 0 ? `+$${v}` : `-$${v}`;
}

function fmtPct(n: number, digits = 2): string {
  const s = n.toFixed(digits);
  return n >= 0 ? `+${s}%` : `${s}%`;
}

function buildSlackText(
  tier: Tier,
  opts: {
    equity: number;
    starting: number;
    intradayPnlPct: number;
    intradayPnlUsd: number;
    hwm: number;
    drawdownFromHwmPct: number;
    warnPct: number;
    urgentPct: number;
    hwmUrgentPct: number;
  },
): string {
  if (tier === 'warn') {
    // Short — one line of context. James glances, decides.
    return `:large_yellow_circle: *BOOK WARN* · equity ${fmtUsd(opts.equity)} (${fmtPct(opts.intradayPnlPct)} intraday — warn at ${fmtPct(opts.warnPct)}, ${fmtUsd(opts.intradayPnlUsd, true)} on ${fmtUsd(opts.starting)}). Kill switch: \`/kill\``;
  }
  // URGENT — fuller context, kill-switch reminder louder.
  return [
    `:red_circle: *BOOK URGENT* · equity ${fmtUsd(opts.equity)}`,
    `• intraday: ${fmtPct(opts.intradayPnlPct)} — urgent at ${fmtPct(opts.urgentPct)} (${fmtUsd(opts.intradayPnlUsd, true)} on ${fmtUsd(opts.starting)})`,
    `• HWM: ${fmtUsd(opts.hwm)} · drawdown from HWM: ${fmtPct(opts.drawdownFromHwmPct)} — urgent at ${fmtPct(opts.hwmUrgentPct)}`,
    `Consider kill switch: \`/kill\` — James decides.`,
  ].join('\n');
}

serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
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

  // Pull tunable thresholds from ct_config (60s cache TTL, defaults preserve
  // legacy behavior if the row is missing or the RPC errors).
  const warnPct = await getConfig<number>('book.drawdown.warn_pct', -1.0);
  const urgentPct = await getConfig<number>('book.drawdown.urgent_pct', -2.0);
  const hwmUrgentPct = await getConfig<number>('book.drawdown.hwm_urgent_pct', -3.0);
  console.log(`[ct-drawdown-watch] thresholds: warn=${warnPct}% urgent=${urgentPct}% hwm=${hwmUrgentPct}%`);

  const sessionDate = new Date().toISOString().slice(0, 10);

  // 1. Pull current session's book row.
  const { data: bookRow, error: bookErr } = await supabase
    .from('ct_book')
    .select('session_date, starting_balance, realized_pnl, unrealized_pnl, high_water_mark')
    .eq('session_date', sessionDate)
    .maybeSingle();

  if (bookErr) {
    return new Response(JSON.stringify({ error: `book_read:${bookErr.message}` }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  if (!bookRow) {
    return new Response(JSON.stringify({ ok: true, note: 'no_session_today', session_date: sessionDate }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const book = bookRow as BookRow;
  const starting = Number(book.starting_balance);
  if (!(starting > 0)) {
    return new Response(JSON.stringify({ ok: true, note: 'zero_starting_balance' }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const realized = Number(book.realized_pnl ?? 0);
  const unrealized = Number(book.unrealized_pnl ?? 0);
  const hwm = Number(book.high_water_mark ?? starting);
  const liveEquity = starting + realized + unrealized;
  const intradayPnlUsd = realized + unrealized;
  const intradayPnlPct = ((liveEquity - starting) / starting) * 100;
  const drawdownFromHwmPct = hwm > 0 ? ((liveEquity - hwm) / hwm) * 100 : 0;

  // 2. Classify tier. URGENT wins over WARN — we check URGENT first.
  const tiersToFire: Tier[] = [];
  const urgentTripped = intradayPnlPct <= urgentPct || drawdownFromHwmPct <= hwmUrgentPct;
  const warnTripped = intradayPnlPct <= warnPct;
  if (warnTripped) tiersToFire.push('warn');       // fires once — the table catches re-fires
  if (urgentTripped) tiersToFire.push('urgent');   // different tier key → separate INSERT

  if (tiersToFire.length === 0) {
    return new Response(JSON.stringify({
      ok: true,
      tripped: false,
      metrics: { liveEquity, intradayPnlPct, drawdownFromHwmPct },
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  // 3. Resolve Slack target userId (same pattern as ct-iv-shift-watch).
  const { data: users } = await supabase.from('profiles').select('id').limit(1);
  const userId = (users?.[0]?.id as string | undefined) ?? null;

  const fired: Tier[] = [];
  const skipped: Array<{ tier: Tier; reason: string }> = [];

  for (const tier of tiersToFire) {
    // Attempt the dedupe-by-constraint INSERT. On unique violation (23505)
    // we silently skip — that tier already fired for this session.
    const { error: insErr } = await supabase
      .from('ct_drawdown_alerts')
      .insert({
        session_date: sessionDate,
        tier,
        intraday_pnl_pct: +intradayPnlPct.toFixed(4),
        drawdown_from_hwm_pct: +drawdownFromHwmPct.toFixed(4),
        equity_at_trigger: +liveEquity.toFixed(2),
      });

    if (insErr) {
      // Postgres unique_violation is SQLSTATE 23505. PostgREST surfaces it
      // in error.code. Treat as "already alerted, skip." Any other error
      // also shouldn't block — log and continue, preserving at-least-once.
      if (insErr.code === '23505') {
        skipped.push({ tier, reason: 'already_alerted_today' });
        continue;
      }
      skipped.push({ tier, reason: `insert_error:${insErr.message.slice(0, 80)}` });
      continue;
    }

    // INSERT succeeded → this is the first time we're firing this tier today.
    // Push Slack via direct path (our own dedupe via the constraint above).
    if (userId) {
      const text = buildSlackText(tier, {
        equity: liveEquity,
        starting,
        intradayPnlPct,
        intradayPnlUsd,
        hwm,
        drawdownFromHwmPct,
        warnPct,
        urgentPct,
        hwmUrgentPct,
      });
      await ctSlackPushDirect(supabase, userId, text, `drawdown_${tier}`);
    }
    fired.push(tier);
  }

  return new Response(JSON.stringify({
    ok: true,
    tripped: true,
    fired,
    skipped,
    metrics: {
      liveEquity: +liveEquity.toFixed(2),
      starting,
      hwm,
      realized,
      unrealized,
      intradayPnlPct: +intradayPnlPct.toFixed(3),
      drawdownFromHwmPct: +drawdownFromHwmPct.toFixed(3),
    },
  }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});
