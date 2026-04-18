/**
 * useRegimeAnalogs — the deeper sibling of wave 24's "session analog matcher".
 *
 * Where ct-session-analog returns sessions most-similar to today's TAPE via
 * embedding cosine, this hook lets the user filter history by EXPLICIT regime
 * constraints (positive gamma + low IV + strong breadth + no catalyst, etc.)
 * and browse the resulting sessions + their outcomes.
 *
 * Data sources — all internal, zero new UW calls:
 *   - ct_session_embeddings   : one row/day with state_features JSONB
 *                               (gamma regime, vix/iv tier, breadth, catalyst flags)
 *   - ct_iv_rank_daily        : authoritative SPY IV rank per date (fills gaps
 *                               when state_features.iv_rank_spy is null)
 *   - ct_events               : macro + earnings catalysts per date; used to
 *                               derive a per-session "has catalyst in 24h"
 *                               boolean independent of embedding flags.
 *   - ct_grades               : Claude's referee verdicts per (subject_id, graded_at)
 *                               — rolled up per session_date for the list row.
 *
 * Regime tag derivation per historical session (see deriveTags below):
 *   - gamma    : from state_features.spx_regime (positive|negative|unknown)
 *   - iv_tier  : ct_iv_rank_daily.iv_rank if present, else state_features.iv_tier
 *                ("cold"<25 / "mid"<60 / "hot")
 *   - vix_tier : from state_features.vix_tier (low/mid/elevated/stressed)
 *   - breadth  : derived from state_features.breadth_net and market_tide
 *                (net_call_premium vs net_put_premium) — "strong" >0 both,
 *                "weak" <0 both, "mixed" otherwise.
 *   - catalyst : TRUE if ct_events has an econ-importance>=2 or earnings row
 *                within 24h of session_date (before or after), OR the
 *                embedding's own catalyst_flags array is non-empty.
 *   - opex_week: true if session_date is in the week containing the 3rd Friday
 *                (monthly OPEX approximation). Cheap client-side, zero queries.
 *   - dow      : JS Date.getUTCDay() (0=Sun .. 6=Sat) → we filter out weekends
 *                upstream but the field is present so the UI can filter.
 *
 * Aggregate stats across filtered sessions:
 *   - avg_close_return_pct : mean of eod_return_pct where present
 *   - median_dd_pct        : median of |min(0, eod_return_pct)| — we don't
 *                            have intraday DD, so this is a floor approximation
 *                            using close return as the worst mark. Labeled as
 *                            "est" in the UI.
 *   - hit_rate             : fraction of filtered sessions where eod_return_pct > 0
 *
 * The corpus is thin (requires >=7 sessions to show meaningful results) — the
 * component surfaces a "not enough history yet" state below that threshold.
 *
 * No network calls beyond initial fetches; filtering is pure memo. One round
 * trip per session list for grades; paginated query for embeddings (up to 400
 * rows covers ~1.5 years of trading days).
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

// ----------------------------------------------------------------------------
// Public filter + row shapes
// ----------------------------------------------------------------------------

export type GammaFilter = 'positive' | 'negative' | 'any';
export type IvTierFilter = 'low' | 'mid' | 'high' | 'any';
export type BreadthFilter = 'strong' | 'mixed' | 'weak' | 'any';
export type CatalystFilter = 'yes' | 'no' | 'any';
export type VixTierFilter = 'low' | 'mid' | 'elevated' | 'stressed' | 'any';
export type OpexFilter = 'yes' | 'no' | 'any';

export interface RegimeAnalogFilters {
  gamma: GammaFilter;
  iv_tier: IvTierFilter;
  breadth: BreadthFilter;
  catalyst: CatalystFilter;
  vix_tier: VixTierFilter;
  /** Day-of-week multi-select. Empty = any. 0=Sun .. 6=Sat. */
  days_of_week: number[];
  opex_week: OpexFilter;
  /** Minimum similarity to TODAY's tape embedding. 0 disables this filter. */
  min_similarity: number;
}

