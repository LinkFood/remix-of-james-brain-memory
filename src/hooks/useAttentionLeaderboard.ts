/**
 * useAttentionLeaderboard — per-ticker attention aggregate over the last 30 min.
 *
 * Consumes the same four ct_* tables that feed ct_attention_stream (observations,
 * flags, alerts, heartbeats). We query the source tables directly rather than
 * ct_attention_stream because:
 *
 *   - The view exposes (kind, id, created_at, attention_score, summary) — NO
 *     ticker column, NO instruments array. Parsing tickers out of the summary
 *     string is fragile (summaries are free-form glance text).
 *   - ct_observations / ct_flags / ct_alerts already carry an `instruments[]`
 *     array (used by useTickerDensity). That's the canonical source of truth
 *     for "which ticker does this event apply to."
 *   - ct_heartbeats has a `watching[]` array at session scope — attributing
 *     a heartbeat's attention_score to every watched ticker over-weights
 *     every ticker equally, so we skip heartbeats (they're session-scale,
 *     not per-ticker signals).
 *
 * Each event is attributed to EVERY ticker in its instruments[]. A NVDA+SPY
 * flag at score 70 counts as a 70 for both NVDA and SPY.
 *
 * Scoring formula (per ticker, within 30-min window):
 *
 *   base     = max(attention_score of all events attributed to this ticker)
 *   recency  = 1.5x multiplier applied to events in the last 5 minutes when
 *              they would raise `base` (we take the max of (base, score*1.5)
 *              across recent events)
 *   volume   = +10 if total events in window >= 3
 *   score    = round(clamp(base * recency_factor + volume_bonus, 0, 100))
 *
 * No new edge functions. No new tables. Pure client-side aggregation.
 */
import { useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export const LEADERBOARD_TICKERS = [
  'SPY', 'QQQ', 'IWM',
  'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'TSLA',
] as const;

export type LeaderboardTicker = typeof LEADERBOARD_TICKERS[number];

const WATCHED_SET = new Set<string>(LEADERBOARD_TICKERS);

export interface LeaderboardEntry {
  ticker: string;
  score: number;
  event_count: number;
  recent_count_5min: number;
  top_event_kind: 'observation' | 'flag' | 'alert';
}

interface RawAttentionRow {
  kind: 'observation' | 'flag' | 'alert';
  id: string;
  instruments: string[] | null;
  attention_score: number | null;
  created_at: string;
}

/**
 * Batched read of the three ticker-carrying attention sources. Heartbeats are
 * intentionally excluded — see module header.
 *
 * Single React Query cache key — one round trip per refresh.
 */
function useAttentionRows(windowMinutes: number) {
  const qc = useQueryClient();

  // Realtime invalidation on new attention-producing rows so the leaderboard
  // reflects fresh events without waiting for the next 60s poll.
  useEffect(() => {
    const chan = supabase
      .channel('ct_attention_leaderboard')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'ct_observations' }, () => qc.invalidateQueries({ queryKey: ['ct_attention_leaderboard_rows'] }))
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'ct_flags' }, () => qc.invalidateQueries({ queryKey: ['ct_attention_leaderboard_rows'] }))
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'ct_alerts' }, () => qc.invalidateQueries({ queryKey: ['ct_attention_leaderboard_rows'] }))
      .subscribe();
    return () => { supabase.removeChannel(chan); };
  }, [qc]);

  return useQuery<RawAttentionRow[]>({
    queryKey: ['ct_attention_leaderboard_rows', windowMinutes],
    refetchInterval: 60_000,
    queryFn: async () => {
      const since = new Date(Date.now() - windowMinutes * 60_000).toISOString();
      const [obs, flags, alerts] = await Promise.all([
        supabase
          .from('ct_observations')
          .select('id, instruments, attention_score, created_at')
          .gte('created_at', since)
          .order('created_at', { ascending: false })
          .limit(200),
        supabase
          .from('ct_flags')
          .select('id, instruments, attention_score, created_at')
          .gte('created_at', since)
          .order('created_at', { ascending: false })
          .limit(200),
        supabase
          .from('ct_alerts')
          .select('id, instruments, attention_score, created_at')
          .gte('created_at', since)
          .order('created_at', { ascending: false })
          .limit(200),
      ]);
      const rows: RawAttentionRow[] = [];
      for (const r of (obs.data ?? []) as Array<Record<string, unknown>>) {
        rows.push({
          kind: 'observation',
          id: r.id as string,
          instruments: (r.instruments as string[] | null) ?? null,
          attention_score: (r.attention_score as number | null) ?? null,
          created_at: r.created_at as string,
        });
      }
      for (const r of (flags.data ?? []) as Array<Record<string, unknown>>) {
        rows.push({
          kind: 'flag',
          id: r.id as string,
          instruments: (r.instruments as string[] | null) ?? null,
          attention_score: (r.attention_score as number | null) ?? null,
          created_at: r.created_at as string,
        });
      }
      for (const r of (alerts.data ?? []) as Array<Record<string, unknown>>) {
        rows.push({
          kind: 'alert',
          id: r.id as string,
          instruments: (r.instruments as string[] | null) ?? null,
          attention_score: (r.attention_score as number | null) ?? null,
          created_at: r.created_at as string,
        });
      }
      return rows;
    },
  });
}

