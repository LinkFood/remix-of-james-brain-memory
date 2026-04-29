/**
 * useContractTracks — hooks for the contract-axis grading layer (Phase D UI).
 *
 * Backed by tables built in parallel by Phase A/B/C agents:
 *   - ct_contract_tracks  (Phase A populated, Phase B updates in place):
 *       lifetime tracking ledger of option-CONTRACT price evolution. One row
 *       per alert_id (UNIQUE). Phase B's poller fills current_*, peak_*,
 *       trough_*, time_to_*pct, sweep_count, last_quoted_at, track_status.
 *   - ct_contract_quotes  (Phase B builds): time-series of contract quotes
 *       (bid/ask/mid/last) keyed by (option_symbol, ts). Read by useContractQuotes.
 *
 * Defensive throughout: tables may not exist on first deploy or may be empty
 * before Phase B's poller starts firing. Every hook returns null/[] on error
 * with retry: false so the UI never crashes and the chip just renders the
 * empty/STALE state until quotes arrive.
 */

import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';

// ---------- types ----------

export type ContractTrackStatus =
  | 'WORKING'
  | 'WIN'
  | 'LOSS'
  | 'EXPIRED_WIN'
  | 'EXPIRED_LOSS'
  | 'EXPIRED_FLAT'
  | 'STALE';

export interface ContractTrackRow {
  id: string;
  alert_id: string;
  option_symbol: string;
  ticker: string;
  side: 'call' | 'put';
  strike: number | null;
  expiry: string | null;          // YYYY-MM-DD
  dte_at_print: number | null;
  print_time: string;             // ISO
  predicted_direction: 'up' | 'down';
  predicted_source: string;
  entry_contract_price: number | null;
  entry_source: 'flow_alert_price' | 'chain_lookup_at_print' | 'estimated_mid';
  current_contract_price: number | null;
  current_contract_pct: number | null;       // signed, decimal: +0.47 = +47%
  peak_contract_price: number | null;
  peak_contract_at: string | null;
  peak_contract_pct: number;                 // absolute magnitude
  trough_contract_price: number | null;
  trough_contract_at: string | null;
  max_drawdown_pct: number;                  // absolute magnitude
  time_to_50pct: string | null;              // ISO 8601 interval
  time_to_100pct: string | null;
  time_to_200pct: string | null;
  track_status: ContractTrackStatus;
  tracking_until: string;
  last_quoted_at: string | null;
  sweep_count: number;
  first_tracked_at: string;
  last_tracked_at: string;
  grading_method: string;
  // Per-symbol identity additions (2026-04-28 dedup migration).
  print_count: number;
  last_print_at: string | null;
  first_alert_id: string | null;
}

const SELECT_COLS =
  'id, alert_id, option_symbol, ticker, side, strike, expiry, dte_at_print, ' +
  'print_time, predicted_direction, predicted_source, ' +
  'entry_contract_price, entry_source, current_contract_price, current_contract_pct, ' +
  'peak_contract_price, peak_contract_at, peak_contract_pct, ' +
  'trough_contract_price, trough_contract_at, max_drawdown_pct, ' +
  'time_to_50pct, time_to_100pct, time_to_200pct, ' +
  'track_status, tracking_until, last_quoted_at, sweep_count, ' +
  'first_tracked_at, last_tracked_at, grading_method, ' +
  'print_count, last_print_at, first_alert_id';

// ---------- single-row lookup (drill sheet) ----------
//
// Post-2026-04-28 per-symbol identity migration: ct_contract_tracks no longer
// has a UNIQUE on alert_id. The append-only ct_contract_track_alerts ledger
// maps alert_id → track_id. We chain through it: alert_id → ledger → track.
// One row per option_symbol (WORKING) means callers see the canonical track
// even when re-prints have been folded in via print_count increment.

