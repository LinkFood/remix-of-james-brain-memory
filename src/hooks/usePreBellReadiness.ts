/**
 * usePreBellReadiness — pre-bell preparation checklist.
 *
 * Runs eight parallel checks against existing ct_* tables every 60s during the
 * pre-market window (04:00–09:31 ET weekdays, skips NYSE holidays). Zero new
 * UW calls; every datum comes from tables the rest of CommandStation already
 * queries. Also emits a live countdown to today's 09:30 ET open.
 *
 * Status mapping per row:
 *   'ok'      → green check (condition met)
 *   'pending' → amber dot    (data not yet landed — still acceptable while the
 *                             upstream producer's cron hasn't fired)
 *   'fail'    → red cross    (condition actively wrong — needs intervention)
 *
 * The overall verdict rolls up those eight:
 *   'ready'     → every blocking check is 'ok' (countdown row excluded)
 *   'degraded'  → no 'fail' but at least one 'pending'
 *   'not-ready' → any 'fail'
 *
 * Used by <PreBellChecklist /> and mirrored server-side by ct-pre-bell-alert.
 * Keep the two query shapes aligned — they are the same checklist in two
 * execution environments.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  getEtNow,
  isPreMarket,
  msUntilMarketOpen,
} from '@/lib/etMarketClock';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PreBellStatus = 'ok' | 'pending' | 'fail';

export type PreBellItemId =
  | 'morning_brief'
  | 'premarket_scan'
  | 'book_seeded'
  | 'killswitch_disarmed'
  | 'uw_usage_reset'
  | 'ui_errors_clean'
  | 'concentration_headroom'
  | 'biases_loaded'
  | 'event_trigger_debounce'
  | 'countdown';

export interface PreBellItem {
  id: PreBellItemId;
  label: string;
  status: PreBellStatus;
  detail: string;
  /** Where clicking the row should take the user. null = no navigation. */
  href: string | null;
  /** True for the countdown row — styled as info-only, not counted in the overall verdict. */
  isInformational?: boolean;
}

export interface PreBellReadiness {
  items: PreBellItem[];
  overall: 'ready' | 'degraded' | 'not-ready';
  marketOpensInMs: number;
  lastUpdated: string;
  isLoading: boolean;
  forceRefresh: () => Promise<void>;
  /** True iff we are currently in the pre-bell window on a trading day. */
  visible: boolean;
}

// ---------------------------------------------------------------------------
// Per-check query functions. Each returns `{ status, detail }`. A thrown error
// from Supabase is swallowed into 'pending' with the error message — we never
// want a single failing read to collapse the whole panel.
// ---------------------------------------------------------------------------

interface CheckResult {
  status: PreBellStatus;
  detail: string;
}

const STALE_MS = 30_000;     // Within-window per-query staleness
const REFRESH_MS = 60_000;   // Spec: every 60s

function todayEt(): string {
  return getEtNow().ymd;
}

/** ct_reports row with report_type='morning_brief' created today (ET). */
async function checkMorningBrief(): Promise<CheckResult> {
  const dayStartUtc = new Date(`${todayEt()}T00:00:00-05:00`).toISOString();
  const { data, error } = await supabase
    .from('ct_reports')
    .select('id, created_at')
    .eq('report_type', 'morning_brief')
    .gte('created_at', dayStartUtc)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return { status: 'pending', detail: `read error: ${error.message}` };
  if (!data) return { status: 'pending', detail: 'not yet published today' };
  return { status: 'ok', detail: `landed ${timeOfDay(data.created_at)}` };
}

/** ct_premarket_gaps — at least 10 rows today = scan complete. */
async function checkPremarketScan(): Promise<CheckResult> {
  const { count, error } = await supabase
    .from('ct_premarket_gaps')
    .select('*', { count: 'estimated', head: true })
    .eq('session_date', todayEt());
  if (error) return { status: 'pending', detail: `read error: ${error.message}` };
  const n = count ?? 0;
  if (n === 0) return { status: 'pending', detail: 'scan has not run yet' };
  if (n < 10) return { status: 'fail', detail: `only ${n} tickers scanned (expected ≥10)` };
  return { status: 'ok', detail: `${n} tickers scanned` };
}

