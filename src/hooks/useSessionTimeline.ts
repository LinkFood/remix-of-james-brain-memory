/**
 * useSessionTimeline — pulls every event emitted for a single trading session
 * (heartbeats, observations, flags, alerts, trades, grades, sweep/dp clusters,
 * regime inversions, news) from its source table in parallel and normalizes
 * them into one chronologically sorted timeline.
 *
 * Session window is 13:00–21:00 UTC (pre-open through after-close) for the
 * supplied `sessionDate`. Row-level filtering by ticker is applied AFTER the
 * fetch so multi-instrument events (alerts with instruments=['SPY','QQQ'])
 * are kept whenever ANY element of the array matches the filter.
 *
 * Refetch cadence: 60s when viewing today, cache-only (no refetch) otherwise.
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type TimelineKind =
  | 'HEARTBEAT'
  | 'OBSERVATION'
  | 'FLAG'
  | 'ALERT'
  | 'TRADE_COMMIT'
  | 'TRADE_CLOSE'
  | 'GRADE'
  | 'SWEEP'
  | 'DP'
  | 'REGIME'
  | 'NEWS';

export interface TimelineEvent {
  id: string;
  time: string;                 // ISO timestamp
  kind: TimelineKind;
  subject: string;              // ticker, instrument set, or "—"
  attention_score: number | null;
  summary: string;              // one-line
  detail: Record<string, unknown>;
  color_class: string;          // Tailwind classes for stripe + badge bg
  direction?: string | null;    // bullish/bearish/etc — used for color shifts
  /**
   * When present, this row was produced by an event-driven watcher tick
   * (news_event/sweep_cluster/dp_cluster/regime_inversion). UI renders a
   * lightning bolt icon when set.
   */
  triggered_by?: {
    source?: string;
    priority?: string;
    reason?: string;
  } | null;
}

interface Args {
  sessionDate: string;          // yyyy-mm-dd
  ticker?: string;              // "all" or undefined = no filter
}

/** True if the supplied yyyy-mm-dd equals today in UTC terms. */
function isToday(dateStr: string): boolean {
  return dateStr === new Date().toISOString().slice(0, 10);
}

/** Returns [startIso, endIso] for the 13:00-21:00 UTC session window. */
function sessionWindow(dateStr: string): [string, string] {
  return [
    `${dateStr}T13:00:00.000Z`,
    `${dateStr}T21:00:00.000Z`,
  ];
}

/**
 * Ticker-filter rule:
 *  - null/undefined "all" → everything passes
 *  - single-instrument row (trade, news, regime, sweep, dp) → exact match on
 *    row.instrument / row.ticker
 *  - multi-instrument row (observation/flag/alert with instruments[]) → passes
 *    if ANY element of the array matches (case-insensitive)
 *  - rows with no ticker column at all (heartbeat) → always passes (market-wide)
 */
function tickerMatches(
  filter: string | undefined,
  single: string | null | undefined,
  multi: string[] | null | undefined,
  marketWide: boolean,
): boolean {
  if (!filter || filter === 'all') return true;
  if (marketWide) return true;
  const f = filter.toUpperCase();
  if (single && single.toUpperCase() === f) return true;
  if (multi && multi.some((t) => (t ?? '').toUpperCase() === f)) return true;
  return false;
}

function firstGlance(glance: string[] | null | undefined, fallback: string): string {
  if (Array.isArray(glance) && glance.length > 0 && glance[0]) return glance[0];
  return fallback;
}

/** Color-code direction on ALERT rows: bullish→green stripe, bearish→red. */
function alertColor(direction: string | null | undefined): string {
  const d = (direction ?? '').toLowerCase();
  if (d.includes('bull')) return 'border-l-green-500 bg-green-500/5';
  if (d.includes('bear')) return 'border-l-red-500 bg-red-500/5';
  return 'border-l-red-400 bg-red-400/5';
}

function gradeColor(verdict: string | null | undefined): string {
  const v = (verdict ?? '').toLowerCase();
  if (v === 'right') return 'border-l-green-500 bg-green-500/5';
  if (v === 'partial') return 'border-l-amber-400 bg-amber-400/5';
  if (v === 'wrong') return 'border-l-red-500 bg-red-500/5';
  return 'border-l-slate-400 bg-slate-400/5';
}

