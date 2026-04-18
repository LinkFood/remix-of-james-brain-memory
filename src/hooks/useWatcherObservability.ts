/**
 * useWatcherObservability — observability for watcher v1.2.
 *
 * Read-only visibility into the two v1.2 behaviors that are currently invisible:
 *
 *   1. Evidence-diversity gate — every ALERT must cite 3+ axes, and >=2 of
 *      those must differ from the most-recent prior ALERT on the same
 *      instruments within the last 60min. We compute a "diversity score" per
 *      alert (0.0 = full echo-chamber, 1.0 = fully novel) by comparing axes
 *      against the prior alert on the same instrument set.
 *
 *   2. Cooldown demotion — the watcher demotes echo-chamber alerts to
 *      FLAG/OBSERVATION and writes a status_line to ct_heartbeats. We scan
 *      heartbeats for the literal demotion signature and count per day.
 *
 * Nothing is mutated. No new tables. No RPCs added (see Optional in the task —
 * a server-side ct_diversity_stats RPC is deferred to v2 once alert volume
 * makes client-side window comparison painful).
 *
 * Refresh: 5min. Window: last 14 days. Sample cap: 500 alerts per day.
 *
 * Backward compat:
 *   Rows written before v1.2 have empty evidence_axes — we treat those as
 *   "unknown diversity" (null score) so they don't pollute the stats.
 */

import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AlertRow {
  id: string;
  instruments: string[];
  evidence_axes: string[] | null;
  prompt_version: string | null;
  direction: string;
  created_at: string;
}

/** Per-alert diversity record with the prior-alert context we used. */
export interface AlertDiversity {
  id: string;
  created_at: string;
  instruments: string[];
  axes: string[];
  direction: string;
  /** 0..1, or null if we couldn't compute (no axes on this or on prior). */
  diversity: number | null;
  /** The prior alert (on same instruments, within 60min) we compared against. */
  prior_id: string | null;
  prior_axes: string[] | null;
  prior_created_at: string | null;
}

export interface DiversityDailyRow {
  date: string;         // YYYY-MM-DD
  alerts: number;
  scored: number;       // alerts with non-null diversity
  median: number | null;
  pct_good: number;     // % of scored alerts with diversity > 0.5
  pct_echo: number;     // % of scored alerts with diversity < 0.3
}

export interface DemotionDailyRow {
  date: string;
  demotions: number;
  alerts: number;
  /** demotions / (demotions + alerts) — the "would have fired" rate. */
  rate: number;
}

