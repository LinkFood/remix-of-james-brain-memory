/**
 * eventRecencyTypes — public TypeScript surface shared between
 * `eventRecencyContext.ts`, `eventRecencyNormalize.ts`, and
 * `eventCoherenceValidator.ts`.
 *
 * Re-exported from `eventRecencyContext.ts` for consumer ergonomics; importers
 * should prefer the re-export from the helper module.
 *
 * Pure module — no DB, no side effects.
 */

export type EventCategory =
  | 'earnings'
  | 'fda'
  | 'econ'
  | 'central_bank'
  | 'news'
  | 'other';

export interface RecencyEvent {
  /** Stable id from the source row (uuid). */
  id: string;
  /** Source table — useful when the orchestrator wants to cite or dedupe. */
  source: 'ct_events' | 'ct_earnings_moves' | 'ct_breaking_news' | 'ct_central_bank_rates';
  category: EventCategory;
  /** Single ticker if scoped, else null for market-wide. */
  ticker: string | null;
  /** Tickers affected (for breaking_news multi-ticker rows). */
  tickers_affected: string[];
  /** YYYY-MM-DD calendar day in NY tz. */
  event_date: string;
  /** Full ISO timestamp when known (event_time, published_at, captured_at). */
  event_iso: string | null;
  /** Short human title — never null in output (filled with synthesized fallback). */
  title: string;
  /**
   * Outcome blob — only populated for just_happened where data is available.
   * Earnings: {actual_eps, surprise_pct, beat_miss, move_pct, move_direction}
   * Central bank: {rate, direction_trend, country_code}
   * News: {severity, sentiment, category, summary}
   * Generic: pass-through of source row's `raw` if useful.
   */
  outcome: Record<string, unknown> | null;
  /** Severity 1-5 for news; importance for econ; null otherwise. */
  importance: number | null;
  /** True when this row has materially completed (just_happened only). */
  has_outcome: boolean;
}

export interface EventRecencyResult {
  session_date: string;
  per_ticker: Array<{
    ticker: string;
    just_happened: RecencyEvent[];
    happening_today: RecencyEvent[];
    upcoming: RecencyEvent[];
  }>;
  market_wide: {
    just_happened: RecencyEvent[];
    happening_today: RecencyEvent[];
    upcoming: RecencyEvent[];
  };
  generated_at: string;
}
