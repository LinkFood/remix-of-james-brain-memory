/**
 * useEventRecency — frontend mirror of the `eventRecencyContext` brain organ.
 *
 * Three buckets per ticker / market-wide:
 *   - just_happened    — last 72h with outcome data (the hallucination shield)
 *   - happening_today  — events whose date == sessionDate (NY tz)
 *   - upcoming         — next 14 calendar days
 *
 * Sources (all read-only):
 *   - ct_events              — earnings / FDA / econ calendar
 *   - ct_earnings_moves      — historical day-after move cache
 *   - ct_breaking_news       — Tavily / UW news watcher (severity)
 *   - ct_central_bank_rates  — daily snapshot of central-bank state
 *
 * Mirrors `getEventRecencyContext` shape. Hook does the bucket assembly
 * client-side from a single multi-source fetch — keeps RPC surface small,
 * lets the UI re-bucket on session-date roll without re-querying.
 *
 * Phase 5 of the Synthesis Layer (see `docs/SYNTHESIS_LAYER_ARCHITECTURE.md`
 * § 5a). queryKey starts with `'event-recency-'` (NOT `ct_*`). Refetch every
 * 5min — events are slow-moving by nature.
 *
 * Defensive on every error path. retry:false. Returns empty buckets if any
 * single source fails (best-effort union, never blocks the UI on one source).
 */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type EventCategory =
  | 'earnings' | 'fda' | 'econ' | 'central_bank' | 'breaking_news' | 'other';

export interface RecencyEventRow {
  id: string;
  source: 'ct_events' | 'ct_earnings_moves' | 'ct_breaking_news' | 'ct_central_bank_rates';
  category: EventCategory;
  ticker: string | null;
  /** Title / headline. */
  label: string;
  /** ISO date YYYY-MM-DD or full ISO timestamp. */
  event_at: string;
  /** Event outcome blob (sparse). */
  outcome: Record<string, unknown> | null;
  /** Severity for breaking news; null otherwise. */
  severity: number | null;
}

export interface EventRecencyBuckets {
  just_happened: RecencyEventRow[];
  happening_today: RecencyEventRow[];
  upcoming: RecencyEventRow[];
}

export interface UseEventRecencyArgs {
  /** Single ticker focus. Pass null to fetch market-wide. */
  ticker?: string | null;
  /** Watchlist override when `ticker` is null. */
  watchlist?: string[];
  /** Per-bucket cap. Default 5 per ticker, 10 market-wide. */
  perBucketCap?: number;
}

const DEFAULT_WATCHLIST = [
  'NVDA', 'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'TSLA', 'QQQ', 'SPY', 'IWM',
];
const DEFAULT_PER_BUCKET = 5;
const MARKET_WIDE_CAP = 10;
const LOOKBACK_DAYS = 3;
const UPCOMING_DAYS = 14;

/** Today's date in America/New_York, formatted YYYY-MM-DD. */
function nyToday(): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(new Date());
}

function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

interface CtEventRow {
  id: string;
  ticker: string | null;
  category: string | null;
  title: string | null;
  event_date: string | null;
  event_time: string | null;
  outcome: Record<string, unknown> | null;
}

interface CtEarningsMoveRow {
  id: string;
  ticker: string;
  earnings_date: string;
  next_day_move_pct: number | null;
  beat_miss: string | null;
}

interface CtBreakingNewsRow {
  id: string;
  headline: string;
  severity: number | null;
  category: string | null;
  tickers_affected: string[] | null;
  published_at: string | null;
  ingested_at: string;
  macro_wide: boolean | null;
}

interface CtCentralBankRow {
  id: string;
  country: string | null;
  decision_date: string;
  rate: number | null;
  action: string | null;
}

function normalizeCategory(raw: string | null, fallback: EventCategory = 'other'): EventCategory {
  if (raw === 'earnings' || raw === 'fda' || raw === 'econ' ||
      raw === 'central_bank' || raw === 'breaking_news') return raw;
  return fallback;
}

