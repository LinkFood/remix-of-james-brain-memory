/**
 * ct-sweep-cluster — always-on flag pattern, no UW calls.
 *
 * Thresholds live in ct_config (keys: clusters.sweep.window_min,
 * clusters.sweep.count_min, clusters.sweep.premium_usd). Tune via
 * /ct-settings. 60s cache TTL — changes propagate within ~1 minute.
 *
 * Every minute during weekday market hours, scan ct_flow_alerts for the last
 * window_min minutes where alert_type ilike '%sweep%' AND premium >= premium_usd,
 * group by ticker, and emit a "SWEEP CLUSTER" finding for any ticker with
 * count >= count_min.
 *
 * Dedupe: per-ticker 10-min cooldown — we check ct_sweep_clusters.created_at
 * before inserting so a single hot ticker doesn't spam the strip.
 *
 * Attention score:  count >= 5 → 85   count >= 4 → 75   count >= count_min → 65
 * Slack push:       score >= 75       (count >= 4)
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { ctSlackPushDirect } from '../_shared/ctSlack.ts';
import { getConfig } from '../_shared/configCache.ts';
import { fireWatcherImmediate } from '../_shared/watcherDispatch.ts';

interface FlowRow {
  ticker: string;
  executed_at: string | null;
  premium: number | null;
  side: string | null;
  alert_type: string | null;
}

interface ClusterResult {
  ticker: string;
  window_start: string;
  window_end: string;
  sweep_count: number;
  total_premium: number;
  dominant_side: 'call' | 'put' | 'mixed';
  largest_single_premium: number;
  call_count: number;
  put_count: number;
  attention_score: number;
}

function scoreFor(count: number): number {
  if (count >= 5) return 85;
  if (count >= 4) return 75;
  return 65; // count >= count_min
}

function isCall(side: string | null): boolean {
  return (side ?? '').trim().toLowerCase().startsWith('c');
}

function isPut(side: string | null): boolean {
  return (side ?? '').trim().toLowerCase().startsWith('p');
}

function dominantSide(calls: number, puts: number): 'call' | 'put' | 'mixed' {
  if (calls === 0 && puts === 0) return 'mixed';
  // Dominant = clear majority (>=70% of sided rows).
  const total = calls + puts;
  if (total === 0) return 'mixed';
  if (calls / total >= 0.7) return 'call';
  if (puts / total >= 0.7) return 'put';
  return 'mixed';
}

function fmtMoney(n: number): string {
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

/**
 * Dedupe: has this ticker already been emitted as a cluster in the last 10
 * minutes? If so, skip it. Cheap index hit on (ticker, created_at DESC).
 */
