/**
 * usePreflightChecks — Monday-morning readiness suite for Co-Trader.
 *
 * Runs eight independent checks in parallel. Each returns its own
 * green/yellow/red status plus a short explanation and an expandable
 * details payload. One check failing never blocks the others.
 *
 * Read-only: no writes, no fixes, no auto-repair. Pure visibility.
 *
 * Refresh: 60s. Exposes refetch() for manual re-run.
 *
 * Sources:
 *   - get_cron_status RPC       → ct-* cron liveness
 *   - ct_reports                → latest morning_brief
 *   - ct_book                   → today's session_date row
 *   - ct_uw_usage_latest view   → today's UW %
 *   - ct_heartbeats             → latest pipeline heartbeat
 *   - ct_biases                 → active bias count
 *   - ct_news_analyses          → weekend news captured
 *   - ct_config                 → bounds check on every row
 */

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CheckStatus = 'green' | 'yellow' | 'red';

export interface PreflightCheck {
  key: CheckKey;
  name: string;
  status: CheckStatus;
  /** One-line human summary, e.g. "14 ct-* crons healthy". */
  explanation: string;
  /** ISO timestamp of when this check last ran. */
  lastCheckedAt: string;
  /** Expandable detail rows — name + status + note. */
  details: PreflightDetail[];
  /** Non-fatal error from this check (shown in the detail panel). */
  error?: string;
}

export interface PreflightDetail {
  label: string;
  status: CheckStatus;
  note?: string;
}

export type CheckKey =
  | 'crons'
  | 'cron_failures_6h'
  | 'morning_brief'
  | 'book'
  | 'uw_usage'
  | 'heartbeat'
  | 'biases'
  | 'weekend_news'
  | 'config'
  | 'kill_switch';

export interface PreflightSummary {
  overall: CheckStatus;
  green: number;
  yellow: number;
  red: number;
  /** Short headline, e.g. "READY (8 green)". */
  headline: string;
  /** Subline, e.g. "fix before open" when red > 0. */
  subline: string;
}

export interface PreflightResult {
  checks: PreflightCheck[];
  summary: PreflightSummary;
  loading: boolean;
  refetch: () => Promise<void>;
  lastRun: string | null;
}

// ---------------------------------------------------------------------------
// Time / market helpers
// ---------------------------------------------------------------------------

/** Loosely "is this a US equities trading day?" — Mon-Fri in ET. */
function isWeekday(d: Date = new Date()): boolean {
  // Convert to ET. In Node/browser we can cheat with toLocaleString.
  const et = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay(); // 0=Sun, 6=Sat
  return day >= 1 && day <= 5;
}

/** True if current ET clock is within regular or extended US equities hours
 *  where we'd expect the watcher/heartbeat pipeline to be ticking
 *  (roughly 04:00–20:00 ET on weekdays). Off-hours loosen thresholds. */
function isMarketActive(d: Date = new Date()): boolean {
  if (!isWeekday(d)) return false;
  const et = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins >= 4 * 60 && mins <= 20 * 60;
}

/** "YYYY-MM-DD" in the user's local tz. ct_book rows key on this. */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Minutes between then→now (positive = then is in the past). */
function minutesAgo(iso: string | null | undefined): number {
  if (!iso) return Infinity;
  return (Date.now() - new Date(iso).getTime()) / 60_000;
}

/** Parse a cron schedule and estimate expected cadence in minutes.
 *  Handles the pg_cron forms we actually use: every-N-minute style,
 *  `N * * * *` hourly, `N M * * *` daily, and plain daily/weekly. Falls
 *  back to 60m when unrecognized so we don't red-flag custom schedules
 *  spuriously. */