export const DEFAULT_FILTERS: RegimeAnalogFilters = {
  gamma: 'any',
  iv_tier: 'any',
  breadth: 'any',
  catalyst: 'any',
  vix_tier: 'any',
  days_of_week: [],
  opex_week: 'any',
  min_similarity: 0,
};

export interface RegimeSessionRow {
  session_date: string;              // 'YYYY-MM-DD'
  through_utc: string;               // ISO timestamp
  state_summary: string;
  // Derived regime tags (coarse, for filter + chip display)
  gamma: 'positive' | 'negative' | 'unknown';
  iv_tier: 'low' | 'mid' | 'high' | 'unknown';
  vix_tier: 'low' | 'mid' | 'elevated' | 'stressed' | 'unknown';
  breadth: 'strong' | 'mixed' | 'weak' | 'unknown';
  has_catalyst: boolean;
  catalyst_sources: string[];        // ['fomc','earnings:AAPL', ...]
  opex_week: boolean;
  dow: number;                       // 0..6
  event_count: number;               // ct_events within 24h
  // Numeric context
  spy_price: number | null;
  iv_rank_spy: number | null;
  vix: number | null;
  breadth_net: number | null;
  // Outcome
  eod_return_pct: number | null;
  eod_summary: string | null;
  // Referee rollup
  grade_right: number;
  grade_wrong: number;
  grade_partial: number;
  grade_ambiguous: number;
  // Similarity (vs today) — NaN/null when unavailable (no today snapshot)
  similarity_to_today: number | null;
}

export interface RegimeAggregate {
  count: number;
  avg_close_return_pct: number | null;
  median_dd_pct_est: number | null;
  hit_rate: number | null;              // fraction with eod_return_pct > 0
  avg_event_count: number | null;
  precision: number | null;             // right / (right+wrong+partial) across all sessions
}

// ----------------------------------------------------------------------------
// Raw shapes from the three queries
// ----------------------------------------------------------------------------

interface RawEmbeddingRow {
  id: string;
  session_date: string;
  through_utc: string;
  state_summary: string;
  state_features: RawStateFeatures | null;
  embedding: number[] | string | null;
  eod_return_pct: number | null;
  eod_summary: string | null;
}

interface RawStateFeatures {
  spy_price?: number | null;
  spx_regime?: 'positive' | 'negative' | 'unknown';
  vix?: number | null;
  vix_tier?: 'low' | 'mid' | 'elevated' | 'stressed' | 'unknown';
  iv_rank_spy?: number | null;
  iv_tier?: 'cold' | 'mid' | 'hot' | 'low' | 'high' | 'unknown';
  breadth_advancers?: number | null;
  breadth_decliners?: number | null;
  breadth_net?: number | null;
  net_call_premium?: number | null;
  net_put_premium?: number | null;
  put_call_ratio?: number | null;
  catalyst_flags?: string[];
  extras?: Record<string, unknown>;
}

interface RawIvRow  { ticker: string; iv_rank: number | null; date: string; }
interface RawEventRow {
  event_type: 'earnings' | 'fda' | 'econ';
  ticker: string | null;
  event_date: string;
  title: string | null;
  importance: number | null;
}
interface RawGradeRow {
  subject_id: string;
  verdict: 'right' | 'wrong' | 'partial' | 'ambiguous';
  graded_at: string;
  actual_return_pct: number | null;
}

// ----------------------------------------------------------------------------
// Derivation helpers
// ----------------------------------------------------------------------------

/**
 * Third-Friday OPEX approximation — true for every weekday in the week
 * containing the month's 3rd Friday. Cheap, zero-query, good-enough proxy.
 */
function isOpexWeek(dateStr: string): boolean {
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) return false;
  // Find the 3rd Friday of this month (UTC-calendar is fine for a date-only check).
  const first = new Date(Date.UTC(y, m - 1, 1));
  const firstDow = first.getUTCDay();               // 0=Sun
  // Days to first Friday (5 = Friday)
  const offsetToFirstFri = (5 - firstDow + 7) % 7;
  const thirdFri = 1 + offsetToFirstFri + 14;       // DOM of 3rd Friday
  // Monday of that week = thirdFri - 4
  const weekStart = thirdFri - 4;
  const weekEnd   = thirdFri + 1;                   // Saturday — inclusive of Friday
  return d >= weekStart && d <= weekEnd;
}

