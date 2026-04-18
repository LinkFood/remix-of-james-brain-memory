/**
 * ct-vix-capture — capture today's VIX close into ct_vix_history.
 *
 * Fired daily at 21:05 UTC (4:05 PM ET) by pg_cron. Uses uwClient.getVixSpot()
 * which tries VIX first and falls back to VIXY (1x short-term VIX ETF) when
 * UW refuses the index directly. The `source` column preserves which endpoint
 * answered so downstream regime math can downweight proxy rows.
 *
 * First-run / missing history:
 *   - No prior row → prev_close stays null and change_pct resolves to null
 *     via the generated column. Matches ct_spy_daily behavior in spirit,
 *     but VIX change_pct is more meaningful than "0%" when we have no
 *     anchor, so we leave it null rather than synthesizing 0.
 *
 * Forward-only: UW's wrapped endpoints expose no historical bars. Backfill
 * punted — see migration header for rationale.
 *
 * Auth: service role only (invoked by pg_cron or trigger_ct_vix_capture RPC).
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { isKillSwitchActive, killSwitchSkipResponse } from '../_shared/killSwitch.ts';
import { getVixSpot } from '../_shared/uwClient.ts';

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

  // Kill switch — skip entire capture if engaged. Matches ct-watcher.
  if (await isKillSwitchActive(supabase)) {
    return killSwitchSkipResponse(supabase, 'ct-vix-capture', corsHeaders);
  }

  const today = new Date().toISOString().slice(0, 10);

  // Pull VIX spot with VIXY fallback. Never throws by design.
  const vix = await getVixSpot();
  if (!vix) {
    console.error('[ct-vix-capture] UW refused both VIX and VIXY — no row written');
    return new Response(JSON.stringify({ error: 'VIX + VIXY unavailable' }), {
      status: 502,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // prev_close = most recent row strictly before today. First-run: null
  // (change_pct stays null rather than synthesizing 0).
  const { data: prior, error: priorErr } = await supabase
    .from('ct_vix_history')
    .select('date, level')
    .lt('date', today)
    .order('date', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (priorErr) {
    console.error('[ct-vix-capture] prior-row query failed:', priorErr.message);
  }
  const prevClose = prior?.level ?? null;

  const { error: upsertErr } = await supabase
    .from('ct_vix_history')
    .upsert(
      {
        date: today,
        level: +vix.level.toFixed(4),
        prev_close: prevClose != null ? +Number(prevClose).toFixed(4) : null,
        source: vix.source,
        endpoint: vix.endpoint,
      },
      { onConflict: 'date' },
    );

  if (upsertErr) {
    console.error('[ct-vix-capture] upsert failed:', upsertErr.message);
    return new Response(JSON.stringify({ error: upsertErr.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Re-read to return authoritative generated columns (tier, change_pct).
  const { data: written } = await supabase
    .from('ct_vix_history')
    .select('date, level, prev_close, change_pct, tier, source, endpoint')
    .eq('date', today)
    .maybeSingle();

  return new Response(
    JSON.stringify({
      ok: true,
      date: written?.date ?? today,
      level: written?.level ?? vix.level,
      prev_close: written?.prev_close ?? prevClose,
      change_pct: written?.change_pct ?? null,
      tier: written?.tier ?? null,
      source: written?.source ?? vix.source,
      endpoint: written?.endpoint ?? vix.endpoint,
    }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  );
});