function expectedCadenceMinutes(schedule: string): number {
  const s = (schedule ?? '').trim();
  if (!s) return 60;

  const parts = s.split(/\s+/);
  if (parts.length !== 5) return 60;
  const [minute, hour, dom, month, dow] = parts;

  // `*/N * * * *` → every N minutes
  const everyNMinMatch = minute.match(/^\*\/(\d+)$/);
  if (everyNMinMatch && hour === '*') {
    return Math.max(1, parseInt(everyNMinMatch[1], 10));
  }

  // `N */H * * *` → every H hours at minute N (e.g. `0 */4 * * *` = 240m).
  // Must come before the `N * * * *` branch because `hour === '*'` is
  // false here but the previous code's default of 60m was wrong.
  const everyNHourMatch = hour.match(/^\*\/(\d+)$/);
  if (/^\d+$/.test(minute) && everyNHourMatch) {
    return Math.max(60, parseInt(everyNHourMatch[1], 10) * 60);
  }

  // `N * * * *` → once an hour
  if (/^\d+$/.test(minute) && hour === '*') return 60;

  // Specific hour(s) — daily-ish cadence.
  if (
    /^\d+$/.test(minute) &&
    /^[\d,]+$/.test(hour) &&
    dom === '*' &&
    month === '*' &&
    (dow === '*' || /^[\d,-]+$/.test(dow))
  ) {
    // Multiple hours in a day — treat as ~(24/count) hour cadence.
    const hours = hour.split(',').filter(Boolean).length || 1;
    return Math.max(60, Math.floor((24 * 60) / hours));
  }

  // Weekly-ish schedule (specific dow).
  if (/^\d+$/.test(dow)) return 7 * 24 * 60;

  return 60;
}

/** Staleness threshold for a given cadence. 1.25× cadence floored at 60m —
 *  sub-hour crons still get a ≥1h tail; multi-hour crons scale up
 *  proportionally (4h cron alerts at 5h, not 85m). */
