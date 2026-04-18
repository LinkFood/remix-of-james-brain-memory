/**
 * useHypotheses — data layer for the Thesis Engine (Wave 2).
 *
 * UI label is "Thesis", table name is ct_hypotheses (distinct from the
 * per-turn ct_theses snapshots from Wave 1). Claude-authored by default,
 * edited by James via the /workspace page.
 *
 * Tables referenced (not yet in supabase types.ts — cast via `as any`):
 *   - ct_hypotheses           — the claim
 *   - ct_hypothesis_evidence  — evidence stack (observation/alert/grade/...)
 *   - ct_hypothesis_events    — immutable audit log
 *   - ct_alerts / ct_flags    — linked via hypothesis_id
 *   - ct_grades               — linked via hypothesis_id
 *
 * RPC:
 *   - retire_hypothesis(p_hypothesis_id, p_status, p_reason)
 *     → atomic status change + audit log insert.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb = supabase as any;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type HypothesisStatus = 'open' | 'supported' | 'refuted' | 'zombie' | 'retired';
export type HypothesisHorizon = 'session' | 'week' | 'month' | 'open';
export type HypothesisAuthor = 'claude' | 'james';
export type EvidencePolarity = 'for' | 'against';
export type EvidenceAddedBy = 'claude' | 'james' | 'cron';
export type EvidenceType =
  | 'observation' | 'alert' | 'grade' | 'news' | 'flow' | 'gex'
  | 'regime' | 'catalyst' | 'manual';

export interface Hypothesis {
  id: string;
  claim: string;
  because: string[];
  invalidate_if: string;
  horizon: HypothesisHorizon;
  status: HypothesisStatus;
  confidence: number;
  elo: number;
  created_by: HypothesisAuthor;
  parent_hypothesis_id: string | null;
  tickers: string[];
  last_tested_at: string | null;
  invalidated_at: string | null;
  invalidated_reason: string | null;
  created_at: string;
  updated_at: string;
  last_edited_by: string | null;
}

export interface HypothesisEvidence {
  id: string;
  hypothesis_id: string;
  evidence_type: EvidenceType;
  source_id: string | null;
  polarity: EvidencePolarity;
  weight: number;
  summary: string | null;
  added_at: string;
  added_by: EvidenceAddedBy;
}

export interface HypothesisEvent {
  id: string;
  hypothesis_id: string;
  event_type:
    | 'created' | 'confidence_update' | 'elo_update' | 'status_change'
    | 'evidence_added' | 'edited' | 'invalidated' | 'retired' | 'promoted';
  delta: number | null;
  before_value: number | null;
  after_value: number | null;
  reason: string;
  linked_grade_id: string | null;
  created_at: string;
  created_by: 'claude' | 'james' | 'cron' | 'trigger';
}

export interface LinkedAlert {
  id: string;
  kind: 'alert' | 'flag';
  instrument: string | null;
  claimed_direction: string | null;
  created_at: string;
  horizon_end: string | null;
  grade_id: string | null;
}

export interface LinkedGrade {
  id: string;
  subject_type: string;
  subject_id: string;
  instrument: string;
  claimed_direction: string;
  actual_direction: string;
  actual_return_pct: number;
  verdict: string;
  graded_at: string;
}

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------
const keys = {
  list: (status?: HypothesisStatus | 'all') => ['ct_hypotheses', 'list', status ?? 'all'] as const,
  one: (id: string) => ['ct_hypotheses', 'one', id] as const,
  evidence: (id: string) => ['ct_hypotheses', 'evidence', id] as const,
  events: (id: string) => ['ct_hypotheses', 'events', id] as const,
  linkedAlerts: (id: string) => ['ct_hypotheses', 'linkedAlerts', id] as const,
  linkedGrades: (id: string) => ['ct_hypotheses', 'linkedGrades', id] as const,
  recentlyProposed: () => ['ct_hypotheses', 'recentlyProposed'] as const,
  reviews: (id: string) => ['ct_james_reviews', 'hypothesis', id] as const,
};

// ---------------------------------------------------------------------------
// James reviews — SANDBOXED table. James sees his thumbs; Claude never does.
// ---------------------------------------------------------------------------
export type ReviewThumb = 'up' | 'down' | 'neutral';
export interface JamesReview {
  id: string;
  subject_type: 'trade' | 'trade_idea' | 'hypothesis' | 'rule';
  subject_id: string;
  thumb: ReviewThumb;
  note: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * List hypotheses ordered by elo DESC. If a status is passed (and not 'all'),
 * filter to that status. Auto-refetch every 60s so the right rail's
 * "needs review" count stays fresh without manual invalidation.
 */
