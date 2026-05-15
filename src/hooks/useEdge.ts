/**
 * useEdge — hooks for the /edge hedge-fund attribution dashboard.
 *
 * Backed by tables built in parallel by Agents A/B/C:
 *   - ct_edge_daily   (Agent B): one row per session_date with regime, hit
 *                       rates, sample counts, slow_burn_pays_today JSONB,
 *                       by_ticker / by_time_bucket / by_dte_bucket JSONB.
 *   - ct_signatures   (Agent B): library of recurring (signature_key) shapes
 *                       with sample, snap/lifetime hit rates, edge_score, etc.
 *   - ct_print_grades (Agent A): per-print snapshot grades joined with
 *                       ct_flow_alerts for ticker/strike/side/dte context.
 *   - ct_print_tracks (Agent A): lifetime-tracked prints that are still WORKING
 *                       (or RESOLVED) — used for the open-position view.
 *
 * Defensive throughout: tables may be empty / not exist on first deploy.
 * Every hook returns [] / null on error and `retry: false` so a missing
 * table doesn't cause 3x 404s. Components own their own skeleton/empty UI.
 */

import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

// ---------- types ----------

export interface SlowBurnPay {
  ticker: string;
  side: string | null;
  strike: number | null;
  expiry: string | null;
  print_date: string | null;
  realized_at: string | null;
  days_to_realize: number | null;
  peak_favorable_pct: number | null;
  signature_key: string | null;
  alert_id?: string | null;
}

export interface EdgeDailyByBucket {
  bucket: string;
  hit_rate: number | null;
  sample: number;
}

export interface EdgeDailyRow {
  session_date: string;
  regime_tag: string | null;
  total_graded: number | null;
  snapshot_total_graded: number | null;
  snapshot_wins: number | null;
  snapshot_losses: number | null;
  snapshot_flats: number | null;
  snapshot_hit_rate: number | null;
  overall_hit_rate: number | null;
  tracks_realized_today: number | null;
  tracks_new_peaks_today: number | null;
  tracks_expired_today: number | null;
  slow_burn_pays_today: SlowBurnPay[] | null;
  by_ticker: EdgeDailyByBucket[] | null;
  by_time_bucket: EdgeDailyByBucket[] | null;
  by_dte_bucket: EdgeDailyByBucket[] | null;
  computed_at?: string | null;
}

export interface SignatureRow {
  signature_key: string;
  sample_count: number;
  snapshot_hit_rate: number | null;
  lifetime_hit_rate: number | null;
  median_days_to_realization: number | null;
  edge_score: number | null;
  promoted: boolean;
  first_seen_at: string | null;
  last_updated_at: string | null;
  ticker?: string | null;
}

export interface PrintGradeRow {
  id: string | number;
  alert_id: string | number | null;
  graded_at: string | null;
  grade: string | null; // 'WIN' | 'LOSS' | 'FLAT'
  magnitude_pct: number | null;
  signature_key: string | null;
  ticker: string | null;
  side: string | null;
  strike: number | null;
  expiry: string | null;
  dte: number | null;
  executed_at: string | null;
  premium: number | null;
}

export interface PrintTrackRow {
  id: string | number;
  alert_id: string | number | null;
  ticker: string | null;
  side: string | null;
  strike: number | null;
  expiry: string | null;
  dte_at_print: number | null;
  /** Producer column is `print_time`; kept as `print_date` in this interface for legacy consumer reads. */
  print_date: string | null;
  print_time: string | null;
  track_status: string | null; // 'WORKING' | 'REALIZED' | 'EXPIRED'
  peak_favorable_pct: number | null;
  /** Derived from first_tracked_at -> last_tracked_at; producer has no scalar column. */
  days_tracked: number | null;
  first_tracked_at: string | null;
  last_tracked_at: string | null;
  tracking_until: string | null;
  signature_key: string | null;
  predicted_source: string | null;
}

// ---------- schema-drift canary (Ship 3 class-kill) ----------
//
// Hook-type drift from producer schema has bitten /edge twice (Ship 3
// reconciliation 2026-05-14). Cheap defense: when a hook receives a row, check
// a small list of expected columns. If ANY are `undefined` (column doesn't
// exist in the response shape), warn once per session. `null` is fine
// (column exists, no value) — only `undefined` flags a real schema-drift hit.
const _schemaDriftWarned = new Set<string>();
function assertHookSchema(
  hookName: string,
  row: Record<string, unknown> | null | undefined,
  expectedKeys: readonly string[],
): void {
  if (!row || typeof row !== 'object') return;
  const missing = expectedKeys.filter((k) => !(k in row));
  if (missing.length === 0) return;
  const cacheKey = `${hookName}:${missing.sort().join(',')}`;
  if (_schemaDriftWarned.has(cacheKey)) return;
  _schemaDriftWarned.add(cacheKey);
  // eslint-disable-next-line no-console
  console.warn(
    `[schema-drift] ${hookName}: producer missing expected columns: ${missing.join(', ')}. ` +
      'Likely a column rename — reconcile hook types against producer table.',
  );
}

