/**
 * ct-news-causality — did flow/dark-pool activity move within 15 minutes
 * of each news headline? Produces a derived signal: per-source hit rates.
 *
 * Cron: every 15 min.
 * Scope: ct_news_analyses rows from the last 24h that lack a ct_news_causality row.
 * Per row: query ct_flow_alerts + ct_dark_pool_prints where ticker matches
 *   AND ingested_at in [news.created_at, news.created_at + 15min].
 * moved = flow_premium_15min > 0 OR dp_notional_15min >= 10_000_000.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';

const WINDOW_MINUTES = 15;
const DP_MOVE_THRESHOLD = 10_000_000; // $10M dark pool notional = "meaningful"
const LOOKBACK_HOURS = 24;

interface NewsRow {
  id: string;
  instrument: string;
  news_source: string | null;
  created_at: string;
}

async function findUnanalyzedNews(supabase: SupabaseClient): Promise<NewsRow[]> {
  const cutoff = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();
  // Left-anti join via two queries: get news, then filter out ones that have causality rows.
  const { data: news, error } = await supabase
    .from('ct_news_analyses')
    .select('id, instrument, news_source, created_at')
    .gte('created_at', cutoff)
    .order('created_at', { ascending: true })
    .limit(500);
  if (error) throw error;
  if (!news || news.length === 0) return [];

  const ids = news.map((n) => n.id);
  const { data: done, error: doneErr } = await supabase
    .from('ct_news_causality')
    .select('news_id')
    .in('news_id', ids);
  if (doneErr) throw doneErr;

  const seen = new Set((done ?? []).map((r: { news_id: string }) => r.news_id));
  return (news as NewsRow[]).filter((n) => !seen.has(n.id));
}

async function analyzeOne(supabase: SupabaseClient, news: NewsRow): Promise<{ moved: boolean }> {
  const startIso = news.created_at;
  const endIso = new Date(Date.parse(news.created_at) + WINDOW_MINUTES * 60 * 1000).toISOString();

  // Flow alerts in window
  const { data: flowRows } = await supabase
    .from('ct_flow_alerts')
    .select('premium')
    .eq('ticker', news.instrument)
    .gte('ingested_at', startIso)
    .lte('ingested_at', endIso);

  const flow_hits_15min = flowRows?.length ?? 0;
  const flow_premium_15min = (flowRows ?? []).reduce(
    (sum: number, r: { premium: number | null }) => sum + (Number(r.premium) || 0),
    0,
  );

  // Dark pool prints in window
  const { data: dpRows } = await supabase
    .from('ct_dark_pool_prints')
    .select('notional_value')
    .eq('ticker', news.instrument)
    .gte('ingested_at', startIso)
    .lte('ingested_at', endIso);

  const dp_hits_15min = dpRows?.length ?? 0;
  const dp_notional_15min = (dpRows ?? []).reduce(
    (sum: number, r: { notional_value: number | null }) => sum + (Number(r.notional_value) || 0),
    0,
  );

  const moved = flow_premium_15min > 0 || dp_notional_15min >= DP_MOVE_THRESHOLD;

  const { error } = await supabase.from('ct_news_causality').insert({
    news_id: news.id,
    ticker: news.instrument,
    news_source: news.news_source,
    news_at: news.created_at,
    flow_hits_15min,
    flow_premium_15min,
    dp_hits_15min,
    dp_notional_15min,
    moved,
  });
  if (error) throw error;

  return { moved };
}

serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
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
  const startedAt = Date.now();

  try {
    const news = await findUnanalyzedNews(supabase);
    let analyzed = 0;
    let moved_count = 0;
    let failed = 0;

    for (const n of news) {
      try {
        const { moved } = await analyzeOne(supabase, n);
        analyzed++;
        if (moved) moved_count++;
      } catch (e) {
        failed++;
        console.warn(`[ct-news-causality] ${n.instrument} ${n.id} failed:`, e instanceof Error ? e.message : e);
      }
    }

    return new Response(JSON.stringify({
      success: true,
      analyzed,
      moved_count,
      skipped: 0,
      failed,
      duration_ms: Date.now() - startedAt,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error) {
    console.error('[ct-news-causality] fatal:', error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'failed' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