export function useHypothesesList(status?: HypothesisStatus | 'all') {
  return useQuery<Hypothesis[]>({
    queryKey: keys.list(status),
    refetchInterval: 60_000,
    queryFn: async () => {
      let q = sb.from('ct_hypotheses').select('*').order('elo', { ascending: false });
      if (status && status !== 'all') q = q.eq('status', status);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as Hypothesis[];
    },
  });
}

/**
 * Single hypothesis with evidence and events loaded in parallel.
 * Using two extra queries (not joins) keeps cache invalidation granular —
 * adding evidence doesn't force a full hypothesis reload.
 */
export function useHypothesis(id: string | null) {
  const hypothesis = useQuery<Hypothesis | null>({
    queryKey: keys.one(id ?? ''),
    enabled: !!id,
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await sb
        .from('ct_hypotheses')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (error) throw error;
      return (data as Hypothesis | null) ?? null;
    },
  });

  const evidence = useQuery<HypothesisEvidence[]>({
    queryKey: keys.evidence(id ?? ''),
    enabled: !!id,
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await sb
        .from('ct_hypothesis_evidence')
        .select('*')
        .eq('hypothesis_id', id)
        .order('added_at', { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as HypothesisEvidence[];
    },
  });

  const events = useQuery<HypothesisEvent[]>({
    queryKey: keys.events(id ?? ''),
    enabled: !!id,
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await sb
        .from('ct_hypothesis_events')
        .select('*')
        .eq('hypothesis_id', id)
        .order('created_at', { ascending: true })
        .limit(500);
      if (error) throw error;
      return (data ?? []) as HypothesisEvent[];
    },
  });

  return {
    hypothesis: hypothesis.data ?? null,
    evidence: evidence.data ?? [],
    events: events.data ?? [],
    isLoading: hypothesis.isLoading || evidence.isLoading || events.isLoading,
    error: hypothesis.error ?? evidence.error ?? events.error,
  };
}

/**
 * Linked alerts + flags (both have hypothesis_id FK). Unioned and sorted by
 * created_at DESC. Not a view — two parallel queries then merge-sort.
 */
export function useLinkedAlerts(hypothesisId: string | null) {
  return useQuery<LinkedAlert[]>({
    queryKey: keys.linkedAlerts(hypothesisId ?? ''),
    enabled: !!hypothesisId,
    refetchInterval: 60_000,
    queryFn: async () => {
      const [alertsRes, flagsRes] = await Promise.all([
        sb.from('ct_alerts')
          .select('id, instrument, claimed_direction, created_at, horizon_end, grade_id')
          .eq('hypothesis_id', hypothesisId)
          .order('created_at', { ascending: false })
          .limit(50),
        sb.from('ct_flags')
          .select('id, instrument, claimed_direction, created_at, horizon_end, grade_id')
          .eq('hypothesis_id', hypothesisId)
          .order('created_at', { ascending: false })
          .limit(50),
      ]);
      if (alertsRes.error) throw alertsRes.error;
      if (flagsRes.error) throw flagsRes.error;
      const alerts: LinkedAlert[] = (alertsRes.data ?? []).map((r: Record<string, unknown>) => ({
        id: r.id as string,
        kind: 'alert' as const,
        instrument: (r.instrument as string) ?? null,
        claimed_direction: (r.claimed_direction as string) ?? null,
        created_at: r.created_at as string,
        horizon_end: (r.horizon_end as string) ?? null,
        grade_id: (r.grade_id as string) ?? null,
      }));
      const flags: LinkedAlert[] = (flagsRes.data ?? []).map((r: Record<string, unknown>) => ({
        id: r.id as string,
        kind: 'flag' as const,
        instrument: (r.instrument as string) ?? null,
        claimed_direction: (r.claimed_direction as string) ?? null,
        created_at: r.created_at as string,
        horizon_end: (r.horizon_end as string) ?? null,
        grade_id: (r.grade_id as string) ?? null,
      }));
      return [...alerts, ...flags].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      );
    },
  });
}