/**
 * Per-ticker attention leaderboard. Memoized so downstream render is cheap —
 * rows only change on the 60s refetch or realtime INSERT invalidation.
 */
export function useAttentionLeaderboard(
  windowMinutes = 30,
  recentMinutes = 5,
): { data: LeaderboardEntry[]; isLoading: boolean } {
  const { data: rows, isLoading } = useAttentionRows(windowMinutes);

  const data = useMemo<LeaderboardEntry[]>(() => {
    if (!rows || rows.length === 0) return [];

    const now = Date.now();
    const recentCutoff = now - recentMinutes * 60_000;

    interface Bucket {
      scoreBase: number;                // best effective score seen (with recency 1.5x applied)
      eventCount: number;
      recentCount: number;
      topKind: 'observation' | 'flag' | 'alert';
      topRawScore: number;              // un-boosted score of the `topKind` event (for tie-breaking on kind)
    }
    const buckets = new Map<string, Bucket>();

    for (const r of rows) {
      const raw = r.attention_score ?? 0;
      if (raw <= 0) continue;
      const ts = Date.parse(r.created_at);
      const isRecent = ts >= recentCutoff;
      const boosted = isRecent ? raw * 1.5 : raw;
      const instruments = r.instruments ?? [];
      for (const inst of instruments) {
        const T = (inst ?? '').toUpperCase();
        if (!T || !WATCHED_SET.has(T)) continue;
        let b = buckets.get(T);
        if (!b) {
          b = { scoreBase: 0, eventCount: 0, recentCount: 0, topKind: r.kind, topRawScore: 0 };
          buckets.set(T, b);
        }
        b.eventCount += 1;
        if (isRecent) b.recentCount += 1;
        if (boosted > b.scoreBase) b.scoreBase = boosted;
        if (raw > b.topRawScore) {
          b.topRawScore = raw;
          b.topKind = r.kind;
        }
      }
    }

    const out: LeaderboardEntry[] = [];
    for (const [ticker, b] of buckets) {
      const volumeBonus = b.eventCount >= 3 ? 10 : 0;
      const final = Math.max(0, Math.min(100, Math.round(b.scoreBase + volumeBonus)));
      out.push({
        ticker,
        score: final,
        event_count: b.eventCount,
        recent_count_5min: b.recentCount,
        top_event_kind: b.topKind,
      });
    }

    out.sort((a, b) => b.score - a.score || b.event_count - a.event_count);
    return out;
  }, [rows, recentMinutes]);

  return { data, isLoading };
}
