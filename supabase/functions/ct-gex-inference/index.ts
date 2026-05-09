/**
 * ct-gex-inference — thin edge wrapper around the gex_inference brain organ
 * (`_shared/gexInferenceContext.ts`, PR #104).
 *
 * Single source of truth for GEX dealer-positioning inference across every
 * Co-Trader read surface (Tenet 24 — no silos). Frontend consumers (`/alpha`
 * GexSnapshotCard, `/heatmap` redesign) invoke this function instead of
 * each reimplementing the strike-ladder math against `ct_gex_timeseries`.
 *
 * The kernel is in `_shared/gexInferenceContext.ts` — this file is the
 * UI-facing transport so the math lives ONCE.
 *
 * Returns:
 *   {
 *     per_ticker: GexInferencePerTicker[],   // strike + dealer positioning per ticker
 *     watchlist: GexInferenceWatchlistAggregate, // consensus_direction + counts + median dist
 *     generated_at: string,
 *     organ_status: OrganStatus,             // 'populated' | 'data_missing' | 'no_signal_detected' | 'error'
 *     warning?: string,
 *   }
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { getGexInferenceContext } from '../_shared/gexInferenceContext.ts';

const DEFAULT_WATCHLIST = [
  'NVDA', 'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'TSLA',
  'QQQ', 'SPY', 'IWM',
];

serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  const corsHeaders = getCorsHeaders(req);

  try {
    let body: Record<string, unknown> = {};
    if (req.method === 'POST') {
      try { body = await req.json() as Record<string, unknown>; } catch { body = {}; }
    }

    const rawTickers = body.tickers;
    const watchlist: string[] = Array.isArray(rawTickers) && rawTickers.length > 0
      ? (rawTickers as unknown[]).map((t) => String(t).toUpperCase()).filter(Boolean)
      : [...DEFAULT_WATCHLIST];

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    if (!supabaseUrl || !serviceKey) {
      return new Response(
        JSON.stringify({ error: 'missing_supabase_env' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const supabase = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const result = await getGexInferenceContext(supabase, watchlist);

    return new Response(
      JSON.stringify({
        per_ticker: result.data.per_ticker,
        watchlist: result.data.watchlist,
        generated_at: result.data.generated_at,
        organ_status: result.organMetadata?.status ?? 'populated',
        warning: result.meta?.warning,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[ct-gex-inference] failure:', msg);
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