function mapIvTier(
  ivRank: number | null,
  fallback: RawStateFeatures['iv_tier'] | undefined,
): RegimeSessionRow['iv_tier'] {
  if (typeof ivRank === 'number' && Number.isFinite(ivRank)) {
    if (ivRank < 25) return 'low';
    if (ivRank < 60) return 'mid';
    return 'high';
  }
  if (fallback === 'cold' || fallback === 'low') return 'low';
  if (fallback === 'mid') return 'mid';
  if (fallback === 'hot' || fallback === 'high') return 'high';
  return 'unknown';
}

function mapBreadth(feat: RawStateFeatures | null): RegimeSessionRow['breadth'] {
  if (!feat) return 'unknown';
  const adv = feat.breadth_advancers ?? null;
  const dec = feat.breadth_decliners ?? null;
  const net = feat.breadth_net ?? (adv !== null && dec !== null ? adv - dec : null);
  const call = feat.net_call_premium ?? null;
  const put  = feat.net_put_premium  ?? null;

  // Combine breadth proxy (regime-count diff) with tide (net call vs put premium)
  // Strong: both skew positive. Weak: both negative. Mixed: disagree / one null.
  const breadthPos = typeof net === 'number' ? net > 0 : null;
  const tidePos =
    typeof call === 'number' && typeof put === 'number'
      ? call - put > 0
      : null;
  if (breadthPos === null && tidePos === null) return 'unknown';
  if (breadthPos === true  && tidePos !== false) return 'strong';
  if (breadthPos === false && tidePos !== true ) return 'weak';
  if (breadthPos === null) return tidePos ? 'strong' : 'weak';
  if (tidePos === null)    return breadthPos ? 'strong' : 'weak';
  return 'mixed';
}

function eventSourceLabel(e: RawEventRow): string {
  if (e.event_type === 'earnings') return `earnings${e.ticker ? `:${e.ticker}` : ''}`;
  if (e.event_type === 'fda')      return `fda${e.ticker ? `:${e.ticker}` : ''}`;
  // econ — use title when short, else just the type
  const t = (e.title ?? '').toLowerCase();
  if (/\bfomc\b|\bfed\b|\bpowell\b/.test(t)) return 'fomc';
  if (/\bcpi\b/.test(t)) return 'cpi';
  if (/\bpce\b/.test(t)) return 'pce';
  if (/\bppi\b/.test(t)) return 'ppi';
  if (/\bnfp\b|\bpayroll\b|\bjobs\b|\bunemployment\b/.test(t)) return 'jobs';
  if (/\bgdp\b/.test(t)) return 'gdp';
  return e.title ? e.title.slice(0, 28) : 'econ';
}

function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

/** Cosine similarity on unit-norm 512-dim vectors. Inputs may be string-encoded. */
function cosine(a: number[] | null, b: number[] | null): number | null {
  if (!a || !b || a.length !== b.length) return null;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]; const y = b[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    dot += x * y; na += x * x; nb += y * y;
  }
  if (na === 0 || nb === 0) return null;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function parseEmbedding(raw: unknown): number[] | null {
  if (!raw) return null;
  if (Array.isArray(raw)) return raw as number[];
  if (typeof raw === 'string') {
    // pgvector returns as "[0.01,0.02,...]"
    try {
      const cleaned = raw.trim().replace(/^\[/, '[').replace(/\]$/, ']');
      const v = JSON.parse(cleaned);
      return Array.isArray(v) ? v : null;
    } catch {
      return null;
    }
  }
  return null;
}

// ----------------------------------------------------------------------------
// Main hook
// ----------------------------------------------------------------------------

