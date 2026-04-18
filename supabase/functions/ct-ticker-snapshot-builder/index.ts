/**
 * ct-ticker-snapshot-builder — every 2 min during RTH, builds a fresh quant
 * card for each watchlist ticker via `public.build_ticker_quant_card` and
 * upserts it into `ct_ticker_snapshots`. Downstream readers (generator, future
 * daily brief) then get O(1) cached reads instead of re-aggregating per tick.
 *
 * Writes one `ct_claude_decisions` row per run with outcome
 * 'snapshot_cache_refreshed' and the list of tickers_touched in
 * context_snapshot.
 *
 * Auth: service role only. Called by pg_cron (every 2 min, 13-20 UTC, M-F)
 * and manually via `trigger_ct_ticker_snapshot_builder()`.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { getWatchlist } from '../_shared/watchlist.ts';
import { getTickerQuantCard } from '../_shared/tickerQuantCard.ts';
import { recordDecision } from '../_shared/decisionJournal.ts';

serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  const corsHeaders = getCorsHeaders(req);

  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'Service role required' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
  const startedAt = Date.now();

  const watchlist = await getWatchlist(supabase);

  const results: Array<{ ticker: string; status: 'upserted' | 'empty' | 'error'; reason?: string }> = [];

  for (const ticker of watchlist) {
    const card = await getTickerQuantCard(supabase, ticker);
    if (!card) {
      results.push({ ticker, status: 'error', reason: 'quant_card_null' });
      continue;
    }

    const structure = card.structure ?? {};
    const events = card.events ?? {};
    const sentiment = card.sentiment ?? {};
    const brief = card.brief ?? {};

    const row = {
      ticker,
      spot:                   structure.spot ?? null,
      gamma_flip:             structure.gamma_flip ?? null,
      call_wall:              structure.call_wall ?? null,
      put_wall:               structure.put_wall ?? null,
      max_pain:               structure.max_pain ?? null,
      iv_rank:                structure.iv_rank ?? null,
      iv_percentile:          structure.iv_percentile ?? null,
      net_gamma:              structure.net_gamma ?? null,
      regime:                 structure.regime ?? null,
      flow_last_hour:         card.flow_last_hour ?? {},
      dark_pool_last_hour:    card.dark_pool_last_hour ?? {},
      greek_flow_last_hour:   card.greek_flow_last_hour ?? {},
      next_earnings_date:     events.next_earnings_date ?? null,
      earnings_expected_move: events.earnings_expected_move ?? null,
      upcoming_catalysts:     events.upcoming_catalysts ?? [],
      nope_latest:            sentiment.nope_latest ?? null,
      put_call_ratio:         sentiment.put_call_ratio ?? null,
      net_premium_cum:        sentiment.net_premium_cum ?? null,
      recent_news:            card.news ?? [],
      brief_tilt:             brief.tilt ?? null,
      avoid_today:            brief.avoid_today ?? false,
      snapshot_at:            new Date().toISOString(),
      source_brief_id:        brief.source_brief_id ?? null,
    };

    const { error } = await supabase
      .from('ct_ticker_snapshots')
      .upsert(row, { onConflict: 'ticker' });

    if (error) {
      results.push({ ticker, status: 'error', reason: error.message });
    } else {
      const hasData = structure.spot !== null && structure.spot !== undefined;
      results.push({ ticker, status: hasData ? 'upserted' : 'empty' });
    }
  }

  const upserted = results.filter((r) => r.status === 'upserted').length;
  const empty = results.filter((r) => r.status === 'empty').length;
  const errored = results.filter((r) => r.status === 'error').length;

  // One decision journal row per run — tells us the cache refreshed and when.
  await recordDecision(supabase, {
    decision_type: 'no_trade',
    model_tier: 'none',
    reasoning: `Snapshot cache refresh for ${watchlist.length} tickers: ${upserted} upserted, ${empty} empty, ${errored} errored`,
    outcome: 'snapshot_cache_refreshed',
    context_snapshot: {
      tickers_touched: watchlist,
      results,
      duration_ms: Date.now() - startedAt,
    },
  });

  const body = {
    ok: true,
    tickers: watchlist.length,
    upserted,
    empty,
    errored,
    results,
    duration_ms: Date.now() - startedAt,
  };
  console.log('[ct-ticker-snapshot-builder]', JSON.stringify(body));
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