export function useContractTrack(
  alertId: string | null,
): UseQueryResult<ContractTrackRow | null> {
  return useQuery<ContractTrackRow | null>({
    queryKey: ['ct_contract_tracks', 'one', alertId],
    enabled: alertId !== null,
    staleTime: 15_000,
    refetchInterval: 30_000,
    retry: false,
    queryFn: async () => {
      if (!alertId) return null;
      // Step 1: alert_id → track_id via ledger.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: ledger, error: ledgerErr } = await (supabase.from as any)('ct_contract_track_alerts')
        .select('track_id')
        .eq('alert_id', alertId)
        .limit(1);
      if (ledgerErr) {
        console.warn('[useContractTrack ledger]', ledgerErr.message);
        return null;
      }
      const trackId = (ledger?.[0] as { track_id?: string } | undefined)?.track_id;
      if (!trackId) return null;
      // Step 2: track_id → full track row.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.from as any)('ct_contract_tracks')
        .select(SELECT_COLS)
        .eq('id', trackId)
        .limit(1);
      if (error) {
        console.warn('[useContractTrack]', error.message);
        return null;
      }
      const rows = (data ?? []) as ContractTrackRow[];
      return rows[0] ?? null;
    },
  });
}

// ---------- by-symbol lookup (drill sheet, canonical track) ----------
//
// Queries ct_contract_tracks directly by option_symbol. After the 2026-04-28
// per-symbol identity migration there is one canonical track per
// option_symbol (UNIQUE INDEX on the WORKING tier, latest for non-WORKING).
// This is the load-bearing read for the drill sheet — it sidesteps the
// alert_id → ledger → track_id chain so re-prints surface the aggregated
// `print_count` / `last_print_at` immediately, even before the ledger row
// for the latest alert lands.
//
// Strategy: pull all rows for the symbol, prefer WORKING (live/active),
// otherwise the most recently updated. Empty / error returns null so the
// drill sheet can fall back to its empty-state card.

export function useContractTrackBySymbol(
  optionSymbol: string | null,
): UseQueryResult<ContractTrackRow | null> {
  return useQuery<ContractTrackRow | null>({
    queryKey: ['ct_contract_tracks', 'by_symbol', optionSymbol],
    enabled: optionSymbol !== null && optionSymbol !== '',
    staleTime: 15_000,
    refetchInterval: 30_000,
    retry: false,
    queryFn: async () => {
      if (!optionSymbol) return null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.from as any)('ct_contract_tracks')
        .select(SELECT_COLS)
        .eq('option_symbol', optionSymbol)
        .order('last_tracked_at', { ascending: false })
        .limit(8);
      if (error) {
        console.warn('[useContractTrackBySymbol]', error.message);
        return null;
      }
      const rows = (data ?? []) as ContractTrackRow[];
      if (rows.length === 0) return null;
      // Prefer WORKING (the canonical live row, guaranteed unique post-migration).
      const working = rows.find((r) => r.track_status === 'WORKING');
      return working ?? rows[0];
    },
  });
}

// ---------- batch lookup (chip column on /tape) ----------
//
// Same chain as useContractTrack but batched. Returns Map<alert_id,
// ContractTrackRow> so callers don't have to re-key. Multiple alert_ids can
// resolve to the SAME track (re-prints of the same contract) — the Map will
// have multiple entries pointing at the same row, which is exactly what the
// chip column wants (one chip per row, all chips for the same contract show
// the canonical state).

