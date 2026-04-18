/**
 * useActivityLive — unified "right now" feed across every Co-Trader event
 * source. Polls 15 tables in parallel every 10s, limits each to the 50 most
 * recent rows in the last 2h, then normalizes into a single ActivityEvent
 * shape sorted by time descending.
 *
 * This is the live sibling to useSessionTimeline: same normalization
 * philosophy (one row per source event, ticker/attention/summary/metadata)
 * but not scoped to a session date. It's a tail of the whole system.
 *
 * Polling cadence: 10s refetch. Caller can pause via the `enabled` flag
 * (used for hover-to-pause UX). Refetch is disabled when tab is hidden
 * via `refetchIntervalInBackground: false` to avoid wasted work and stale
 * snapshots when returning to the tab (stale cache is instantly replaced
 * on mousemove because React Query fires a focus refetch).
 *
 * For v1 this is client-side fan-out. At steady state it's 15 queries ×
 * 50 rows = up to 750 rows per tick, every 10s → ~4,500 rows/min. When
 * this becomes a bottleneck the fan-out should move into a batched RPC.
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type ActivityKind =
  | 'heartbeat'
  | 'obs'
  | 'flag'
  | 'alert'
  | 'trade'
  | 'trade_action'
  | 'grade'
  | 'sweep'
  | 'dp'
  | 'regime'
  | 'iv_shift'
  | 'event_trigger'
  | 'curiosity'
  | 'news'
  | 'advisory'
  | 'chat'
  | 'error';

export interface ActivityEvent {
  id: string;                                    // unique across all sources: "<kind>_<row.id>"
  kind: ActivityKind;
  subject: string;                               // ticker, "Market", or "—"
  time: string;                                  // ISO timestamp
  attention_score: number | null;
  summary: string;                               // 1-line
  metadata: Record<string, unknown>;             // full row for hover-expand
  source_table: string;
  direction?: string | null;
}

export interface ActivityFilters {
  kind?: ActivityKind | 'all';
  ticker?: string;                               // "all" or uppercase symbol
  minAttention?: number;                         // inclusive floor; null-score rows are kept when min=0
  includeHeartbeats?: boolean;                   // default false — heartbeats are noisy
}

interface Args {
  enabled?: boolean;                             // pause polling (e.g. on hover)
  filters?: ActivityFilters;
  lookbackHours?: number;                        // default 2
  perTableLimit?: number;                        // default 50
  maxRows?: number;                              // default 200 post-filter
}

const POLL_MS = 10_000;

/** Resolve ticker filter against a single and/or multi-instrument row. */
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

