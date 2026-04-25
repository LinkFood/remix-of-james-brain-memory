/**
 * useAlarms — full-table feed for the /alarms calibration page.
 *
 * Reads ct_flags filtered by source='signature_alarm' inside a configurable
 * day window, then subscribes to realtime INSERTs to push new rows in without
 * a refetch. Mirrors the bootstrap-fetch + realtime pattern in
 * useAlarmRealtime, but returns a sortable table shape (not a 60s glow queue).
 *
 * Outcome lookup: source_flow_ids[0] is the alert_id that ct_contract_tracks
 * is keyed on. We batch-fetch tracks for the visible alarms in a separate,
 * non-blocking query so the table renders alarms immediately and fills in
 * outcome chips as data arrives.
 *
 * Realtime caveat (per user-scope memory): ALTER PUBLICATION succeeded but
 * INSERT delivery isn't guaranteed — the bootstrap fetch is the floor, the
 * subscription is the optimization.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type AlarmTier = 'gold' | 'silver' | 'bronze' | 'unknown';
export type AlarmDayFilter = 'today' | 'yesterday' | 'last3d' | 'all';
export type AlarmTypeFilter = 'all' | 'live' | 'replay';
export type AlarmTierFilter = 'all' | 'gold' | 'silver' | 'bronze';

export interface AlarmRow {
  id: string;
  ticker: string;
  optionSymbol: string;
  side: 'call' | 'put' | null;
  strike: number | null;
  expiry: string | null;
  direction: string | null;
  score: number | null;
  tier: AlarmTier;
  thesis: string | null;
  horizonHours: number | null;
  entryPrice: number | null;
  targetPrice: number | null;
  status: string | null;
  isReplay: boolean;
  alertId: string | null;
  createdAt: string;
}

export type ContractOutcomeStatus = 'WIN' | 'LOSS' | 'WORKING' | 'EXPIRED' | 'UNKNOWN';

export interface ContractOutcome {
  status: ContractOutcomeStatus;
  peakPct: number;
  currentPct: number;
}

interface CtFlagRow {
  id: string;
  instrument: string | null;
  option_symbol: string | null;
  side: 'call' | 'put' | null;
  strike: number | null;
  expiry: string | null;
  direction: string | null;
  score: number | null;
  tags: string[] | null;
  thesis: string | null;
  horizon_hours: number | null;
  entry_price: number | null;
  target_price: number | null;
  status: string | null;
  source_flow_ids: string[] | null;
  created_at: string;
}

const SELECT_COLS =
  'id, instrument, option_symbol, side, strike, expiry, direction, score, tags, thesis, horizon_hours, entry_price, target_price, status, source_flow_ids, created_at';

function parseTier(tags: string[] | null | undefined): AlarmTier {
  if (!tags) return 'unknown';
  if (tags.includes('gold')) return 'gold';
  if (tags.includes('silver')) return 'silver';
  if (tags.includes('bronze')) return 'bronze';
  return 'unknown';
}

function rowToAlarm(row: CtFlagRow): AlarmRow {
  const isReplay = (row.tags ?? []).includes('replay');
  const alertId = Array.isArray(row.source_flow_ids) && row.source_flow_ids.length > 0
    ? String(row.source_flow_ids[0])
    : null;
  return {
    id: row.id,
    ticker: row.instrument ?? '',
    optionSymbol: row.option_symbol ?? '',
    side: row.side,
    strike: row.strike,
    expiry: row.expiry,
    direction: row.direction,
    score: row.score,
    tier: parseTier(row.tags),
    thesis: row.thesis,
    horizonHours: row.horizon_hours,
    entryPrice: row.entry_price,
    targetPrice: row.target_price,
    status: row.status,
    isReplay,
    alertId,
    createdAt: row.created_at,
  };
}

/** Returns the lower-bound ISO timestamp for the day filter — null = no filter. */
function dayFilterFloor(filter: AlarmDayFilter): string | null {
  if (filter === 'all') return null;
  // Anchor to ET midnight to match the user's mental model of "today".
  const now = new Date();
  const etDateStr = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const todayMidnightEt = new Date(`${etDateStr}T00:00:00-04:00`);
  if (filter === 'today') return todayMidnightEt.toISOString();
  if (filter === 'yesterday') {
    const y = new Date(todayMidnightEt.getTime() - 86_400_000);
    return y.toISOString();
  }
  if (filter === 'last3d') {
    const d = new Date(todayMidnightEt.getTime() - 3 * 86_400_000);
    return d.toISOString();
  }
  return null;
}

