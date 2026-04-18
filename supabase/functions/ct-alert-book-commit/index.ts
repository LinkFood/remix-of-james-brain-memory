/**
 * ct-alert-book-commit — wire live ct_alerts into the paper book.
 *
 * The watcher fires ALERTs with trade_setup blocks throughout the market
 * session. Historically those alerts died as advisory rows: the book only
 * opens trades at 9:26 ET and reopens at 10:30 ET. After that, the tape
 * can scream and the book stays flat. This function bridges that gap.
 *
 * Guardrails (sequential — any fail = skip, bias fail aborts the tick):
 *   1. Cooldown   — no other alert-sourced trade in the last 60 min
 *   2. Capacity   — <3 open trades AND projected exposure ≤ 100%
 *   3. Bias       — no active ct_biases (severity ≥4) match direction/instrument
 *   4. Whitelist  — instrument is in the 12-ticker underlying universe
 *   5. Price      — getCurrentPrice() returns a finite number
 *
 * Sizing is FIXED at 20% per alert. Alert-sourced trades are intraday by
 * definition, higher variance than the 9:26 deliberate opens, so size is
 * capped below the book-manager conviction-5 ceiling.
 *
 * Auth: service role only.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { isKillSwitchActive, killSwitchSkipResponse } from '../_shared/killSwitch.ts';
import { getCurrentPrice } from '../_shared/ctGrader.ts';
import { ctSlackPush } from '../_shared/ctSlack.ts';
import { CT_PROMPT_VERSION } from '../_shared/systemPromptV1.ts';
import { classifyThesis } from '../_shared/thesisClassifier.ts';
import { getConfig } from '../_shared/configCache.ts';
import { writeTradeAudit, deriveMarketRegime, shapeMcpCalls } from '../_shared/tradeAudit.ts';

const WATCHLIST = new Set([
  'SPY', 'QQQ', 'IWM', 'NVDA', 'AAPL', 'MSFT',
  'META', 'GOOGL', 'AMZN', 'TSLA', 'GLD', 'USO',
]);

// Defaults — overridable via ct_config keys alert_commit.size_pct,
// alert_commit.cooldown_min, alert_commit.max_concurrent. size_usd is derived
// from size_pct at runtime against the $10k book.
const DEFAULT_ALERT_SIZE_PCT = 20;
const BOOK_EQUITY_USD = 10_000;
const DEFAULT_COOLDOWN_MINUTES = 60;
const DEFAULT_MAX_CONCURRENT = 3;
const LOOKBACK_MINUTES = 15;
const BIAS_MIN_SEVERITY = 4;

interface TradeSetup {
  instrument?: string;
  strike?: number;
  expiry?: string;
  entry_level?: number;
  stop_level?: number;
  target_level?: number;
  rationale?: string;
  strategy?: string;
}

interface Alert {
  id: string;
  user_id: string | null;
  instruments: string[];
  direction: 'bullish' | 'bearish' | 'neutral' | 'volatility';
  alert_trigger: string;
  trade_setup: TradeSetup | null;
  up_case: string | null;
  down_case: string | null;
  glance: string[] | null;
  created_at: string;
  committed_trade_id: string | null;
}

interface Skip {
  alert_id: string;
  reason: string;
  detail?: string;
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

  // Kill switch — no new trade commits when engaged.
  if (await isKillSwitchActive(supabase)) {
    return killSwitchSkipResponse(supabase, 'ct-alert-book-commit', corsHeaders);
  }

  // Pull tunable thresholds from ct_config (60s cache TTL, defaults preserve
  // legacy behavior if the row is missing or the RPC errors).
  const [cooldownMin, sizePct, maxConcurrent] = await Promise.all([
    getConfig<number>('alert_commit.cooldown_min', DEFAULT_COOLDOWN_MINUTES),
    getConfig<number>('alert_commit.size_pct', DEFAULT_ALERT_SIZE_PCT),
    getConfig<number>('alert_commit.max_concurrent', DEFAULT_MAX_CONCURRENT),
  ]);
  const alertSizeUsd = Math.round(BOOK_EQUITY_USD * (sizePct / 100));
  console.log(`[ct-alert-book-commit] thresholds: cooldown=${cooldownMin}min size=${sizePct}% max_concurrent=${maxConcurrent}`);

  const sessionDate = new Date().toISOString().slice(0, 10);
  const lookbackIso = new Date(Date.now() - LOOKBACK_MINUTES * 60_000).toISOString();
  const cooldownIso = new Date(Date.now() - cooldownMin * 60_000).toISOString();

  // 1. Cooldown — one alert trade per hour, global.
  const { data: recentAlertTrades } = await supabase
    .from('ct_trades')
    .select('id, created_at, instrument')
    .eq('session_date', sessionDate)
    .eq('source', 'alert')
    .gte('created_at', cooldownIso)
    .limit(1);

  if (recentAlertTrades && recentAlertTrades.length > 0) {
    return new Response(JSON.stringify({
      committed: 0,
      skipped: [],
      cooldown_blocked: true,
      reason: `alert-sourced trade within last ${cooldownMin}min`,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  // 2. Candidate alerts — recent, uncommitted, have a trade_setup, directional,
  //    and not an invalidation (invalidations close positions, they don't open).
  const { data: alertRows, error: alertErr } = await supabase
    .from('ct_alerts')
    .select('id, user_id, instruments, direction, alert_trigger, trade_setup, up_case, down_case, glance, created_at, committed_trade_id')
    .is('committed_trade_id', null)
    .gte('created_at', lookbackIso)
    .not('trade_setup', 'is', null)
    .in('direction', ['bullish', 'bearish'])
    .neq('alert_trigger', 'thesis_invalidation')
    .order('created_at', { ascending: false });

  if (alertErr) {
    return new Response(JSON.stringify({ error: `alert query failed: ${alertErr.message}` }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const alerts = (alertRows ?? []) as Alert[];
  if (alerts.length === 0) {
    return new Response(JSON.stringify({ committed: 0, skipped: [], note: 'no eligible alerts' }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // 3. Active biases — two reads:
  //    (a) full active list for the audit trail (all severities)
  //    (b) high-severity subset (≥ BIAS_MIN_SEVERITY) that actually gates trades
  const { data: allActiveBiasRows } = await supabase
    .from('ct_biases')
    .select('id, pattern, instruments, severity')
    .eq('active', true);
  const allActiveBiases = allActiveBiasRows ?? [];
  const activeBiases = allActiveBiases.filter(b => Number(b.severity ?? 0) >= BIAS_MIN_SEVERITY);

  // Latest heartbeat — shared across every alert commit in this tick. Used for
  // uw_state_snapshot + heartbeat_id + market_regime on each audit row.
  const { data: hbRow } = await supabase
    .from('ct_heartbeats')
    .select('id, current_reads, created_at')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const snapshot = (hbRow?.current_reads as Record<string, unknown> | undefined)?._snapshot ?? null;
  const marketRegime = deriveMarketRegime(snapshot);

  // 4. Current open book — capacity check is per-tick (refreshed after each commit).
  const { data: openRows } = await supabase
    .from('ct_trades')
    .select('id, size_pct')
    .eq('session_date', sessionDate)
    .eq('status', 'open');
  let openCount = (openRows ?? []).length;
  let totalExposure = (openRows ?? []).reduce((a, r) => a + Number(r.size_pct ?? 0), 0);

  // 5. Resolve a user_id for Slack (single-user system).
  const { data: profileRow } = await supabase.from('profiles').select('id').limit(1).maybeSingle();
  const userId = (profileRow?.id as string | undefined) ?? null;

  const skipped: Skip[] = [];
  const committed: Array<{ alert_id: string; trade_id: string; instrument: string; side: string; entry: number }> = [];

  for (const alert of alerts) {
    const setup = alert.trade_setup;
    if (!setup || !setup.instrument) {
      skipped.push({ alert_id: alert.id, reason: 'no_trade_setup' });
      continue;
    }
    const instrument = setup.instrument.toUpperCase();

    // Whitelist
    if (!WATCHLIST.has(instrument)) {
      skipped.push({ alert_id: alert.id, reason: 'instrument_not_whitelisted', detail: instrument });
      continue;
    }

    // Capacity — re-check every iteration so consecutive commits don't
    // breach limits if we ever raise the cooldown.
    if (openCount >= maxConcurrent) {
      skipped.push({ alert_id: alert.id, reason: 'book_full' });
      continue;
    }
    if (totalExposure + sizePct > 100) {
      skipped.push({ alert_id: alert.id, reason: 'exposure_cap', detail: `would be ${totalExposure + sizePct}%` });
      continue;
    }

    // Bias check — match on direction or instrument via ilike against pattern text.
    // Biases with null instruments array are universal; biases with specific
    // instruments only block if this alert's instrument is in the list.
    const biasHit = activeBiases.find(b => {
      const pattern = ((b.pattern as string | null) ?? '').toLowerCase();
      const instList = (b.instruments as string[] | null) ?? [];
      const universalOrMatching = instList.length === 0 || instList.includes(instrument);
      if (!universalOrMatching) return false;
      return (
        pattern.includes(alert.direction) ||
        pattern.includes(instrument.toLowerCase())
      );
    });
    if (biasHit) {
      skipped.push({ alert_id: alert.id, reason: 'bias_block', detail: `bias_id=${biasHit.id} sev=${biasHit.severity}` });
      continue;
    }

    // Price sanity.
    const price = await getCurrentPrice(instrument);
    if (price == null || !Number.isFinite(price)) {
      skipped.push({ alert_id: alert.id, reason: 'no_price' });
      continue;
    }

    // Map direction → side. v1: bullish = long, bearish = short. (For
    // option-style setups like long_put, the underlying direction is the
    // right read — we trade the underlying in v1.)
    const side = alert.direction === 'bullish' ? 'long' : 'short';

    const thesisCore = alert.direction === 'bullish' ? (alert.up_case ?? setup.rationale ?? '')
                                                     : (alert.down_case ?? setup.rationale ?? '');
    const thesis = `${thesisCore}`.trim() + ' [alert-sourced]';

    // Insert trade.
    const { data: tradeRow, error: insErr } = await supabase
      .from('ct_trades')
      .insert({
        session_date:   sessionDate,
        instrument,
        side,
        size_pct:       sizePct,
        size_usd:       alertSizeUsd,
        entry_price:    price,
        stop_price:     setup.stop_level ?? null,
        target_price:   setup.target_level ?? null,
        thesis,
        thesis_theme:   classifyThesis(thesis),
        horizon:        'intraday',
        conviction:     5,
        status:         'open',
        opened_at:      new Date().toISOString(),
        contract_type:  'underlying',
        source:         'alert',
        prompt_version: CT_PROMPT_VERSION,
      })
      .select('id')
      .maybeSingle();

    if (insErr || !tradeRow) {
      skipped.push({ alert_id: alert.id, reason: 'insert_failed', detail: insErr?.message ?? 'unknown' });
      continue;
    }
    const tradeId = tradeRow.id as string;

    // Link alert → trade.
    await supabase.from('ct_alerts').update({ committed_trade_id: tradeId }).eq('id', alert.id);

    // Audit trail — fire-and-forget. MCP linking is best-effort: the watcher's
    // MCP calls within a 15-min window around the alert's creation time WERE
    // the reasoning that produced this alert. Grab them as part of the forensic
    // record. If no calls land in the window (mocked alert, silent tick), we
    // still write the audit row with mcp_calls=[].
    (async () => {
      const alertAt = new Date(alert.created_at).getTime();
      const winStart = new Date(alertAt - 15 * 60_000).toISOString();
      const winEnd   = new Date(alertAt + 15 * 60_000).toISOString();
      const { data: mcpRows } = await supabase
        .from('ct_mcp_calls')
        .select('tool_name, input, result, is_error, created_at')
        .eq('source', 'watcher')
        .gte('created_at', winStart)
        .lte('created_at', winEnd)
        .order('created_at', { ascending: true })
        .limit(40);

      writeTradeAudit(supabase, {
        trade_id: tradeId,
        source: 'alert-book-commit',
        uw_state_snapshot: snapshot,
        mcp_calls: shapeMcpCalls(mcpRows as Array<Record<string, unknown>> | null),
        active_biases: allActiveBiases,
        sizing_computed: {
          book_equity:  BOOK_EQUITY_USD,
          size_pct:     sizePct,
          size_usd:     alertSizeUsd,
          entry_price:  price,
          stop_price:   setup.stop_level ?? null,
          target_price: setup.target_level ?? null,
          conviction:   5, // alert commits are hard-coded conviction=5
        },
        market_regime: marketRegime,
        heartbeat_id: (hbRow?.id as string | undefined) ?? null,
        triggering_alert_id: alert.id,
        triggering_flag_id: null,
        prompt_version: CT_PROMPT_VERSION,
        // Alerts don't have a single raw Claude response — the watcher that
        // produced the alert did. Serialize the alert row itself as the
        // closest artifact: rationale + glance + setup are the reasoning.
        raw_claude_response: JSON.stringify({
          alert_id: alert.id,
          direction: alert.direction,
          alert_trigger: alert.alert_trigger,
          trade_setup: setup,
          up_case: alert.up_case,
          down_case: alert.down_case,
          glance: alert.glance,
        }),
      });
    })();

    // Log action.
    const firstGlance = (alert.glance && alert.glance.length > 0 ? alert.glance[0] : '').slice(0, 500);
    await supabase.from('ct_trade_actions').insert({
      trade_id: tradeId,
      action: 'alert_commit',
      price,
      rationale: firstGlance || `alert ${alert.id} → ${side} ${instrument} @ ${price}`,
    });

    // Slack push — best effort.
    if (userId) {
      const glanceLines = [
        `Alert committed to book: ${side.toUpperCase()} ${instrument} @ ${price} (${sizePct}%)`,
        ...((alert.glance ?? []).slice(0, 3)),
        setup.stop_level ? `stop ${setup.stop_level}` : '',
        setup.target_level ? `target ${setup.target_level}` : '',
      ].filter(Boolean) as string[];

      await ctSlackPush(supabase, userId, {
        state: 'FLAG',
        instruments: [instrument],
        glance: glanceLines,
        conviction: 5,
        horizon: 'intraday',
        alert_trigger: alert.alert_trigger,
        direction: alert.direction,
      });
    }

    // Reserve capacity for the rest of the loop.
    openCount += 1;
    totalExposure += sizePct;

    committed.push({ alert_id: alert.id, trade_id: tradeId, instrument, side, entry: price });
  }

  return new Response(JSON.stringify({
    committed: committed.length,
    trades: committed,
    skipped,
    scanned: alerts.length,
  }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