export function useActivityLive({
  enabled = true,
  filters = {},
  lookbackHours = 2,
  perTableLimit = 50,
  maxRows = 200,
}: Args = {}) {
  const kindFilter = filters.kind ?? 'all';
  const tickerFilter = filters.ticker;
  const minAttention = filters.minAttention ?? 0;
  const includeHeartbeats = filters.includeHeartbeats ?? false;

  return useQuery<{ all: ActivityEvent[]; filtered: ActivityEvent[]; fetchedAt: number }>({
    queryKey: [
      'ct_activity_live',
      kindFilter,
      tickerFilter ?? 'all',
      minAttention,
      includeHeartbeats,
      lookbackHours,
      perTableLimit,
    ],
    enabled,
    refetchInterval: enabled ? POLL_MS : false,
    refetchIntervalInBackground: false,
    staleTime: POLL_MS / 2,
    queryFn: async () => {
      const sinceIso = new Date(Date.now() - lookbackHours * 3_600_000).toISOString();
      const lim = perTableLimit;

      // 15 parallel queries. Every source orders by its own timestamp column
      // descending and caps at `perTableLimit`.
      const [
        heartbeats,
        observations,
        flags,
        alerts,
        trades,
        tradeActions,
        grades,
        sweepClusters,
        dpClusters,
        regimeInversions,
        ivShifts,
        eventTriggers,
        curiosityFindings,
        newsAnalyses,
        tradeAdvisories,
        chatTokens,
        uiErrors,
      ] = await Promise.all([
        supabase
          .from('ct_heartbeats')
          .select('id, status_line, watching, current_reads, created_at')
          .gte('created_at', sinceIso)
          .order('created_at', { ascending: false })
          .limit(lim),
        supabase
          .from('ct_observations')
          .select('id, instruments, direction, glance, observation, self_assessment, triggered_by, created_at')
          .gte('created_at', sinceIso)
          .order('created_at', { ascending: false })
          .limit(lim),
        supabase
          .from('ct_flags')
          .select('id, instruments, direction, conviction, horizon, glance, full_reasoning, triggered_by, created_at')
          .gte('created_at', sinceIso)
          .order('created_at', { ascending: false })
          .limit(lim),
        supabase
          .from('ct_alerts')
          .select('id, instruments, direction, conviction, horizon, alert_trigger, glance, full_reasoning, triggered_by, created_at')
          .gte('created_at', sinceIso)
          .order('created_at', { ascending: false })
          .limit(lim),
        supabase
          .from('ct_trades')
          .select('id, instrument, side, entry_price, stop_price, target_price, thesis, conviction, status, opened_at, close_price, closed_at, close_reason, realized_pnl_pct')
          .gte('opened_at', sinceIso)
          .order('opened_at', { ascending: false })
          .limit(lim),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (supabase.from('ct_trade_actions' as any) as any)
          .select('id, trade_id, action, reason, details, created_at')
          .gte('created_at', sinceIso)
          .order('created_at', { ascending: false })
          .limit(lim),
        supabase
          .from('ct_grades')
          .select('id, subject_type, subject_id, instrument, claimed_direction, actual_direction, actual_return_pct, verdict, graded_at')
          .gte('graded_at', sinceIso)
          .order('graded_at', { ascending: false })
          .limit(lim),
        supabase
          .from('ct_sweep_clusters')
          .select('id, ticker, sweep_count, total_premium, dominant_side, attention_score, created_at')
          .gte('created_at', sinceIso)
          .order('created_at', { ascending: false })
          .limit(lim),
        supabase
          .from('ct_dp_clusters')
          .select('id, ticker, print_count, total_notional, attention_score, created_at')
          .gte('created_at', sinceIso)
          .order('created_at', { ascending: false })
          .limit(lim),
        supabase
          .from('ct_regime_inversions')
          .select('id, ticker, prev_regime, new_regime, flip_level, spot_at_flip, attention_score, created_at')
          .gte('created_at', sinceIso)
          .order('created_at', { ascending: false })
          .limit(lim),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (supabase.from('ct_iv_shifts' as any) as any)
          .select('id, ticker, iv_before, iv_after, shift_pct, attention_score, created_at')
          .gte('created_at', sinceIso)
          .order('created_at', { ascending: false })
          .limit(lim),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (supabase.from('ct_watcher_event_triggers' as any) as any)
          .select('id, source, priority, reason, ticker, payload, created_at')
          .gte('created_at', sinceIso)
          .order('created_at', { ascending: false })
          .limit(lim),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (supabase.from('ct_curiosity_findings' as any) as any)
          .select('id, ticker, finding_type, summary, attention_score, details, created_at')
          .gte('created_at', sinceIso)
          .order('created_at', { ascending: false })
          .limit(lim),
        supabase
          .from('ct_news_analyses')
          .select('id, instrument, news_headline, news_source, claude_take, impact, significance, created_at')
          .gte('created_at', sinceIso)
          .order('created_at', { ascending: false })
          .limit(lim),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (supabase.from('ct_trade_advisories' as any) as any)
          .select('id, trade_id, instrument, advice, reason, urgency, created_at')
          .gte('created_at', sinceIso)
          .order('created_at', { ascending: false })
          .limit(lim),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (supabase.from('ct_chat_tokens' as any) as any)
          .select('id, role, content_preview, tokens_in, tokens_out, cost_usd, created_at')
          .gte('created_at', sinceIso)
          .order('created_at', { ascending: false })
          .limit(lim),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (supabase.from('ct_ui_errors' as any) as any)
          .select('id, route, message, stack_preview, resolved, created_at')
          .gte('created_at', sinceIso)
          .order('created_at', { ascending: false })
          .limit(lim),
      ]);

      const events: ActivityEvent[] = [];

      // --- Heartbeats ---
      for (const r of (heartbeats.data ?? []) as Array<Record<string, unknown>>) {
        events.push({
          id: `heartbeat_${r.id}`,
          kind: 'heartbeat',
          subject: Array.isArray(r.watching) ? (r.watching as string[]).join(' · ') : 'Market',
          time: r.created_at as string,
          attention_score: null,
          summary: (r.status_line as string) ?? 'heartbeat',
          metadata: r,
          source_table: 'ct_heartbeats',
        });
      }

      // --- Observations ---
      for (const r of (observations.data ?? []) as Array<Record<string, unknown>>) {
        const instruments = (r.instruments as string[] | null) ?? null;
        events.push({
          id: `obs_${r.id}`,
          kind: 'obs',
          subject: instruments?.join('+') || 'Market',
          time: r.created_at as string,
          attention_score: null,
          summary: firstGlance(r.glance as string[] | null, (r.observation as string) ?? 'observation'),
          metadata: r,
          source_table: 'ct_observations',
          direction: (r.direction as string) ?? null,
        });
      }

      // --- Flags ---
      for (const r of (flags.data ?? []) as Array<Record<string, unknown>>) {
        const instruments = (r.instruments as string[] | null) ?? null;
        events.push({
          id: `flag_${r.id}`,
          kind: 'flag',
          subject: instruments?.join('+') || 'Market',
          time: r.created_at as string,
          attention_score: (r.conviction as number | null) ?? null,
          summary: firstGlance(r.glance as string[] | null, (r.full_reasoning as string) ?? 'flag'),
          metadata: r,
          source_table: 'ct_flags',
          direction: (r.direction as string) ?? null,
        });
      }

      // --- Alerts ---
      for (const r of (alerts.data ?? []) as Array<Record<string, unknown>>) {
        const instruments = (r.instruments as string[] | null) ?? null;
        events.push({
          id: `alert_${r.id}`,
          kind: 'alert',
          subject: instruments?.join('+') || 'Market',
          time: r.created_at as string,
          attention_score: (r.conviction as number | null) ?? null,
          summary:
            (r.alert_trigger as string) ??
            firstGlance(r.glance as string[] | null, (r.full_reasoning as string) ?? 'alert'),
          metadata: r,
          source_table: 'ct_alerts',
          direction: (r.direction as string) ?? null,
        });
      }

      // --- Trades (commit + close as separate rows if both fell in window) ---
      for (const r of (trades.data ?? []) as Array<Record<string, unknown>>) {
        const instrument = (r.instrument as string) ?? '—';
        const openedAt = (r.opened_at as string) ?? null;
        if (openedAt && openedAt >= sinceIso) {
          events.push({
            id: `trade_open_${r.id}`,
            kind: 'trade',
            subject: instrument,
            time: openedAt,
            attention_score: (r.conviction as number | null) ?? null,
            summary: `OPEN ${(r.side as string)?.toUpperCase() ?? '?'} ${instrument} @ ${r.entry_price ?? '?'} — ${(r.thesis as string) ?? 'no thesis'}`,
            metadata: r,
            source_table: 'ct_trades',
            direction: (r.side as string) ?? null,
          });
        }
        const closedAt = (r.closed_at as string) ?? null;
        if (closedAt && closedAt >= sinceIso) {
          const pnl = (r.realized_pnl_pct as number | null) ?? null;
          events.push({
            id: `trade_close_${r.id}`,
            kind: 'trade',
            subject: instrument,
            time: closedAt,
            attention_score: null,
            summary: `CLOSE ${instrument} @ ${r.close_price ?? '?'} — ${pnl !== null ? (pnl >= 0 ? '+' : '') + pnl.toFixed(2) + '%' : 'n/a'} — ${(r.close_reason as string) ?? ''}`,
            metadata: r,
            source_table: 'ct_trades',
          });
        }
      }

      // --- Trade actions ---
      for (const r of (tradeActions.data ?? []) as Array<Record<string, unknown>>) {
        events.push({
          id: `trade_action_${r.id}`,
          kind: 'trade_action',
          subject: ((r.details as Record<string, unknown>)?.instrument as string) ?? 'Market',
          time: r.created_at as string,
          attention_score: null,
          summary: `${(r.action as string) ?? 'ACTION'} — ${(r.reason as string) ?? ''}`,
          metadata: r,
          source_table: 'ct_trade_actions',
        });
      }

      // --- Grades ---
      for (const r of (grades.data ?? []) as Array<Record<string, unknown>>) {
        const instrument = (r.instrument as string) ?? '';
        const verdict = (r.verdict as string) ?? null;
        const ret = r.actual_return_pct as number | null;
        events.push({
          id: `grade_${r.id}`,
          kind: 'grade',
          subject: instrument || 'Market',
          time: r.graded_at as string,
          attention_score: null,
          summary: `${verdict ?? '?'} · ${(r.subject_type as string) ?? '?'} · ${(r.claimed_direction as string) ?? '?'} → ${(r.actual_direction as string) ?? '?'}${ret != null ? ` (${ret >= 0 ? '+' : ''}${ret.toFixed(2)}%)` : ''}`,
          metadata: r,
          source_table: 'ct_grades',
        });
      }

      // --- Sweep clusters ---
      for (const r of (sweepClusters.data ?? []) as Array<Record<string, unknown>>) {
        const tkr = (r.ticker as string) ?? '—';
        events.push({
          id: `sweep_${r.id}`,
          kind: 'sweep',
          subject: tkr,
          time: r.created_at as string,
          attention_score: (r.attention_score as number | null) ?? null,
          summary: `SWEEP ${tkr} — ${r.sweep_count ?? 0} sweeps · $${Math.round(((r.total_premium as number) ?? 0) / 1000)}k · ${(r.dominant_side as string) ?? 'mixed'}`,
          metadata: r,
          source_table: 'ct_sweep_clusters',
        });
      }

      // --- DP clusters ---
      for (const r of (dpClusters.data ?? []) as Array<Record<string, unknown>>) {
        const tkr = (r.ticker as string) ?? '—';
        events.push({
          id: `dp_${r.id}`,
          kind: 'dp',
          subject: tkr,
          time: r.created_at as string,
          attention_score: (r.attention_score as number | null) ?? null,
          summary: `DP ${tkr} — ${r.print_count ?? 0} prints · $${Math.round(((r.total_notional as number) ?? 0) / 1_000_000)}M`,
          metadata: r,
          source_table: 'ct_dp_clusters',
        });
      }

      // --- Regime inversions ---
      for (const r of (regimeInversions.data ?? []) as Array<Record<string, unknown>>) {
        const tkr = (r.ticker as string) ?? '—';
        events.push({
          id: `regime_${r.id}`,
          kind: 'regime',
          subject: tkr,
          time: r.created_at as string,
          attention_score: (r.attention_score as number | null) ?? null,
          summary: `REGIME ${tkr} — ${(r.prev_regime as string) ?? '?'} → ${(r.new_regime as string) ?? '?'} @ spot ${r.spot_at_flip ?? '?'}`,
          metadata: r,
          source_table: 'ct_regime_inversions',
        });
      }

      // --- IV shifts ---
      for (const r of (ivShifts.data ?? []) as Array<Record<string, unknown>>) {
        const tkr = (r.ticker as string) ?? '—';
        const shift = r.shift_pct as number | null;
        events.push({
          id: `iv_shift_${r.id}`,
          kind: 'iv_shift',
          subject: tkr,
          time: r.created_at as string,
          attention_score: (r.attention_score as number | null) ?? null,
          summary: `IV ${tkr} — ${shift != null ? (shift >= 0 ? '+' : '') + shift.toFixed(1) + '%' : 'shift'}`,
          metadata: r,
          source_table: 'ct_iv_shifts',
        });
      }

      // --- Watcher event triggers ---
      for (const r of (eventTriggers.data ?? []) as Array<Record<string, unknown>>) {
        events.push({
          id: `event_trigger_${r.id}`,
          kind: 'event_trigger',
          subject: (r.ticker as string) || 'Market',
          time: r.created_at as string,
          attention_score: null,
          summary: `${(r.source as string) ?? '?'} · ${(r.priority as string) ?? '?'} — ${(r.reason as string) ?? ''}`,
          metadata: r,
          source_table: 'ct_watcher_event_triggers',
        });
      }

      // --- Curiosity findings ---
      for (const r of (curiosityFindings.data ?? []) as Array<Record<string, unknown>>) {
        events.push({
          id: `curiosity_${r.id}`,
          kind: 'curiosity',
          subject: (r.ticker as string) || 'Market',
          time: r.created_at as string,
          attention_score: (r.attention_score as number | null) ?? null,
          summary: `${(r.finding_type as string) ?? 'curiosity'} — ${(r.summary as string) ?? ''}`,
          metadata: r,
          source_table: 'ct_curiosity_findings',
        });
      }

      // --- News ---
      for (const r of (newsAnalyses.data ?? []) as Array<Record<string, unknown>>) {
        const instrument = (r.instrument as string) ?? '';
        events.push({
          id: `news_${r.id}`,
          kind: 'news',
          subject: instrument || 'Market',
          time: r.created_at as string,
          attention_score: (r.significance as number | null) ?? null,
          summary: `${instrument ? instrument + ' · ' : ''}${(r.news_headline as string) ?? 'news'}`,
          metadata: r,
          source_table: 'ct_news_analyses',
        });
      }

      // --- Trade advisories ---
      for (const r of (tradeAdvisories.data ?? []) as Array<Record<string, unknown>>) {
        events.push({
          id: `advisory_${r.id}`,
          kind: 'advisory',
          subject: (r.instrument as string) || 'Market',
          time: r.created_at as string,
          attention_score: null,
          summary: `${(r.urgency as string) ?? ''} ${(r.advice as string) ?? 'advice'} — ${(r.reason as string) ?? ''}`.trim(),
          metadata: r,
          source_table: 'ct_trade_advisories',
        });
      }

      // --- Chat tokens ---
      for (const r of (chatTokens.data ?? []) as Array<Record<string, unknown>>) {
        events.push({
          id: `chat_${r.id}`,
          kind: 'chat',
          subject: 'Market',
          time: r.created_at as string,
          attention_score: null,
          summary: `${(r.role as string) ?? '?'} · ${r.tokens_in ?? 0}→${r.tokens_out ?? 0} tokens — ${(r.content_preview as string) ?? ''}`,
          metadata: r,
          source_table: 'ct_chat_tokens',
        });
      }

      // --- UI errors ---
      for (const r of (uiErrors.data ?? []) as Array<Record<string, unknown>>) {
        events.push({
          id: `error_${r.id}`,
          kind: 'error',
          subject: (r.route as string) || 'Market',
          time: r.created_at as string,
          attention_score: null,
          summary: `${r.resolved ? '[resolved] ' : ''}${(r.message as string) ?? 'UI error'}`,
          metadata: r,
          source_table: 'ct_ui_errors',
        });
      }

      // Sort descending (newest first).
      events.sort((a, b) => b.time.localeCompare(a.time));
      const all = events;

      // Apply filters.
      const filtered = events.filter((e) => {
        if (!includeHeartbeats && e.kind === 'heartbeat') return false;
        if (kindFilter !== 'all' && e.kind !== kindFilter) return false;
        if (minAttention > 0 && (e.attention_score ?? -1) < minAttention) return false;
        if (tickerFilter && tickerFilter !== 'all') {
          // Market-wide rows (subject === 'Market' or '—') pass only when filter is 'all'.
          const subj = e.subject;
          const isMarketWide = subj === 'Market' || subj === '—' || subj === '';
          if (isMarketWide) return false;
          // Subject can be "SPY" or "SPY+QQQ" — split & match.
          const parts = subj.split(/[+·]/).map((s) => s.trim().toUpperCase()).filter(Boolean);
          if (!parts.includes(tickerFilter.toUpperCase())) return false;
        }
        return true;
      }).slice(0, maxRows);

      return { all, filtered, fetchedAt: Date.now() };
    },
  });
}

