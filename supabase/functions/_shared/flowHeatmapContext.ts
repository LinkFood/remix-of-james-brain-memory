import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';

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
 * Pulls top 3 expiry-week stacks per watchlist ticker by abs(value) using the
 * `aggressive_directional_decay` math mode and a 168h lookback. Compact enough
 * to drop into any Claude context payload as positioning regime input.
 *
 * Always returns a FlowHeatmapContext, never null. If the RPC fails, returns
 * an empty per_ticker array (defensive — never blocks the caller).
 */
export async function getFlowHeatmapContext(
  supabase: SupabaseClient,
  watchlist: string[],
): Promise<FlowHeatmapContext> {
  const lookback = 168;
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
      stacks: stacks.sort((a, b) => Math.abs(b.value) - Math.abs(a.value)).slice(0, 3),
    }));
    return { ...empty, per_ticker };
  } catch {
    return empty;
  }
}