export function useContractTracksByAlerts(
  alertIds: string[],
): UseQueryResult<Map<string, ContractTrackRow>> {
  // Stable cache key — sort + join so render-order shifts don't refetch.
  const sorted = [...new Set(alertIds.filter(Boolean))].sort();
  const cacheKey = sorted.join(',');

  return useQuery<Map<string, ContractTrackRow>>({
    queryKey: ['ct_contract_tracks', 'batch', cacheKey],
    enabled: sorted.length > 0,
    staleTime: 15_000,
    refetchInterval: 30_000,
    retry: false,
    queryFn: async () => {
      const out = new Map<string, ContractTrackRow>();
      if (sorted.length === 0) return out;
      const CHUNK = 500;
      // Step 1: alert_id → track_id (and option_symbol) via ledger.
      const alertToTrackId = new Map<string, string>();
      const trackIdSet = new Set<string>();
      for (let i = 0; i < sorted.length; i += CHUNK) {
        const chunk = sorted.slice(i, i + CHUNK);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data, error } = await (supabase.from as any)('ct_contract_track_alerts')
          .select('alert_id, track_id')
          .in('alert_id', chunk);
        if (error) {
          console.warn('[useContractTracksByAlerts ledger]', error.message);
          return out;
        }
        for (const row of (data ?? []) as { alert_id: string; track_id: string }[]) {
          alertToTrackId.set(row.alert_id, row.track_id);
          trackIdSet.add(row.track_id);
        }
      }
      if (trackIdSet.size === 0) return out;
      // Step 2: track_ids → full rows.
      const trackById = new Map<string, ContractTrackRow>();
      const trackIds = Array.from(trackIdSet);
      for (let i = 0; i < trackIds.length; i += CHUNK) {
        const chunk = trackIds.slice(i, i + CHUNK);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data, error } = await (supabase.from as any)('ct_contract_tracks')
          .select(SELECT_COLS)
          .in('id', chunk);
        if (error) {
          console.warn('[useContractTracksByAlerts tracks]', error.message);
          return out;
        }
        for (const row of (data ?? []) as ContractTrackRow[]) {
          trackById.set(row.id, row);
        }
      }
      // Step 3: re-key Map by alert_id so callers can do `map.get(alert_id)`.
      for (const [alertId, trackId] of alertToTrackId.entries()) {
        const t = trackById.get(trackId);
        if (t) out.set(alertId, t);
      }
      return out;
    },
  });
}

// ---------- contract_v1 horizon grades (chips on /tape) ----------

export type ContractGradeHorizon = '30m' | '2h' | 'eod' | 'plus1d';
export type ContractGradeOutcome = 'WIN' | 'LOSS' | 'FLAT';

export interface ContractGradeRow {
  alert_id: string;
  horizon: ContractGradeHorizon;
  grade: ContractGradeOutcome;
  actual_move_pct: number | null;        // signed decimal — +0.50 = +50% on contract
  contract_at_print: number | null;
  contract_at_horizon: number | null;
  threshold_used: number | null;
  graded_at: string;
}

export const CONTRACT_GRADE_HORIZONS: ContractGradeHorizon[] = ['30m', '2h', 'eod', 'plus1d'];

const GRADE_HORIZON_ORDER: Record<ContractGradeHorizon, number> = {
  '30m': 0,
  '2h': 1,
  eod: 2,
  plus1d: 3,
};

const GRADE_SELECT_COLS =
  'alert_id, horizon, grade, actual_move_pct, contract_at_print, contract_at_horizon, threshold_used, graded_at';

/**
 * Batch-fetch contract_v1 horizon grades for a list of alert_ids.
 * Returns Map<alert_id, ContractGradeRow[]> — list per alert because each
 * alert can have up to 4 horizons (30m / 2h / eod / +1d).
 *
 * Empty Map on error / no-data so callers (the chip component) render the
 * placeholder cluster without throwing. Sorted ascending by horizon order.
 */
