/**
 * ct-specialist-dispatcher — event-driven wakeup for the 10 specialists.
 *
 * Runs every 5 min during RTH via pg_cron (see migration 20260423000037).
 * Scans ct_scored_flow for HIGH-score events in the last N minutes, groups
 * them by ticker, and fires each affected specialist with reason='event_driven'.
 * Cooldown is enforced here (not in specialists themselves) so one noisy
 * ticker can't spam its specialist with back-to-back wakeups.
 *
 * Configuration (all via ct_config):
 *   specialist.dispatcher.score_trigger      — min score to trigger (default 70)
 *   specialist.dispatcher.lookback_minutes   — scan window (default 5)
 *   specialist.cooldown_minutes              — per-specialist cooldown (default 15)
 *
 * Auth: service-role only. Safety-net scheduled wakeups still happen even if
 * this function is down — the dispatcher is optimization, not critical path.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { getConfig } from '../_shared/configCache.ts';
import { isKillSwitchActive, killSwitchSkipResponse } from '../_shared/killSwitch.ts';

const WATCHLIST = ['SPY', 'QQQ', 'IWM', 'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'TSLA'];

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

  if (await isKillSwitchActive(supabase)) {
    return killSwitchSkipResponse(supabase, 'ct-specialist-dispatcher', corsHeaders);
  }

  // -------------------------------------------------------------------------
  // 1. Load tunable thresholds.
  // -------------------------------------------------------------------------
  const scoreTrigger    = await getConfig<number>('specialist.dispatcher.score_trigger', 70);
  const lookbackMinutes = await getConfig<number>('specialist.dispatcher.lookback_minutes', 5);
  const cooldownMinutes = await getConfig<number>('specialist.cooldown_minutes', 15);

  const nowMs       = Date.now();
  const lookbackIso = new Date(nowMs - lookbackMinutes * 60_000).toISOString();
  const cooldownIso = new Date(nowMs - cooldownMinutes * 60_000).toISOString();

  // -------------------------------------------------------------------------
  // 2. Scan for hot events on watchlist tickers within the lookback window.
  // -------------------------------------------------------------------------
  const { data: hotEvents, error: scanError } = await supabase
    .from('ct_scored_flow')
    .select('id, ticker, score, event_ts')
    .gte('event_ts', lookbackIso)
    .gte('score', scoreTrigger)
    .in('ticker', WATCHLIST)
    .order('score', { ascending: false })
    .limit(200);

  if (scanError) {
    console.error('[ct-specialist-dispatcher] scan error:', scanError.message);
    return new Response(
      JSON.stringify({ ok: false, error: scanError.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }

  if (!hotEvents || hotEvents.length === 0) {
    return new Response(
      JSON.stringify({
        ok: true,
        triggered: [],
        hot_events: 0,
        score_trigger: scoreTrigger,
        lookback_minutes: lookbackMinutes,
        reason: 'no_hot_events',
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }

  // -------------------------------------------------------------------------
  // 3. Group event ids by ticker.
  // -------------------------------------------------------------------------
  const eventsByTicker = new Map<string, number[]>();
  for (const row of hotEvents) {
    const t = (row.ticker as string).toUpperCase();
    if (!eventsByTicker.has(t)) eventsByTicker.set(t, []);
    eventsByTicker.get(t)!.push(row.id as number);
  }

  // -------------------------------------------------------------------------
  // 4. Cooldown filter — skip tickers whose specialist ran within cooldown.
  //    We check ct_flags.created_at as the authoritative "did this specialist
  //    just run?" signal. If the specialist woke up and passed (no flag), the
  //    hourly safety-net will still catch it shortly.
  // -------------------------------------------------------------------------
  const cooledDown: Array<{ ticker: string; skipped: true; reason: string }> = [];
  const toFire: Array<{ ticker: string; event_ids: number[] }> = [];

  for (const [ticker, eventIds] of eventsByTicker.entries()) {
    const { data: lastFlag, error: flagError } = await supabase
      .from('ct_flags')
      .select('id, created_at')
      .eq('specialist_ticker', ticker)
      .gte('created_at', cooldownIso)
      .order('created_at', { ascending: false })
      .limit(1);

    if (flagError) {
      console.warn(`[ct-specialist-dispatcher] cooldown check error for ${ticker}:`, flagError.message);
      // Fail open — let the specialist run rather than sit silent.
    }

    if (lastFlag && lastFlag.length > 0) {
      cooledDown.push({ ticker, skipped: true, reason: 'cooldown_active' });
      continue;
    }

    toFire.push({ ticker, event_ids: eventIds });
  }

  if (toFire.length === 0) {
    return new Response(
      JSON.stringify({
        ok: true,
        triggered: [],
        skipped: cooledDown,
        hot_events: hotEvents.length,
        reason: 'all_in_cooldown',
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }

  // -------------------------------------------------------------------------
  // 5. Fire specialists in parallel via _ct_post_with_body RPC.
  //    Vault-authed; avoids the CLI-vs-runtime service_role key mismatch.
  // -------------------------------------------------------------------------
  const fires = await Promise.all(
    toFire.map(async ({ ticker, event_ids }) => {
      const fnName = `ct-specialist-${ticker.toLowerCase()}`;
      const { data, error } = await supabase.rpc('_ct_post_with_body', {
        _fn: fnName,
        _body: { reason: 'event_driven', forced_event_ids: event_ids },
      });

      if (error) {
        console.error(`[ct-specialist-dispatcher] fire failed for ${fnName}:`, error.message);
        return { ticker, fired: false, error: error.message, event_count: event_ids.length };
      }
      return { ticker, fired: true, event_count: event_ids.length, request_id: (data as any)?.request_id ?? null };
    }),
  );

  return new Response(
    JSON.stringify({
      ok: true,
      triggered: fires,
      skipped: cooledDown,
      hot_events: hotEvents.length,
      score_trigger: scoreTrigger,
      lookback_minutes: lookbackMinutes,
      cooldown_minutes: cooldownMinutes,
    }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  );
});
