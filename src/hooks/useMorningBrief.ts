/**
 * useMorningBrief — TanStack Query hook over ct_daily_briefs.
 *
 * Reads the daily brief rows produced by the ct-daily-brief cron at
 * 7 AM ET plus any breaking_news / regime_shift / manual rebriefs.
 * Read-only — UI mode per the three-mode rule (tenet 26).
 *
 * Multiple rows per session_date possible (v1 + rebrief v2/v3/...). This hook
 * returns ONE CANONICAL ROW per session_date (the max brief_version) with the
 * older rows attached as `superseded_versions[]` so the page can show a
 * single card per day with an "earlier reads" disclosure.
 *
 * Date range filter mirrors /flags: Today / 7d / 30d / All.
 *  - 'today'  → session_date = today (NY-tz)
 *  - '7d'     → session_date ≥ today-7
 *  - '30d'    → session_date ≥ today-30
 *  - 'all'    → no lower bound (last 365 still capped server-side)
 *
 * Refetches every 5 min so the 7 AM ET cron landing surfaces without a
 * page reload. Canonical rows sorted by session_date DESC so today is index 0.
 */

import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type BriefDateRange = 'today' | '7d' | '30d' | 'all';

export interface BreakingEvent {
  time: string;
  source: string;
  headline: string;
  severity: number; // 1 (low) → 5 (high)
}

export interface RecentPrint {
  at: string;
  name: string;
  value: string;
}

export interface PerTickerView {
  ticker: string;
  regime: string;
  tilt: 'long_lean' | 'short_lean' | 'neutral' | 'avoid' | string;
  focus: number; // 1-5
  alignment: string;
  catalysts: string[];
  rationale: string;
  tape_view: string;
  narrative_view: string;
  confidence_multiplier: number;
  avoid_today?: boolean;
}

export interface HighConvictionIdea {
  instrument: string;
  direction: 'long' | 'short' | string;
  entry_zone: string;
  stop: string;
  target: string;
  size_pct: number;
  rationale: string;
}

export interface DailyBriefRow {
  id: string;
  session_date: string;
  brief_version: number;
  triggered_by: string | null;
  urgency: string | null;
  macro_narrative: string | null;
  macro_regime: string | null;
  breaking_events: BreakingEvent[] | null;
  overnight_action: string | null;
  recent_prints: RecentPrint[] | null;
  per_ticker: PerTickerView[] | null;
  convergent_view: string | null;
  high_conviction_ideas: HighConvictionIdea[] | null;
  watchlist_focus: string[] | null;
  skip_today: string[] | null;
  generated_by_model: string | null;
  ttl_hours: number | null;
  expires_at: string | null;
  created_at: string | null;
  /** Older versions superseded by this canonical row, sorted by
   *  brief_version DESC. Empty on rows with no prior versions. */
  superseded_versions?: DailyBriefRow[];
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

export function useMorningBrief(range: BriefDateRange = 'today') {
  return useQuery<DailyBriefRow[]>({
    queryKey: ['ct_daily_briefs', range],
    refetchInterval: 5 * 60_000, // 5 min — picks up the 7 AM ET cron landing
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let query = (supabase.from('ct_daily_briefs' as never) as any)
        .select(
          'id, session_date, brief_version, triggered_by, urgency, macro_narrative, macro_regime, breaking_events, overnight_action, recent_prints, per_ticker, convergent_view, high_conviction_ideas, watchlist_focus, skip_today, generated_by_model, ttl_hours, expires_at, created_at',
        )
        .order('session_date', { ascending: false })
        .limit(range === 'all' ? 365 : 60);

      if (range === 'today') {
        query = query.eq('session_date', nyTodayDateStr());
      } else if (range === '7d') {
        query = query.gte('session_date', nyDateNDaysAgo(7));
      } else if (range === '30d') {
        query = query.gte('session_date', nyDateNDaysAgo(30));
      }

      const { data, error } = await query;
      if (error) throw error;

      // Group raw rows by session_date → canonical = max brief_version per
      // group, older rows attached as superseded_versions. Mirrors the
      // ct_insert_daily_brief_locked chain semantics (always one canonical row
      // per day, even when concurrent fires race past the DB UNIQUE guard).
      const rows = (data ?? []) as DailyBriefRow[];
      const groups = new Map<string, DailyBriefRow[]>();
      for (const r of rows) {
        const bucket = groups.get(r.session_date) ?? [];
        bucket.push(r);
        groups.set(r.session_date, bucket);
      }
      const canonical: DailyBriefRow[] = [];
      for (const [, bucket] of groups) {
        bucket.sort((a, b) => (b.brief_version ?? 0) - (a.brief_version ?? 0));
        const [head, ...rest] = bucket;
        canonical.push({ ...head, superseded_versions: rest });
      }
      canonical.sort((a, b) => b.session_date.localeCompare(a.session_date));
      return canonical;
    },
  });
}