export function useContractGradesByAlerts(
  alertIds: string[],
): UseQueryResult<Map<string, ContractGradeRow[]>> {
  const sorted = [...new Set(alertIds.filter(Boolean))].sort();
  const cacheKey = sorted.join(',');

  return useQuery<Map<string, ContractGradeRow[]>>({
    queryKey: ['ct_print_grades', 'contract_v1', 'batch', cacheKey],
    enabled: sorted.length > 0,
    staleTime: 60_000,
    refetchInterval: 120_000,
    retry: false,
    queryFn: async () => {
      const out = new Map<string, ContractGradeRow[]>();
      if (sorted.length === 0) return out;
      const CHUNK = 500;
      for (let i = 0; i < sorted.length; i += CHUNK) {
        const chunk = sorted.slice(i, i + CHUNK);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data, error } = await (supabase.from as any)('ct_print_grades')
          .select(GRADE_SELECT_COLS)
          .in('alert_id', chunk)
          .eq('grading_method', 'contract_v1');
        if (error) {
          console.warn('[useContractGradesByAlerts]', error.message);
          return out;
        }
        for (const row of (data ?? []) as ContractGradeRow[]) {
          const list = out.get(row.alert_id) ?? [];
          list.push(row);
          out.set(row.alert_id, list);
        }
      }
      // Sort each list by horizon order so chips render 30m → 2h → eod → +1d.
      for (const list of out.values()) {
        list.sort((a, b) => GRADE_HORIZON_ORDER[a.horizon] - GRADE_HORIZON_ORDER[b.horizon]);
      }
      return out;
    },
  });
}

// ---------- top-peaks query (Edge preview) ----------

export function useTopContractPeaks(
  limit = 10,
  sinceISO: string | null = null,
): UseQueryResult<ContractTrackRow[]> {
  return useQuery<ContractTrackRow[]>({
    queryKey: ['ct_contract_tracks', 'top_peaks', limit, sinceISO],
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: false,
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let q: any = (supabase.from as any)('ct_contract_tracks')
        .select(SELECT_COLS)
        .order('peak_contract_pct', { ascending: false, nullsFirst: false })
        .limit(limit);
      if (sinceISO) q = q.gte('print_time', sinceISO);
      const { data, error } = await q;
      if (error) {
        console.warn('[useTopContractPeaks]', error.message);
        return [];
      }
      return (data ?? []) as ContractTrackRow[];
    },
  });
}

// ---------- realtime subscription ----------

/**
 * Subscribes to UPDATE events on ct_contract_tracks and invalidates the
 * matching React Query caches. Mount once near the top of the page that
 * needs live chip updates (e.g. /tape). Phase B's poller writes UPDATE,
 * not INSERT (rows pre-exist from Phase A's grader pass), so we listen
 * to UPDATE only — saves channel chatter.
 */
export function useContractTracksRealtime(): void {
  const qc = useQueryClient();
  const channelRef = useRef<RealtimeChannel | null>(null);
  const gradesChannelRef = useRef<RealtimeChannel | null>(null);

  useEffect(() => {
    const channel = supabase
      .channel('ct_contract_tracks-realtime')
      .on(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        'postgres_changes' as any,
        { event: 'UPDATE', schema: 'public', table: 'ct_contract_tracks' },
        () => {
          // Invalidate everything keyed off the tracks table. Cheap — these
          // queries are small (<= ~500 rows) and cached for 15s, so this
          // typically just marks them stale and the next paint refetches.
          qc.invalidateQueries({ queryKey: ['ct_contract_tracks'] });
        },
      )
      .subscribe();
    channelRef.current = channel;

    // Second channel: refresh horizon-grade chips when a new contract_v1 grade
    // lands. Filter at the postgres_changes layer so we don't wake on the much
    // higher-volume underlying_v1 INSERTs.
    const gradesChannel = supabase
      .channel('ct_print_grades-contract_v1-realtime')
      .on(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        'postgres_changes' as any,
        {
          event: 'INSERT',
          schema: 'public',
          table: 'ct_print_grades',
          filter: 'grading_method=eq.contract_v1',
        },
        () => {
          qc.invalidateQueries({ queryKey: ['ct_print_grades', 'contract_v1'] });
        },
      )
      .subscribe();
    gradesChannelRef.current = gradesChannel;

    return () => {
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }
      if (gradesChannelRef.current) {
        supabase.removeChannel(gradesChannelRef.current);
        gradesChannelRef.current = null;
      }
    };
  }, [qc]);
}

