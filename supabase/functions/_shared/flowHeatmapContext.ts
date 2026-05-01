import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import type {
  ContextHelper,
  HelperDescription,
  HelperFetchContext,
  HelperOpts,
  HelperResult,
} from './contextHelper.ts';

export interface FlowHeatmapStack {
  expiry_bucket_week: string;  // YYYY-MM-DD
  value: number;
  source_alert_count: number;
}

export interface FlowHeatmapContext {
  per_ticker: Array<{ ticker: string; stacks: FlowHeatmapStack[] }>;
  generated_at: string;
  lookback_hours: number;
  math_mode: 'aggressive_directional_decay';
}

/**
 * ContextHelper-contract result alias. The underlying shape is identical to
 * `FlowHeatmapContext`; this name aligns with the brain orchestrator's
 * `HelperResult<TResult>` naming.
 */
export type FlowHeatmapResult = FlowHeatmapContext;

const HELPER_NAME = 'flow_heatmap';
const HELPER_VERSION = 'v1';
const DEFAULT_CAP = 3;
const DEFAULT_LOOKBACK_HOURS = 168;

/**
 * Pulls top N expiry-week stacks per watchlist ticker by abs(value) using the
 * `aggressive_directional_decay` math mode and a 168h lookback. Compact enough
 * to drop into any Claude context payload as positioning regime input.
 *
 * Always returns a FlowHeatmapContext, never null. If the RPC fails, returns
 * an empty per_ticker array (defensive — never blocks the caller).
 *
 * `cap` (default 3) bounds stacks-per-ticker.
 */
export async function getFlowHeatmapContext(
  supabase: SupabaseClient,
  watchlist: string[],
  cap: number = DEFAULT_CAP,
): Promise<FlowHeatmapContext> {
  const lookback = DEFAULT_LOOKBACK_HOURS;
  const empty: FlowHeatmapContext = {
    per_ticker: [],
    generated_at: new Date().toISOString(),
    lookback_hours: lookback,
    math_mode: 'aggressive_directional_decay',
  };
  try {
    const { data, error } = await supabase.rpc('ct_flow_heatmap_live', {
      p_tickers: watchlist,
      p_math_mode: 'aggressive_directional_decay',
      p_min_premium: 100000,
      p_include_0dte: false,
      p_max_expiry_days: 180,
      p_lookback_hours: lookback,
    });
    if (error || !Array.isArray(data)) return empty;
    const byTicker = new Map<string, FlowHeatmapStack[]>();
    for (const row of data as Array<{ ticker: string; expiry_bucket_week: string; value: number; source_alert_count: number }>) {
      if (!byTicker.has(row.ticker)) byTicker.set(row.ticker, []);
      byTicker.get(row.ticker)!.push({
        expiry_bucket_week: row.expiry_bucket_week,
        value: Number(row.value),
        source_alert_count: row.source_alert_count,
      });
    }
    const per_ticker = Array.from(byTicker.entries()).map(([ticker, stacks]) => ({
      ticker,
      stacks: stacks.sort((a, b) => Math.abs(b.value) - Math.abs(a.value)).slice(0, cap),
    }));
    return { ...empty, per_ticker };
  } catch {
    return empty;
  }
}

/**
 * Internal: total `source_alert_count` across all returned stacks. Used as
 * the `rowCount` telemetry signal — more meaningful than per_ticker length
 * which is bounded by watchlist size.
 */
function countStacks(result: FlowHeatmapResult): number {
  let n = 0;
  for (const t of result.per_ticker) n += t.stacks.length;
  return n;
}

/**
 * Default export: ContextHelper<FlowHeatmapResult> — the orchestrator-side
 * surface. Wraps `getFlowHeatmapContext`. Existing named-export consumers
 * (ct-daily-brief, ct-eod-summary, ct-eod-report, ct-watcher, ct-self-grader,
 * ct-trade-idea-generator, specialistRunner) keep working unchanged.
 */
const flowHeatmapHelper: ContextHelper<FlowHeatmapResult> = {
  name: HELPER_NAME,
  version: HELPER_VERSION,
  defaultCap: DEFAULT_CAP,
  isExpensive: false,
  minRefreshSeconds: 60,
  dependencies: [],
  audienceFilter: undefined,
  cacheTtlSeconds: 60,

  async fetch(
    ctx: HelperFetchContext,
    opts: HelperOpts,
  ): Promise<HelperResult<FlowHeatmapResult>> {
    const startedAt = Date.now();
    const cap = Math.max(1, opts.cap ?? DEFAULT_CAP);

    // Single-ticker focus collapses the watchlist for the underlying RPC,
    // matching the same defensive contract the named function provides.
    const tickers = opts.tickerFocus
      ? [opts.tickerFocus]
      : Array.from(ctx.watchlist ?? []);

    const data = await getFlowHeatmapContext(ctx.supabase, tickers, cap);
    const rowCount = countStacks(data);

    return {
      data,
      meta: {
        helperName: HELPER_NAME,
        helperVersion: HELPER_VERSION,
        fetchedAt: data.generated_at,
        rowCount,
        cacheHit: false,
        latencyMs: Date.now() - startedAt,
        // We can't know with certainty whether the RPC truncated upstream;
        // we only know that we asked for `cap` stacks per ticker.
        truncated: data.per_ticker.some((t) => t.stacks.length >= cap),
        warning: rowCount === 0 ? 'empty_result' : undefined,
      },
    };
  },

  describe(): HelperDescription {
    return {
      name: HELPER_NAME,
      version: HELPER_VERSION,
      defaultCap: DEFAULT_CAP,
      expensive: false,
      minRefreshSeconds: 60,
      dependencies: [],
      audienceFilter: undefined,
      outputShape:
        'Top-N expiry-week stacks per watchlist ticker, sorted by |value| ' +
        'descending, using aggressive_directional_decay math over a 168h lookback. ' +
        'Defensive: empty per_ticker array on RPC failure.',
      exampleResult: {
        per_ticker: [
          {
            ticker: 'NVDA',
            stacks: [
              { expiry_bucket_week: '2026-05-02', value: 1234567.89, source_alert_count: 18 },
            ],
          },
        ],
        generated_at: '2026-04-30T18:00:00.000Z',
        lookback_hours: 168,
        math_mode: 'aggressive_directional_decay',
      } satisfies FlowHeatmapResult,
    };
  },
};

export default flowHeatmapHelper;