function stalenessThresholdMinutes(cadenceMin: number): number {
  return Math.max(60, Math.ceil(cadenceMin * 1.25));
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

interface CronRow {
  jobname: string;
  schedule: string;
  active: boolean;
  last_run_status: string | null;
  last_run_at: string | null;
}

async function runCronCheck(now: Date): Promise<PreflightCheck> {
  const startedIso = new Date().toISOString();
  try {
    const { data, error } = await supabase.rpc('get_cron_status');
    if (error) throw error;

    const rows = (data as CronRow[] | null) ?? [];
    const ctRows = rows.filter((r) =>
      (r.jobname ?? '').toLowerCase().startsWith('ct-') ||
      (r.jobname ?? '').toLowerCase().startsWith('ct_'),
    );

    if (ctRows.length === 0) {
      return {
        key: 'crons',
        name: 'Crons healthy',
        status: 'red',
        explanation: 'No ct-* crons found',
        lastCheckedAt: startedIso,
        details: [],
      };
    }

    const marketActive = isMarketActive(now);
    const details: PreflightDetail[] = [];
    let broken = 0;
    let stale = 0;

    for (const r of ctRows) {
      const cadence = expectedCadenceMinutes(r.schedule);
      const threshold = stalenessThresholdMinutes(cadence);
      const ageMin = minutesAgo(r.last_run_at);

      // Off-hours carve-out: short-cadence crons legitimately don't run overnight.
      // Only treat "stale" as failing when the market is active OR the cron is
      // a daily/weekly one that should fire regardless of market hours.
      const isIntraday = cadence <= 60;
      const staleApplies = marketActive || !isIntraday;

      const statusOk = (r.last_run_status ?? '') === 'succeeded';
      const isStale = staleApplies && ageMin > threshold;
      const isBroken = !statusOk || isStale;

      let itemStatus: CheckStatus = 'green';
      let note = '';
      if (!r.active) {
        itemStatus = 'yellow';
        note = 'disabled';
      } else if (!statusOk) {
        itemStatus = 'red';
        note = `last status: ${r.last_run_status ?? 'never ran'}`;
        broken += 1;
      } else if (isStale) {
        itemStatus = 'red';
        note = `stale: ${Math.round(ageMin)}m ago (cadence ~${cadence}m)`;
        stale += 1;
      } else {
        note = `${Math.round(ageMin)}m ago`;
      }

      if (isBroken || itemStatus !== 'green') {
        details.push({ label: r.jobname, status: itemStatus, note });
      }
    }

    const healthy = ctRows.length - broken - stale;
    let status: CheckStatus = 'green';
    let explanation = `${healthy}/${ctRows.length} ct-* crons healthy`;
    if (broken > 0 || stale > 0) {
      status = 'red';
      explanation = `${broken + stale} of ${ctRows.length} ct-* crons broken/stale`;
    }

    return {
      key: 'crons',
      name: 'Crons healthy',
      status,
      explanation,
      lastCheckedAt: startedIso,
      details,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      key: 'crons',
      name: 'Crons healthy',
      status: 'red',
      explanation: 'Failed to query cron status',
      lastCheckedAt: startedIso,
      details: [],
      error: message,
    };
  }
}

/**
 * runCronFailuresCheck — red if any ct_cron_failures rows with resolved_at
 * IS NULL exist inside the last 6h window. This is the proactive companion
 * to runCronCheck: that one asks "are the crons alive right now?"; this
 * one asks "did any cron fall over since I last looked?"
 *
 * The 6h window matches the pre-bell cadence — James is looking back at
 * overnight/premarket activity, and rows older than that are either
 * resolved, stale-noise, or already reflected in the live cron check.
 */
async function runCronFailuresCheck(): Promise<PreflightCheck> {
  const startedIso = new Date().toISOString();
  try {
    const since = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .from('ct_cron_failures' as any)
      .select('id, cron_name, status, detected_at, last_run_at, resolved_at')
      .is('resolved_at', null)
      .gte('detected_at', since)
      .order('detected_at', { ascending: false })
      .limit(25);

    if (error) throw error;

    const rows = (data ?? []) as unknown as Array<{
      id: string;
      cron_name: string;
      status: 'failed' | 'stale' | 'never_ran';
      detected_at: string;
      last_run_at: string | null;
      resolved_at: string | null;
    }>;

    // Dedupe by (cron_name, status) so a repeated 10m-cron detection doesn't
    // balloon the count. Same logic the /health section uses.
    const seen = new Set<string>();
    const deduped: typeof rows = [];
    for (const r of rows) {
      const k = `${r.cron_name}:${r.status}`;
      if (seen.has(k)) continue;
      seen.add(k);
      deduped.push(r);
    }

    if (deduped.length === 0) {
      return {
        key: 'cron_failures_6h',
        name: 'No failed ct-* crons last 6h',
        status: 'green',
        explanation: 'No unresolved cron failures in the last 6 hours',
        lastCheckedAt: startedIso,
        details: [],
      };
    }

    return {
      key: 'cron_failures_6h',
      name: 'No failed ct-* crons last 6h',
      status: 'red',
      explanation: `${deduped.length} unresolved cron failure${deduped.length > 1 ? 's' : ''} in last 6h`,
      lastCheckedAt: startedIso,
      details: deduped.slice(0, 10).map((r) => ({
        label: r.cron_name,
        status: 'red' as const,
        note: `${r.status} · detected ${new Date(r.detected_at).toLocaleTimeString()}`,
      })),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      key: 'cron_failures_6h',
      name: 'No failed ct-* crons last 6h',
      status: 'red',
      explanation: 'Failed to query ct_cron_failures',
      lastCheckedAt: startedIso,
      details: [],
      error: message,
    };
  }
}

async function runMorningBriefCheck(now: Date): Promise<PreflightCheck> {
  const startedIso = new Date().toISOString();
  try {
    const { data, error } = await supabase
      .from('ct_reports')
      .select('id, report_type, created_at, summary')
      .eq('report_type', 'morning_brief')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;

    const weekday = isWeekday(now);
    if (!data) {
      return {
        key: 'morning_brief',
        name: 'Morning brief fresh',
        status: 'red',
        explanation: 'No morning brief on file',
        lastCheckedAt: startedIso,
        details: [],
      };
    }

    const ageH = minutesAgo(data.created_at) / 60;
    // On weekdays we want brief < 6h old (fired at ~6am ET).
    // Off-days, an older brief is fine — just show green if present.
    let status: CheckStatus;
    let explanation: string;
    if (!weekday) {
      status = 'green';
      explanation = `Last brief ${ageH.toFixed(1)}h ago (weekend, no fresh brief expected)`;
    } else if (ageH <= 6) {
      status = 'green';
      explanation = `Brief ${ageH.toFixed(1)}h old`;
    } else if (ageH <= 12) {
      status = 'yellow';
      explanation = `Brief ${ageH.toFixed(1)}h old (expected < 6h on weekdays)`;
    } else {
      status = 'red';
      explanation = `Brief stale: ${ageH.toFixed(1)}h old`;
    }

    return {
      key: 'morning_brief',
      name: 'Morning brief fresh',
      status,
      explanation,
      lastCheckedAt: startedIso,
      details: [
        { label: 'Created at', status, note: new Date(data.created_at).toLocaleString() },
        { label: 'Report ID', status: 'green', note: String(data.id) },
      ],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      key: 'morning_brief',
      name: 'Morning brief fresh',
      status: 'red',
      explanation: 'Failed to query ct_reports',
      lastCheckedAt: startedIso,
      details: [],
      error: message,
    };
  }
}

async function runBookCheck(): Promise<PreflightCheck> {
  const startedIso = new Date().toISOString();
  try {
    const today = todayIso();
    const { data, error } = await supabase
      .from('ct_book')
      .select('session_date, starting_balance, ending_balance, realized_pnl, unrealized_pnl')
      .eq('session_date', today)
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      return {
        key: 'book',
        name: 'Book seeded',
        status: 'red',
        explanation: `No ct_book row for ${today}`,
        lastCheckedAt: startedIso,
        details: [],
      };
    }

    if (data.starting_balance == null) {
      return {
        key: 'book',
        name: 'Book seeded',
        status: 'red',
        explanation: `ct_book row exists but starting_balance is null`,
        lastCheckedAt: startedIso,
        details: [
          { label: 'session_date', status: 'green', note: String(data.session_date) },
          { label: 'starting_balance', status: 'red', note: 'null' },
        ],
      };
    }

    return {
      key: 'book',
      name: 'Book seeded',
      status: 'green',
      explanation: `Book seeded with $${Number(data.starting_balance).toLocaleString()}`,
      lastCheckedAt: startedIso,
      details: [
        { label: 'session_date', status: 'green', note: String(data.session_date) },
        { label: 'starting_balance', status: 'green', note: `$${Number(data.starting_balance).toLocaleString()}` },
      ],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      key: 'book',
      name: 'Book seeded',
      status: 'red',
      explanation: 'Failed to query ct_book',
      lastCheckedAt: startedIso,
      details: [],
      error: message,
    };
  }
}

