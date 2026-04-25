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
  regime: string | null;
  total_graded: number | null;
  wins: number | null;
  losses: number | null;
  flats: number | null;
  snapshot_hit_rate: number | null;
  tracks_realized_today: number | null;
  tracks_new_peaks_today: number | null;
  slow_burn_count: number | null;
  slow_burn_pays_today: SlowBurnPay[] | null;
  by_ticker: EdgeDailyByBucket[] | null;
  by_time_bucket: EdgeDailyByBucket[] | null;
  by_dte_bucket: EdgeDailyByBucket[] | null;
  computed_at?: string | null;
}

export interface SignatureRow {
  signature_key: string;
  sample: number;
  snap_hit_rate: number | null;
  lifetime_hit_rate: number | null;
  median_days_to_realize: number | null;
  edge_score: number | null;
  promoted: boolean;
  first_seen_at: string | null;
  updated_at: string | null;
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
  print_date: string | null;
  track_status: string | null; // 'WORKING' | 'REALIZED' | 'EXPIRED'
  peak_favorable_pct: number | null;
  days_tracked: number | null;
  tracking_until: string | null;
  signature_key: string | null;
}

// ---------- ct_edge_daily ----------

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
      return rows[0] ?? null;
    },
  });
}

// ---------- ct_signatures ----------

interface UseSignaturesArgs {
  ticker?: string;
  promoted?: boolean;
  limit?: number;
  orderBy?: 'edge_score' | 'sample' | 'lifetime_hit_rate' | 'updated_at';
}

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
      return (data ?? []) as SignatureRow[];
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

export function usePrintGrades(args: UsePrintGradesArgs = {}) {
  const { date, grade, ticker, minMagnitude, limit = 10, orderBy = 'magnitude_desc' } = args;
  return useQuery<PrintGradeRow[]>({
    queryKey: ['ct_print_grades', date ?? null, grade ?? null, ticker ?? null, minMagnitude ?? null, limit, orderBy],
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: false,
    queryFn: async () => {
      // We pull grades + a hand-picked alert join. Supabase PostgREST allows
      // !inner foreign-key embedding; fall back to two-step if the FK isn't
      // declared. We try the embed path first (cheap, one round-trip).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let q: any = (supabase.from as any)('ct_print_grades')
        .select(
          'id, alert_id, graded_at, grade, magnitude_pct, signature_key, ' +
          'ct_flow_alerts:alert_id ( ticker, side, strike, expiry, dte, executed_at, premium )'
        )
        .limit(limit);
      if (grade) q = q.eq('grade', grade);
      if (date) {
        const start = `${date}T00:00:00Z`;
        const end = `${date}T23:59:59Z`;
        q = q.gte('graded_at', start).lte('graded_at', end);
      }
      if (typeof minMagnitude === 'number') {
        // Magnitude can be signed; filter on absolute server-side via OR.
        q = q.or(`magnitude_pct.gte.${minMagnitude},magnitude_pct.lte.${-minMagnitude}`);
      }
      // Order — magnitude desc puts the biggest moves first.
      if (orderBy === 'magnitude_desc') q = q.order('magnitude_pct', { ascending: false, nullsFirst: false });
      else if (orderBy === 'magnitude_asc') q = q.order('magnitude_pct', { ascending: true, nullsFirst: false });
      else q = q.order('graded_at', { ascending: false, nullsFirst: false });

      const { data, error } = await q;
      if (error) {
        console.warn('[usePrintGrades]', error.message);
        return [];
      }
      // Flatten the joined alert into top-level columns so the table is plain.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = (data ?? []) as any[];
      const out: PrintGradeRow[] = rows.map((r) => {
        const a = r.ct_flow_alerts ?? {};
        let t = a.ticker ?? null;
        // Filter by ticker client-side after the join (we can't pre-filter on
        // a joined column without a relationship-filter syntax that varies by
        // PostgREST version — keep it simple).
        if (ticker && t !== ticker) return null;
        return {
          id: r.id,
          alert_id: r.alert_id,
          graded_at: r.graded_at,
          grade: r.grade,
          magnitude_pct: r.magnitude_pct,
          signature_key: r.signature_key,
          ticker: t,
          side: a.side ?? null,
          strike: a.strike ?? null,
          expiry: a.expiry ?? null,
          dte: a.dte ?? null,
          executed_at: a.executed_at ?? null,
          premium: a.premium ?? null,
        } as PrintGradeRow;
      }).filter((x): x is PrintGradeRow => x !== null);
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
      else if (orderBy === 'days_tracked_desc') q = q.order('days_tracked', { ascending: false, nullsFirst: false });
      else q = q.order('print_date', { ascending: false, nullsFirst: false });
      const { data, error } = await q;
      if (error) {
        console.warn('[usePrintTracks]', error.message);
        return [];
      }
      return (data ?? []) as PrintTrackRow[];
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
    queryKey: ['ct_contract_threshold_distribution', sinceDays],
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: false,
    queryFn: async () => {
      const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase as any).rpc('ct_contract_threshold_distribution', {
        p_since: since,
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
