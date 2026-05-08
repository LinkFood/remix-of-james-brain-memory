/**
 * ct-uw-spot-poll — extended-hours spot price coverage via UW spot-exposures.
 *
 * Closes the 17.5-hour-off-RTH-blindness gap surfaced by the 2026-05-07
 * substrate audit. ct-price-live-poll (Yahoo) covers RTH 13:00-20:58 UTC
 * only. This poller covers pre-market 8-12:55 UTC + after-hours 21-23:55 UTC
 * weekdays (8 hours/day) so ct_ticker_snapshots carries a fresh, source-
 * labeled spot during the windows Yahoo doesn't see.
 *
 * Writes to LABELED columns on ct_ticker_snapshots (uw_spot,
 * uw_snapshot_at, uw_source) — does NOT touch the existing `spot` column,
 * so Yahoo and UW writers operate independently. Consumer migration to
 * read uw_spot is a separate ship (Phase 2A vendor abstraction or
 * per-consumer follow-ups).
 *
 * UW BUDGET
 *   Per fire: 10 calls (one per watchlist ticker). Cron `*\/5 8-12,21-23 * * 1-5`
 *   = 96 fires/day × 10 = 960 calls/day. ~4.8% of 20k/day cap. Empirical
 *   weekday baseline (2026-05-01 onward) is ~12k/day, leaving ~8k headroom.
 *
 * ERROR POLICY
 *   Per-ticker failures are logged to errors[] but do not abort the cycle.
 *   extractSpotPrice returns null when UW payload doesn't carry a price
 *   (defensive). Null result skips the upsert for that ticker — never
 *   writes garbage. Matches ct-price-tick-capture / ct-spy-capture pattern.
 *
 * AUTH
 *   Service role only — invoked by pg_cron via _ct_post() helper. Uses
 *   isServiceRoleRequest() per 2026-05-07 gateway-rewrite class kill
 *   (apikey header check).
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { getSpotGexByStrike, setUwCaller } from '../_shared/uwClient.ts';
import { getWatchlist } from '../_shared/watchlist.ts';

const SOURCE_LABEL = 'unusualwhales:spot-exposures/strike';

interface TickerResult {
  ticker: string;
  uw_spot: number | null;
  error?: string;
}

/**
 * Extract underlying price from a spot-exposures payload. Defensive — the
 * shape varies a bit between calls. Mirrors extractSpotPrice in uwClient.ts
 * for parity (private helper there).
 */
function extractSpotPrice(raw: unknown): number | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const candidates = ['price', 'spot', 'underlying_price', 'last_price', 'close'];
  for (const k of candidates) {
    const v = r[k];
    if (v === undefined || v === null) continue;
    const n = typeof v === 'number' ? v : Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const data = r.data;
  if (Array.isArray(data) && data.length > 0) {
    const first = data[0] as Record<string, unknown>;
    for (const k of candidates) {
      const v = first[k];
      if (v === undefined || v === null) continue;
      const n = typeof v === 'number' ? v : Number(v);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return extractSpotPrice(data);
  }
  return null;
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

  setUwCaller('ct-uw-spot-poll');

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const startedAt = Date.now();
  const watchlist = await getWatchlist(supabase);
  const perTicker: TickerResult[] = [];
  const errors: string[] = [];

  for (const ticker of watchlist) {
    try {
      const raw = await getSpotGexByStrike(ticker);
      const spot = extractSpotPrice(raw);
      if (spot === null) {
        perTicker.push({ ticker, uw_spot: null, error: 'no_spot_in_payload' });
        errors.push(`${ticker}:no_spot_in_payload`);
        continue;
      }
      const { error: upsertErr } = await supabase
        .from('ct_ticker_snapshots')
        .update({
          uw_spot: spot,
          uw_snapshot_at: new Date().toISOString(),
          uw_source: SOURCE_LABEL,
        })
        .eq('ticker', ticker);
      if (upsertErr) {
        perTicker.push({ ticker, uw_spot: null, error: `upsert: ${upsertErr.message.slice(0, 120)}` });
        errors.push(`${ticker}:upsert:${upsertErr.message.slice(0, 120)}`);
        continue;
      }
      perTicker.push({ ticker, uw_spot: spot });
    } catch (e) {
      const msg = e instanceof Error ? e.message.slice(0, 160) : String(e).slice(0, 160);
      perTicker.push({ ticker, uw_spot: null, error: `fatal: ${msg}` });
      errors.push(`${ticker}:fatal:${msg}`);
    }
  }

  const ok = perTicker.some((r) => r.uw_spot !== null);

  return new Response(
    JSON.stringify({
      ok,
      tickers: watchlist.length,
      per_ticker: perTicker,
      errors,
      duration_ms: Date.now() - startedAt,
    }),
    {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    },
  );
});