// ---------- ct_edge_daily ----------

const EDGE_DAILY_CANARY = [
  'session_date',
  'regime_tag',
  'snapshot_wins',
  'snapshot_losses',
  'snapshot_flats',
  'snapshot_hit_rate',
  'slow_burn_pays_today',
  'computed_at',
] as const;

export function useEdgeDaily(sessionDate?: string) {
  return useQuery<EdgeDailyRow | null>({
    queryKey: ['ct_edge_daily', sessionDate ?? 'today'],
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: false,
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let q: any = (supabase.from as any)('ct_edge_daily')
        .select('*')
        .order('session_date', { ascending: false })
        .limit(1);
      if (sessionDate) {
        q = q.eq('session_date', sessionDate);
      }
      const { data, error } = await q;
      if (error) {
        console.warn('[useEdgeDaily]', error.message);
        return null;
      }
      const rows = (data ?? []) as EdgeDailyRow[];
      const row = rows[0] ?? null;
      assertHookSchema('useEdgeDaily', row as unknown as Record<string, unknown>, EDGE_DAILY_CANARY);
      return row;
    },
  });
}

/** Derive slow_burn count from the JSONB array — producer doesn't write a scalar count column. */
export function slowBurnCount(d: EdgeDailyRow | null | undefined): number {
  const pays = d?.slow_burn_pays_today;
  return Array.isArray(pays) ? pays.length : 0;
}

// ---------- ct_signatures ----------

interface UseSignaturesArgs {
  ticker?: string;
  promoted?: boolean;
  limit?: number;
  orderBy?: 'edge_score' | 'sample_count' | 'lifetime_hit_rate' | 'last_updated_at';
}

const SIGNATURE_CANARY = [
  'signature_key',
  'sample_count',
  'snapshot_hit_rate',
  'lifetime_hit_rate',
  'median_days_to_realization',
  'edge_score',
  'last_updated_at',
] as const;

export function useSignatures(args: UseSignaturesArgs = {}) {
  const { ticker, promoted, limit = 20, orderBy = 'edge_score' } = args;
  return useQuery<SignatureRow[]>({
    queryKey: ['ct_signatures', ticker ?? null, promoted ?? null, limit, orderBy],
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: false,
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let q: any = (supabase.from as any)('ct_signatures')
        .select('*')
        .order(orderBy, { ascending: false, nullsFirst: false })
        .limit(limit);
      if (typeof promoted === 'boolean') q = q.eq('promoted', promoted);
      if (ticker) q = q.eq('ticker', ticker);
      const { data, error } = await q;
      if (error) {
        console.warn('[useSignatures]', error.message);
        return [];
      }
      const rows = (data ?? []) as SignatureRow[];
      if (rows[0]) assertHookSchema('useSignatures', rows[0] as unknown as Record<string, unknown>, SIGNATURE_CANARY);
      return rows;
    },
  });
}

// ---------- ct_print_grades JOIN ct_flow_alerts ----------

interface UsePrintGradesArgs {
  date?: string;        // ISO YYYY-MM-DD; filters graded_at by day
  grade?: 'WIN' | 'LOSS' | 'FLAT';
  ticker?: string;
  minMagnitude?: number; // absolute value floor on magnitude_pct
  limit?: number;
  orderBy?: 'magnitude_desc' | 'magnitude_asc' | 'graded_at_desc';
}

/** Compute DTE from expiry (YYYY-MM-DD) and a reference timestamp. */
function deriveDte(expiry: string | null | undefined, ref: string | null | undefined): number | null {
  if (!expiry || !ref) return null;
  const exp = Date.parse(expiry.length === 10 ? `${expiry}T00:00:00Z` : expiry);
  const r = Date.parse(ref);
  if (!Number.isFinite(exp) || !Number.isFinite(r)) return null;
  return Math.max(0, Math.round((exp - r) / 86_400_000));
}

