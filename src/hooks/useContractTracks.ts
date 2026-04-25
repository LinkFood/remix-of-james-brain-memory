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
}

const SELECT_COLS =
  'id, alert_id, option_symbol, ticker, side, strike, expiry, dte_at_print, ' +
  'print_time, predicted_direction, predicted_source, ' +
  'entry_contract_price, entry_source, current_contract_price, current_contract_pct, ' +
  'peak_contract_price, peak_contract_at, peak_contract_pct, ' +
  'trough_contract_price, trough_contract_at, max_drawdown_pct, ' +
  'time_to_50pct, time_to_100pct, time_to_200pct, ' +
  'track_status, tracking_until, last_quoted_at, sweep_count, ' +
  'first_tracked_at, last_tracked_at, grading_method';

// ---------- single-row lookup (drill sheet) ----------

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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.from as any)('ct_contract_tracks')
        .select(SELECT_COLS)
        .eq('alert_id', alertId)
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

// ---------- batch lookup (chip column on /tape) ----------

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
      // PostgREST .in() works for thousands; chunk defensively at 500 anyway.
      const CHUNK = 500;
      for (let i = 0; i < sorted.length; i += CHUNK) {
        const chunk = sorted.slice(i, i + CHUNK);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data, error } = await (supabase.from as any)('ct_contract_tracks')
          .select(SELECT_COLS)
          .in('alert_id', chunk);
        if (error) {
          console.warn('[useContractTracksByAlerts]', error.message);
          return out;
        }
        for (const row of (data ?? []) as ContractTrackRow[]) {
          out.set(row.alert_id, row);
        }
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

    return () => {
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
        channelRef.current = null;
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
  digits = 0,
): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const pct = v * 100;
  const sign = pct >= 0 ? '+' : '−';
  return `${sign}${Math.abs(pct).toFixed(digits)}%`;
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