export const REGIME_ANALOGS_MIN_CORPUS = 7;

export interface UseRegimeAnalogsResult {
  loading: boolean;
  error: string | null;
  corpusCount: number;
  warmingUp: boolean;                // corpusCount < REGIME_ANALOGS_MIN_CORPUS
  todaySession: RegimeSessionRow | null;
  sessions: RegimeSessionRow[];      // fully-derived, pre-filter
  filtered: RegimeSessionRow[];
  aggregate: RegimeAggregate;
}

export function useRegimeAnalogs(
  filters: RegimeAnalogFilters,
): UseRegimeAnalogsResult {
  // 1) Session embeddings — primary corpus (includes today's row if ct-session-analog
  //    has built it). We pull `embedding` for optional similarity filtering
  //    and exclude the query-session itself from the "sessions" list.
  const embQ = useQuery<RawEmbeddingRow[]>({
    queryKey: ['useRegimeAnalogs:session_embeddings'],
    refetchInterval: 5 * 60_000,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('ct_session_embeddings')
        .select('id, session_date, through_utc, state_summary, state_features, embedding, eod_return_pct, eod_summary')
        .order('session_date', { ascending: false })
        .limit(400);
      if (error) throw new Error(error.message);
      return (data ?? []) as unknown as RawEmbeddingRow[];
    },
  });

  // 2) IV rank daily — SPY only, last ~18 months, fills gaps in state_features
  const ivQ = useQuery<RawIvRow[]>({
    queryKey: ['useRegimeAnalogs:iv_rank_daily'],
    refetchInterval: 15 * 60_000,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const cutoff = new Date(); cutoff.setUTCMonth(cutoff.getUTCMonth() - 18);
      const { data, error } = await supabase
        .from('ct_iv_rank_daily')
        .select('ticker, iv_rank, date')
        .eq('ticker', 'SPY')
        .gte('date', cutoff.toISOString().slice(0, 10));
      if (error) throw new Error(error.message);
      return (data ?? []) as RawIvRow[];
    },
  });

  // 3) Events — econ (importance>=2) + earnings rows within the window
  const evQ = useQuery<RawEventRow[]>({
    queryKey: ['useRegimeAnalogs:events'],
    refetchInterval: 15 * 60_000,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const cutoff = new Date(); cutoff.setUTCMonth(cutoff.getUTCMonth() - 18);
      const { data, error } = await supabase
        .from('ct_events')
        .select('event_type, ticker, event_date, title, importance')
        .gte('event_date', cutoff.toISOString().slice(0, 10))
        .order('event_date', { ascending: false })
        .limit(5000);
      if (error) throw new Error(error.message);
      return (data ?? []) as RawEventRow[];
    },
  });

  // 4) Grades rollup — pull recent grades, bucket by session_date (date of graded_at).
  //    We cap to 2000; referee history older than that is unlikely to correspond
  //    to any session in the 18-month window anyway.
  const grQ = useQuery<RawGradeRow[]>({
    queryKey: ['useRegimeAnalogs:grades'],
    refetchInterval: 5 * 60_000,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('ct_grades')
        .select('subject_id, verdict, graded_at, actual_return_pct')
        .order('graded_at', { ascending: false })
        .limit(2000);
      if (error) throw new Error(error.message);
      return (data ?? []) as RawGradeRow[];
    },
  });

  const loading = embQ.isLoading || ivQ.isLoading || evQ.isLoading || grQ.isLoading;
  const error =
    (embQ.error as Error | null)?.message ??
    (ivQ.error as Error | null)?.message ??
    (evQ.error as Error | null)?.message ??
    (grQ.error as Error | null)?.message ??
    null;

  // ----- Derive full session rows + filtered view (pure memo) -----
  const result = useMemo<Omit<UseRegimeAnalogsResult, 'loading' | 'error'>>(() => {
    const empty: Omit<UseRegimeAnalogsResult, 'loading' | 'error'> = {
      corpusCount: 0,
      warmingUp: true,
      todaySession: null,
      sessions: [],
      filtered: [],
      aggregate: {
        count: 0, avg_close_return_pct: null, median_dd_pct_est: null,
        hit_rate: null, avg_event_count: null, precision: null,
      },
    };

    const embRows = embQ.data ?? [];
    if (embRows.length === 0) return empty;

    // Index IV rank by date
    const ivByDate = new Map<string, number | null>();
    for (const r of ivQ.data ?? []) ivByDate.set(r.date, r.iv_rank);

    // Index events by date → list of event rows. Also produce adjacency set
    // for "±24h" lookup via addDays.
    const evByDate = new Map<string, RawEventRow[]>();
    for (const e of evQ.data ?? []) {
      const arr = evByDate.get(e.event_date) ?? [];
      arr.push(e);
      evByDate.set(e.event_date, arr);
    }

    // Grades rollup keyed by date (UTC portion of graded_at)
    const gradeByDate = new Map<string, { right: number; wrong: number; partial: number; ambiguous: number }>();
    for (const g of grQ.data ?? []) {
      const d = (g.graded_at ?? '').slice(0, 10);
      if (!d) continue;
      const bucket = gradeByDate.get(d) ?? { right: 0, wrong: 0, partial: 0, ambiguous: 0 };
      bucket[g.verdict] = (bucket[g.verdict] ?? 0) + 1;
      gradeByDate.set(d, bucket);
    }

    // Deduplicate: one row per session_date (newest through_utc wins).
    const byDate = new Map<string, RawEmbeddingRow>();
    for (const r of embRows) {
      const prev = byDate.get(r.session_date);
      if (!prev || r.through_utc > prev.through_utc) byDate.set(r.session_date, r);
    }

    // Today's date (UTC) — used to pull today's row for "match today's regime"
    const todayStr = new Date().toISOString().slice(0, 10);
    const todayRow = byDate.get(todayStr) ?? null;
    const todayEmb = todayRow ? parseEmbedding(todayRow.embedding as unknown) : null;

    // ---- Build RegimeSessionRow for every date (today excluded from the list) ----
    const sessions: RegimeSessionRow[] = [];
    for (const row of byDate.values()) {
      if (row.session_date === todayStr) continue; // exclude today from historical set

      const feat = row.state_features ?? null;
      const ivRank =
        (typeof feat?.iv_rank_spy === 'number' ? feat.iv_rank_spy : null) ??
        (ivByDate.get(row.session_date) ?? null);

      // ±24h event window (-1, 0, +1 days)
      const ev: RawEventRow[] = [
        ...(evByDate.get(addDays(row.session_date, -1)) ?? []),
        ...(evByDate.get(row.session_date) ?? []),
        ...(evByDate.get(addDays(row.session_date, +1)) ?? []),
      ];
      const qualifyingEvents = ev.filter(e =>
        e.event_type === 'earnings' ||
        e.event_type === 'fda' ||
        (e.event_type === 'econ' && (e.importance ?? 0) >= 2),
      );
      const flagSet = new Set<string>(feat?.catalyst_flags ?? []);
      for (const e of qualifyingEvents) flagSet.add(eventSourceLabel(e));
      const has_catalyst = flagSet.size > 0;

      // Similarity to today — null when we don't have today's embedding
      const rowEmb = parseEmbedding(row.embedding as unknown);
      const sim = todayEmb ? cosine(todayEmb, rowEmb) : null;

      // Day of week (UTC is fine for our purposes; sessions are weekdays)
      const [yy, mm, dd] = row.session_date.split('-').map(Number);
      const dow = new Date(Date.UTC(yy, (mm ?? 1) - 1, dd ?? 1)).getUTCDay();

      const gradeBucket = gradeByDate.get(row.session_date) ?? { right: 0, wrong: 0, partial: 0, ambiguous: 0 };

      sessions.push({
        session_date: row.session_date,
        through_utc: row.through_utc,
        state_summary: row.state_summary ?? '',
        gamma: (feat?.spx_regime === 'positive' || feat?.spx_regime === 'negative')
          ? feat.spx_regime
          : 'unknown',
        iv_tier: mapIvTier(ivRank, feat?.iv_tier),
        vix_tier: feat?.vix_tier ?? 'unknown',
        breadth: mapBreadth(feat),
        has_catalyst,
        catalyst_sources: [...flagSet].sort(),
        opex_week: isOpexWeek(row.session_date),
        dow,
        event_count: qualifyingEvents.length,
        spy_price: feat?.spy_price ?? null,
        iv_rank_spy: ivRank,
        vix: feat?.vix ?? null,
        breadth_net: feat?.breadth_net ?? null,
        eod_return_pct: row.eod_return_pct ?? null,
        eod_summary: row.eod_summary ?? null,
        grade_right: gradeBucket.right,
        grade_wrong: gradeBucket.wrong,
        grade_partial: gradeBucket.partial,
        grade_ambiguous: gradeBucket.ambiguous,
        similarity_to_today: sim,
      });
    }

    // Today's session as a convenience for "match today's regime"
    let todaySession: RegimeSessionRow | null = null;
    if (todayRow) {
      const feat = todayRow.state_features ?? null;
      const ivRank =
        (typeof feat?.iv_rank_spy === 'number' ? feat.iv_rank_spy : null) ??
        (ivByDate.get(todayStr) ?? null);
      const ev: RawEventRow[] = [
        ...(evByDate.get(addDays(todayStr, -1)) ?? []),
        ...(evByDate.get(todayStr) ?? []),
        ...(evByDate.get(addDays(todayStr, +1)) ?? []),
      ];
      const qe = ev.filter(e =>
        e.event_type === 'earnings' ||
        e.event_type === 'fda' ||
        (e.event_type === 'econ' && (e.importance ?? 0) >= 2),
      );
      const flags = new Set<string>(feat?.catalyst_flags ?? []);
      for (const e of qe) flags.add(eventSourceLabel(e));
      const [yy, mm, dd] = todayStr.split('-').map(Number);
      const dow = new Date(Date.UTC(yy, (mm ?? 1) - 1, dd ?? 1)).getUTCDay();
      todaySession = {
        session_date: todayStr,
        through_utc: todayRow.through_utc,
        state_summary: todayRow.state_summary ?? '',
        gamma: (feat?.spx_regime === 'positive' || feat?.spx_regime === 'negative')
          ? feat.spx_regime
          : 'unknown',
        iv_tier: mapIvTier(ivRank, feat?.iv_tier),
        vix_tier: feat?.vix_tier ?? 'unknown',
        breadth: mapBreadth(feat),
        has_catalyst: flags.size > 0,
        catalyst_sources: [...flags].sort(),
        opex_week: isOpexWeek(todayStr),
        dow,
        event_count: qe.length,
        spy_price: feat?.spy_price ?? null,
        iv_rank_spy: ivRank,
        vix: feat?.vix ?? null,
        breadth_net: feat?.breadth_net ?? null,
        eod_return_pct: todayRow.eod_return_pct ?? null,
        eod_summary: todayRow.eod_summary ?? null,
        grade_right: gradeByDate.get(todayStr)?.right ?? 0,
        grade_wrong: gradeByDate.get(todayStr)?.wrong ?? 0,
        grade_partial: gradeByDate.get(todayStr)?.partial ?? 0,
        grade_ambiguous: gradeByDate.get(todayStr)?.ambiguous ?? 0,
        similarity_to_today: 1.0,
      };
    }

    // Filter
    const filtered = sessions.filter(s => {
      if (filters.gamma !== 'any'    && s.gamma    !== filters.gamma) return false;
      if (filters.iv_tier !== 'any'  && s.iv_tier  !== filters.iv_tier) return false;
      if (filters.breadth !== 'any'  && s.breadth  !== filters.breadth) return false;
      if (filters.vix_tier !== 'any' && s.vix_tier !== filters.vix_tier) return false;
      if (filters.catalyst === 'yes' && !s.has_catalyst) return false;
      if (filters.catalyst === 'no'  &&  s.has_catalyst) return false;
      if (filters.opex_week === 'yes' && !s.opex_week) return false;
      if (filters.opex_week === 'no'  &&  s.opex_week) return false;
      if (filters.days_of_week.length > 0 && !filters.days_of_week.includes(s.dow)) return false;
      if (filters.min_similarity > 0) {
        if (s.similarity_to_today === null) return false;
        if (s.similarity_to_today < filters.min_similarity) return false;
      }
      return true;
    });

    // Sort newest first by default
    filtered.sort((a, b) => b.session_date.localeCompare(a.session_date));

    // Aggregate
    const agg = computeAggregate(filtered);

    const corpusCount = sessions.length;
    return {
      corpusCount,
      warmingUp: corpusCount < REGIME_ANALOGS_MIN_CORPUS,
      todaySession,
      sessions,
      filtered,
      aggregate: agg,
    };
  }, [embQ.data, ivQ.data, evQ.data, grQ.data, filters]);

  return { loading, error, ...result };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function computeAggregate(rows: RegimeSessionRow[]): RegimeAggregate {
  if (rows.length === 0) {
    return {
      count: 0, avg_close_return_pct: null, median_dd_pct_est: null,
      hit_rate: null, avg_event_count: null, precision: null,
    };
  }
  const withReturn = rows.filter(r => typeof r.eod_return_pct === 'number' && Number.isFinite(r.eod_return_pct));
  const avg =
    withReturn.length === 0
      ? null
      : withReturn.reduce((s, r) => s + (r.eod_return_pct as number), 0) / withReturn.length;
  const dds = withReturn.map(r => Math.abs(Math.min(0, r.eod_return_pct as number)));
  const mdd = median(dds);
  const hits = withReturn.length === 0
    ? null
    : withReturn.filter(r => (r.eod_return_pct as number) > 0).length / withReturn.length;
  const avgEvents = rows.reduce((s, r) => s + r.event_count, 0) / rows.length;
  const totals = rows.reduce(
    (s, r) => ({
      right:   s.right   + r.grade_right,
      wrong:   s.wrong   + r.grade_wrong,
      partial: s.partial + r.grade_partial,
    }),
    { right: 0, wrong: 0, partial: 0 },
  );
  const denom = totals.right + totals.wrong + totals.partial;
  const precision = denom === 0 ? null : totals.right / denom;
  return {
    count: rows.length,
    avg_close_return_pct: avg,
    median_dd_pct_est: mdd,
    hit_rate: hits,
    avg_event_count: avgEvents,
    precision,
  };
}

