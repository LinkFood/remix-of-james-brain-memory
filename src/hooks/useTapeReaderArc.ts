/**
 * useTapeReaderArc — today's full chronological tape commentary stream for
 * the v2 Alpha surface "Tape Reader Arc" component (Phase 3 of the
 * audit-driven loop, 2026-05-09).
 *
 * Source: `ct_tape_commentary` rows where `session_date` = today (NY-tz).
 * Returns all rows oldest-first so the Arc can render left-to-right as the
 * day's evolving "mood." Captain glances at the strip and reads the
 * structural narrative (open green-tilted, midday flat, late-day red flip)
 * in <1 sec — instead of scrolling /tape-reader timeline prose.
 *
 * Refetch every 60s — tape commentary writes on a 10-min cadence so a fresh
 * segment lands within one cron interval. queryKey starts with
 * `'tape-reader-arc-'` so useMarketHoursTrigger picks it up at the
 * 09:30/16:00 ET crossing for clean session-rollover.
 *
 * Defensive on every error path. retry:false.
 */

import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface TapeArcSegment {
  id: number;
  created_at: string;
  session_date: string;
  trigger_kind: 'scheduled' | 'flag_interrupt' | 'manual';
  commentary: string;
  vix_level: number | null;
  market_tide: 'bullish' | 'bearish' | 'flat' | null;
  flag_count: number;
  flow_count: number;
  /** flag_count + flow_count/4, capped at 16 — feeds segment height. */
  intensity: number;
}

interface RawArcRow {
  id: number;
  created_at: string;
  session_date: string;
  trigger_kind: string;
  commentary: string;
  vix_level: number | null;
  market_tide: string | null;
  flag_ids: string[] | null;
  flow_ids: number[] | null;
}

function normTrigger(k: string): TapeArcSegment['trigger_kind'] {
  if (k === 'scheduled' || k === 'flag_interrupt' || k === 'manual') return k;
  return 'scheduled';
}

function normTide(t: string | null): TapeArcSegment['market_tide'] {
  if (t === 'bullish' || t === 'bearish' || t === 'flat') return t;
  return null;
}

function toSegment(r: RawArcRow): TapeArcSegment {
  const flag_count = Array.isArray(r.flag_ids) ? r.flag_ids.length : 0;
  const flow_count = Array.isArray(r.flow_ids) ? r.flow_ids.length : 0;
  const intensity = Math.min(16, flag_count + Math.floor(flow_count / 4));
  return {
    id: r.id,
    created_at: r.created_at,
    session_date: r.session_date,
    trigger_kind: normTrigger(r.trigger_kind),
    commentary: r.commentary,
    vix_level: r.vix_level == null ? null : Number(r.vix_level),
    market_tide: normTide(r.market_tide),
    flag_count,
    flow_count,
    intensity,
  };
}

/**
 * NY-tz date-string for the current moment, matching the producer's
 * `session_date` default ((now() AT TIME ZONE 'America/New_York')::date).
 */
function nyTodayString(): string {
  const ny = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const y = ny.getFullYear();
  const m = String(ny.getMonth() + 1).padStart(2, '0');
  const d = String(ny.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function useTapeReaderArc() {
  const today = nyTodayString();

  const query = useQuery<TapeArcSegment[]>({
    queryKey: ['tape-reader-arc', today],
    refetchInterval: 60_000,
    staleTime: 55_000,
    retry: false,
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sb: any = supabase;
      const { data, error } = await sb.from('ct_tape_commentary')
        .select('id, created_at, session_date, trigger_kind, commentary, vix_level, market_tide, flag_ids, flow_ids')
        .eq('session_date', today)
        .order('created_at', { ascending: true })
        .limit(200);
      if (error) throw error;
      const rows = Array.isArray(data) ? (data as RawArcRow[]) : [];
      return rows.map(toSegment);
    },
  });

  const segments = query.data ?? [];
  const latest = segments.length > 0 ? segments[segments.length - 1] : null;

  // Derive a session arc tilt: count tides + weight by intensity.
  let bullish = 0;
  let bearish = 0;
  let flat = 0;
  for (const s of segments) {
    const w = 1 + s.intensity;
    if (s.market_tide === 'bullish') bullish += w;
    else if (s.market_tide === 'bearish') bearish += w;
    else flat += w;
  }
  const dominantTide = bullish > bearish && bullish > flat
    ? 'bullish'
    : bearish > bullish && bearish > flat
      ? 'bearish'
      : 'flat';

  return {
    segments,
    latest,
    sessionDate: today,
    dominantTide,
    counts: { bullish, bearish, flat },
    isLoading: query.isLoading,
    isError: query.isError,
  };
}