async function runUwUsageCheck(): Promise<PreflightCheck> {
  const startedIso = new Date().toISOString();
  try {
    const { data, error } = await supabase
      .from('ct_uw_usage_latest')
      .select('session_date, observed_at, daily_count, daily_limit, pct')
      .order('session_date', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      return {
        key: 'uw_usage',
        name: 'UW usage reset',
        status: 'yellow',
        explanation: 'No UW usage row yet today',
        lastCheckedAt: startedIso,
        details: [],
      };
    }

    const pct = Number(data.pct ?? 0);
    const today = todayIso();
    const isToday = data.session_date === today;

    let status: CheckStatus;
    let explanation: string;
    if (!isToday) {
      status = 'yellow';
      explanation = `Latest UW row is for ${data.session_date}, not today`;
    } else if (pct < 10) {
      status = 'green';
      explanation = `UW usage ${pct}% — full budget available`;
    } else if (pct < 50) {
      status = 'yellow';
      explanation = `UW usage ${pct}% — weekend ate some of today's budget`;
    } else {
      status = 'red';
      explanation = `UW usage ${pct}% before open — budget largely spent`;
    }

    return {
      key: 'uw_usage',
      name: 'UW usage reset',
      status,
      explanation,
      lastCheckedAt: startedIso,
      details: [
        { label: 'session_date', status: isToday ? 'green' : 'yellow', note: String(data.session_date) },
        { label: 'daily_count / daily_limit', status, note: `${data.daily_count} / ${data.daily_limit}` },
        { label: 'pct', status, note: `${pct}%` },
      ],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      key: 'uw_usage',
      name: 'UW usage reset',
      status: 'red',
      explanation: 'Failed to query ct_uw_usage_latest',
      lastCheckedAt: startedIso,
      details: [],
      error: message,
    };
  }
}