function tradeCloseColor(pnl: number | null | undefined): string {
  if (pnl === null || pnl === undefined) return 'border-l-slate-400 bg-slate-400/5';
  return pnl >= 0
    ? 'border-l-blue-500 bg-blue-500/5'
    : 'border-l-red-500 bg-red-500/5';
}

export function useSessionTimeline({ sessionDate, ticker }: Args) {
  return useQuery<TimelineEvent[]>({
    queryKey: ['ct_session_timeline', sessionDate, ticker ?? 'all'],
    refetchInterval: isToday(sessionDate) ? 60_000 : false,
    staleTime: isToday(sessionDate) ? 30_000 : Infinity,
    queryFn: async () => {
      const [startIso, endIso] = sessionWindow(sessionDate);

      // 10 parallel queries — one per source table.
      const [
        heartbeats,
        observations,
        flags,
        alerts,
        trades,
        grades,
        sweepClusters,
        dpClusters,
        regimeInversions,
        news,
      ] = await Promise.all([
        supabase
          .from('ct_heartbeats')
          .select('id, status_line, watching, current_reads, created_at')
          .neq('prompt_version', 'mcp-verify')
          .gte('created_at', startIso)
          .lte('created_at', endIso)
          .order('created_at', { ascending: true })
          .limit(500),
        supabase
          .from('ct_observations')
          .select('id, instruments, direction, glance, observation, self_assessment, triggered_by, created_at')
          .gte('created_at', startIso)
          .lte('created_at', endIso)
          .order('created_at', { ascending: true })
          .limit(500),
        supabase
          .from('ct_flags')
          .select('id, instruments, direction, conviction, horizon, glance, full_reasoning, self_assessment, trade_setup, triggered_by, created_at')
          .gte('created_at', startIso)
          .lte('created_at', endIso)
          .order('created_at', { ascending: true })
          .limit(500),
        supabase
          .from('ct_alerts')
          .select('id, instruments, direction, conviction, horizon, alert_trigger, glance, full_reasoning, self_assessment, trade_setup, triggered_by, created_at')
          .gte('created_at', startIso)
          .lte('created_at', endIso)
          .order('created_at', { ascending: true })
          .limit(500),
        supabase
          .from('ct_trades')
          .select('id, session_date, instrument, side, size_pct, size_usd, entry_price, stop_price, target_price, thesis, conviction, status, opened_at, close_price, closed_at, close_reason, realized_pnl_pct, realized_pnl_usd')
          .eq('session_date', sessionDate)
          .limit(500),
        supabase
          .from('ct_grades')
          .select('id, subject_type, subject_id, instrument, claimed_direction, actual_direction, actual_return_pct, verdict, calibration_delta, graded_at')
          .gte('graded_at', startIso)
          .lte('graded_at', endIso)
          .order('graded_at', { ascending: true })
          .limit(500),
        supabase
          .from('ct_sweep_clusters')
          .select('id, ticker, window_start, window_end, sweep_count, total_premium, dominant_side, largest_single_premium, call_count, put_count, attention_score, created_at')
          .gte('created_at', startIso)
          .lte('created_at', endIso)
          .order('created_at', { ascending: true })
          .limit(500),
        supabase
          .from('ct_dp_clusters')
          .select('id, ticker, window_start, window_end, print_count, total_notional, largest_single_notional, attention_score, created_at, session_date')
          .eq('session_date', sessionDate)
          .order('created_at', { ascending: true })
          .limit(500),
        supabase
          .from('ct_regime_inversions')
          .select('id, created_at, session_date, ticker, prev_regime, new_regime, prev_net_gamma, new_net_gamma, flip_level, spot_at_flip, attention_score')
          .eq('session_date', sessionDate)
          .order('created_at', { ascending: true })
          .limit(500),
        supabase
          .from('ct_news_analyses')
          .select('id, instrument, news_headline, news_source, news_url, claude_take, impact, significance, created_at')
          .gte('created_at', startIso)
          .lte('created_at', endIso)
          .order('created_at', { ascending: true })
          .limit(500),
      ]);

      const events: TimelineEvent[] = [];

      // --- Heartbeats (market-wide) ---
      for (const r of (heartbeats.data ?? []) as Array<Record<string, unknown>>) {
        if (!tickerMatches(ticker, null, null, true)) continue;
        // Event-driven watcher ticks tag current_reads._event_trigger; expose
        // it as triggered_by so the UI can render a bolt icon.
        const cr = (r.current_reads ?? null) as { _event_trigger?: { source?: string; priority?: string; reason?: string } } | null;
        const trig = cr?._event_trigger ?? null;
        events.push({
          id: `hb_${r.id}`,
          time: r.created_at as string,
          kind: 'HEARTBEAT',
          subject: Array.isArray(r.watching) ? (r.watching as string[]).join(' · ') : '—',
          attention_score: null,
          summary: (r.status_line as string) ?? 'heartbeat',
          detail: r,
          color_class: 'border-l-slate-500/50 bg-slate-500/5',
          triggered_by: trig,
        });
      }

      // --- Observations ---
      for (const r of (observations.data ?? []) as Array<Record<string, unknown>>) {
        const instruments = (r.instruments as string[] | null) ?? null;
        if (!tickerMatches(ticker, null, instruments, !instruments || instruments.length === 0)) continue;
        events.push({
          id: `obs_${r.id}`,
          time: r.created_at as string,
          kind: 'OBSERVATION',
          subject: instruments?.join('+') || '—',
          attention_score: null,
          summary: firstGlance(r.glance as string[] | null, (r.observation as string) ?? 'observation'),
          detail: r,
          color_class: 'border-l-slate-400 bg-slate-400/5',
          direction: (r.direction as string) ?? null,
          triggered_by: (r.triggered_by as TimelineEvent['triggered_by']) ?? null,
        });
      }

      // --- Flags ---
      for (const r of (flags.data ?? []) as Array<Record<string, unknown>>) {
        const instruments = (r.instruments as string[] | null) ?? null;
        if (!tickerMatches(ticker, null, instruments, !instruments || instruments.length === 0)) continue;
        events.push({
          id: `flag_${r.id}`,
          time: r.created_at as string,
          kind: 'FLAG',
          subject: instruments?.join('+') || '—',
          attention_score: (r.conviction as number | null) ?? null,
          summary: firstGlance(r.glance as string[] | null, (r.full_reasoning as string) ?? 'flag'),
          detail: r,
          color_class: 'border-l-amber-400 bg-amber-400/10',
          direction: (r.direction as string) ?? null,
          triggered_by: (r.triggered_by as TimelineEvent['triggered_by']) ?? null,
        });
      }

      // --- Alerts (color depends on direction) ---
      for (const r of (alerts.data ?? []) as Array<Record<string, unknown>>) {
        const instruments = (r.instruments as string[] | null) ?? null;
        if (!tickerMatches(ticker, null, instruments, !instruments || instruments.length === 0)) continue;
        events.push({
          id: `alert_${r.id}`,
          time: r.created_at as string,
          kind: 'ALERT',
          subject: instruments?.join('+') || '—',
          attention_score: (r.conviction as number | null) ?? null,
          summary:
            (r.alert_trigger as string) ??
            firstGlance(r.glance as string[] | null, (r.full_reasoning as string) ?? 'alert'),
          detail: r,
          color_class: alertColor(r.direction as string | null),
          direction: (r.direction as string) ?? null,
          triggered_by: (r.triggered_by as TimelineEvent['triggered_by']) ?? null,
        });
      }

      // --- Trades — one event per commit + one per close ---
      for (const r of (trades.data ?? []) as Array<Record<string, unknown>>) {
        const instrument = (r.instrument as string) ?? '';
        if (!tickerMatches(ticker, instrument, null, false)) continue;

        // Commit event — fires at opened_at (fallback: created_at-equivalent)
        const openedAt = (r.opened_at as string) ?? null;
        if (openedAt) {
          events.push({
            id: `trade_open_${r.id}`,
            time: openedAt,
            kind: 'TRADE_COMMIT',
            subject: instrument,
            attention_score: (r.conviction as number | null) ?? null,
            summary: `${(r.side as string)?.toUpperCase() ?? '?'} ${instrument} @ ${r.entry_price ?? '?'} — ${(r.thesis as string) ?? 'no thesis'}`,
            detail: r,
            color_class: 'border-l-teal-400 bg-teal-400/10',
            direction: (r.side as string) ?? null,
          });
        }

        // Close event — fires at closed_at if closed
        const closedAt = (r.closed_at as string) ?? null;
        if (closedAt) {
          const pnl = (r.realized_pnl_pct as number | null) ?? null;
          events.push({
            id: `trade_close_${r.id}`,
            time: closedAt,
            kind: 'TRADE_CLOSE',
            subject: instrument,
            attention_score: null,
            summary: `CLOSE ${instrument} @ ${r.close_price ?? '?'} — ${pnl !== null ? (pnl >= 0 ? '+' : '') + pnl.toFixed(2) + '%' : 'n/a'} — ${(r.close_reason as string) ?? ''}`,
            detail: r,
            color_class: tradeCloseColor(pnl),
          });
        }
      }

      // --- Grades ---
      for (const r of (grades.data ?? []) as Array<Record<string, unknown>>) {
        const instrument = (r.instrument as string) ?? '';
        if (!tickerMatches(ticker, instrument, null, !instrument)) continue;
        const verdict = (r.verdict as string) ?? null;
        const ret = r.actual_return_pct as number | null;
        events.push({
          id: `grade_${r.id}`,
          time: r.graded_at as string,
          kind: 'GRADE',
          subject: instrument || '—',
          attention_score: null,
          summary: `GRADE ${verdict ?? '?'} · ${(r.subject_type as string) ?? '?'} · claimed ${(r.claimed_direction as string) ?? '?'} → actual ${(r.actual_direction as string) ?? '?'}${ret !== null && ret !== undefined ? ` (${ret >= 0 ? '+' : ''}${ret.toFixed(2)}%)` : ''}`,
          detail: r,
          color_class: gradeColor(verdict),
        });
      }

      // --- Sweep clusters ---
      for (const r of (sweepClusters.data ?? []) as Array<Record<string, unknown>>) {
        const tkr = (r.ticker as string) ?? '';
        if (!tickerMatches(ticker, tkr, null, false)) continue;
        events.push({
          id: `sweep_${r.id}`,
          time: r.created_at as string,
          kind: 'SWEEP',
          subject: tkr,
          attention_score: (r.attention_score as number | null) ?? null,
          summary: `SWEEP CLUSTER ${tkr} — ${r.sweep_count ?? 0} sweeps · $${Math.round(((r.total_premium as number) ?? 0) / 1000)}k · ${(r.dominant_side as string) ?? 'mixed'}`,
          detail: r,
          color_class: 'border-l-orange-400 bg-orange-400/10',
        });
      }

      // --- Dark-pool clusters ---
      for (const r of (dpClusters.data ?? []) as Array<Record<string, unknown>>) {
        const tkr = (r.ticker as string) ?? '';
        if (!tickerMatches(ticker, tkr, null, false)) continue;
        events.push({
          id: `dp_${r.id}`,
          time: r.created_at as string,
          kind: 'DP',
          subject: tkr,
          attention_score: (r.attention_score as number | null) ?? null,
          summary: `DP CLUSTER ${tkr} — ${r.print_count ?? 0} prints · $${Math.round(((r.total_notional as number) ?? 0) / 1_000_000)}M notional`,
          detail: r,
          color_class: 'border-l-slate-500 bg-slate-500/10',
        });
      }

      // --- Regime inversions ---
      for (const r of (regimeInversions.data ?? []) as Array<Record<string, unknown>>) {
        const tkr = (r.ticker as string) ?? '';
        if (!tickerMatches(ticker, tkr, null, false)) continue;
        events.push({
          id: `regime_${r.id}`,
          time: r.created_at as string,
          kind: 'REGIME',
          subject: tkr,
          attention_score: (r.attention_score as number | null) ?? null,
          summary: `REGIME INVERSION ${tkr} — ${(r.prev_regime as string) ?? '?'} → ${(r.new_regime as string) ?? '?'} @ spot ${r.spot_at_flip ?? '?'}`,
          detail: r,
          color_class: 'border-l-yellow-400 bg-yellow-400/10',
        });
      }

      // --- News ---
      for (const r of (news.data ?? []) as Array<Record<string, unknown>>) {
        const instrument = (r.instrument as string) ?? '';
        // News often tagged to a specific ticker; treat missing instrument as market-wide.
        if (!tickerMatches(ticker, instrument, null, !instrument)) continue;
        events.push({
          id: `news_${r.id}`,
          time: r.created_at as string,
          kind: 'NEWS',
          subject: instrument || '—',
          attention_score: (r.significance as number | null) ?? null,
          summary: `${instrument ? instrument + ' · ' : ''}${(r.news_headline as string) ?? 'news'}`,
          detail: r,
          color_class: 'border-l-muted-foreground/40 bg-muted/30',
        });
      }

      // --- Sort ascending by time ---
      events.sort((a, b) => a.time.localeCompare(b.time));
      return events;
    },
  });
}