// ---------- formatting helpers (contract-axis specific) ----------

/**
 * Format a SIGNED decimal-fraction P&L as a percentage string.
 * 0.47 -> "+47%", -0.12 -> "-12%". Differs from useEdge.fmtPct which expects
 * already-percent values (47 -> "+47.0%").
 */
export function fmtPctFromFraction(
  v: number | null | undefined,
  digits?: number,
): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const pct = v * 100;
  const sign = pct >= 0 ? '+' : '−';
  const abs = Math.abs(pct);
  // Auto-precision: sub-1% needs decimals or it renders "+0%" on every tick;
  // single-digit % gets 1 decimal; bigger numbers drop decimals for compactness.
  const d = digits ?? (abs < 1 ? 2 : abs < 10 ? 1 : 0);
  return `${sign}${abs.toFixed(d)}%`;
}

/**
 * Format an ABSOLUTE-magnitude decimal fraction as a percent string.
 * Always positive sign. 50.0 -> "+5,000%".
 */
export function fmtPctMagnitude(
  v: number | null | undefined,
  digits = 0,
): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const pct = Math.abs(v) * 100;
  return `+${pct.toLocaleString('en-US', { maximumFractionDigits: digits })}%`;
}

/** Parse a Postgres ISO 8601 interval (e.g. "PT1H23M") into a friendly label. */
export function fmtInterval(v: string | null | undefined): string {
  if (!v) return '—';
  // PostgREST returns intervals as "HH:MM:SS" or ISO 8601 ("P0Y0M0DT1H23M")
  // depending on schema settings. Handle both common shapes.
  const iso = v.match(/^P(?:\d+Y)?(?:\d+M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/);
  if (iso) {
    const [, dStr, hStr, mStr] = iso;
    const d = dStr ? parseInt(dStr, 10) : 0;
    const h = hStr ? parseInt(hStr, 10) : 0;
    const m = mStr ? parseInt(mStr, 10) : 0;
    const totalH = d * 24 + h;
    if (totalH === 0 && m === 0) return '<1m';
    if (totalH === 0) return `${m}m`;
    if (m === 0) return `${totalH}h`;
    return `${totalH}h ${m}m`;
  }
  const hms = v.match(/^(\d+):(\d+):(\d+)/);
  if (hms) {
    const h = parseInt(hms[1], 10);
    const m = parseInt(hms[2], 10);
    if (h === 0 && m === 0) return '<1m';
    if (h === 0) return `${m}m`;
    if (m === 0) return `${h}h`;
    return `${h}h ${m}m`;
  }
  return v;
}

/** Add a Postgres interval to a base ISO time. Returns null if either input is missing. */
export function addInterval(baseISO: string | null, interval: string | null): string | null {
  if (!baseISO || !interval) return null;
  const base = Date.parse(baseISO);
  if (!Number.isFinite(base)) return null;
  const iso = interval.match(/^P(?:\d+Y)?(?:\d+M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/);
  let ms = 0;
  if (iso) {
    const [, dStr, hStr, mStr, sStr] = iso;
    ms += (dStr ? parseInt(dStr, 10) : 0) * 86_400_000;
    ms += (hStr ? parseInt(hStr, 10) : 0) * 3_600_000;
    ms += (mStr ? parseInt(mStr, 10) : 0) * 60_000;
    ms += (sStr ? parseFloat(sStr) : 0) * 1000;
  } else {
    const hms = interval.match(/^(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (!hms) return null;
    ms += parseInt(hms[1], 10) * 3_600_000;
    ms += parseInt(hms[2], 10) * 60_000;
    ms += parseFloat(hms[3]) * 1000;
  }
  return new Date(base + ms).toISOString();
}