async function runHeartbeatCheck(now: Date): Promise<PreflightCheck> {
  const startedIso = new Date().toISOString();
  try {
    const { data, error } = await supabase
      .from('ct_heartbeats')
      .select('id, created_at, status_line')
      .neq('prompt_version', 'mcp-verify')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      return {
        key: 'heartbeat',
        name: 'Pipeline alive',
        status: 'red',
        explanation: 'No ct_heartbeats rows at all',
        lastCheckedAt: startedIso,
        details: [],
      };
    }

    const ageMin = minutesAgo(data.created_at);
    const marketActive = isMarketActive(now);
    // Inside market hours → expect <45min. Off-hours → cron is paused; anything
    // younger than ~18h is "the pipeline was alive at last close" = green.
    const threshold = marketActive ? 45 : 18 * 60;
    const warn = marketActive ? 30 : 12 * 60;

    let status: CheckStatus;
    let explanation: string;
    if (ageMin > threshold) {
      status = 'red';
      explanation = marketActive
        ? `Last heartbeat ${Math.round(ageMin)}m ago (threshold 45m during market hours)`
        : `Last heartbeat ${Math.round(ageMin / 60)}h ago (off-hours, but still too old)`;
    } else if (ageMin > warn) {
      status = 'yellow';
      explanation = `Heartbeat ${Math.round(ageMin)}m ago`;
    } else {
      status = 'green';
      explanation = marketActive
        ? `Heartbeat ${Math.round(ageMin)}m ago`
        : `Last heartbeat ${Math.round(ageMin)}m ago (market closed — expected)`;
    }

    return {
      key: 'heartbeat',
      name: 'Pipeline alive',
      status,
      explanation,
      lastCheckedAt: startedIso,
      details: [
        { label: 'created_at', status, note: new Date(data.created_at).toLocaleString() },
        { label: 'status_line', status: 'green', note: data.status_line ?? '(empty)' },
        { label: 'market_active', status: 'green', note: String(marketActive) },
      ],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      key: 'heartbeat',
      name: 'Pipeline alive',
      status: 'red',
      explanation: 'Failed to query ct_heartbeats',
      lastCheckedAt: startedIso,
      details: [],
      error: message,
    };
  }
}

async function runBiasesCheck(): Promise<PreflightCheck> {
  const startedIso = new Date().toISOString();
  try {
    const { data, error } = await supabase
      // ct_biases not in generated types yet — same cast used elsewhere.
      .from('ct_biases' as never)
      .select('id, pattern, severity, active')
      .eq('active', true)
      .order('severity', { ascending: false });

    if (error) throw error;

    const rows = (data ?? []) as unknown as Array<{ id: string; pattern: string; severity: number }>;
    const count = rows.length;

    let status: CheckStatus;
    let explanation: string;
    if (count === 0) {
      status = 'yellow';
      explanation = '0 active biases — Claude never wrong?';
    } else if (count > 10) {
      status = 'yellow';
      explanation = `${count} active biases — chaotic, consider retiring stale ones`;
    } else if (count >= 2 && count <= 6) {
      status = 'green';
      explanation = `${count} active biases surfaced`;
    } else {
      status = 'yellow';
      explanation = `${count} active biases (target 2–6)`;
    }

    return {
      key: 'biases',
      name: 'Biases surfaced',
      status,
      explanation,
      lastCheckedAt: startedIso,
      details: rows.slice(0, 12).map((r) => ({
        label: r.pattern,
        status: 'green',
        note: `severity ${r.severity}`,
      })),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      key: 'biases',
      name: 'Biases surfaced',
      status: 'red',
      explanation: 'Failed to query ct_biases',
      lastCheckedAt: startedIso,
      details: [],
      error: message,
    };
  }
}