interface UseAlarmsArgs {
  tier?: AlarmTierFilter;
  type?: AlarmTypeFilter;
  dayFilter?: AlarmDayFilter;
}

interface UseAlarmsResult {
  alarms: AlarmRow[];
  outcomes: Map<string, ContractOutcome>;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
}

export function useAlarms({
  tier = 'all',
  type = 'all',
  dayFilter = 'today',
}: UseAlarmsArgs): UseAlarmsResult {
  const floorIso = useMemo(() => dayFilterFloor(dayFilter), [dayFilter]);
  // Realtime pushes land here; bootstrap query seeds it on (re)mount.
  const [liveAlarms, setLiveAlarms] = useState<AlarmRow[]>([]);
  const channelRef = useRef<RealtimeChannel | null>(null);

  // Bootstrap fetch — keyed on day window so changing the chip refetches.
  const { data: bootstrap, isLoading, isError, refetch } = useQuery<AlarmRow[]>({
    queryKey: ['ct_signature_alarms', floorIso ?? 'all'],
    refetchInterval: 30_000,
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let q: any = (supabase.from('ct_flags' as never) as any)
        .select(SELECT_COLS)
        .eq('source', 'signature_alarm')
        .order('created_at', { ascending: false })
        .limit(500);
      if (floorIso) q = q.gte('created_at', floorIso);
      const { data, error } = await q;
      if (error) throw error;
      return ((data ?? []) as CtFlagRow[]).map(rowToAlarm);
    },
  });

  // When bootstrap data lands, replace the merged-live list (preserve any
  // realtime rows that arrived after the bootstrap snapshot).
  useEffect(() => {
    if (!bootstrap) return;
    setLiveAlarms((prev) => {
      const seen = new Set(bootstrap.map((a) => a.id));
      const newer = prev.filter((a) => !seen.has(a.id));
      return [...newer, ...bootstrap];
    });
  }, [bootstrap]);

  // Realtime subscription — INSERT-only on signature_alarm rows.
  useEffect(() => {
    const channel = supabase
      .channel('ct_flags-alarms-page')
      .on(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        'postgres_changes' as any,
        {
          event: 'INSERT',
          schema: 'public',
          table: 'ct_flags',
          filter: 'source=eq.signature_alarm',
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (payload: any) => {
          const row = payload?.new as CtFlagRow | undefined;
          if (!row) return;
          const alarm = rowToAlarm(row);
          setLiveAlarms((prev) => {
            if (prev.some((a) => a.id === alarm.id)) return prev;
            return [alarm, ...prev];
          });
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
  }, []);

  // Apply client-side filters (tier / type) over the merged set.
  const alarms = useMemo(() => {
    const floorMs = floorIso ? Date.parse(floorIso) : null;
    return liveAlarms
      .filter((a) => {
        if (floorMs != null && Date.parse(a.createdAt) < floorMs) return false;
        if (tier !== 'all' && a.tier !== tier) return false;
        if (type === 'live' && a.isReplay) return false;
        if (type === 'replay' && !a.isReplay) return false;
        return true;
      })
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }, [liveAlarms, tier, type, floorIso]);

  // Outcome lookup — non-blocking, batched on visible alert IDs.
  const alertIds = useMemo(
    () => Array.from(new Set(alarms.map((a) => a.alertId).filter((x): x is string => !!x))),
    [alarms],
  );

  const { data: outcomes } = useQuery<Map<string, ContractOutcome>>({
    queryKey: ['ct_contract_tracks_for_alarms', alertIds],
    enabled: alertIds.length > 0,
    refetchInterval: 60_000,
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.from('ct_contract_tracks' as never) as any)
        .select('alert_id, peak_contract_pct, current_contract_pct, track_status')
        .in('alert_id', alertIds);
      if (error) throw error;
      const m = new Map<string, ContractOutcome>();
      for (const row of (data ?? []) as Array<{
        alert_id: string;
        peak_contract_pct: number | null;
        current_contract_pct: number | null;
        track_status: string | null;
      }>) {
        const status: ContractOutcomeStatus =
          row.track_status === 'WIN' ? 'WIN' :
          row.track_status === 'LOSS' ? 'LOSS' :
          row.track_status === 'WORKING' ? 'WORKING' :
          row.track_status === 'EXPIRED' ? 'EXPIRED' :
          'UNKNOWN';
        m.set(row.alert_id, {
          status,
          peakPct: Number(row.peak_contract_pct ?? 0),
          currentPct: Number(row.current_contract_pct ?? 0),
        });
      }
      return m;
    },
  });

  return {
    alarms,
    outcomes: outcomes ?? new Map(),
    isLoading,
    isError,
    refetch,
  };
}