export function usePrintGrades(args: UsePrintGradesArgs = {}) {
  const { date, grade, ticker, minMagnitude, limit = 10, orderBy = 'magnitude_desc' } = args;
  return useQuery<PrintGradeRow[]>({
    queryKey: ['ct_print_grades', date ?? null, grade ?? null, ticker ?? null, minMagnitude ?? null, limit, orderBy],
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: false,
    queryFn: async () => {
      // Two-step join: PostgREST FK embedding (`ct_flow_alerts:alert_id(...)`)
      // returns PGRST200 "no FK relationship" because the link is logical
      // (grade.alert_id -> flow_alerts.alert_id, both UUIDs, NOT id), not
      // declared as a database foreign key. Ship 3 fix (2026-05-14):
      // (1) query grades, (2) collect alert_ids, (3) .in() against
      // ct_flow_alerts, (4) merge in JS. ticker can pre-filter step 1.
      //
      // Note: ct_print_grades has no `signature_key` column — the de-facto
      // signature is `predicted_source` (e.g. 'aggressive_ask_call').
      // ct_flow_alerts has no `dte` column — derive from expiry - print_time.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let q: any = (supabase.from as any)('ct_print_grades')
        .select('id, alert_id, ticker, graded_at, print_time, grade, magnitude_pct, predicted_source')
        .limit(limit);
      if (grade) q = q.eq('grade', grade);
      if (ticker) q = q.eq('ticker', ticker);
      if (date) {
        const start = `${date}T00:00:00Z`;
        const end = `${date}T23:59:59Z`;
        q = q.gte('graded_at', start).lte('graded_at', end);
      }
      if (typeof minMagnitude === 'number') {
        // Magnitude is a decimal fraction (0.05 = 5%); filter accordingly.
        q = q.or(`magnitude_pct.gte.${minMagnitude},magnitude_pct.lte.${-minMagnitude}`);
      }
      if (orderBy === 'magnitude_desc') q = q.order('magnitude_pct', { ascending: false, nullsFirst: false });
      else if (orderBy === 'magnitude_asc') q = q.order('magnitude_pct', { ascending: true, nullsFirst: false });
      else q = q.order('graded_at', { ascending: false, nullsFirst: false });

      const { data, error } = await q;
      if (error) {
        console.warn('[usePrintGrades]', error.message);
        return [];
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const grades = (data ?? []) as any[];
      if (grades.length === 0) return [];

      // Step 2: pull matching ct_flow_alerts rows in one batch via .in().
      const alertIds: string[] = grades
        .map((g) => g.alert_id)
        .filter((a: unknown): a is string => typeof a === 'string' && a.length > 0);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const alertMap: Record<string, any> = {};
      if (alertIds.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: alerts, error: alertErr } = await (supabase.from as any)('ct_flow_alerts')
          .select('alert_id, side, strike, expiry, executed_at, premium')
          .in('alert_id', alertIds);
        if (alertErr) {
          console.warn('[usePrintGrades] alerts fetch', alertErr.message);
        } else if (Array.isArray(alerts)) {
          for (const a of alerts) {
            if (a?.alert_id) alertMap[a.alert_id] = a;
          }
        }
      }

      const out: PrintGradeRow[] = grades.map((r) => {
        const a = alertMap[r.alert_id] ?? {};
        const refTime: string | null = a.executed_at ?? r.print_time ?? null;
        return {
          id: r.id,
          alert_id: r.alert_id,
          graded_at: r.graded_at,
          grade: r.grade,
          magnitude_pct: r.magnitude_pct,
          signature_key: r.predicted_source ?? null,
          ticker: r.ticker ?? null,
          side: a.side ?? null,
          strike: a.strike ?? null,
          expiry: a.expiry ?? null,
          dte: deriveDte(a.expiry, refTime ?? r.print_time),
          executed_at: a.executed_at ?? r.print_time ?? null,
          premium: a.premium ?? null,
        } as PrintGradeRow;
      });
      return out;
    },
  });
}

// ---------- ct_print_tracks ----------

interface UsePrintTracksArgs {
  status?: 'WORKING' | 'REALIZED' | 'EXPIRED';
  ticker?: string;
  orderBy?: 'peak_favorable_desc' | 'days_tracked_desc' | 'print_date_desc';
  limit?: number;
}

const PRINT_TRACK_CANARY = [
  'id',
  'alert_id',
  'ticker',
  'side',
  'strike',
  'expiry',
  'dte_at_print',
  'print_time',
  'track_status',
  'peak_favorable_pct',
  'first_tracked_at',
  'last_tracked_at',
  'tracking_until',
] as const;

