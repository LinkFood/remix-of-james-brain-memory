/**
 * useCostDashboard — consolidated API-cost telemetry for Co-Trader.
 *
 * One hook, one read-only query batch. Powers /cost.
 *
 * Sources
 * -------
 *   ct_claude_usage        — canonical per-call Claude cost (source + model +
 *                            tokens + cost_usd). 30-day window.
 *   ct_chat_tokens         — legacy dual-write path for chat only. Surfaced so
 *                            we can sanity-check that ct-chat rows in
 *                            ct_claude_usage match the legacy table and spot
 *                            drift between the two.
 *   ct_uw_usage            — Unusual Whales rate-limit counter. Flat monthly
 *                            pricing, so there's no $-cost column — what
 *                            matters is "approaching daily budget". 30d.
 *   ct_uw_usage_latest     — today's count / limit / pct (view, dedup per day).
 *   ct_trades              — count of closed trades for cost-per-trade stat.
 *   ct_grades              — count of graded alerts for cost-per-alert stat.
 *   ct_config (RPC)        — cost.monthly_alert_threshold (default $50).
 *
 * Shape returned
 * --------------
 *   See CostDashboardData below. Everything is pre-computed in the hook so
 *   the page is a pure render.
 *
 * Forecast
 * --------
 *   Linear: current-month spend × (days_in_month / days_elapsed_so_far).
 *   Only valid once we're ≥1 day into the month. Documented in FORECAST_NOTE.
 *
 * Error handling
 * --------------
 *   Each fetcher isolated in a try/catch shim so one failed query doesn't
 *   nuke the rest. First-day / thin-history is the empty array, not a crash.
 */

import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How many days of history to pull. 30 is enough for month-to-date + last-month forecast trend. */
const WINDOW_DAYS = 30;

/** UW Advanced tier daily limit (used when flagging upgrade suggestion). */
export const UW_ADVANCED_DAILY = 80_000;

/** UW upgrade price ($/mo from trial → advanced). */
export const UW_ADVANCED_PRICE_USD = 300;

/** Default monthly alert threshold in $ if ct_config key missing. */
export const DEFAULT_MONTHLY_ALERT_USD = 50;

export const FORECAST_NOTE =
  'Linear forecast: month-to-date spend × (days_in_month / days_elapsed). Assumes today\'s burn rate holds.';

/**
 * Canonical ct-* Claude-instrumented function list. Sourced from the
 * claudeUsageLog.ts helper callers (supabase/functions/**) as of 2026-04-17.
 * If a function appears in ct_claude_usage that ISN'T here, it'll still
 * render in the table — this list just seeds the "expected" set so we can
 * compute the "untracked" row.
 */
export const KNOWN_INSTRUMENTED_SOURCES = [
  'ct-alert-post-mortem',
  'ct-book-eod-close',
  'ct-book-manager',
  'ct-chat',
  'ct-curiosity',
  'ct-debate-outcome-scorer',
  'ct-eod-recap',
  'ct-eod-summary',
  'ct-hypothesis-health-check',
  'ct-hypothesis-proposer',
  'ct-lessons-curator',
  'ct-mcp-verify',
  'ct-midday-recap',
  'ct-morning-brief',
  'ct-news-ingester',
  'ct-news-sentiment-backfill',
  'ct-news-sweep',
  'ct-playbook-curator',
  'ct-premarket-scan',
  'ct-reflect-to-jac',
  'ct-replay',
  'ct-self-grader',
  'ct-tape-reader',
  'ct-trade-advisories',
  'ct-watcher',
  'ct-weekly-reflection',
] as const;

/**
 * ct-* functions that CALL Claude but haven't been migrated to
 * logClaudeUsage() yet. Shown as an "untracked" row in the table with an
 * estimated-count placeholder. When a function is added to logClaudeUsage
 * it naturally disappears from this list (move it up top).
 */
