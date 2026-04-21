/**
 * ct-dp-cluster — always-on flag pattern for dark pool blocks. No UW calls.
 *
 * Thresholds live in ct_config (keys: clusters.dp.window_min,
 * clusters.dp.count_min, clusters.dp.notional_usd,
 * clusters.dp.slack_notional_min_usd, clusters.dp.slack_cooldown_min).
 * Tune via /ct-settings. 60s cache TTL — changes propagate within ~1 minute.
 *
 * Every minute during weekday market hours, scan ct_dark_pool_prints for the
 * last window_min minutes where notional_value >= notional_usd, group by
 * ticker, and emit a "DP CLUSTER" finding for any ticker with count >= count_min.
 *
 * Dedupe: per-ticker cooldown (default 30min, tunable). Fail-closed: if the
 * dedupe query errors, treat as recently-emitted and skip.
 *
 * Attention score:  count >= 5 → 85   count >= 4 → 75   count >= count_min → 65
 * Slack push:       score >= 85 AND total_notional >= slack_notional_min_usd.
 *                   Monday's live-open run pushed 70+ per-ticker standalone
 *                   pings on routine $10-30M institutional prints — noise.
 *                   Slack is now reserved for exceptional clusters; the rest
 *                   still land in ct_dp_clusters (Claude sees them) and get
 *                   rolled into the Co-Trader 30-min digest / FLAG convergence.
 *
 * Window defaults to 10min (not 5 like sweeps) because DP prints trickle in slower.
 * Threshold defaults to $1M per print (vs $500k for sweeps) — DP blocks are chunkier.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { ctSlackPushDirect } from '../_shared/ctSlack.ts';
import { getConfig } from '../_shared/configCache.ts';
import { fireWatcherImmediate } from '../_shared/watcherDispatch.ts';

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
  return 65; // count >= count_min
}

function fmtMoney(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

/**
 * Dedupe: has this ticker already been emitted as a cluster in the last
 * cooldownMin minutes? If so, skip it. Cheap index hit on
 * (ticker, created_at DESC). Cooldown is tunable via ct_config.
 */
async function recentlyEmitted(
  supabase: SupabaseClient,
  ticker: string,
  cooldownMin: number,
): Promise<boolean> {
  const cutoff = new Date(Date.now() - cooldownMin * 60_000).toISOString();
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
  notionalUsd: number,
): Promise<DpRow[]> {
  // Pull all DP prints >= notionalUsd in the window. notional_value is a
  // generated column (size * price), indexed via standard DP indexes.
  const { data, error } = await supabase
    .from('ct_dark_pool_prints')
    .select('ticker, executed_at, size, price, notional_value')
    .gte('executed_at', windowStart)
    .lte('executed_at', windowEnd)
    .gte('notional_value', notionalUsd)
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
  countMin: number,
): ClusterResult | null {
  const count = rows.length;
  if (count < countMin) return null;
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
    // Pull tunable thresholds from ct_config (60s cache TTL).
    const [windowMin, countMin, notionalUsd, slackNotionalMin, cooldownMin, slackEnabled] = await Promise.all([
      getConfig<number>('clusters.dp.window_min', 10),
      getConfig<number>('clusters.dp.count_min', 3),
      getConfig<number>('clusters.dp.notional_usd', 1_000_000),
      // Slack gate — only push clusters above this total notional. $250M
      // default empirically drops ~90% of Monday's pings (routine $10-30M
      // institutional flow) while preserving truly notable bursts.
      getConfig<number>('clusters.dp.slack_notional_min_usd', 250_000_000),
      // Per-ticker slack cooldown. 30 min default (was 15) — DP clusters
      // on the same ticker re-firing twice an hour is operator noise.
      getConfig<number>('clusters.dp.slack_cooldown_min', 30),
      // Master kill: default OFF. Operator explicitly opts back in via
      // /ct-settings once they want per-cluster pings. Until flipped true,
      // clusters still land in ct_dp_clusters (Claude reads them) and feed
      // the 30-min digest + FLAG convergence — they just don't page Slack.
      getConfig<boolean>('clusters.dp.slack_enabled', false),
    ]);
    console.log(`[ct-dp-cluster v2] thresholds: window=${windowMin}min count=${countMin} notional=$${notionalUsd} slack_enabled=${slackEnabled} slack_min=$${slackNotionalMin} cooldown=${cooldownMin}min`);

    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - windowMin * 60_000);
    const windowStartIso = windowStart.toISOString();
    const windowEndIso = windowEnd.toISOString();

    const rows = await scanWindow(supabase, windowStartIso, windowEndIso, notionalUsd);
    const byTicker = groupByTicker(rows);

    const perTicker: Record<string, { count: number; total_notional: number; emitted: boolean; reason?: string }> = {};
    const emitted: ClusterResult[] = [];

    for (const [ticker, tickerRows] of byTicker.entries()) {
      const cluster = buildCluster(ticker, tickerRows, windowStartIso, windowEndIso, countMin);
      if (!cluster) {
        perTicker[ticker] = { count: tickerRows.length, total_notional: 0, emitted: false, reason: 'below_threshold' };
        continue;
      }

      const deduped = await recentlyEmitted(supabase, ticker, cooldownMin);
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

      // Event-driven watcher trigger at attention >= 85 — a 5+ block burst on
      // one ticker is the kind of dark-pool signal that deserves immediate
      // watcher attention, not the next scheduled tick.
      if (cluster.attention_score >= 85) {
        await fireWatcherImmediate(supabase, {
          source: 'dp_cluster',
          priority: 'high',
          reason: `${cluster.ticker} ${cluster.print_count} DP blocks · score ${cluster.attention_score}`,
        });
      }

      // Slack push is gated behind THREE independent conditions, all tunable:
      //   1. Master switch clusters.dp.slack_enabled (default false)
      //   2. attention_score >= 85 (count >= 5 prints)
      //   3. total_notional >= clusters.dp.slack_notional_min_usd (default $250M)
      // Standard clusters still land in ct_dp_clusters (Claude sees them)
      // and feed the 30-min digest + FLAG convergence path.
      if (slackEnabled && cluster.attention_score >= 85 && cluster.total_notional >= slackNotionalMin) {
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
