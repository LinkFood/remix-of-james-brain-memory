/**
 * ct-watcher — Co-trader Claude watcher cron
 *
 * Day 1 stub: pulls watchlist state from UW, writes a heartbeat row.
 * Day 2 adds: memory recall + Claude invocation + state-based writes
 *              (HEARTBEAT/OBSERVATION/FLAG/ALERT) + Slack push.
 *
 * Runs every 30 min during market hours (13:00-21:00 UTC weekdays).
 * pg_cron schedule added in separate migration once verified manually.
 *
 * Auth: service role only (internal cron).
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { pullWatcherState, WATCHLIST } from '../_shared/uwClient.ts';
import { now as clockNow } from '../_shared/clock.ts';

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

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const clock = clockNow();
  const startedAt = Date.now();

  try {
    console.log(`[ct-watcher] tick @ ${clock.datetime} (${clock.tz})`);

    // Pull current state for all 12 instruments + SPX macro + market tide
    const state = await pullWatcherState();

    const gexCount = Object.keys(state.spot_gex).length;
    const volCount = Object.keys(state.options_volume).length;
    const errCount = state.errors.length;

    console.log(`[ct-watcher] UW pull: spot_gex=${gexCount}/${WATCHLIST.length} options_vol=${volCount}/${WATCHLIST.length} spx=${state.spx_spot_gex ? 'ok' : 'fail'} tide=${state.market_tide ? 'ok' : 'fail'} errors=${errCount}`);

    if (errCount > 0) {
      console.warn(`[ct-watcher] errors: ${JSON.stringify(state.errors.slice(0, 5))}`);
    }

    // Day 1: write a heartbeat row with the raw state as proof of life.
    // Day 2 replaces this with memory recall + Claude decision logic.
    const currentReads: Record<string, { spot_gex: unknown; options_volume: unknown }> = {};
    for (const t of WATCHLIST) {
      currentReads[t] = {
        spot_gex: state.spot_gex[t] ?? null,
        options_volume: state.options_volume[t] ?? null,
      };
    }

    const { error: hbError } = await supabase.from('ct_heartbeats').insert({
      status_line: `Day 1 stub — spot_gex ${gexCount}/${WATCHLIST.length}, options_vol ${volCount}/${WATCHLIST.length}, spx ${state.spx_spot_gex ? 'ok' : 'fail'}, tide ${state.market_tide ? 'ok' : 'fail'} — ${Date.now() - startedAt}ms`,
      watching: [...WATCHLIST],
      current_reads: {
        ...currentReads,
        _macro: {
          spx_spot_gex: state.spx_spot_gex ?? null,
          market_tide: state.market_tide ?? null,
        },
        _meta: {
          errors: state.errors,
          pulled_at: clock.iso,
        },
      },
      prompt_version: 'v1',
    });

    if (hbError) {
      console.error('[ct-watcher] heartbeat insert failed:', hbError);
      return new Response(JSON.stringify({ error: 'heartbeat insert failed', detail: hbError.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const durationMs = Date.now() - startedAt;

    return new Response(JSON.stringify({
      success: true,
      phase: 'day-1-stub',
      tickers_covered: okCount,
      gex_covered: gexCount,
      errors: errCount,
      duration_ms: durationMs,
      error_samples: state.errors.slice(0, 3),
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('[ct-watcher] fatal:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'watcher failed',
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
