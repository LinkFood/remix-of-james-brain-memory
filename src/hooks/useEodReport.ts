/**
 * useEodReport — TanStack Query hook over ct_eod_reports.
 *
 * Reads the daily EOD-report rows produced by the ct-eod-report cron at
 * 5 PM ET (close +30m). One row per session_date (UNIQUE). Read-only —
 * UI mode per the three-mode rule (tenet 26): the page is a window into
 * state, never a trigger.
 *
 * Distinct from the older ct_eod_summaries (rendered by /eod). This is
 * the close-to-open handoff report: graded morning brief, regime close,
 * carryover thesis, overnight catalysts, tomorrow setup.
 *
 * Date range filter mirrors /morning-brief: Today / 7d / 30d / All.
 *  - 'today'  → session_date = today (NY-tz)
 *  - '7d'     → session_date ≥ today-7
 *  - '30d'    → session_date ≥ today-30
 *  - 'all'    → no lower bound (capped server-side at 60)
 *
 * Refetches every 5 min so the 5 PM ET cron landing surfaces without a
 * page reload. Sorted DESC so today (or latest) is index 0.
 */

import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type EodReportDateRange = 'today' | '7d' | '30d' | 'all';

export interface ScorecardEntry {
  ticker: string;
  morning_call: string;
  morning_thesis: string;
  actual_outcome: string;
  verdict: 'win' | 'partial' | 'neutral' | 'loss';
  alpha_pct: number;
  commentary: string;
}

export interface TickerCloseCard {
  ticker: string;
  open_tilt: string;
  close_tilt: string;
  alignment: 'aligned' | 'partial' | 'missed';
  session_pct: number;
  flow_close: string;
  specialist_close_read: string;
  carryover_thesis: string;
  confidence_close: number;
}

export interface OvernightCatalyst {
  when: string;
  event: string;
  tickers: string[];
}

export interface TomorrowWatchEntry {
  ticker: string;
  reason: string;
  priority: 'high' | 'medium';
}

export interface SkipTomorrowEntry {
  ticker: string;
  reason: string;
}

export interface BreakingEventToday {
  headline: string;
  severity: number;
  source: string;
}

export interface ScorecardSummary {
  wins: number;
  partials: number;
  neutrals: number;
  losses: number;
  score_pct: number | null;
}

export interface EodReportRow {
  id: string;
  session_date: string;
  generated_at: string;
  generated_by_model: string | null;
  session_summary: string | null;
  regime_close: string | null;
  regime_shift_today: string | null;
  per_ticker_close: TickerCloseCard[];
  morning_brief_scorecard: ScorecardEntry[];
  scorecard_summary: ScorecardSummary;
  carryover_themes: string[];
  overnight_catalysts: OvernightCatalyst[];
  breaking_events_today: BreakingEventToday[];
  tomorrow_watchlist: TomorrowWatchEntry[];
  skip_tomorrow: SkipTomorrowEntry[];
  lessons_today: string[];
  script: string | null;
  cost_usd: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  triggered_by: string | null;
}

/** NY-tz YYYY-MM-DD for "today" — aligns with the trader's calendar day. */
function nyTodayDateStr(): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .formatToParts(new Date())
    .reduce<Record<string, string>>((acc, p) => {
      if (p.type !== 'literal') acc[p.type] = p.value;
      return acc;
    }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Subtract N days from NY-today; return YYYY-MM-DD. */
function nyDateNDaysAgo(n: number): string {
  const today = nyTodayDateStr();
  const [y, m, d] = today.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - n);
  return dt.toISOString().slice(0, 10);
}

const COLS = [
  'id',
  'session_date',
  'generated_at',
  'generated_by_model',
  'session_summary',
  'regime_close',
  'regime_shift_today',
  'per_ticker_close',
  'morning_brief_scorecard',
  'scorecard_summary',
  'carryover_themes',
  'overnight_catalysts',
  'breaking_events_today',
  'tomorrow_watchlist',
  'skip_tomorrow',
  'lessons_today',
  'script',
  'cost_usd',
  'tokens_in',
  'tokens_out',
  'triggered_by',
].join(', ');

export function useEodReport(range: EodReportDateRange = 'today') {
  return useQuery<EodReportRow[]>({
    queryKey: ['ct_eod_reports', range],
    refetchInterval: 5 * 60_000, // 5 min — picks up the 5 PM ET cron landing
    queryFn: async () => {
      // ct_eod_reports isn't in the generated supabase types yet; cast through
      // any to bypass the Database['public']['Tables'] constraint. Same pattern
      // used in TopNav.tsx and other places that touch new ct_* tables.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let query = (supabase.from('ct_eod_reports' as never) as any)
        .select(COLS)
        .order('session_date', { ascending: false })
        .limit(60);

      if (range === 'today') {
        query = query.eq('session_date', nyTodayDateStr());
      } else if (range === '7d') {
        query = query.gte('session_date', nyDateNDaysAgo(7));
      } else if (range === '30d') {
        query = query.gte('session_date', nyDateNDaysAgo(30));
      }

      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []) as EodReportRow[];
    },
  });
}
