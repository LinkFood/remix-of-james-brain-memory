/**
 * tickerQuantCard — thin TS wrapper over `public.build_ticker_quant_card`.
 *
 * The RPC returns a jsonb blob aggregating every data surface the generator
 * and daily brief need for one ticker (structure, flow, dark pool, greeks,
 * sentiment, events, news, brief tilt, freshness).
 *
 * Consumers:
 *   - ct-ticker-snapshot-builder: calls this per watchlist ticker and upserts
 *     into ct_ticker_snapshots.
 *   - ct-trade-idea-generator: reads the cached snapshot first, falls back to
 *     a live build if the snapshot is missing or stale (>5 min).
 *   - ct-daily-brief (future): reads 12 cards at brief composition time.
 *
 * Contract:
 *   - Never throws. On error, logs and returns null.
 *   - Returns the parsed jsonb as an opaque `TickerQuantCard` shape — callers
 *     treat it as a dictionary; field presence is best-effort (nulls are fine).
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';

export interface QuantCardStructure {
  spot: number | null;
  gamma_flip: number | null;
  call_wall: number | null;
  put_wall: number | null;
  max_pain: number | null;
  iv_rank: number | null;
  iv_percentile: number | null;
  net_gamma: number | null;
  regime: 'positive_gamma' | 'negative_gamma' | 'neutral';
  latest_gex_snapshot_at: string | null;
}

export interface QuantCardFlowHour {
  alert_count: number;
  total_premium: number;
  net_call_prem: number;
  net_put_prem: number;
  net_prem: number;
  whale_count: number;
  sweep_count: number;
  opening_trades: number;
}

export interface QuantCardDarkPoolHour {
  print_count: number;
  total_notional: number;
  largest_single: number;
  accumulation_score: number;
}

export interface QuantCardGreekFlowHour {
  net_delta_flow: number;
  net_vega_flow: number;
  net_call_delta: number;
  net_put_delta: number;
  tick_count: number;
}

export interface QuantCardSentiment {
  nope_latest: number | null;
  put_call_ratio: number | null;
  net_premium_cum: number;
}

export interface QuantCardEvents {
  next_earnings_date: string | null;
  earnings_expected_move: number | null;
  upcoming_catalysts: Array<{
    event_type: string;
    event_date: string;
    event_time?: string | null;
    title: string | null;
    importance: number | null;
  }>;
}

export interface QuantCardBrief {
  source_brief_id: string | null;
  tilt: string | null;
  avoid_today: boolean;
  focus_today: boolean;
  session_date: string | null;
}

export interface QuantCardFreshness {
  gex_snapshot_at: string | null;
  seconds_stale_gex: number | null;
  as_of: string;
}

export interface QuantCardNewsItem {
  headline: string;
  url: string | null;
  source: string | null;
  severity: number;
  sentiment: string | null;
  category: string | null;
  summary: string | null;
  published_at: string | null;
  ingested_at: string;
}

export interface TickerQuantCard {
  ticker: string;
  as_of: string;
  structure: QuantCardStructure;
  flow_last_hour: QuantCardFlowHour;
  dark_pool_last_hour: QuantCardDarkPoolHour;
  greek_flow_last_hour: QuantCardGreekFlowHour;
  sentiment: QuantCardSentiment;
  events: QuantCardEvents;
  news: QuantCardNewsItem[];
  brief: QuantCardBrief;
  freshness: QuantCardFreshness;
}

/**
 * Build a full quant card for a ticker. Returns null if the RPC errors.
 *
 * @param supabase - service-role client (RPC is SECURITY DEFINER so either works)
 * @param ticker   - will be uppercased/trimmed inside the RPC
 * @param asOf     - optional ISO timestamp; defaults to NOW() server-side
 */
export async function getTickerQuantCard(
  supabase: SupabaseClient,
  ticker: string,
  asOf?: string,
): Promise<TickerQuantCard | null> {
  try {
    const params: Record<string, unknown> = { p_ticker: ticker };
    if (asOf) params.p_as_of = asOf;
    const { data, error } = await supabase.rpc('build_ticker_quant_card', params);
    if (error) {
      console.warn(`[tickerQuantCard] RPC error for ${ticker}: ${error.message}`);
      return null;
    }
    if (!data || typeof data !== 'object') {
      console.warn(`[tickerQuantCard] RPC returned non-object for ${ticker}`);
      return null;
    }
    return data as TickerQuantCard;
  } catch (e) {
    console.warn(`[tickerQuantCard] threw for ${ticker}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/**
 * Read the cached snapshot from ct_ticker_snapshots. Returns null if missing
 * or older than maxStaleSeconds (default 5 min). Callers typically fall back
 * to getTickerQuantCard() when this returns null.
 */
export async function getCachedTickerSnapshot(
  supabase: SupabaseClient,
  ticker: string,
  maxStaleSeconds = 300,
): Promise<Record<string, unknown> | null> {
  try {
    const { data, error } = await supabase
      .from('ct_ticker_snapshots')
      .select('*')
      .eq('ticker', ticker.toUpperCase().trim())
      .maybeSingle();
    if (error) {
      console.warn(`[tickerQuantCard] snapshot read error for ${ticker}: ${error.message}`);
      return null;
    }
    if (!data) return null;
    const snapAt = data.snapshot_at ? new Date(data.snapshot_at as string).getTime() : 0;
    if (!snapAt) return null;
    const ageSec = (Date.now() - snapAt) / 1000;
    if (ageSec > maxStaleSeconds) return null;
    return data as Record<string, unknown>;
  } catch (e) {
    console.warn(`[tickerQuantCard] snapshot read threw for ${ticker}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