export interface WatcherObservabilityData {
  /** Every scored alert in the window, newest first. */
  alerts: AlertDiversity[];
  daily: DiversityDailyRow[];
  demotions: DemotionDailyRow[];
  /** Total demotions & alerts across the whole window. */
  totals: { demotions: number; alerts: number; rate: number };
  /** 10 most-recent alerts with diversity < 0.3 in the last 7 days. */
  echoCandidates: AlertDiversity[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WINDOW_DAYS = 14;
const ECHO_WINDOW_DAYS = 7;
const ECHO_LIMIT = 10;
/** Hard cap on alerts fetched per page (Supabase default is 1000). */
const MAX_ALERTS = WINDOW_DAYS * 500;
const PRIOR_LOOKBACK_MINUTES = 60;

/** Literal signature the watcher writes when the cooldown demotes an alert. */
const DEMOTION_REGEX = /ALERT demoted to (FLAG|OBSERVATION).*cooldown/i;

// ---------------------------------------------------------------------------
// Diversity math
// ---------------------------------------------------------------------------

/**
 * overlap = |prev_axes ∩ curr_axes| / min(3, |curr_axes|)
 * diversity = 1 - overlap, clamped to [0, 1]
 *
 * Normalizing to min(3, |curr_axes|) matches the v1.2 gate, which requires
 * 3+ axes cited. If a current alert cites only 2 axes, we normalize to 2 so
 * the score still lands in [0, 1].
 */
function computeDiversity(currAxes: string[], prevAxes: string[]): number {
  if (currAxes.length === 0) return 0;
  const prev = new Set(prevAxes);
  let overlap = 0;
  for (const a of currAxes) if (prev.has(a)) overlap += 1;
  const denom = Math.min(3, currAxes.length);
  if (denom === 0) return 0;
  const score = 1 - overlap / denom;
  return Math.max(0, Math.min(1, score));
}

/** Same-instrument-set key. Order-insensitive. */
function instrumentKey(instruments: string[]): string {
  return [...instruments].sort().join('|');
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// ---------------------------------------------------------------------------
// Fetchers
// ---------------------------------------------------------------------------

async function fetchAlertsWindow(sinceIso: string): Promise<AlertRow[]> {
  const { data, error } = await supabase
    .from('ct_alerts')
    .select('id, instruments, evidence_axes, prompt_version, direction, created_at')
    .gte('created_at', sinceIso)
    .in('prompt_version', ['v1.1', 'v1.2'])
    .order('created_at', { ascending: true })
    .limit(MAX_ALERTS);
  if (error) {
    console.warn('[useWatcherObservability] ct_alerts failed:', error.message);
    return [];
  }
  return (data ?? []) as AlertRow[];
}

async function fetchHeartbeatDemotions(sinceIso: string): Promise<Array<{ created_at: string }>> {
  // Pull only rows whose status_line contains "demoted" — ilike is still a
  // scan but narrows us to a tiny fraction of heartbeats (most are quiet pings).
  const { data, error } = await supabase
    .from('ct_heartbeats')
    .select('created_at, status_line')
    .gte('created_at', sinceIso)
    .ilike('status_line', '%demoted%')
    .order('created_at', { ascending: true })
    .limit(5000);
  if (error) {
    console.warn('[useWatcherObservability] ct_heartbeats failed:', error.message);
    return [];
  }
  // Re-match in JS with the full regex so FLAG|OBSERVATION + cooldown are both enforced.
  return ((data ?? []) as Array<{ created_at: string; status_line: string }>)
    .filter((r) => DEMOTION_REGEX.test(r.status_line))
    .map(({ created_at }) => ({ created_at }));
}

// ---------------------------------------------------------------------------
// Window comparison
// ---------------------------------------------------------------------------

/**
 * Walk alerts in chronological order. For each alert, look back at the last
 * alert on the same instrument-set within PRIOR_LOOKBACK_MINUTES minutes. If
 * both have evidence_axes, compute diversity. Otherwise null.
 */
function scoreAlerts(rows: AlertRow[]): AlertDiversity[] {
  /** key → last alert we saw for this instrument-set */
  const lastByInstruments = new Map<string, AlertRow>();
  const out: AlertDiversity[] = [];

  for (const curr of rows) {
    const key = instrumentKey(curr.instruments ?? []);
    const prev = lastByInstruments.get(key);
    const currAxes = curr.evidence_axes ?? [];

    let diversity: number | null = null;
    let prior_id: string | null = null;
    let prior_axes: string[] | null = null;
    let prior_created_at: string | null = null;

    if (prev) {
      const ageMs = Date.parse(curr.created_at) - Date.parse(prev.created_at);
      if (ageMs <= PRIOR_LOOKBACK_MINUTES * 60_000) {
        const prevAxes = prev.evidence_axes ?? [];
        if (currAxes.length > 0 && prevAxes.length > 0) {
          diversity = computeDiversity(currAxes, prevAxes);
        }
        prior_id = prev.id;
        prior_axes = prevAxes;
        prior_created_at = prev.created_at;
      }
    }

    out.push({
      id: curr.id,
      created_at: curr.created_at,
      instruments: curr.instruments ?? [],
      axes: currAxes,
      direction: curr.direction,
      diversity,
      prior_id,
      prior_axes,
      prior_created_at,
    });

    // Always update last-seen so the next alert compares against THIS one,
    // even if THIS one had no axes (v1.0 legacy rows still serve as a prior).
    lastByInstruments.set(key, curr);
  }

  return out;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

function bucketByDate<T extends { created_at: string }>(rows: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const d = r.created_at.slice(0, 10);
    if (!out.has(d)) out.set(d, []);
    out.get(d)!.push(r);
  }
  return out;
}

function buildDiversityDaily(scored: AlertDiversity[]): DiversityDailyRow[] {
  const byDay = bucketByDate(scored);
  const out: DiversityDailyRow[] = [];
  for (const [date, rows] of byDay) {
    const withScores = rows.filter((r) => r.diversity != null).map((r) => r.diversity!);
    const good = withScores.filter((s) => s > 0.5).length;
    const echo = withScores.filter((s) => s < 0.3).length;
    out.push({
      date,
      alerts: rows.length,
      scored: withScores.length,
      median: median(withScores),
      pct_good: withScores.length === 0 ? 0 : (good / withScores.length) * 100,
      pct_echo: withScores.length === 0 ? 0 : (echo / withScores.length) * 100,
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

function buildDemotionDaily(
  demotions: Array<{ created_at: string }>,
  alerts: AlertDiversity[],
  windowDays: number,
): DemotionDailyRow[] {
  const demByDay = bucketByDate(demotions);
  const alertByDay = bucketByDate(alerts);

  // Build contiguous per-day series so the line chart doesn't have gaps.
  const dates: string[] = [];
  const today = new Date();
  for (let i = windowDays - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }

  return dates.map((date) => {
    const d = demByDay.get(date)?.length ?? 0;
    const a = alertByDay.get(date)?.length ?? 0;
    const rate = d + a === 0 ? 0 : (d / (d + a)) * 100;
    return { date, demotions: d, alerts: a, rate };
  });
}

function buildEchoCandidates(scored: AlertDiversity[]): AlertDiversity[] {
  const cutoff = Date.now() - ECHO_WINDOW_DAYS * 86_400_000;
  return scored
    .filter((r) => r.diversity != null && r.diversity < 0.3 && Date.parse(r.created_at) >= cutoff)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .slice(0, ECHO_LIMIT);
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useWatcherObservability() {
  return useQuery<WatcherObservabilityData>({
    queryKey: ['watcher-observability', WINDOW_DAYS],
    refetchInterval: 5 * 60_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();
      const [alertRows, demotions] = await Promise.all([
        fetchAlertsWindow(since),
        fetchHeartbeatDemotions(since),
      ]);

      const scored = scoreAlerts(alertRows);
      const daily = buildDiversityDaily(scored);
      const demotionDaily = buildDemotionDaily(demotions, scored, WINDOW_DAYS);
      const totalAlerts = scored.length;
      const totalDemotions = demotions.length;
      const totalRate =
        totalDemotions + totalAlerts === 0
          ? 0
          : (totalDemotions / (totalDemotions + totalAlerts)) * 100;

      return {
        alerts: scored.slice().reverse(), // newest-first for UI convenience
        daily,
        demotions: demotionDaily,
        totals: { demotions: totalDemotions, alerts: totalAlerts, rate: totalRate },
        echoCandidates: buildEchoCandidates(scored),
      };
    },
  });
}
