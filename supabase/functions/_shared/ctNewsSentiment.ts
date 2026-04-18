/**
 * Per-ticker news sentiment net score over a rolling window (default 24h).
 *
 * Sourced from ct_news_analyses.sentiment + sentiment_magnitude (added in
 * 20260420000014_news_sentiment.sql). Consumed by the watcher as evidence
 * axis E (catalyst): a net score of -3 or worse flips the bearish bias unless
 * structural evidence contradicts. See CT_SYSTEM_PROMPT_V1.
 *
 * Kept separate from ctStateCondense.ts because that file's contract is
 * strictly about condensing UW tape state — news sentiment is a separate
 * data source and its own concern.
 */
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';

export interface NewsSentimentNet {
  /** ticker */
  instrument: string;
  /** count of positive rows in window */
  positive: number;
  /** count of negative rows in window */
  negative: number;
  /** count of neutral rows in window */
  neutral: number;
  /** Σ signed magnitudes — positive adds +mag, negative adds -mag. <=-3 is a bearish tilt. */
  net_score: number;
  /** total rows with sentiment set in window */
  scored: number;
}

/**
 * Pull per-ticker sentiment net score over the last `windowHours`.
 * Defensive: query errors return an empty map (watcher must not crash on
 * news signal loss).
 */
export async function getNewsSentimentNet(
  supabase: SupabaseClient,
  tickers: string[],
  windowHours = 24,
): Promise<Record<string, NewsSentimentNet>> {
  if (tickers.length === 0) return {};
  const cutoff = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('ct_news_analyses')
    .select('instrument, sentiment, sentiment_magnitude')
    .in('instrument', tickers)
    .gte('created_at', cutoff)
    .not('sentiment', 'is', null);
  if (error) {
    console.warn('[ctNewsSentiment] query failed:', error.message);
    return {};
  }
  const rollup: Record<string, NewsSentimentNet> = {};
  for (const t of tickers) {
    rollup[t] = { instrument: t, positive: 0, negative: 0, neutral: 0, net_score: 0, scored: 0 };
  }
  for (const r of (data ?? []) as Array<{ instrument: string; sentiment: string; sentiment_magnitude: number | null }>) {
    const bucket = rollup[r.instrument];
    if (!bucket) continue;
    bucket.scored++;
    const mag = r.sentiment_magnitude ?? 0;
    if (r.sentiment === 'positive') { bucket.positive++; bucket.net_score += mag; }
    else if (r.sentiment === 'negative') { bucket.negative++; bucket.net_score -= mag; }
    else if (r.sentiment === 'neutral') { bucket.neutral++; }
  }
  return rollup;
}