async function runWeekendNewsCheck(now: Date): Promise<PreflightCheck> {
  const startedIso = new Date().toISOString();
  try {
    // Last Friday 22:00 UTC → now. For a Sunday/Monday preflight this is the
    // actual weekend window. On other days we still query "since last Friday
    // 22:00 UTC" — which surfaces a full weekend + part of the current week.
    const friday = new Date(now);
    const day = friday.getUTCDay();
    // Days back to Friday: Fri=0, Sat=1, Sun=2, Mon=3, Tue=4, Wed=5, Thu=6.
    const daysBack = (day + 2) % 7;
    friday.setUTCDate(friday.getUTCDate() - daysBack);
    friday.setUTCHours(22, 0, 0, 0);

    const { data, error, count } = await supabase
      .from('ct_news_analyses')
      .select('id, instrument, news_headline, created_at', { count: 'estimated' })
      .gte('created_at', friday.toISOString())
      .order('created_at', { ascending: false })
      .limit(5);

    if (error) throw error;

    const total = count ?? (data?.length ?? 0);
    let status: CheckStatus;
    let explanation: string;
    if (total === 0) {
      status = 'yellow';
      explanation = `0 news rows since ${friday.toISOString().slice(0, 10)} 22:00 UTC`;
    } else {
      status = 'green';
      explanation = `${total} news rows since ${friday.toISOString().slice(0, 10)} 22:00 UTC`;
    }

    return {
      key: 'weekend_news',
      name: 'Weekend news captured',
      status,
      explanation,
      lastCheckedAt: startedIso,
      details: (data ?? []).map((r) => ({
        label: `${r.instrument}: ${r.news_headline}`,
        status: 'green',
        note: new Date(r.created_at).toLocaleString(),
      })),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      key: 'weekend_news',
      name: 'Weekend news captured',
      status: 'red',
      explanation: 'Failed to query ct_news_analyses',
      lastCheckedAt: startedIso,
      details: [],
      error: message,
    };
  }
}

interface ConfigRow {
  key: string;
  value: unknown;
  default_value: unknown;
  min_value: number | null;
  max_value: number | null;
  category: string | null;
}

async function runConfigCheck(): Promise<PreflightCheck> {
  const startedIso = new Date().toISOString();
  try {
    const { data, error } = await supabase
      .from('ct_config')
      .select('key, value, default_value, min_value, max_value, category');

    if (error) throw error;

    const rows = (data ?? []) as ConfigRow[];
    const violations: PreflightDetail[] = [];

    for (const r of rows) {
      // Only enforce bounds on numeric rows. Non-numeric values (strings,
      // booleans, JSON) have no min/max to validate against.
      if (typeof r.value !== 'number') continue;
      if (r.min_value != null && r.value < r.min_value) {
        violations.push({
          label: r.key,
          status: 'red',
          note: `${r.value} < min ${r.min_value}`,
        });
      } else if (r.max_value != null && r.value > r.max_value) {
        violations.push({
          label: r.key,
          status: 'red',
          note: `${r.value} > max ${r.max_value}`,
        });
      }
    }

    let status: CheckStatus;
    let explanation: string;
    if (rows.length === 0) {
      status = 'yellow';
      explanation = 'No ct_config rows found';
    } else if (violations.length === 0) {
      status = 'green';
      explanation = `${rows.length} config keys all within bounds`;
    } else {
      status = 'red';
      explanation = `${violations.length} config key${violations.length > 1 ? 's' : ''} out of bounds`;
    }

    return {
      key: 'config',
      name: 'Config sane',
      status,
      explanation,
      lastCheckedAt: startedIso,
      details: violations,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      key: 'config',
      name: 'Config sane',
      status: 'red',
      explanation: 'Failed to query ct_config',
      lastCheckedAt: startedIso,
      details: [],
      error: message,
    };
  }
}