/** ct_book for today with starting_balance > 0. */
async function checkBookSeeded(): Promise<CheckResult> {
  const { data, error } = await supabase
    .from('ct_book')
    .select('starting_balance')
    .eq('session_date', todayEt())
    .maybeSingle();
  if (error) return { status: 'pending', detail: `read error: ${error.message}` };
  if (!data) return { status: 'fail', detail: 'no book row for today' };
  const sb = Number(data.starting_balance ?? 0);
  if (!Number.isFinite(sb) || sb <= 0) {
    return { status: 'fail', detail: `starting_balance=${sb}` };
  }
  return { status: 'ok', detail: `$${sb.toLocaleString()} seed` };
}

/** ct_killswitch_active() RPC — we want FALSE (disarmed). */
async function checkKillSwitchDisarmed(): Promise<CheckResult> {
  // RPC returns boolean. Cast via `as never` — rpc type generic isn't in codegen.
  const { data, error } = await supabase.rpc('ct_killswitch_active' as never);
  if (error) return { status: 'pending', detail: `rpc error: ${error.message}` };
  if (data === true) return { status: 'fail', detail: 'kill switch is ENGAGED' };
  return { status: 'ok', detail: 'disarmed' };
}

/** ct_uw_usage_latest pct < 20 = reset cleanly overnight. */
async function checkUwUsageReset(): Promise<CheckResult> {
  const { data, error } = await supabase
    .from('ct_uw_usage_latest')
    .select('pct, session_date, daily_count, daily_limit')
    .order('session_date', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return { status: 'pending', detail: `read error: ${error.message}` };
  if (!data) return { status: 'pending', detail: 'no usage row yet' };
  const pct = Number(data.pct ?? 0);
  if (!Number.isFinite(pct)) return { status: 'pending', detail: 'pct null' };
  if (pct >= 20) return { status: 'fail', detail: `UW ${pct}% used already` };
  return { status: 'ok', detail: `UW ${pct}% used` };
}

/** ct_ui_errors — zero in last 6h = clean. */
async function checkUiErrorsClean(): Promise<CheckResult> {
  const cutoff = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const { count, error } = await supabase
    .from('ct_ui_errors')
    .select('*', { count: 'estimated', head: true })
    .gte('created_at', cutoff);
  if (error) return { status: 'pending', detail: `read error: ${error.message}` };
  const n = count ?? 0;
  if (n === 0) return { status: 'ok', detail: 'clean 6h' };
  return { status: 'fail', detail: `${n} UI error(s) in last 6h` };
}

/** Sum of open trade size_pct < 40 = concentration headroom. */
async function checkConcentrationHeadroom(): Promise<CheckResult> {
  const { data, error } = await supabase
    .from('ct_trades')
    .select('size_pct, status')
    .eq('status', 'open');
  if (error) return { status: 'pending', detail: `read error: ${error.message}` };
  const rows = (data ?? []) as Array<{ size_pct: number | null }>;
  const total = rows.reduce((s, r) => s + (Number(r.size_pct) || 0), 0);
  if (total >= 40) return { status: 'fail', detail: `already ${total.toFixed(0)}% deployed` };
  const headroom = 40 - total;
  return { status: 'ok', detail: `${headroom.toFixed(0)}% headroom` };
}

/** ct_biases with active=true — at least one loaded. */
async function checkBiasesLoaded(): Promise<CheckResult> {
  const { count, error } = await supabase
    .from('ct_biases')
    .select('*', { count: 'estimated', head: true })
    .eq('active', true);
  if (error) return { status: 'pending', detail: `read error: ${error.message}` };
  const n = count ?? 0;
  if (n === 0) return { status: 'fail', detail: 'no active biases' };
  return { status: 'ok', detail: `${n} active` };
}

/**
 * Event-trigger debounce is working. Reads ct_watcher_event_triggers for the
 * last hour — presence of rows (fired or debounced) shows the audit pipe is
 * live. Seeing at least one skip_reason='debounced' within an hour is a
 * positive signal that the per-source debounce is actually kicking in.
 */
async function checkEventTriggerDebounce(): Promise<CheckResult> {
  const hourAgoIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .from('ct_watcher_event_triggers' as any)
    .select('id, skip_reason, trigger_fired')
    .gte('created_at', hourAgoIso)
    .limit(200);
  if (error) return { status: 'pending', detail: `read error: ${error.message}` };
  const rows = (data ?? []) as Array<{ skip_reason: string | null; trigger_fired: boolean }>;
  if (rows.length === 0) return { status: 'pending', detail: 'no event-driven invocations in last hour' };
  const fired = rows.filter((r) => r.trigger_fired).length;
  const debounced = rows.filter((r) => r.skip_reason === 'debounced').length;
  return { status: 'ok', detail: `${fired} fired · ${debounced} debounced in last hour` };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

interface CheckSpec {
  id: Exclude<PreBellItemId, 'countdown'>;
  label: string;
  href: string | null;
  fn: () => Promise<CheckResult>;
}

const CHECKS: readonly CheckSpec[] = [
  { id: 'morning_brief',         label: 'Morning brief landed',         href: '/reports',           fn: checkMorningBrief },
  { id: 'premarket_scan',        label: 'Pre-market scan complete',     href: '/command#co-premarket-gaps', fn: checkPremarketScan },
  { id: 'book_seeded',           label: 'Book seeded',                  href: '/book',              fn: checkBookSeeded },
  { id: 'killswitch_disarmed',   label: 'Kill switch disarmed',         href: '/ct-settings',       fn: checkKillSwitchDisarmed },
  { id: 'uw_usage_reset',        label: 'UW usage reset',               href: '/ct-settings',       fn: checkUwUsageReset },
  { id: 'ui_errors_clean',       label: 'No UI errors in last 6h',      href: '/health',            fn: checkUiErrorsClean },
  { id: 'concentration_headroom',label: 'Concentration headroom',       href: '/book',              fn: checkConcentrationHeadroom },
  { id: 'biases_loaded',         label: 'Active biases loaded',         href: '/ct-settings',       fn: checkBiasesLoaded },
  { id: 'event_trigger_debounce',label: 'Event-trigger debounce is working', href: '/health',       fn: checkEventTriggerDebounce },
];

export const PRE_BELL_QUERY_KEY_ROOT = ['pre-bell-readiness'] as const;

export function usePreBellReadiness(): PreBellReadiness {
  const qc = useQueryClient();

  // Re-render every second to tick the countdown + re-evaluate isPreMarket
  // on the minute boundary. Checks themselves still refetch on their own 60s
  // cadence — this tick is UI-only.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const visible = isPreMarket(now);

  // Parallel check queries. We run them even when `visible=false` but only
  // while the tab is foreground — once hidden, disable to save roundtrips.
  const queries = useQueries({
    queries: CHECKS.map((c) => ({
      queryKey: [...PRE_BELL_QUERY_KEY_ROOT, c.id],
      queryFn: c.fn,
      enabled: visible,
      refetchInterval: visible ? REFRESH_MS : false,
      staleTime: STALE_MS,
      // Keep last successful result even while refetching, so UI doesn't flicker.
      placeholderData: (prev: CheckResult | undefined) => prev,
    })),
  });

  const items = useMemo<PreBellItem[]>(() => {
    const checkItems: PreBellItem[] = CHECKS.map((c, i) => {
      const q = queries[i];
      const result = q?.data as CheckResult | undefined;
      // While loading with no prior data, show 'pending' with a spinner label.
      const status: PreBellStatus = result?.status ?? (q?.isLoading ? 'pending' : 'pending');
      const detail = result?.detail ?? (q?.isLoading ? 'checking…' : '—');
      return {
        id: c.id,
        label: c.label,
        status,
        detail,
        href: c.href,
      };
    });

    const marketOpensInMs = Math.max(0, msUntilMarketOpen(now));
    checkItems.push({
      id: 'countdown',
      label: 'Market open in',
      status: 'ok', // always neutral — not a pass/fail
      detail: '', // PreBellChecklist renders the live countdown itself
      href: null,
      isInformational: true,
    });

    return checkItems;
  }, [queries, now]);

  const overall: PreBellReadiness['overall'] = useMemo(() => {
    const blocking = items.filter((i) => !i.isInformational);
    if (blocking.some((i) => i.status === 'fail')) return 'not-ready';
    if (blocking.some((i) => i.status === 'pending')) return 'degraded';
    return 'ready';
  }, [items]);

  const forceRefresh = useCallback(async () => {
    await qc.invalidateQueries({ queryKey: PRE_BELL_QUERY_KEY_ROOT });
  }, [qc]);

  const lastUpdatedMs = Math.max(0, ...queries.map((q) => q?.dataUpdatedAt ?? 0));
  const isLoading = queries.some((q) => q?.isLoading);

  return {
    items,
    overall,
    marketOpensInMs: Math.max(0, msUntilMarketOpen(now)),
    lastUpdated: lastUpdatedMs ? new Date(lastUpdatedMs).toISOString() : '',
    isLoading,
    forceRefresh,
    visible,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function timeOfDay(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleTimeString([], {
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
  } catch {
    return '—';
  }
}
