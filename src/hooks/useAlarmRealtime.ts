/**
 * useAlarmRealtime — live-glow + banner feed for ct-signature-watcher tiered alarms.
 *
 * Subscribes to INSERT events on ct_flags filtered by source=signature_alarm.
 * The watcher writes one row per fired alarm with tags including the tier
 * ('gold' / 'silver' / 'bronze') alongside the signature-class tag, e.g.
 *   ['signature_alarm', 'QQQ:call:short:aggressive_bid_call', 'gold']
 *
 * State shape:
 *   recentAlarms      — last 20 alarms ordered DESC by firedAt (drives banner)
 *   activeAlarms      — Set<option_symbol> still inside the 60s glow window
 *   glowingForSymbol  — highest-tier glow currently active for a given symbol
 *
 * On mount we bootstrap the last 20 signature_alarm rows so the banner has
 * something to show immediately if alarms fired moments before nav.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';

export type AlarmTier = 'gold' | 'silver' | 'bronze' | 'unknown';

export interface ActiveAlarm {
  id: string;
  optionSymbol: string;
  ticker: string;
  direction: string | null;
  tier: AlarmTier;
  thesis: string | null;
  firedAt: string;
}

export interface UseAlarmRealtimeResult {
  recentAlarms: ActiveAlarm[];
  activeAlarms: Set<string>;
  glowingForSymbol: (sym: string) => 'gold' | 'silver' | 'bronze' | null;
}

const MAX_RECENT = 20;
const GLOW_WINDOW_MS = 60_000;
// Tier ordering — used to pick the strongest glow when multiple alarms hit
// the same option_symbol inside the active window.
const TIER_RANK: Record<AlarmTier, number> = {
  gold: 3,
  silver: 2,
  bronze: 1,
  unknown: 0,
};

interface CtFlagInsertRow {
  id: string;
  option_symbol: string | null;
  instrument: string | null;
  direction: string | null;
  tags: string[] | null;
  thesis: string | null;
  created_at: string;
}

function parseTier(tags: string[] | null | undefined): AlarmTier {
  if (!tags) return 'unknown';
  // Tags array order isn't guaranteed — scan for the first tier match.
  if (tags.includes('gold')) return 'gold';
  if (tags.includes('silver')) return 'silver';
  if (tags.includes('bronze')) return 'bronze';
  return 'unknown';
}

function rowToAlarm(row: CtFlagInsertRow): ActiveAlarm | null {
  if (!row.option_symbol) return null;
  return {
    id: row.id,
    optionSymbol: row.option_symbol,
    ticker: row.instrument ?? '',
    direction: row.direction,
    tier: parseTier(row.tags),
    thesis: row.thesis,
    firedAt: row.created_at,
  };
}

const SELECT_COLS = 'id, option_symbol, instrument, direction, tags, thesis, created_at';

export function useAlarmRealtime(): UseAlarmRealtimeResult {
  const [recentAlarms, setRecentAlarms] = useState<ActiveAlarm[]>([]);
  // tick state forces re-render every second so glow expiry surfaces in the UI
  // without us recomputing recentAlarms.
  const [, setTick] = useState(0);
  const channelRef = useRef<RealtimeChannel | null>(null);

  // Bootstrap: fetch the most recent N signature_alarm rows on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.from as any)('ct_flags')
        .select(SELECT_COLS)
        .eq('source', 'signature_alarm')
        .order('created_at', { ascending: false })
        .limit(MAX_RECENT);
      if (cancelled) return;
      if (error) {
        console.warn('[useAlarmRealtime bootstrap]', error.message);
        return;
      }
      const alarms = ((data ?? []) as CtFlagInsertRow[])
        .map(rowToAlarm)
        .filter((a): a is ActiveAlarm => a !== null);
      setRecentAlarms(alarms);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Realtime subscription — INSERT only, server-side filter on source.
  useEffect(() => {
    const channel = supabase
      .channel('ct_flags-signature-alarm-realtime')
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
          const row = payload?.new as CtFlagInsertRow | undefined;
          if (!row) return;
          const alarm = rowToAlarm(row);
          if (!alarm) return;
          setRecentAlarms((prev) => {
            // Dedupe by id (Realtime can deliver duplicates after reconnect).
            if (prev.some((a) => a.id === alarm.id)) return prev;
            const next = [alarm, ...prev];
            return next.length > MAX_RECENT ? next.slice(0, MAX_RECENT) : next;
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

  // 1Hz tick so glow window expirations (60s after fire) surface without
  // depending on a new alarm to trigger a re-render.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => (t + 1) % 1_000_000), 1000);
    return () => clearInterval(id);
  }, []);

  // Derive the active set fresh each render — keeps the source of truth in
  // recentAlarms + wall clock, no separate state to drift out of sync.
  const now = Date.now();
  const activeAlarms = new Set<string>();
  const symbolToTier = new Map<string, AlarmTier>();
  for (const a of recentAlarms) {
    const firedMs = Date.parse(a.firedAt);
    if (!Number.isFinite(firedMs)) continue;
    if (now - firedMs > GLOW_WINDOW_MS) continue;
    activeAlarms.add(a.optionSymbol);
    const existing = symbolToTier.get(a.optionSymbol);
    if (!existing || TIER_RANK[a.tier] > TIER_RANK[existing]) {
      symbolToTier.set(a.optionSymbol, a.tier);
    }
  }

  const glowingForSymbol = useCallback(
    (sym: string): 'gold' | 'silver' | 'bronze' | null => {
      const t = symbolToTier.get(sym);
      if (!t || t === 'unknown') return null;
      return t;
    },
    // symbolToTier is rebuilt every render — closure captures the current map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [recentAlarms],
  );

  return { recentAlarms, activeAlarms, glowingForSymbol };
}
