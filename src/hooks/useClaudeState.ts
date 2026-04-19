/**
 * useClaudeState — glance-first dashboard data for /workspace.
 *
 * Powers the Claude's State landing view. Tenet 9 — "UI is glance-first.
 * User sees state in one view. Tabs drill down." Each hook is a small,
 * focused read that plays nicely with an empty-weekend state.
 *
 * All tables referenced here live outside the generated supabase types, so
 * we cast to `any` the same way useHypotheses / useClaudeBook do.
 *
 * Tables read (all read-only from the UI):
 *   - ct_claude_heartbeat          (Phase 1 foundation)
 *   - ct_claude_circuit_breakers   (Phase 1 foundation)
 *   - ct_claude_decisions          (Phase 1 foundation — journal)
 *   - ct_daily_briefs              (Phase 1 foundation)
 *   - ct_trades (trader='claude', status='open')
 *   - ct_trade_ideas (trader='claude', status='armed')
 *   - ct_hypotheses (for review queue)
 *   - ct_james_reviews (to subtract already-reviewed from queue)
 */
import { useQuery } from '@tanstack/react-query';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { CtBookRow, CtTradeRow } from './useCoTraderData';
import type { CtTradeIdeaRow } from './useClaudeBook';
import type { ReviewThumb } from './useHypotheses';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb = supabase as any;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
function todayISODate(): string {
  return new Date().toISOString().slice(0, 10);
}
function startOfTodayUTC(): string {
  // Date ops in postgres are timezone-aware; for "today" we use UTC-midnight
  // as a conservative lower-bound filter. The count surfaces are short enough
  // that a little overlap won't matter for the display.
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------
export type HeartbeatLiveness = 'alive' | 'stale' | 'dead' | 'off_hours' | 'unknown';

export interface ClaudeHeartbeatStatus {
  status: HeartbeatLiveness;
  minutesSinceDecision: number | null;
  checkedAt: string | null;
  note: string | null;
}

export function useClaudeHeartbeatStatus() {
  return useQuery<ClaudeHeartbeatStatus>({
    queryKey: ['ct_claude_heartbeat', 'latest'],
    refetchInterval: 30_000,
    queryFn: async () => {
      const { data, error } = await sb
        .from('ct_claude_heartbeat')
        .select('status, minutes_since_decision, checked_at, note')
        .order('checked_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      if (!data) {
        return { status: 'unknown', minutesSinceDecision: null, checkedAt: null, note: null };
      }
      return {
        status: (data.status as HeartbeatLiveness) ?? 'unknown',
        minutesSinceDecision: data.minutes_since_decision ?? null,
        checkedAt: data.checked_at ?? null,
        note: data.note ?? null,
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Circuit breaker — active for today
// ---------------------------------------------------------------------------
export interface ActiveBreaker {
  id: string;
  breakerType: string;
  reason: string;
  trippedAt: string;
  triggerValue: number | null;
  threshold: number | null;
}

export function useCircuitBreakerStatus() {
  return useQuery<ActiveBreaker[]>({
    queryKey: ['ct_claude_circuit_breakers', 'active'],
    refetchInterval: 30_000,
    queryFn: async () => {
      const { data, error } = await sb
        .from('ct_claude_circuit_breakers')
        .select('id, breaker_type, reason, tripped_at, trigger_value, threshold, cleared_at, session_date')
        .eq('session_date', todayISODate())
        .is('cleared_at', null)
        .order('tripped_at', { ascending: false });
      if (error) throw error;
      return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
        id: r.id as string,
        breakerType: r.breaker_type as string,
        reason: r.reason as string,
        trippedAt: r.tripped_at as string,
        triggerValue: (r.trigger_value as number | null) ?? null,
        threshold: (r.threshold as number | null) ?? null,
      }));
    },
  });
}

// ---------------------------------------------------------------------------
// Hallucination count today
// ---------------------------------------------------------------------------
export function useTodaysHallucinationCount() {
  return useQuery<number>({
    queryKey: ['ct_claude_decisions', 'hallucinations_today'],
    refetchInterval: 60_000,
    queryFn: async () => {
      const { count, error } = await sb
        .from('ct_claude_decisions')
        .select('id', { count: 'estimated', head: true })
        .eq('hallucination_flag', true)
        .gte('created_at', startOfTodayUTC());
      if (error) throw error;
      return count ?? 0;
    },
  });
}

// ---------------------------------------------------------------------------
// Latest brief (prefer non-expired; fall back to newest regardless)
// ---------------------------------------------------------------------------
export interface DailyBriefRow {
  id: string;
  session_date: string;
  brief_version: number;
  triggered_by: 'scheduled' | 'breaking_news' | 'manual' | 'regime_shift';
  urgency: 'normal' | 'elevated' | 'high' | 'acute';
  macro_narrative: string;
  macro_regime: string | null;
  breaking_events: Array<Record<string, unknown>> | null;
  per_ticker: Array<Record<string, unknown>>;
  convergent_view: string;
  high_conviction_ideas: Array<Record<string, unknown>> | null;
  watchlist_focus: string[] | null;
  skip_today: string[] | null;
  expires_at: string;
  created_at: string;
}

export function useLatestBrief() {
  return useQuery<DailyBriefRow | null>({
    queryKey: ['ct_daily_briefs', 'latest'],
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await sb
        .from('ct_daily_briefs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return (data as DailyBriefRow | null) ?? null;
    },
  });
}

// ---------------------------------------------------------------------------
// Open Claude trades (reuse shape from useClaudeBook / useCoTraderData)
// ---------------------------------------------------------------------------
export function useOpenClaudeTrades() {
  return useQuery<CtTradeRow[]>({
    queryKey: ['ct_trades_claude_open'],
    refetchInterval: 30_000,
    queryFn: async () => {
      const { data, error } = await sb
        .from('ct_trades')
        .select('*')
        .eq('trader', 'claude')
        .eq('status', 'open')
        .order('opened_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data ?? []) as CtTradeRow[];
    },
  });
}

// ---------------------------------------------------------------------------
// Armed Claude trade ideas, ordered by expiry ASC (most urgent first)
// ---------------------------------------------------------------------------
export function useArmedTradeIdeas() {
  return useQuery<CtTradeIdeaRow[]>({
    queryKey: ['ct_trade_ideas_claude_armed'],
    refetchInterval: 30_000,
    queryFn: async () => {
      const { data, error } = await sb
        .from('ct_trade_ideas')
        .select('*')
        .eq('trader', 'claude')
        .eq('status', 'armed')
        .order('expires_at', { ascending: true })
        .limit(50);
      if (error) throw error;
      return (data ?? []) as CtTradeIdeaRow[];
    },
  });
}

// ---------------------------------------------------------------------------
// Today's book row for Claude — balance + YTD anchor
// ---------------------------------------------------------------------------
export function useClaudeTodayBook() {
  return useQuery<{ today: CtBookRow | null; firstOfYear: CtBookRow | null }>({
    queryKey: ['ct_book_claude_dashboard'],
    refetchInterval: 60_000,
    queryFn: async () => {
      const [{ data: todayRow }, { data: firstRow }] = await Promise.all([
        sb.from('ct_book')
          .select('*')
          .eq('trader', 'claude')
          .eq('session_date', todayISODate())
          .maybeSingle(),
        sb.from('ct_book')
          .select('*')
          .eq('trader', 'claude')
          .order('session_date', { ascending: true })
          .limit(1)
          .maybeSingle(),
      ]);
      return {
        today: (todayRow as CtBookRow | null) ?? null,
        firstOfYear: (firstRow as CtBookRow | null) ?? null,
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Recent decision journal entries — feed for row 4
// ---------------------------------------------------------------------------
export interface ClaudeDecisionRow {
  id: string;
  decision_type: string;
  model_tier: 'opus' | 'sonnet' | 'haiku' | 'none';
  reasoning: string;
  outcome: string | null;
  hallucination_flag: boolean;
  linked_hypothesis_id: string | null;
  linked_trade_idea_id: string | null;
  linked_trade_id: string | null;
  linked_brief_id: string | null;
  created_at: string;
}

export function useRecentDecisions(limit = 15) {
  return useQuery<ClaudeDecisionRow[]>({
    queryKey: ['ct_claude_decisions', 'recent', limit],
    refetchInterval: 30_000,
    queryFn: async () => {
      const { data, error } = await sb
        .from('ct_claude_decisions')
        .select(
          'id, decision_type, model_tier, reasoning, outcome, hallucination_flag, ' +
            'linked_hypothesis_id, linked_trade_idea_id, linked_trade_id, linked_brief_id, created_at',
        )
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return (data ?? []) as ClaudeDecisionRow[];
    },
  });
}

// ---------------------------------------------------------------------------
// James's review queue — subjects from the last 7 days with no ct_james_reviews
// row yet. We assemble in the client from three parallel queries + an exclude
// set from ct_james_reviews. Small enough to be fine; keeps the UI code simple.
// ---------------------------------------------------------------------------
export type ReviewSubjectType = 'trade' | 'trade_idea' | 'hypothesis';

export interface ReviewQueueItem {
  subjectType: ReviewSubjectType;
  subjectId: string;
  title: string;      // short summary shown in the row
  detail: string;     // 1-line context below
  createdAt: string;
}

const SEVEN_DAYS_MS = 7 * 86_400_000;

export function useReviewQueue() {
  return useQuery<ReviewQueueItem[]>({
    queryKey: ['ct_james_reviews', 'queue'],
    refetchInterval: 60_000,
    queryFn: async () => {
      const since = new Date(Date.now() - SEVEN_DAYS_MS).toISOString();

      const [tradesRes, ideasRes, hypsRes, reviewsRes] = await Promise.all([
        sb.from('ct_trades')
          .select('id, instrument, side, entry_price, status, thesis, created_at')
          .eq('trader', 'claude')
          .gte('created_at', since)
          .order('created_at', { ascending: false })
          .limit(100),
        sb.from('ct_trade_ideas')
          .select('id, instrument, direction, rationale, status, created_at')
          .eq('trader', 'claude')
          .gte('created_at', since)
          .order('created_at', { ascending: false })
          .limit(100),
        sb.from('ct_hypotheses')
          .select('id, claim, horizon, created_by, created_at')
          .gte('created_at', since)
          .order('created_at', { ascending: false })
          .limit(100),
        sb.from('ct_james_reviews')
          .select('subject_type, subject_id')
          .gte('created_at', since),
      ]);

      if (tradesRes.error) throw tradesRes.error;
      if (ideasRes.error) throw ideasRes.error;
      if (hypsRes.error) throw hypsRes.error;
      if (reviewsRes.error) throw reviewsRes.error;

      const reviewed = new Set<string>();
      for (const r of (reviewsRes.data ?? []) as Array<Record<string, unknown>>) {
        reviewed.add(`${r.subject_type as string}:${r.subject_id as string}`);
      }

      const items: ReviewQueueItem[] = [];

      for (const t of (tradesRes.data ?? []) as Array<Record<string, unknown>>) {
        const key = `trade:${t.id as string}`;
        if (reviewed.has(key)) continue;
        items.push({
          subjectType: 'trade',
          subjectId: t.id as string,
          title: `${(t.instrument as string) ?? '?'} ${(t.side as string) ?? ''}`.trim(),
          detail: (t.thesis as string) ?? `${(t.status as string) ?? ''}`,
          createdAt: t.created_at as string,
        });
      }
      for (const i of (ideasRes.data ?? []) as Array<Record<string, unknown>>) {
        const key = `trade_idea:${i.id as string}`;
        if (reviewed.has(key)) continue;
        items.push({
          subjectType: 'trade_idea',
          subjectId: i.id as string,
          title: `${(i.instrument as string) ?? '?'} ${(i.direction as string) ?? ''}`.trim(),
          detail: (i.rationale as string) ?? `${(i.status as string) ?? ''}`,
          createdAt: i.created_at as string,
        });
      }
      for (const h of (hypsRes.data ?? []) as Array<Record<string, unknown>>) {
        const key = `hypothesis:${h.id as string}`;
        if (reviewed.has(key)) continue;
        items.push({
          subjectType: 'hypothesis',
          subjectId: h.id as string,
          title: ((h.claim as string) ?? '').slice(0, 80),
          detail: `hypothesis · ${(h.horizon as string) ?? ''} · by ${(h.created_by as string) ?? ''}`,
          createdAt: h.created_at as string,
        });
      }

      items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      return items.slice(0, 20);
    },
  });
}

// ---------------------------------------------------------------------------
// One-click review mutation — optimistic removal from the queue.
// ---------------------------------------------------------------------------
export function useReviewSubjectOptimistic() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      subjectType, subjectId, thumb, note,
    }: {
      subjectType: ReviewSubjectType | 'rule';
      subjectId: string;
      thumb: ReviewThumb;
      note?: string;
    }) => {
      const { error } = await sb
        .from('ct_james_reviews')
        .insert(
          {
            subject_type: subjectType,
            subject_id: subjectId,
            thumb,
            note: note ?? null,
          },
          { returning: 'minimal' },
        );
      if (error) throw error;
    },
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: ['ct_james_reviews', 'queue'] });
      const previous = qc.getQueryData<ReviewQueueItem[]>(['ct_james_reviews', 'queue']);
      if (previous) {
        qc.setQueryData<ReviewQueueItem[]>(
          ['ct_james_reviews', 'queue'],
          previous.filter(
            (it) => !(it.subjectType === vars.subjectType && it.subjectId === vars.subjectId),
          ),
        );
      }
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) {
        qc.setQueryData(['ct_james_reviews', 'queue'], ctx.previous);
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['ct_james_reviews', 'queue'] });
    },
  });
}