function bucketOf(eventDateIso: string, sessionDate: string): keyof EventRecencyBuckets | null {
  const d = eventDateIso.slice(0, 10);
  if (d === sessionDate) return 'happening_today';
  // just_happened: within LOOKBACK_DAYS before sessionDate (exclusive of today)
  const back = addDays(sessionDate, -LOOKBACK_DAYS);
  if (d >= back && d < sessionDate) return 'just_happened';
  // upcoming: within UPCOMING_DAYS after sessionDate (exclusive of today)
  const fwd = addDays(sessionDate, UPCOMING_DAYS);
  if (d > sessionDate && d <= fwd) return 'upcoming';
  return null;
}

export function useEventRecency(args: UseEventRecencyArgs = {}) {
  const ticker = args.ticker ?? null;
  const watchlist = args.watchlist ?? DEFAULT_WATCHLIST;
  const perBucketCap = Math.max(1, args.perBucketCap ?? DEFAULT_PER_BUCKET);
  const sessionDate = nyToday();
  const lookbackDate = addDays(sessionDate, -LOOKBACK_DAYS);
  const upcomingDate = addDays(sessionDate, UPCOMING_DAYS);

  const targetTickers = ticker ? [ticker.toUpperCase()] : watchlist.map((t) => t.toUpperCase());

  const query = useQuery<RecencyEventRow[]>({
    queryKey: [
      'event-recency',
      { sessionDate, tickers: [...targetTickers].sort() },
    ],
    refetchInterval: 5 * 60_000,
    staleTime: 4 * 60_000,
    retry: false,
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sb: any = supabase;
      const out: RecencyEventRow[] = [];

      // 1. ct_events
      try {
        let q = sb.from('ct_events')
          .select('id, ticker, category, title, event_date, event_time, outcome')
          .gte('event_date', lookbackDate)
          .lte('event_date', upcomingDate)
          .order('event_date', { ascending: true })
          .limit(200);
        if (targetTickers.length > 0) q = q.in('ticker', targetTickers);
        const { data, error } = await q;
        if (!error && Array.isArray(data)) {
          for (const r of data as CtEventRow[]) {
            if (!r.event_date) continue;
            out.push({
              id: r.id,
              source: 'ct_events',
              category: normalizeCategory(r.category, 'other'),
              ticker: r.ticker,
              label: r.title ?? '(untitled event)',
              event_at: r.event_time ? `${r.event_date}T${r.event_time}` : r.event_date,
              outcome: r.outcome,
              severity: null,
            });
          }
        }
      } catch {
        // table may not exist; skip silently
      }

      // 2. ct_earnings_moves (historical outcome cache)
      try {
        let q = sb.from('ct_earnings_moves')
          .select('id, ticker, earnings_date, next_day_move_pct, beat_miss')
          .gte('earnings_date', lookbackDate)
          .lte('earnings_date', sessionDate)
          .order('earnings_date', { ascending: false })
          .limit(100);
        if (targetTickers.length > 0) q = q.in('ticker', targetTickers);
        const { data, error } = await q;
        if (!error && Array.isArray(data)) {
          for (const r of data as CtEarningsMoveRow[]) {
            out.push({
              id: r.id,
              source: 'ct_earnings_moves',
              category: 'earnings',
              ticker: r.ticker,
              label: `${r.ticker} earnings`,
              event_at: r.earnings_date,
              outcome: {
                next_day_move_pct: r.next_day_move_pct,
                beat_miss: r.beat_miss,
              },
              severity: null,
            });
          }
        }
      } catch {
        // skip
      }

      // 3. ct_breaking_news (severity ≥ 3 in lookback window)
      try {
        const sinceIso = new Date(Date.parse(lookbackDate + 'T00:00:00Z')).toISOString();
        let q = sb.from('ct_breaking_news')
          .select('id, headline, severity, category, tickers_affected, macro_wide, published_at, ingested_at')
          .gte('ingested_at', sinceIso)
          .gte('severity', 3)
          .order('severity', { ascending: false })
          .order('ingested_at', { ascending: false })
          .limit(60);
        if (ticker) q = q.contains('tickers_affected', [ticker.toUpperCase()]);
        const { data, error } = await q;
        if (!error && Array.isArray(data)) {
          for (const r of data as CtBreakingNewsRow[]) {
            const ts = r.published_at ?? r.ingested_at;
            const tickersInScope = Array.isArray(r.tickers_affected)
              ? r.tickers_affected.filter((t): t is string => typeof t === 'string' && t.length > 0)
              : [];
            // Emit one row per affected ticker (or a single market_wide row).
            if (tickersInScope.length === 0) {
              out.push({
                id: r.id,
                source: 'ct_breaking_news',
                category: 'breaking_news',
                ticker: null,
                label: r.headline,
                event_at: ts,
                outcome: null,
                severity: r.severity,
              });
            } else {
              for (const t of tickersInScope) {
                if (targetTickers.length > 0 && !targetTickers.includes(t.toUpperCase())) continue;
                out.push({
                  id: `${r.id}::${t}`,
                  source: 'ct_breaking_news',
                  category: 'breaking_news',
                  ticker: t,
                  label: r.headline,
                  event_at: ts,
                  outcome: null,
                  severity: r.severity,
                });
              }
            }
          }
        }
      } catch {
        // skip
      }

      // 4. ct_central_bank_rates (latest decisions)
      try {
        const { data, error } = await sb.from('ct_central_bank_rates')
          .select('id, country, decision_date, rate, action')
          .gte('decision_date', lookbackDate)
          .lte('decision_date', upcomingDate)
          .order('decision_date', { ascending: false })
          .limit(20);
        if (!error && Array.isArray(data)) {
          for (const r of data as CtCentralBankRow[]) {
            out.push({
              id: r.id,
              source: 'ct_central_bank_rates',
              category: 'central_bank',
              ticker: null,
              label: `${r.country ?? 'central bank'} rate ${r.action ?? 'decision'}`,
              event_at: r.decision_date,
              outcome: { rate: r.rate, action: r.action },
              severity: null,
            });
          }
        }
      } catch {
        // skip
      }

      return out;
    },
  });

  const events = query.data ?? [];

  /** Buckets keyed by ticker (or 'MARKET' for ticker=null events). */
  const buckets = useMemo(() => {
    const perTicker = new Map<string, EventRecencyBuckets>();
    const market: EventRecencyBuckets = { just_happened: [], happening_today: [], upcoming: [] };

    for (const ev of events) {
      const b = bucketOf(ev.event_at, sessionDate);
      if (!b) continue;
      if (!ev.ticker) {
        market[b].push(ev);
        continue;
      }
      const tk = ev.ticker.toUpperCase();
      if (!perTicker.has(tk)) {
        perTicker.set(tk, { just_happened: [], happening_today: [], upcoming: [] });
      }
      perTicker.get(tk)![b].push(ev);
    }

    // Cap per-bucket per-ticker; market-wide cap at MARKET_WIDE_CAP.
    for (const [, b] of perTicker) {
      b.just_happened = b.just_happened.slice(0, perBucketCap);
      b.happening_today = b.happening_today.slice(0, perBucketCap);
      b.upcoming = b.upcoming.slice(0, perBucketCap);
    }
    market.just_happened = market.just_happened.slice(0, MARKET_WIDE_CAP);
    market.happening_today = market.happening_today.slice(0, MARKET_WIDE_CAP);
    market.upcoming = market.upcoming.slice(0, MARKET_WIDE_CAP);

    return { perTicker, market };
  }, [events, sessionDate, perBucketCap]);

  return {
    sessionDate,
    events,
    perTicker: buckets.perTicker,
    market: buckets.market,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}