export function usePrintTracks(args: UsePrintTracksArgs = {}) {
  const { status, ticker, orderBy = 'peak_favorable_desc', limit = 30 } = args;
  return useQuery<PrintTrackRow[]>({
    queryKey: ['ct_print_tracks', status ?? null, ticker ?? null, orderBy, limit],
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: false,
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let q: any = (supabase.from as any)('ct_print_tracks')
        .select('*')
        .limit(limit);
      if (status) q = q.eq('track_status', status);
      if (ticker) q = q.eq('ticker', ticker);
      if (orderBy === 'peak_favorable_desc') q = q.order('peak_favorable_pct', { ascending: false, nullsFirst: false });
      else if (orderBy === 'days_tracked_desc') q = q.order('last_tracked_at', { ascending: false, nullsFirst: false });
      else q = q.order('print_time', { ascending: false, nullsFirst: false });
      const { data, error } = await q;
      if (error) {
        console.warn('[usePrintTracks]', error.message);
        return [];
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw = (data ?? []) as any[];
      if (raw[0]) assertHookSchema('usePrintTracks', raw[0] as Record<string, unknown>, PRINT_TRACK_CANARY);
      // Derive days_tracked from first_tracked_at -> last_tracked_at, and
      // map print_time -> print_date alias so existing consumers keep working.
      return raw.map((r) => {
        const start = r.first_tracked_at ? Date.parse(r.first_tracked_at) : NaN;
        const end = r.last_tracked_at ? Date.parse(r.last_tracked_at) : NaN;
        const days =
          Number.isFinite(start) && Number.isFinite(end)
            ? Math.max(0, Math.round((end - start) / 86_400_000))
            : null;
        return {
          ...r,
          print_date: r.print_time ?? null,
          days_tracked: days,
          signature_key: r.predicted_source ?? null,
        } as PrintTrackRow;
      });
    },
  });
}

// ---------- formatting helpers ----------

export function fmtPct(v: number | null | undefined, digits = 1): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const sign = v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(digits)}%`;
}

export function fmtPctRate(v: number | null | undefined, digits = 0): string {
  if (v == null || !Number.isFinite(v)) return '—';
  // Edge daily / signatures store rates as 0..1. Detect and scale.
  const pct = Math.abs(v) <= 1 ? v * 100 : v;
  return `${pct.toFixed(digits)}%`;
}

export function fmtInt(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return Math.round(v).toLocaleString('en-US');
}

export function fmtNum(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toFixed(digits);
}

export function gradeColor(grade: string | null | undefined): string {
  if (grade === 'WIN') return 'text-emerald-400';
  if (grade === 'LOSS') return 'text-rose-400';
  return 'text-muted-foreground';
}

// ---------- ct_signature_magnitude_stats RPC ----------

export interface SignatureMagnitudeRow {
  signature_label: string;
  ticker: string;
  side: string;
  dte_bucket: string;
  predicted_source: string;
  n_tracks: number;
  median_peak_pct: number | null;
  p75_peak_pct: number | null;
  p90_peak_pct: number | null;
  max_peak_pct: number | null;
  win_count: number;
  loss_count: number;
  working_count: number;
  hit_rate: number | null;
  expected_value_pct: number | null;
}

export function useSignatureMagnitudeStats(sinceDays = 7, minN = 3) {
  return useQuery<SignatureMagnitudeRow[]>({
    queryKey: ['ct_signature_magnitude_stats', sinceDays, minN],
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: false,
    queryFn: async () => {
      const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase as any).rpc('ct_signature_magnitude_stats', {
        p_since: since,
        p_min_n: minN,
      });
      if (error) {
        console.warn('[useSignatureMagnitudeStats]', error.message);
        return [];
      }
      return (data ?? []) as SignatureMagnitudeRow[];
    },
  });
}

// ---------- ct_contract_threshold_distribution RPC ----------

export interface ContractThresholdRow {
  dte_bucket: string;
  bucket_order: number;
  n_tracks: number;
  current_threshold_pct: number | null;
  median_peak_pct: number | null;
  p75_peak_pct: number | null;
  p90_peak_pct: number | null;
  max_peak_pct: number | null;
  n_above_threshold: number;
  pct_above_threshold: number | null;
  recommended_p60_pct: number | null;
  recommended_p75_pct: number | null;
}

export function useContractThresholdDistribution(sinceDays = 7) {
  return useQuery<ContractThresholdRow[]>({
    queryKey: ['ct_contract_threshold_distribution', sinceDays, '5bucket'],
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: false,
    queryFn: async () => {
      // Ship 1 v2 (2026-05-14) added a 5-bucket-canonical overload (p_window_days int)
      // matching grader buckets 0dte / 1_3d / 4_14d / 15_45d / 46d_plus. current_threshold_pct
      // is now sourced live from ct_config grader.alarm_win_pct.*. The original
      // (p_since timestamptz) 4-bucket overload still exists for backward-compat.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase as any).rpc('ct_contract_threshold_distribution', {
        p_window_days: sinceDays,
      });
      if (error) {
        console.warn('[useContractThresholdDistribution]', error.message);
        return [];
      }
      return (data ?? []) as ContractThresholdRow[];
    },
  });
}

/** Format a decimal-fraction magnitude (1.0 = 100%) as "+100%". Null-safe. */
export function fmtFractionAsPct(v: number | null | undefined, digits = 0): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const pct = v * 100;
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(digits)}%`;
}
