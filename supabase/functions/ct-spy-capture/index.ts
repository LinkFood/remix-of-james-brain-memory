/**
 * ct-spy-capture — capture today's SPY close into ct_spy_daily.
 *
 * Fired daily at 21:05 UTC (4:05 PM ET) by pg_cron. Pulls SPY spot-exposures
 * (already-used UW endpoint — the response carries underlying_price at the
 * top of the payload) and writes close + volume. Open/high/low stay NULL:
 * UW's wrapped endpoints expose no OHLC bars, and RiskMetricsPanel only
 * needs daily returns for beta/alpha anyway.
 *
 * First-run / missing history:
 *   - No prior row → prev_close = close (return := 0). Matches ct_book's
 *     "day 0 contributes no return" convention.
 *
 * Forward-only: uwClient.ts has no historical-bars function. Backfill is
 * punted. See migration header for rationale.
 *
 * Auth: service role only (invoked by pg_cron or trigger_ct_spy_capture RPC).
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { getSpotGexByStrike } from '../_shared/uwClient.ts';

/**
 * Extract the underlying (spot) price from a spot-exposures/strike payload.
 * UW commonly returns { data: [...], price } with the price at the top level,
 * though occasionally it lands nested under `.data`. Mirrors the logic in
 * ct-gex-radar's spotFromGex so the two stay in sync.
 */
function extractClose(raw: unknown): number | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const candidates = ['price', 'spot', 'underlying_price', 'last_price', 'close'];
  for (const k of candidates) {
    const v = r[k];
    if (v === undefined || v === null) continue;
    const n = typeof v === 'number' ? v : Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  if (r.data && typeof r.data === 'object' && !Array.isArray(r.data)) {
    return extractClose(r.data);
  }
  return null;
}

/** Volume sometimes rides on the same envelope; best-effort, bigint-compatible. */
function extractVolume(raw: unknown): number | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const candidates = ['volume', 'total_volume', 'underlying_volume'];
  for (const k of candidates) {
    const v = r[k];
    if (v === undefined || v === null) continue;
    const n = typeof v === 'number' ? v : Number(v);
    if (Number.isFinite(n) && n >= 0) return Math.round(n);
  }
  if (r.data && typeof r.data === 'object' && !Array.isArray(r.data)) {
    return extractVolume(r.data);
  }
  return null;
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

  const today = new Date().toISOString().slice(0, 10);

  // Pull SPY spot. Reuses the same endpoint every other Co-Trader cron hits,
  // so no incremental UW quota burn beyond the usual watcher cycle.
  let spotRaw: unknown;
  try {
    spotRaw = await getSpotGexByStrike('SPY');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[ct-spy-capture] UW spot-exposures call failed:', msg);
    return new Response(JSON.stringify({ error: `UW call failed: ${msg}` }), {
      status: 502,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const close = extractClose(spotRaw);
  if (close == null) {
    console.error('[ct-spy-capture] no usable close price in UW payload');
    return new Response(JSON.stringify({ error: 'No close price in UW response' }), {
      status: 502,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  const volume = extractVolume(spotRaw);

  // prev_close = most recent row strictly before today. First-run: use today's
  // close so daily_return_pct resolves to 0 instead of NULL / undefined.
  const { data: prior, error: priorErr } = await supabase
    .from('ct_spy_daily')
    .select('date, close')
    .lt('date', today)
    .order('date', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (priorErr) {
    console.error('[ct-spy-capture] prior-row query failed:', priorErr.message);
  }
  const prevClose = prior?.close ?? close;

  const { error: upsertErr } = await supabase
    .from('ct_spy_daily')
    .upsert(
      {
        date: today,
        open: null,
        high: null,
        low: null,
        close: +close.toFixed(4),
        volume: volume,
        prev_close: +Number(prevClose).toFixed(4),
      },
      { onConflict: 'date' },
    );

  if (upsertErr) {
    console.error('[ct-spy-capture] upsert failed:', upsertErr.message);
    return new Response(JSON.stringify({ error: upsertErr.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Re-read the generated column so we return the authoritative return pct.
  const { data: written } = await supabase
    .from('ct_spy_daily')
    .select('date, close, prev_close, daily_return_pct')
    .eq('date', today)
    .maybeSingle();

  return new Response(
    JSON.stringify({
      ok: true,
      date: written?.date ?? today,
      close: written?.close ?? close,
      prev_close: written?.prev_close ?? prevClose,
      daily_return_pct: written?.daily_return_pct ?? 0,
    }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  );
});