// ----------------------------------------------------------------------------
// Export helpers (used by Analogs.tsx export-all button)
// ----------------------------------------------------------------------------

/**
 * Build a CSV string for the filtered session rows. One row per session plus
 * a header. Values are double-quote-escaped where needed.
 */
export function regimeAnalogsToCsv(rows: RegimeSessionRow[]): string {
  const headers = [
    'session_date', 'gamma', 'iv_tier', 'vix_tier', 'breadth',
    'has_catalyst', 'catalyst_sources', 'opex_week', 'dow',
    'event_count', 'spy_price', 'iv_rank_spy', 'vix', 'breadth_net',
    'eod_return_pct', 'eod_summary',
    'grade_right', 'grade_wrong', 'grade_partial', 'grade_ambiguous',
    'similarity_to_today',
  ];
  const esc = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    const s = Array.isArray(v) ? v.join('|') : String(v);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push([
      r.session_date, r.gamma, r.iv_tier, r.vix_tier, r.breadth,
      r.has_catalyst, r.catalyst_sources, r.opex_week, r.dow,
      r.event_count, r.spy_price, r.iv_rank_spy, r.vix, r.breadth_net,
      r.eod_return_pct, r.eod_summary,
      r.grade_right, r.grade_wrong, r.grade_partial, r.grade_ambiguous,
      r.similarity_to_today,
    ].map(esc).join(','));
  }
  return lines.join('\n');
}