async function runKillSwitchCheck(now: Date): Promise<PreflightCheck> {
  const startedIso = new Date().toISOString();
  try {
    const { data, error } = await supabase
      .from('ct_kill_switch')
      .select('active, engaged_at, engaged_by, engaged_reason, auto_release_at' as '*')
      .eq('id', 1)
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      return {
        key: 'kill_switch',
        name: 'Kill switch disarmed',
        status: 'yellow',
        explanation: 'No ct_kill_switch row — migration may be pending',
        lastCheckedAt: startedIso,
        details: [],
      };
    }

    const row = data as unknown as {
      active: boolean;
      engaged_at: string | null;
      engaged_by: string | null;
      engaged_reason: string | null;
      auto_release_at: string | null;
    };

    if (!row.active) {
      return {
        key: 'kill_switch',
        name: 'Kill switch disarmed',
        status: 'green',
        explanation: 'Disarmed — Claude + trade writes free to run',
        lastCheckedAt: startedIso,
        details: [],
      };
    }

    // Engaged: red during market hours (trading is halted), yellow off-hours
    // (we're deliberately paused, not broken).
    const marketActive = isMarketActive(now);
    const status: CheckStatus = marketActive ? 'red' : 'yellow';
    const releaseNote = row.auto_release_at
      ? `auto-release at ${new Date(row.auto_release_at).toLocaleString()}`
      : 'manual disarm only';

    return {
      key: 'kill_switch',
      name: marketActive ? 'Kill switch engaged (market hours)' : 'Kill switch engaged',
      status,
      explanation: marketActive
        ? `HALTED — ${row.engaged_reason ?? '(no reason)'}`
        : `Paused off-hours — ${row.engaged_reason ?? '(no reason)'}`,
      lastCheckedAt: startedIso,
      details: [
        { label: 'reason', status, note: row.engaged_reason ?? '(none)' },
        {
          label: 'engaged',
          status,
          note: row.engaged_at ? new Date(row.engaged_at).toLocaleString() : '?',
        },
        { label: 'engaged by', status: 'green', note: row.engaged_by ?? '?' },
        { label: 'release', status, note: releaseNote },
      ],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      key: 'kill_switch',
      name: 'Kill switch disarmed',
      status: 'red',
      explanation: 'Failed to query ct_kill_switch',
      lastCheckedAt: startedIso,
      details: [],
      error: message,
    };
  }
}

// ---------------------------------------------------------------------------
// Summary rollup
// ---------------------------------------------------------------------------

function rollup(checks: PreflightCheck[]): PreflightSummary {
  let green = 0;
  let yellow = 0;
  let red = 0;
  for (const c of checks) {
    if (c.status === 'green') green += 1;
    else if (c.status === 'yellow') yellow += 1;
    else red += 1;
  }

  let overall: CheckStatus;
  let headline: string;
  let subline: string;
  if (red > 0) {
    overall = 'red';
    headline = `NOT READY (${green} green, ${yellow} yellow, ${red} red)`;
    subline = 'fix before open';
  } else if (yellow > 0) {
    overall = 'yellow';
    headline = `DEGRADED (${green} green, ${yellow} yellow)`;
    subline = 'safe to trade, review warnings';
  } else {
    overall = 'green';
    headline = `READY (${green} green)`;
    subline = 'all checks pass';
  }

  return { overall, green, yellow, red, headline, subline };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function usePreflightChecks(options?: { refreshMs?: number }): PreflightResult {
  const refreshMs = options?.refreshMs ?? 60_000;
  const [checks, setChecks] = useState<PreflightCheck[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastRun, setLastRun] = useState<string | null>(null);

  const runAll = useCallback(async () => {
    const now = new Date();
    // Promise.all — every check is independent, one failure is already
    // contained inside the check function (try/catch → red card).
    const results = await Promise.all([
      runCronCheck(now),
      runCronFailuresCheck(),
      runMorningBriefCheck(now),
      runBookCheck(),
      runUwUsageCheck(),
      runHeartbeatCheck(now),
      runBiasesCheck(),
      runWeekendNewsCheck(now),
      runConfigCheck(),
      runKillSwitchCheck(now),
    ]);
    setChecks(results);
    setLastRun(new Date().toISOString());
    setLoading(false);
  }, []);

  useEffect(() => {
    void runAll();
  }, [runAll]);

  useEffect(() => {
    const interval = setInterval(() => {
      void runAll();
    }, refreshMs);
    return () => clearInterval(interval);
  }, [runAll, refreshMs]);

  const summary = rollup(checks);

  return { checks, summary, loading, refetch: runAll, lastRun };
}
