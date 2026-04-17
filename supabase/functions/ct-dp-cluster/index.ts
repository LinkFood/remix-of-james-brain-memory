/**
 * ct-dp-cluster — always-on flag pattern for dark pool blocks. No UW calls.
 *
 * Every minute during weekday market hours, scan ct_dark_pool_prints for the
 * last 10 minutes where notional_value >= $1M, group by ticker, and emit a
 * "DP CLUSTER" finding for any ticker with count >= 3.
 *
 * Dedupe: per-ticker 15-min cooldown — DP blocks arrive slower and chunkier
 * than sweeps, so the cooldown is more generous than the sweep cluster's 10m.
 * Fail-closed: if the dedupe query errors, treat as recently-emitted and skip.
 *
 * Attention score:  count >= 5 → 85   count >= 4 → 75   count >= 3 → 65
 * Slack push:       score >= 75       (count >= 4)
 *
 * Window = 10min (not 5 like sweeps) because DP prints trickle in slower.
 * Threshold = $1M per print (vs $500k for sweeps) — DP blocks are chunkier.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { ctSlackPushDirect } from '../_shared/ctSlack.ts';

interface DpRow {
  ticker: string;
  executed_at: string | null;
  size: number | null;
  price: number | null;
  notional_value: number | null;
}

interface ClusterResult {
  ticker: string;
  window_start: string;
  window_end: string;
  print_count: number;
  total_notional: number;
  largest_single_notional: number;
  attention_score: number;
}

function scoreFor(count: number): number {
  if (count >= 5) return 85;
  if (count >= 4) return 75;
  return 65; // count >= 3
}

function fmtMoney(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

/**
 * Dedupe: has this ticker already been emitted as a cluster in the last 15
 * minutes? If so, skip it. Cheap index hit on (ticker, created_at DESC).
 */
async function recentlyEmitted(
  supabase: SupabaseClient,
  ticker: string,
): Promise<boolean> {
  const cutoff = new Date(Date.now() - 15 * 60_000).toISOString();
  const { data, error } = await supabase
    .from('ct_dp_clusters')
    .select('id')
    .eq('ticker', ticker)
    .gte('created_at', cutoff)
    .limit(1);
  if (error) {
    console.warn(`[ct-dp-cluster] dedupe query failed (${ticker}):`, error.message);
    // Fail-closed on dedupe: if the check errors, skip emitting — prefer
    // a rare miss over spam.
    return true;
  }
  return (data ?? []).length > 0;
}

async function scanWindow(
  supabase: SupabaseClient,
  windowStart: string,
  windowEnd: string,
): Promise<DpRow[]> {
  // Pull all DP prints >= $1M in the 10-min window. notional_value is a
  // generated column (size * price), indexed via standard DP indexes.
  const { data, error } = await supabase
    .from('ct_dark_pool_prints')
    .select('ticker, executed_at, size, price, notional_value')
    .gte('executed_at', windowStart)
    .lte('executed_at', windowEnd)
    .gte('notional_value', 1_000_000)
    .limit(2000);
  if (error) {
    console.warn('[ct-dp-cluster] dp scan failed:', error.message);
    return [];
  }
  return (data ?? []) as DpRow[];
}

function groupByTicker(rows: DpRow[]): Map<string, DpRow[]> {
  const m = new Map<string, DpRow[]>();
  for (const r of rows) {
    if (!r.ticker) continue;
    const arr = m.get(r.ticker) ?? [];
    arr.push(r);
    m.set(r.ticker, arr);
  }
  return m;
}

function buildCluster(
  ticker: string,
  rows: DpRow[],
  windowStart: string,
  windowEnd: string,
): ClusterResult | null {
  const count = rows.length;
  if (count < 3) return null;
  let total = 0;
  let largest = 0;
  for (const r of rows) {
    const n = r.notional_value ?? 0;
    total += n;
    if (n > largest) largest = n;
  }
  return {
    ticker,
    window_start: windowStart,
    window_end: windowEnd,
    print_count: count,
    total_notional: total,
    largest_single_notional: largest,
    attention_score: scoreFor(count),
  };
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

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
  const startedAt = Date.now();

  try {
    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - 10 * 60_000);
    const windowStartIso = windowStart.toISOString();
    const windowEndIso = windowEnd.toISOString();

    const rows = await scanWindow(supabase, windowStartIso, windowEndIso);
    const byTicker = groupByTicker(rows);

    const perTicker: Record<string, { count: number; total_notional: number; emitted: boolean; reason?: string }> = {};
    const emitted: ClusterResult[] = [];

    for (const [ticker, tickerRows] of byTicker.entries()) {
      const cluster = buildCluster(ticker, tickerRows, windowStartIso, windowEndIso);
      if (!cluster) {
        perTicker[ticker] = { count: tickerRows.length, total_notional: 0, emitted: false, reason: 'below_threshold' };
        continue;
      }

      const deduped = await recentlyEmitted(supabase, ticker);
      if (deduped) {
        perTicker[ticker] = { count: cluster.print_count, total_notional: cluster.total_notional, emitted: false, reason: 'dedupe_15min' };
        continue;
      }

      const { error } = await supabase.from('ct_dp_clusters').insert({
        ticker: cluster.ticker,
        window_start: cluster.window_start,
        window_end: cluster.window_end,
        print_count: cluster.print_count,
        total_notional: cluster.total_notional,
        largest_single_notional: cluster.largest_single_notional,
        attention_score: cluster.attention_score,
      });
      if (error) {
        console.warn(`[ct-dp-cluster] insert failed (${ticker}):`, error.message);
        perTicker[ticker] = { count: cluster.print_count, total_notional: cluster.total_notional, emitted: false, reason: `insert_error:${error.message.slice(0, 60)}` };
        continue;
      }

      emitted.push(cluster);
      perTicker[ticker] = { count: cluster.print_count, total_notional: cluster.total_notional, emitted: true };

      // Slack push only on attention_score >= 75 (count >= 4 prints). Best-effort,
      // use the first user we find so the push has a channel. No dedupe here
      // beyond the 15-min cluster cooldown.
      if (cluster.attention_score >= 75) {
        try {
          const { data: userRow } = await supabase
            .from('user_settings')
            .select('user_id')
            .not('settings->>slack_channel_id', 'is', null)
            .limit(1)
            .maybeSingle();
          const uid = (userRow as { user_id?: string } | null)?.user_id;
          if (uid) {
            const text =
              `:large_blue_square: *DP CLUSTER* · ${cluster.ticker} · ${cluster.print_count} blocks · ` +
              `${fmtMoney(cluster.total_notional)} total · largest ${fmtMoney(cluster.largest_single_notional)} · score ${cluster.attention_score}`;
            await ctSlackPushDirect(supabase, uid, text, 'dp-cluster');
          }
        } catch (e) {
          console.warn('[ct-dp-cluster] slack push failed (non-blocking):', e instanceof Error ? e.message : e);
        }
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        window_start: windowStartIso,
        window_end: windowEndIso,
        scanned_rows: rows.length,
        tickers_considered: byTicker.size,
        emitted_count: emitted.length,
        per_ticker: perTicker,
        duration_ms: Date.now() - startedAt,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (error) {
    console.error('[ct-dp-cluster] fatal:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'failed' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