async function recentlyEmitted(
  supabase: SupabaseClient,
  ticker: string,
): Promise<boolean> {
  const cutoff = new Date(Date.now() - 10 * 60_000).toISOString();
  const { data, error } = await supabase
    .from('ct_sweep_clusters')
    .select('id')
    .eq('ticker', ticker)
    .gte('created_at', cutoff)
    .limit(1);
  if (error) {
    console.warn(`[ct-sweep-cluster] dedupe query failed (${ticker}):`, error.message);
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
  premiumUsd: number,
): Promise<FlowRow[]> {
  // Pull all sweeps >= premiumUsd in the window. alert_type is a free-text
  // column; the ingester writes 'sweep' or variants ('golden_sweep', etc.).
  // ilike '%sweep%' catches them all. Index: ct_flow_alerts_time (executed_at DESC).
  const { data, error } = await supabase
    .from('ct_flow_alerts')
    .select('ticker, executed_at, premium, side, alert_type')
    .gte('executed_at', windowStart)
    .lte('executed_at', windowEnd)
    .ilike('alert_type', '%sweep%')
    .gte('premium', premiumUsd)
    .limit(2000);
  if (error) {
    console.warn('[ct-sweep-cluster] flow scan failed:', error.message);
    return [];
  }
  return (data ?? []) as FlowRow[];
}

function groupByTicker(rows: FlowRow[]): Map<string, FlowRow[]> {
  const m = new Map<string, FlowRow[]>();
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
  rows: FlowRow[],
  windowStart: string,
  windowEnd: string,
  countMin: number,
): ClusterResult | null {
  const count = rows.length;
  if (count < countMin) return null;
  let total = 0;
  let largest = 0;
  let calls = 0;
  let puts = 0;
  for (const r of rows) {
    const p = r.premium ?? 0;
    total += p;
    if (p > largest) largest = p;
    if (isCall(r.side)) calls++;
    else if (isPut(r.side)) puts++;
  }
  return {
    ticker,
    window_start: windowStart,
    window_end: windowEnd,
    sweep_count: count,
    total_premium: total,
    dominant_side: dominantSide(calls, puts),
    largest_single_premium: largest,
    call_count: calls,
    put_count: puts,
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
    // Pull tunable thresholds from ct_config (60s cache TTL, defaults preserve
    // legacy behavior if the row is missing or the RPC errors).
    const windowMin = await getConfig<number>('clusters.sweep.window_min', 5);
    const countMin = await getConfig<number>('clusters.sweep.count_min', 3);
    const premiumUsd = await getConfig<number>('clusters.sweep.premium_usd', 500_000);
    console.log(`[ct-sweep-cluster] thresholds: window=${windowMin}min count=${countMin} premium=$${premiumUsd}`);

    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - windowMin * 60_000);
    const windowStartIso = windowStart.toISOString();
    const windowEndIso = windowEnd.toISOString();

    const rows = await scanWindow(supabase, windowStartIso, windowEndIso, premiumUsd);
    const byTicker = groupByTicker(rows);

    const perTicker: Record<string, { count: number; total_premium: number; emitted: boolean; reason?: string }> = {};
    const emitted: ClusterResult[] = [];

    for (const [ticker, tickerRows] of byTicker.entries()) {
      const cluster = buildCluster(ticker, tickerRows, windowStartIso, windowEndIso, countMin);
      if (!cluster) {
        perTicker[ticker] = { count: tickerRows.length, total_premium: 0, emitted: false, reason: 'below_threshold' };
        continue;
      }

      const deduped = await recentlyEmitted(supabase, ticker);
      if (deduped) {
        perTicker[ticker] = { count: cluster.sweep_count, total_premium: cluster.total_premium, emitted: false, reason: 'dedupe_10min' };
        continue;
      }

      const { error } = await supabase.from('ct_sweep_clusters').insert({
        ticker: cluster.ticker,
        window_start: cluster.window_start,
        window_end: cluster.window_end,
        sweep_count: cluster.sweep_count,
        total_premium: cluster.total_premium,
        dominant_side: cluster.dominant_side,
        largest_single_premium: cluster.largest_single_premium,
        call_count: cluster.call_count,
        put_count: cluster.put_count,
        attention_score: cluster.attention_score,
      });
      if (error) {
        console.warn(`[ct-sweep-cluster] insert failed (${ticker}):`, error.message);
        perTicker[ticker] = { count: cluster.sweep_count, total_premium: cluster.total_premium, emitted: false, reason: `insert_error:${error.message.slice(0, 60)}` };
        continue;
      }

      emitted.push(cluster);
      perTicker[ticker] = { count: cluster.sweep_count, total_premium: cluster.total_premium, emitted: true };

      // Event-driven watcher trigger at attention >= 85 — a 5+ sweep burst
      // on one ticker is the kind of flow we want the watcher to weigh
      // in real time, not at the next scheduled tick.
      if (cluster.attention_score >= 85) {
        const sideWord =
          cluster.dominant_side === 'call' ? 'calls'
          : cluster.dominant_side === 'put' ? 'puts'
          : 'mixed';
        await fireWatcherImmediate(supabase, {
          source: 'sweep_cluster',
          priority: 'high',
          reason: `${cluster.ticker} ${cluster.sweep_count} sweeps ${sideWord} · score ${cluster.attention_score}`,
        });
      }

      // Slack push is gated on EXCEPTIONAL clusters only — score 85 (count
      // >= 5 sweeps) AND total_premium >= clusters.sweep.slack_premium_min_usd
      // (default $10M, tunable). Standard clusters still land in
      // ct_sweep_clusters (Claude sees them) and feed the 30-min digest.
      // Mirrors the ct-dp-cluster silence fix — Slack is for exceptional
      // bursts, not a log of every $500k sweep grouping.
      const slackPremiumMin = await getConfig<number>('clusters.sweep.slack_premium_min_usd', 10_000_000);
      if (cluster.attention_score >= 85 && cluster.total_premium >= slackPremiumMin) {
        try {
          const { data: userRow } = await supabase
            .from('user_settings')
            .select('user_id')
            .not('settings->>slack_channel_id', 'is', null)
            .limit(1)
            .maybeSingle();
          const uid = (userRow as { user_id?: string } | null)?.user_id;
          if (uid) {
            const sideWord =
              cluster.dominant_side === 'call' ? 'calls'
              : cluster.dominant_side === 'put' ? 'puts'
              : 'mixed';
            const text =
              `:zap: *SWEEP CLUSTER* · ${cluster.ticker} · ${cluster.sweep_count} sweeps ${sideWord} · ` +
              `${fmtMoney(cluster.total_premium)} total · largest ${fmtMoney(cluster.largest_single_premium)} · score ${cluster.attention_score}`;
            await ctSlackPushDirect(supabase, uid, text, 'sweep-cluster');
          }
        } catch (e) {
          console.warn('[ct-sweep-cluster] slack push failed (non-blocking):', e instanceof Error ? e.message : e);
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
    console.error('[ct-sweep-cluster] fatal:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'failed' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