export const KNOWN_UNTRACKED_SOURCES = [
  'ct-bias-booth',
  'ct-claude-trade-open',
  'ct-claude-trade-reopen',
  'ct-pre-bell-gauntlet',
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Raw per-call row from ct_claude_usage. We aggregate client-side. */
interface ClaudeUsageRaw {
  session_date: string;
  source: string;
  model: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
}

export interface BySourceRow {
  /** Composite key: "source · model" so Sonnet vs Haiku rows are distinct. */
  key: string;
  source: string;
  model: string;
  calls_today: number;
  tokens_in_today: number;
  tokens_out_today: number;
  cost_today: number;
  calls_month: number;
  cost_month: number;
}

export interface TimelineRow {
  date: string;                        // YYYY-MM-DD
  total: number;                       // total $ this day (sum of bySource)
  bySource: Record<string, number>;    // key: source name → $ that day
  uw_calls: number;                    // daily_count for that day (max observed)
}

export interface Totals {
  claude_today: number;
  claude_week: number;
  claude_month: number;
  /** Linear monthly forecast. Null on day 1 of month (divisor undefined). */
  forecast_month: number | null;
  /** Total for full previous month. Used as trend-arrow reference. */
  last_month_total: number;
}

export interface UwStats {
  today_count: number;
  today_limit: number;
  today_pct: number;
  /** 30-day rolling average of daily_count (end-of-day max per day). */
  rolling_avg_30d: number;
  /** True if rolling avg > 50% of today's limit AND limit < UW_ADVANCED_DAILY. */
  suggest_upgrade: boolean;
  /** Daily rows (session_date + daily_count) sorted ascending. */
  daily: Array<{ date: string; count: number; limit: number | null }>;
}

export interface LegacyChatTotals {
  /** Total cost recorded in ct_chat_tokens over the 30-day window. */
  total_30d: number;
  /** Total recorded in ct_claude_usage WHERE source='ct-chat' over the window. */
  claude_usage_ct_chat_30d: number;
  /** Divergence = |legacy - ct_claude_usage|, flagged if > $0.01. */
  drift_usd: number;
}

export interface CostDashboardData {
  totals: Totals;
  /** Sorted by cost_month DESC. Includes distinct rows per model. */
  bySource: BySourceRow[];
  /** Last 30 days, ascending, keyed by source for stacked bars. */
  timeline: TimelineRow[];
  /** Ordered list of source names present in timeline (for chart <Bar> loop). */
  timelineSources: string[];
  /** UW budget tracking. */
  uw: UwStats;
  /** Legacy chat tokens sanity check. */
  legacyChat: LegacyChatTotals;
  /** Closed trades this month — denominator for cost-per-trade. */
  closedTradesThisMonth: number;
  /** Graded alerts this month — denominator for cost-per-graded-alert. */
  gradedAlertsThisMonth: number;
  /** $ per closed trade (this month). Null if zero trades. */
  costPerClosedTrade: number | null;
  /** $ per graded alert (this month). Null if zero grades. */
  costPerGradedAlert: number | null;
  /** ct_config cost.monthly_alert_threshold (USD). */
  monthlyAlertThresholdUsd: number;
  /** True when forecast exceeds threshold — render red banner. */
  forecastExceedsThreshold: boolean;
  /** Untracked functions: KNOWN_UNTRACKED_SOURCES minus any that now appear in ct_claude_usage. */
  untrackedSources: string[];
}

// ---------------------------------------------------------------------------
// Date helpers — all dates are strings in YYYY-MM-DD, interpreted in the
// user's local tz to match how session_date is set server-side (ET) and how
// the user thinks about "today". We don't convert to UTC — that would shift
// the boundary and double-count evening calls.
// ---------------------------------------------------------------------------

function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function firstOfCurrentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

function firstOfPreviousMonth(): string {
  const d = new Date();
  const prev = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  return `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}-01`;
}

function lastOfPreviousMonth(): string {
  // Last day of previous month = day 0 of current month.
  const d = new Date();
  const last = new Date(d.getFullYear(), d.getMonth(), 0);
  return `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, '0')}-${String(last.getDate()).padStart(2, '0')}`;
}

function daysInCurrentMonth(): number {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}

function daysElapsedInCurrentMonth(): number {
  return new Date().getDate(); // 1..31
}

function startOfIsoWeekLocal(): string {
  // Monday-start week, local tz, matches how most weekly aggregates are shown.
  const d = new Date();
  const day = d.getDay(); // 0=Sun..6=Sat
  const diff = day === 0 ? 6 : day - 1;
  d.setDate(d.getDate() - diff);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ---------------------------------------------------------------------------
// Fetchers — each one swallows errors and returns an empty shape so the
// page can degrade gracefully if (say) ct_grades has no rows yet or a view
// is missing on a dev branch.
// ---------------------------------------------------------------------------

async function fetchClaudeUsageRaw(sinceDate: string): Promise<ClaudeUsageRaw[]> {
  const { data, error } = await supabase
    .from('ct_claude_usage')
    .select('session_date, source, model, tokens_in, tokens_out, cost_usd')
    .gte('session_date', sinceDate)
    .order('session_date', { ascending: true });
  if (error) {
    console.warn('[useCostDashboard] ct_claude_usage failed:', error.message);
    return [];
  }
  return (data ?? []) as ClaudeUsageRaw[];
}

async function fetchLegacyChat(sinceDate: string): Promise<{ total: number }> {
  const { data, error } = await supabase
    .from('ct_chat_tokens')
    .select('cost_usd')
    .gte('session_date', sinceDate);
  if (error) {
    console.warn('[useCostDashboard] ct_chat_tokens failed:', error.message);
    return { total: 0 };
  }
  const total = (data ?? []).reduce((acc, r) => acc + num((r as { cost_usd: number | null }).cost_usd), 0);
  return { total };
}

async function fetchUwLatest(): Promise<{ count: number; limit: number; pct: number }> {
  const { data, error } = await supabase
    .from('ct_uw_usage_latest')
    .select('daily_count, daily_limit, pct')
    .order('session_date', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.warn('[useCostDashboard] ct_uw_usage_latest failed:', error.message);
    return { count: 0, limit: 0, pct: 0 };
  }
  const row = (data ?? null) as { daily_count: number | null; daily_limit: number | null; pct: number | null } | null;
  return {
    count: num(row?.daily_count),
    limit: num(row?.daily_limit),
    pct: num(row?.pct),
  };
}

async function fetchUwDaily(sinceDate: string): Promise<Array<{ date: string; count: number; limit: number | null }>> {
  // Raw table — "end of day" count is the max observed for a session_date.
  const { data, error } = await supabase
    .from('ct_uw_usage')
    .select('session_date, daily_count, daily_limit')
    .gte('session_date', sinceDate)
    .order('observed_at', { ascending: false });
  if (error) {
    console.warn('[useCostDashboard] ct_uw_usage failed:', error.message);
    return [];
  }
  const byDay = new Map<string, { date: string; count: number; limit: number | null }>();
  for (const r of (data ?? []) as Array<{ session_date: string; daily_count: number | null; daily_limit: number | null }>) {
    const count = num(r.daily_count);
    const prev = byDay.get(r.session_date);
    if (!prev || count > prev.count) {
      byDay.set(r.session_date, {
        date: r.session_date,
        count,
        limit: r.daily_limit ?? null,
      });
    }
  }
  return Array.from(byDay.values()).sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchClosedTradesThisMonth(firstOfMonth: string): Promise<number> {
  const { count, error } = await supabase
    .from('ct_trades')
    .select('id', { count: 'estimated', head: true })
    .eq('status', 'closed')
    .gte('session_date', firstOfMonth);
  if (error) {
    console.warn('[useCostDashboard] ct_trades closed count failed:', error.message);
    return 0;
  }
  return count ?? 0;
}

async function fetchGradedAlertsThisMonth(firstOfMonth: string): Promise<number> {
  // ct_grades has no session_date column — we filter on graded_at.
  const startIso = `${firstOfMonth}T00:00:00Z`;
  const { count, error } = await supabase
    .from('ct_grades')
    .select('id', { count: 'estimated', head: true })
    .eq('subject_type', 'alert')
    .gte('graded_at', startIso);
  if (error) {
    console.warn('[useCostDashboard] ct_grades alert count failed:', error.message);
    return 0;
  }
  return count ?? 0;
}

async function fetchMonthlyAlertThreshold(): Promise<number> {
  // ct_config uses jsonb — ct_config_get returns jsonb. Accept number or
  // stringified number for resilience.
  const { data, error } = await supabase.rpc('ct_config_get', {
    p_key: 'cost.monthly_alert_threshold',
  });
  if (error) {
    console.warn('[useCostDashboard] ct_config_get(cost.monthly_alert_threshold) failed:', error.message);
    return DEFAULT_MONTHLY_ALERT_USD;
  }
  if (data == null) return DEFAULT_MONTHLY_ALERT_USD;
  const n = typeof data === 'number' ? data : Number(data);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MONTHLY_ALERT_USD;
}

// ---------------------------------------------------------------------------
// Aggregation — pure functions so they're testable in isolation.
// ---------------------------------------------------------------------------

function computeTotals(rows: ClaudeUsageRaw[]): Totals {
  const today = todayLocal();
  const weekStart = startOfIsoWeekLocal();
  const monthStart = firstOfCurrentMonth();
  const prevMonthStart = firstOfPreviousMonth();
  const prevMonthEnd = lastOfPreviousMonth();

  let claude_today = 0;
  let claude_week = 0;
  let claude_month = 0;
  let last_month_total = 0;

  for (const r of rows) {
    const cost = num(r.cost_usd);
    if (r.session_date === today) claude_today += cost;
    if (r.session_date >= weekStart) claude_week += cost;
    if (r.session_date >= monthStart) claude_month += cost;
    if (r.session_date >= prevMonthStart && r.session_date <= prevMonthEnd) {
      last_month_total += cost;
    }
  }

  const elapsed = daysElapsedInCurrentMonth();
  const total = daysInCurrentMonth();
  const forecast_month =
    elapsed > 0 && claude_month > 0
      ? (claude_month * total) / elapsed
      : null;

  return {
    claude_today,
    claude_week,
    claude_month,
    forecast_month,
    last_month_total,
  };
}

/** Aggregate per-source+model rows for today + month-to-date. */
function computeBySource(rows: ClaudeUsageRaw[]): BySourceRow[] {
  const today = todayLocal();
  const monthStart = firstOfCurrentMonth();

  const byKey = new Map<string, BySourceRow>();
  for (const r of rows) {
    const model = r.model ?? 'unknown';
    const source = r.source ?? 'unknown';
    const key = `${source}::${model}`;
    let row = byKey.get(key);
    if (!row) {
      row = {
        key,
        source,
        model,
        calls_today: 0,
        tokens_in_today: 0,
        tokens_out_today: 0,
        cost_today: 0,
        calls_month: 0,
        cost_month: 0,
      };
      byKey.set(key, row);
    }
    const cost = num(r.cost_usd);
    const tin = num(r.tokens_in);
    const tout = num(r.tokens_out);
    if (r.session_date === today) {
      row.calls_today += 1;
      row.tokens_in_today += tin;
      row.tokens_out_today += tout;
      row.cost_today += cost;
    }
    if (r.session_date >= monthStart) {
      row.calls_month += 1;
      row.cost_month += cost;
    }
  }
  return Array.from(byKey.values()).sort((a, b) => b.cost_month - a.cost_month);
}

/**
 * Build 30-day timeline keyed by source (not source+model — the stacked
 * chart would be unreadable with 15+ stack bands). Uses the full 30-day
 * window so first-of-month users can still see last-month tail.
 */
function computeTimeline(
  rows: ClaudeUsageRaw[],
  uwDaily: Array<{ date: string; count: number }>,
): { timeline: TimelineRow[]; sources: string[] } {
  // Collect all sources that had any cost in the window.
  const sourceTotals = new Map<string, number>();
  for (const r of rows) {
    sourceTotals.set(r.source, (sourceTotals.get(r.source) ?? 0) + num(r.cost_usd));
  }
  // Sort sources by total cost desc — biggest spenders on bottom of stack.
  const sources = Array.from(sourceTotals.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([s]) => s);

  // Build a dense date axis (every day from -29 to today) so the chart
  // doesn't have gaps when a day had zero Claude traffic.
  const byDate = new Map<string, TimelineRow>();
  for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
    const date = daysAgo(i);
    byDate.set(date, {
      date,
      total: 0,
      bySource: Object.fromEntries(sources.map((s) => [s, 0])),
      uw_calls: 0,
    });
  }

  for (const r of rows) {
    const row = byDate.get(r.session_date);
    if (!row) continue; // out-of-window row (shouldn't happen with server filter, defensive)
    const cost = num(r.cost_usd);
    row.total += cost;
    row.bySource[r.source] = (row.bySource[r.source] ?? 0) + cost;
  }

  for (const u of uwDaily) {
    const row = byDate.get(u.date);
    if (row) row.uw_calls = u.count;
  }

  return {
    timeline: Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date)),
    sources,
  };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useCostDashboard() {
  return useQuery<CostDashboardData>({
    queryKey: ['cost-dashboard'],
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    queryFn: async () => {
      const sinceDate = daysAgo(WINDOW_DAYS - 1);
      const firstMonth = firstOfCurrentMonth();

      const [
        claudeRows,
        legacyChat,
        uwLatest,
        uwDaily,
        closedTrades,
        gradedAlerts,
        thresholdUsd,
      ] = await Promise.all([
        fetchClaudeUsageRaw(sinceDate),
        fetchLegacyChat(sinceDate),
        fetchUwLatest(),
        fetchUwDaily(sinceDate),
        fetchClosedTradesThisMonth(firstMonth),
        fetchGradedAlertsThisMonth(firstMonth),
        fetchMonthlyAlertThreshold(),
      ]);

      const totals = computeTotals(claudeRows);
      const bySource = computeBySource(claudeRows);
      const { timeline, sources: timelineSources } = computeTimeline(claudeRows, uwDaily);

      // Legacy drift check — sum ct-chat rows from ct_claude_usage and
      // compare to ct_chat_tokens total over the same window.
      const claudeUsageCtChat = claudeRows
        .filter((r) => r.source === 'ct-chat')
        .reduce((acc, r) => acc + num(r.cost_usd), 0);
      const legacyChatStats: LegacyChatTotals = {
        total_30d: legacyChat.total,
        claude_usage_ct_chat_30d: claudeUsageCtChat,
        drift_usd: Math.abs(legacyChat.total - claudeUsageCtChat),
      };

      // UW rolling avg over the 30-day window.
      const rolling_avg_30d =
        uwDaily.length > 0
          ? uwDaily.reduce((acc, d) => acc + d.count, 0) / uwDaily.length
          : 0;
      // Suggest upgrade when we're consistently burning half the daily limit
      // AND haven't already upgraded to Advanced (limit < 80k).
      const suggest_upgrade =
        uwLatest.limit > 0 &&
        uwLatest.limit < UW_ADVANCED_DAILY &&
        rolling_avg_30d > uwLatest.limit * 0.5;

      const uw: UwStats = {
        today_count: uwLatest.count,
        today_limit: uwLatest.limit,
        today_pct: uwLatest.pct,
        rolling_avg_30d,
        suggest_upgrade,
        daily: uwDaily,
      };

      const costPerClosedTrade =
        closedTrades > 0 ? totals.claude_month / closedTrades : null;
      const costPerGradedAlert =
        gradedAlerts > 0 ? totals.claude_month / gradedAlerts : null;

      const forecastExceedsThreshold =
        totals.forecast_month != null && totals.forecast_month > thresholdUsd;

      // "Untracked" = known-untracked minus any that have since started
      // logging. Defensive: if an untracked function's name shows up in
      // ct_claude_usage (someone migrated it and forgot to update this
      // list), drop it.
      const observedSources = new Set(claudeRows.map((r) => r.source));
      const untrackedSources = KNOWN_UNTRACKED_SOURCES.filter(
        (s) => !observedSources.has(s),
      );

      return {
        totals,
        bySource,
        timeline,
        timelineSources,
        uw,
        legacyChat: legacyChatStats,
        closedTradesThisMonth: closedTrades,
        gradedAlertsThisMonth: gradedAlerts,
        costPerClosedTrade,
        costPerGradedAlert,
        monthlyAlertThresholdUsd: thresholdUsd,
        forecastExceedsThreshold,
        untrackedSources,
      };
    },
  });
}
