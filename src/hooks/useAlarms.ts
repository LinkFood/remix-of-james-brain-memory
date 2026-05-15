/**
 * useAlarms — full-table feed for the /alarms calibration page.
 *
 * Reads ct_flags filtered by source='signature_alarm' inside a configurable
 * day window, then subscribes to realtime INSERTs to push new rows in without
 * a refetch. Mirrors the bootstrap-fetch + realtime pattern in
 * useAlarmRealtime, but returns a sortable table shape (not a 60s glow queue).
 *
 * Outcome lookup chain (2-hop, post Ship 9b 2026-05-14):
 *   ct_flags.source_flow_ids[0] → ct_scored_flow.id (BIGINT)
 *   ct_scored_flow.source_id     → ct_flow_alerts.id (UUID)
 *   ct_contract_tracks.alert_id  = that UUID
 *
 * Pre-Ship-9b, ct_flags.source_flow_ids was assumed to be `string[]` of
 * UUIDs lined up with ct_contract_tracks.alert_id directly — but Ship 9b's
 * Phase A surfaced the actual schema: BIGINT[] referencing ct_scored_flow.id
 * (BIGSERIAL). Reading source_flow_ids[0] as a UUID and joining .in('alert_id', ...)
 * matched zero rows; outcome chips never populated for signature_alarm rows.
 * Fix: thread the 2-hop. AlarmRow.scoredFlowId carries the stringified BIGINT
 * (stable synchronous key for Map indexing); outcome useQuery does the 2-hop
 * internally and re-keys the result Map by scoredFlowId so downstream code
 * stays clean.
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
export type AlarmRegime = 'trending_up' | 'trending_down' | 'chop' | 'unknown';
export type AlarmRegimeFilter = 'all' | AlarmRegime;

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
  detectorId: string | null;
  thesis: string | null;
  horizonHours: number | null;
  entryPrice: number | null;
  targetPrice: number | null;
  status: string | null;
  isReplay: boolean;
  /**
   * Stringified ct_scored_flow.id (BIGINT) — the first element of
   * ct_flags.source_flow_ids. Stable synchronous key for outcome Map
   * indexing. Pre-Ship-9b this field was named `alertId` and assumed to
   * carry a ct_flow_alerts.id UUID; that assumption was structurally
   * wrong (column is BIGINT[], not UUID[]). The 2-hop to the real
   * contract-track row happens inside the outcome useQuery.
   */
  scoredFlowId: string | null;
  createdAt: string;
  pulseRegime: AlarmRegime;
  pulseNetPremium: number | null;
  pulseSlope5min: number | null;
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
  detector_id: string | null;
  thesis: string | null;
  horizon_hours: number | null;
  entry_price: number | null;
  target_price: number | null;
  status: string | null;
  /**
   * Postgres BIGINT[] referencing ct_scored_flow.id (BIGSERIAL). PostgREST
   * serializes BIGINT as either number or string depending on size — accept
   * both, coerce to string downstream for stable Map keying.
   */
  source_flow_ids: (number | string)[] | null;
  created_at: string;
  pulse_regime_at_fire: string | null;
  pulse_net_premium_at_fire: number | string | null;
  pulse_slope_5min_at_fire: number | string | null;
}

const SELECT_COLS =
  'id, instrument, option_symbol, side, strike, expiry, direction, score, tags, detector_id, thesis, horizon_hours, entry_price, target_price, status, source_flow_ids, created_at, pulse_regime_at_fire, pulse_net_premium_at_fire, pulse_slope_5min_at_fire';

function parseTier(tags: string[] | null | undefined): AlarmTier {
  if (!tags) return 'unknown';
  if (tags.includes('gold')) return 'gold';
  if (tags.includes('silver')) return 'silver';
  if (tags.includes('bronze')) return 'bronze';
  return 'unknown';
}

function parseRegime(v: string | null | undefined): AlarmRegime {
  if (v === 'trending_up' || v === 'trending_down' || v === 'chop') return v;
  return 'unknown';
}