/** Convenience helper — kind labels for the filter dropdown. */
export const ACTIVITY_KIND_OPTIONS: Array<{ value: ActivityKind | 'all'; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'heartbeat', label: 'Heartbeat' },
  { value: 'obs', label: 'Observation' },
  { value: 'flag', label: 'Flag' },
  { value: 'alert', label: 'Alert' },
  { value: 'trade', label: 'Trade' },
  { value: 'trade_action', label: 'Trade Action' },
  { value: 'grade', label: 'Grade' },
  { value: 'sweep', label: 'Sweep Cluster' },
  { value: 'dp', label: 'DP Cluster' },
  { value: 'regime', label: 'Regime' },
  { value: 'iv_shift', label: 'IV Shift' },
  { value: 'event_trigger', label: 'Event Trigger' },
  { value: 'curiosity', label: 'Curiosity' },
  { value: 'news', label: 'News' },
  { value: 'advisory', label: 'Advisory' },
  { value: 'chat', label: 'Chat' },
  { value: 'error', label: 'UI Error' },
];

export const ACTIVITY_KIND_BADGE: Record<ActivityKind, string> = {
  heartbeat: 'bg-slate-500/20 text-slate-300',
  obs: 'bg-slate-400/20 text-slate-200',
  flag: 'bg-amber-400/25 text-amber-200',
  alert: 'bg-red-500/25 text-red-200',
  trade: 'bg-teal-400/25 text-teal-200',
  trade_action: 'bg-blue-400/25 text-blue-200',
  grade: 'bg-slate-300/20 text-slate-100',
  sweep: 'bg-orange-400/25 text-orange-200',
  dp: 'bg-slate-500/30 text-slate-100',
  regime: 'bg-yellow-400/25 text-yellow-100',
  iv_shift: 'bg-purple-400/25 text-purple-200',
  event_trigger: 'bg-fuchsia-400/25 text-fuchsia-200',
  curiosity: 'bg-cyan-400/25 text-cyan-200',
  news: 'bg-muted/40 text-muted-foreground',
  advisory: 'bg-indigo-400/25 text-indigo-200',
  chat: 'bg-emerald-400/20 text-emerald-200',
  error: 'bg-red-600/30 text-red-100',
};