/** Linked grades. Separate from alerts — grades land after horizon close. */
export function useLinkedGrades(hypothesisId: string | null) {
  return useQuery<LinkedGrade[]>({
    queryKey: keys.linkedGrades(hypothesisId ?? ''),
    enabled: !!hypothesisId,
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await sb
        .from('ct_grades')
        .select('id, subject_type, subject_id, instrument, claimed_direction, actual_direction, actual_return_pct, verdict, graded_at')
        .eq('hypothesis_id', hypothesisId)
        .order('graded_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      return (data ?? []) as LinkedGrade[];
    },
  });
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Review a hypothesis — retrospective thumbs-up/down + optional note.
 *
 * Wave D semantics: Claude trades autonomously. James's reviews are SANDBOXED
 * in ct_james_reviews and never read by any Claude-facing function. One row
 * per click; no optimistic update. We cannot pre-mutate without polluting the
 * quiet read-back that powers the Workspace "Claude reviews" column.
 */
export function useReviewHypothesis() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      hypothesisId, thumb, note,
    }: { hypothesisId: string; thumb: ReviewThumb; note?: string }) => {
      const { error } = await sb
        .from('ct_james_reviews')
        .insert(
          {
            subject_type: 'hypothesis',
            subject_id: hypothesisId,
            thumb,
            note: note ?? null,
          },
          { returning: 'minimal' },
        );
      if (error) throw error;
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: keys.reviews(vars.hypothesisId) });
    },
  });
}

/**
 * Generic ct_james_reviews insert — for trades / trade_ideas / rules too.
 * Used by the Trade Log tab. Same fire-and-forget semantics.
 */
export function useReviewSubject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      subjectType, subjectId, thumb, note,
    }: {
      subjectType: 'trade' | 'trade_idea' | 'hypothesis' | 'rule';
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
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['ct_james_reviews', vars.subjectType, vars.subjectId] });
      qc.invalidateQueries({ queryKey: ['ct_james_reviews'] });
    },
  });
}

/**
 * Read James's reviews for a given hypothesis. James-side only — Claude
 * functions MUST NOT call this hook.
 */
export function useHypothesisReviews(hypothesisId: string | null) {
  return useQuery<JamesReview[]>({
    queryKey: keys.reviews(hypothesisId ?? ''),
    enabled: !!hypothesisId,
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await sb
        .from('ct_james_reviews')
        .select('*')
        .eq('subject_type', 'hypothesis')
        .eq('subject_id', hypothesisId)
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data ?? []) as JamesReview[];
    },
  });
}

/**
 * Inline edit of claim / because / invalidate_if / tickers / horizon. Writes
 * a single UPDATE and logs an `edited` event. last_edited_by flips to 'james'
 * so the Granola coloring can distinguish Claude text from James text.
 */
export interface HypothesisEditPatch {
  claim?: string;
  because?: string[];
  invalidate_if?: string;
  tickers?: string[];
  horizon?: HypothesisHorizon;
}

export function useEditHypothesis() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: HypothesisEditPatch }) => {
      const update: Record<string, unknown> = {
        ...patch,
        last_edited_by: 'james',
      };
      const { data, error } = await sb
        .from('ct_hypotheses')
        .update(update)
        .eq('id', id)
        .select()
        .maybeSingle();
      if (error) throw error;

      // Best-effort audit event. If it fails we still return the edit — the
      // row did update. Log to console so we can spot systematic drift.
      const { error: evErr } = await sb.from('ct_hypothesis_events').insert({
        hypothesis_id: id,
        event_type: 'edited',
        reason: `james edited: ${Object.keys(patch).join(', ')}`,
        created_by: 'james',
      });
      if (evErr) {
        // eslint-disable-next-line no-console
        console.warn('[useEditHypothesis] event insert failed:', evErr);
      }
      return data as Hypothesis | null;
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['ct_hypotheses'] });
      qc.invalidateQueries({ queryKey: keys.one(vars.id) });
      qc.invalidateQueries({ queryKey: keys.events(vars.id) });
    },
  });
}

/**
 * "Recently proposed" bucket: newly-birthed Claude hypotheses. No approval
 * gate anymore — Claude trades on its own authority. This is purely
 * informational, for James's retrospective review.
 */
export function useRecentlyProposedHypotheses() {
  return useQuery<Hypothesis[]>({
    queryKey: keys.recentlyProposed(),
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await sb
        .from('ct_hypotheses')
        .select('*')
        .eq('created_by', 'claude')
        .eq('status', 'open')
        .is('last_tested_at', null)
        .is('last_edited_by', null)
        .eq('elo', 1500)
        .order('created_at', { ascending: false })
        .limit(25);
      if (error) throw error;
      return (data ?? []) as Hypothesis[];
    },
  });
}