function toNumOrNull(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function rowToAlarm(row: CtFlagRow): AlarmRow {
  const isReplay = (row.tags ?? []).includes('replay');
  // source_flow_ids[0] is a BIGINT (ct_scored_flow.id). Coerce to string for
  // stable Map keying in the outcome lookup. See module docstring for the
  // 2-hop chain to ct_contract_tracks.
  const scoredFlowId = Array.isArray(row.source_flow_ids) && row.source_flow_ids.length > 0
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
    detectorId: row.detector_id ?? null,
    thesis: row.thesis,
    horizonHours: row.horizon_hours,
    entryPrice: row.entry_price,
    targetPrice: row.target_price,
    status: row.status,
    isReplay,
    scoredFlowId,
    createdAt: row.created_at,
    pulseRegime: parseRegime(row.pulse_regime_at_fire),
    pulseNetPremium: toNumOrNull(row.pulse_net_premium_at_fire),
    pulseSlope5min: toNumOrNull(row.pulse_slope_5min_at_fire),
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

// 'all' = no filter; any other string = exact detector_id match. Detector
// filter is exact-match because the registry id is a stable slug.
export type AlarmDetectorFilter = 'all' | string;

interface UseAlarmsArgs {
  tier?: AlarmTierFilter;
  type?: AlarmTypeFilter;
  dayFilter?: AlarmDayFilter;
  detector?: AlarmDetectorFilter;
  regime?: AlarmRegimeFilter;
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
  detector = 'all',
  regime = 'all',
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
        if (detector !== 'all' && a.detectorId !== detector) return false;
        if (regime !== 'all' && a.pulseRegime !== regime) return false;
        return true;
      })
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }, [liveAlarms, tier, type, floorIso, detector, regime]);

  // Outcome lookup — 2-hop, non-blocking, batched on visible scored_flow_ids.
  // Pre-Ship-9b this hook did a single .in('alert_id', source_flow_ids)
  // assuming source_flow_ids were UUIDs. Reality: source_flow_ids is BIGINT[]
  // referencing ct_scored_flow.id; ct_contract_tracks.alert_id is text-UUID
  // matching ct_flow_alerts.id; the bridge is ct_scored_flow.source_id (when
  // source_table='ct_flow_alerts'). Two queries, mapped back to scoredFlowId
  // so downstream Map keying stays stable.
  const scoredFlowIds = useMemo(
    () => Array.from(new Set(alarms.map((a) => a.scoredFlowId).filter((x): x is string => !!x))),
    [alarms],
  );

  const { data: outcomes } = useQuery<Map<string, ContractOutcome>>({
    queryKey: ['ct_contract_tracks_for_alarms', scoredFlowIds],
    enabled: scoredFlowIds.length > 0,
    refetchInterval: 60_000,
    queryFn: async () => {
      // Hop 1: resolve scored_flow.id → underlying ct_flow_alerts.id UUID.
      // PostgREST will accept stringified BIGINTs in .in() — the column is
      // BIGINT, PostgREST coerces.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: scoredRows, error: scoredErr } = await (supabase.from('ct_scored_flow' as never) as any)
        .select('id, source_id, source_table')
        .in('id', scoredFlowIds);
      if (scoredErr) throw scoredErr;
      // scoredFlowId (stringified) → ct_flow_alerts.id UUID
      const scoredToAlert = new Map<string, string>();
      const alertUuids: string[] = [];
      for (const row of (scoredRows ?? []) as Array<{
        id: number | string;
        source_id: string | null;
        source_table: string | null;
      }>) {
        // Only ct_flow_alerts-sourced rows have a usable contract-track UUID.
        // Other source_tables would need different routing (none currently
        // surface via ct-signature-watcher → /alarms).
        if (row.source_table === 'ct_flow_alerts' && row.source_id) {
          scoredToAlert.set(String(row.id), row.source_id);
          alertUuids.push(row.source_id);
        }
      }
      if (alertUuids.length === 0) return new Map<string, ContractOutcome>();

      // Hop 2: fetch contract tracks keyed by the resolved alert_id UUIDs.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: trackRows, error: trackErr } = await (supabase.from('ct_contract_tracks' as never) as any)
        .select('alert_id, peak_contract_pct, current_contract_pct, track_status')
        .in('alert_id', alertUuids);
      if (trackErr) throw trackErr;
      // alert_id UUID → ContractOutcome
      const byAlertId = new Map<string, ContractOutcome>();
      for (const row of (trackRows ?? []) as Array<{
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
        byAlertId.set(row.alert_id, {
          status,
          peakPct: Number(row.peak_contract_pct ?? 0),
          currentPct: Number(row.current_contract_pct ?? 0),
        });
      }

      // Re-key the result Map by scoredFlowId so consumers (Alarms.tsx) can
      // look up via the stable synchronous key on AlarmRow.
      const byScoredFlowId = new Map<string, ContractOutcome>();
      for (const [scoredFlowIdStr, alertUuid] of scoredToAlert) {
        const outcome = byAlertId.get(alertUuid);
        if (outcome) byScoredFlowId.set(scoredFlowIdStr, outcome);
      }
      return byScoredFlowId;
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
