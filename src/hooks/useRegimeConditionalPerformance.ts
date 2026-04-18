/**
 * useRegimeConditionalPerformance — "where does Claude actually have edge?"
 *
 * Slices graded alert+flag outcomes (last 30d) by market regime at claim time,
 * so a single "hit rate = X%" becomes a set of conditionals:
 *   - IN HIGH IV regime, hit rate = Y% (n=Z)
 *   - IN OPEN session, hit rate = W% (n=Q)
 *   - etc.
 *
 * Six regime dimensions, each a categorical bucket:
 *
 *   1. gamma        — nearest ct_heartbeats._snapshot.spx_macro.regime before
 *                     alert.created_at. Values: positive / negative / unknown.
 *   2. iv           — nearest ct_iv_rank_daily row for the primary instrument
 *                     (alert.instruments[0]) at/before alert.created_at.
 *                     Buckets: low (<25) / mid (25-60) / high (>60).
 *   3. session      — derived from alert.created_at UTC hour:
 *                     open (13:30-14:30), midday (14:30-19:30), close (19:30-21:00),
 *                     other (overnight / weekend).
 *   4. catalyst     — any ct_news_analyses row for alert.instruments[*] with
 *                     sentiment_magnitude >= 4 in the 24h BEFORE created_at.
 *                     Values: yes / no.
 *   5. dow          — day of week from created_at (ET approximation via UTC hour
 *                     shift for open-window weekdays). Values: Mon..Fri / weekend.
 *   6. opex         — 3rd Friday of month + Thursday/Friday of that week.
 *                     Values: opex_week / normal. (Flagged approximation —
 *                     task explicitly authorizes the simpler "any Friday" as
 *                     a fallback but we ship the tighter 3rd-Friday definition
 *                     since it's 4 lines of date math.)
 *
 * For each dimension × bucket we emit { count, winRate, avgReturnPct, avgR }.
 *
 * R-multiple definition (honest fallback):
 *   R = actual_return_pct / |expected_move.high_pct - expected_move.low_pct|/2
 *   That is: realized move ÷ half-band of claimed expected move. Skips the
 *   row when expected_move is missing or the band is <= 0. No synthesized R.
 *
 * Nearest-heartbeat lookup: sorted-bisect on client. Heartbeats fetched once
 * (500 most recent in 30d window), sorted ascending by created_at. For each
 * alert we binary-search the largest HB with created_at <= alert.created_at.
 * O((alerts + heartbeats) · log(heartbeats)). Same bisect pattern for IV.
 *
 * Sparse-sample honesty: buckets with count < 3 still render but carry
 * insufficient=true and winRate/avgReturnPct stay numeric (consumer masks).
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

// ─── public types ────────────────────────────────────────────────────────────

export type RegimeDim =
  | 'gamma'
  | 'iv'
  | 'session'
  | 'catalyst'
  | 'dow'
  | 'opex';

export interface RegimeSlice {
  value: string;
  count: number;
  wins: number;
  winRate: number;         // right / (right + partial + wrong); 0..1
  avgReturnPct: number;    // mean actual_return_pct across graded rows
  avgR: number | null;     // mean R-multiple (null when no banded grades)
  rSample: number;         // rows contributing to avgR
  insufficient: boolean;   // count < SPARSE_THRESHOLD
}

export interface DimensionReport {
  dim: RegimeDim;
  label: string;
  slices: RegimeSlice[];
  /** Best slice by winRate with count >= SPARSE_THRESHOLD; null if all sparse. */
  best: RegimeSlice | null;
  /** Worst slice by winRate with count >= SPARSE_THRESHOLD; null if all sparse. */
  worst: RegimeSlice | null;
}

export interface CrossCell {
  gamma: 'positive' | 'negative' | 'unknown';
  session: 'open' | 'midday' | 'close' | 'other';
  count: number;
  winRate: number;
  insufficient: boolean;
}

export interface RegimeConditionalPerformance {
  sample: number;                 // graded alerts+flags with a lookup hit
  overallWinRate: number;         // baseline — denominator for edge color
  overallAvgReturnPct: number;
  dimensions: DimensionReport[];
  crossGammaSession: CrossCell[]; // for the 2D heatmap
  dataThin: boolean;              // sample < MIN_SAMPLE_FOR_CLAIMS (15)
  dataThinNote: string | null;
}

// ─── tuning knobs ────────────────────────────────────────────────────────────

const DAYS_BACK = 30;
const SPARSE_THRESHOLD = 3;
const MIN_SAMPLE_FOR_CLAIMS = 15;
const ALERT_LIMIT = 500;
const HEARTBEAT_LIMIT = 500;
const IV_LOOKUP_DAYS = 45;       // headroom over 30d window for "nearest before"
const NEWS_LOOKBACK_HRS = 24;
const CATALYST_MAG_THRESHOLD = 4;

// ─── row shapes ──────────────────────────────────────────────────────────────

interface GradeRow {
  id: string;
  subject_type: 'flag' | 'alert';
  subject_id: string;
  instrument: string | null;
  verdict: 'right' | 'wrong' | 'partial' | 'ambiguous';
  actual_return_pct: number | null;
  graded_at: string;
}

interface ClaimRow {
  id: string;
  instruments: string[] | null;
  created_at: string;
  expected_move: { low_pct?: number; high_pct?: number } | null;
}

interface HeartbeatLite {
  created_at: string;
  regime: 'positive' | 'negative' | 'unknown' | null;
}

interface IvRow {
  ticker: string;
  date: string;          // YYYY-MM-DD
  iv_rank: number | null;
}

interface NewsRow {
  instrument: string;
  created_at: string;
  sentiment_magnitude: number | null;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function bisectRightByTime<T>(
  arr: T[],
  getTime: (r: T) => number,
  target: number,
): number {
  // Returns i such that arr[0..i-1] all have getTime <= target. Classic upper_bound.
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (getTime(arr[mid]) <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** UTC-hour-based session bucket. Matches RTH 13:30-21:00 UTC mapping. */
function sessionBucket(iso: string): 'open' | 'midday' | 'close' | 'other' {
  const d = new Date(iso);
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return 'other';
  const h = d.getUTCHours();
  const m = d.getUTCMinutes();
  const minutes = h * 60 + m;
  if (minutes >= 13 * 60 + 30 && minutes < 14 * 60 + 30) return 'open';
  if (minutes >= 14 * 60 + 30 && minutes < 19 * 60 + 30) return 'midday';
  if (minutes >= 19 * 60 + 30 && minutes < 21 * 60) return 'close';
  return 'other';
}

/** Day-of-week bucket (UTC). Close enough for ET trading days; weekend alerts bucket separately. */
function dowBucket(iso: string): 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'weekend' {
  const d = new Date(iso).getUTCDay();
  switch (d) {
    case 1: return 'Mon';
    case 2: return 'Tue';
    case 3: return 'Wed';
    case 4: return 'Thu';
    case 5: return 'Fri';
    default: return 'weekend';
  }
}

/**
 * OPEX week detection — 3rd Friday of the month (standard monthly equity OPEX).
 * Returns true if the alert's UTC date is the Thursday or Friday of that week.
 * Approximation (documented in task constraints):
 *   - Ignores quarterly / triple-witching distinctions.
 *   - Uses UTC date for the "which day" check — fine for ET RTH alerts.
 */
function isOpexWeek(iso: string): boolean {
  const d = new Date(iso);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  // Find third Friday of this month.
  const first = new Date(Date.UTC(y, m, 1));
  const firstDow = first.getUTCDay();
  // Friday = 5. Days to add from day 1 to reach first Friday.
  const daysToFirstFri = (5 - firstDow + 7) % 7;
  const thirdFriDay = 1 + daysToFirstFri + 14;
  const thirdFriday = new Date(Date.UTC(y, m, thirdFriDay));
  const thirdThursday = new Date(Date.UTC(y, m, thirdFriDay - 1));
  const sameDay = (a: Date, b: Date) =>
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate();
  return sameDay(d, thirdFriday) || sameDay(d, thirdThursday);
}

function ivBucket(rank: number | null | undefined): 'low' | 'mid' | 'high' | 'unknown' {
  if (rank == null || !Number.isFinite(rank)) return 'unknown';
  if (rank < 25) return 'low';
  if (rank <= 60) return 'mid';
  return 'high';
}

function extractRegime(hb: { current_reads: unknown }): HeartbeatLite['regime'] {
  const snap = (hb.current_reads as Record<string, unknown> | undefined)?._snapshot as
    | { spx_macro?: { regime?: 'positive' | 'negative' | 'unknown' } }
    | undefined;
  return snap?.spx_macro?.regime ?? null;
}

function rMultipleOf(claim: ClaimRow, actualPct: number): number | null {
  const em = claim.expected_move;
  if (!em) return null;
  const low = Number(em.low_pct);
  const high = Number(em.high_pct);
  if (!Number.isFinite(low) || !Number.isFinite(high)) return null;
  const halfBand = Math.abs(high - low) / 2;
  if (halfBand <= 0) return null;
  return actualPct / halfBand;
}

// ─── main hook ───────────────────────────────────────────────────────────────

interface TaggedGrade {
  verdict: GradeRow['verdict'];
  actual_return_pct: number;
  rMultiple: number | null;
  gamma: 'positive' | 'negative' | 'unknown';
  iv: 'low' | 'mid' | 'high' | 'unknown';
  session: 'open' | 'midday' | 'close' | 'other';
  catalyst: 'yes' | 'no';
  dow: 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'weekend';
  opex: 'opex_week' | 'normal';
}

export function useRegimeConditionalPerformance() {
  return useQuery<RegimeConditionalPerformance>({
    queryKey: ['ct_regime_conditional_performance', DAYS_BACK],
    refetchInterval: 5 * 60 * 1000,
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<RegimeConditionalPerformance> => {
      const sinceGrades = new Date(
        Date.now() - DAYS_BACK * 24 * 3600_000,
      ).toISOString();
      const sinceIv = new Date(
        Date.now() - IV_LOOKUP_DAYS * 24 * 3600_000,
      ).toISOString().slice(0, 10);
      const sinceNews = new Date(
        Date.now() - (DAYS_BACK * 24 + NEWS_LOOKBACK_HRS) * 3600_000,
      ).toISOString();

      const [gradesRes, flagsRes, alertsRes, hbRes, ivRes, newsRes] =
        await Promise.all([
          supabase
            .from('ct_grades')
            .select(
              'id, subject_type, subject_id, instrument, verdict, actual_return_pct, graded_at',
            )
            .in('subject_type', ['flag', 'alert'])
            .gte('graded_at', sinceGrades)
            .order('graded_at', { ascending: false })
            .limit(ALERT_LIMIT),
          supabase
            .from('ct_flags')
            .select('id, instruments, created_at, expected_move')
            .gte('created_at', sinceGrades)
            .limit(ALERT_LIMIT),
          supabase
            .from('ct_alerts')
            .select('id, instruments, created_at, expected_move')
            .gte('created_at', sinceGrades)
            .limit(ALERT_LIMIT),
          supabase
            .from('ct_heartbeats')
            .select('created_at, current_reads')
            .neq('prompt_version', 'mcp-verify')
            .gte('created_at', sinceGrades)
            .order('created_at', { ascending: true })
            .limit(HEARTBEAT_LIMIT),
          supabase
            .from('ct_iv_rank_daily')
            .select('ticker, date, iv_rank')
            .gte('date', sinceIv)
            .order('date', { ascending: true }),
          supabase
            .from('ct_news_analyses')
            .select('instrument, created_at, sentiment_magnitude')
            .gte('created_at', sinceNews)
            .gte('sentiment_magnitude', CATALYST_MAG_THRESHOLD)
            .limit(2000),
        ]);

      const grades = (gradesRes.data ?? []) as GradeRow[];
      const flags = (flagsRes.data ?? []) as ClaimRow[];
      const alerts = (alertsRes.data ?? []) as ClaimRow[];
      const rawHbs = (hbRes.data ?? []) as Array<{ created_at: string; current_reads: unknown }>;
      const ivRows = (ivRes.data ?? []) as IvRow[];
      const newsRows = (newsRes.data ?? []) as NewsRow[];

      // ─── index claims ─────────────────────────────────────────────────────
      const flagMap = new Map<string, ClaimRow>();
      for (const f of flags) flagMap.set(f.id, f);
      const alertMap = new Map<string, ClaimRow>();
      for (const a of alerts) alertMap.set(a.id, a);

      // ─── heartbeats (sorted asc, with regime extracted once) ──────────────
      const hbs: HeartbeatLite[] = rawHbs
        .map((h) => ({
          created_at: h.created_at,
          regime: extractRegime(h),
        }))
        .filter((h) => h.regime != null)
        .sort(
          (a, b) =>
            new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
        );
      const hbTimes = hbs.map((h) => new Date(h.created_at).getTime());

      function gammaAt(tsMs: number): 'positive' | 'negative' | 'unknown' {
        if (hbs.length === 0) return 'unknown';
        const idx = bisectRightByTime(hbs, (h) => new Date(h.created_at).getTime(), tsMs);
        if (idx === 0) return 'unknown';
        const hit = hbs[idx - 1].regime;
        return hit ?? 'unknown';
        // unused but left intentionally to silence linters tracking hbTimes
      }
      void hbTimes;

      // ─── IV rank (per-ticker sorted asc, bisect on date-ms) ───────────────
      const ivByTicker = new Map<string, IvRow[]>();
      for (const r of ivRows) {
        if (!r.ticker) continue;
        const list = ivByTicker.get(r.ticker) ?? [];
        list.push(r);
        ivByTicker.set(r.ticker, list);
      }
      for (const list of ivByTicker.values()) {
        list.sort((a, b) => a.date.localeCompare(b.date));
      }

      function ivAt(
        ticker: string | null,
        tsMs: number,
      ): 'low' | 'mid' | 'high' | 'unknown' {
        if (!ticker) return 'unknown';
        const list = ivByTicker.get(ticker);
        if (!list || list.length === 0) return 'unknown';
        const targetDate = new Date(tsMs).toISOString().slice(0, 10);
        const idx = bisectRightByTime(list, (r) => Date.parse(r.date + 'T00:00:00Z'), Date.parse(targetDate + 'T00:00:00Z'));
        if (idx === 0) return 'unknown';
        return ivBucket(list[idx - 1].iv_rank);
      }

      // ─── news catalysts (per-ticker, sorted asc) ──────────────────────────
      const newsByTicker = new Map<string, number[]>();
      for (const n of newsRows) {
        if (!n.instrument) continue;
        const t = new Date(n.created_at).getTime();
        if (!Number.isFinite(t)) continue;
        const list = newsByTicker.get(n.instrument) ?? [];
        list.push(t);
        newsByTicker.set(n.instrument, list);
      }
      for (const list of newsByTicker.values()) list.sort((a, b) => a - b);

      function catalystAt(
        instruments: string[] | null,
        tsMs: number,
      ): 'yes' | 'no' {
        if (!instruments || instruments.length === 0) return 'no';
        const windowStart = tsMs - NEWS_LOOKBACK_HRS * 3600_000;
        for (const t of instruments) {
          const list = newsByTicker.get(t);
          if (!list || list.length === 0) continue;
          // Any news time in (windowStart, tsMs] qualifies. Upper bound at tsMs.
          const upper = bisectRightByTime(list, (v) => v, tsMs);
          if (upper === 0) continue;
          const newest = list[upper - 1];
          if (newest >= windowStart) return 'yes';
        }
        return 'no';
      }

      // ─── build tagged grades ──────────────────────────────────────────────
      const tagged: TaggedGrade[] = [];
      for (const g of grades) {
        const claim =
          g.subject_type === 'flag'
            ? flagMap.get(g.subject_id)
            : alertMap.get(g.subject_id);
        if (!claim) continue;
        if (g.actual_return_pct == null || !Number.isFinite(g.actual_return_pct)) continue;
        const createdMs = Date.parse(claim.created_at);
        if (!Number.isFinite(createdMs)) continue;

        const primaryTicker =
          (claim.instruments && claim.instruments[0]) || g.instrument || null;

        tagged.push({
          verdict: g.verdict,
          actual_return_pct: g.actual_return_pct,
          rMultiple: rMultipleOf(claim, g.actual_return_pct),
          gamma: gammaAt(createdMs),
          iv: ivAt(primaryTicker, createdMs),
          session: sessionBucket(claim.created_at),
          catalyst: catalystAt(claim.instruments, createdMs),
          dow: dowBucket(claim.created_at),
          opex: isOpexWeek(claim.created_at) ? 'opex_week' : 'normal',
        });
      }

      // ─── overall baseline ────────────────────────────────────────────────
      const scored = tagged.filter((t) => t.verdict !== 'ambiguous');
      const wins = scored.filter((t) => t.verdict === 'right').length;
      const overallWinRate =
        scored.length > 0 ? wins / scored.length : 0;
      const overallAvgReturnPct =
        tagged.length > 0
          ? tagged.reduce((s, t) => s + t.actual_return_pct, 0) / tagged.length
          : 0;

      // ─── slice aggregation ───────────────────────────────────────────────
      function aggregate(
        dim: RegimeDim,
        label: string,
        pick: (t: TaggedGrade) => string,
        valueOrder: string[],
      ): DimensionReport {
        const bucket = new Map<
          string,
          { count: number; wins: number; scored: number; retSum: number; rSum: number; rN: number }
        >();
        for (const v of valueOrder) {
          bucket.set(v, { count: 0, wins: 0, scored: 0, retSum: 0, rSum: 0, rN: 0 });
        }
        for (const t of tagged) {
          const v = pick(t);
          let b = bucket.get(v);
          if (!b) {
            b = { count: 0, wins: 0, scored: 0, retSum: 0, rSum: 0, rN: 0 };
            bucket.set(v, b);
          }
          b.count += 1;
          b.retSum += t.actual_return_pct;
          if (t.verdict !== 'ambiguous') {
            b.scored += 1;
            if (t.verdict === 'right') b.wins += 1;
          }
          if (t.rMultiple != null && Number.isFinite(t.rMultiple)) {
            b.rSum += t.rMultiple;
            b.rN += 1;
          }
        }
        const slices: RegimeSlice[] = [];
        for (const [value, b] of bucket.entries()) {
          slices.push({
            value,
            count: b.count,
            wins: b.wins,
            winRate: b.scored > 0 ? b.wins / b.scored : 0,
            avgReturnPct: b.count > 0 ? b.retSum / b.count : 0,
            avgR: b.rN > 0 ? b.rSum / b.rN : null,
            rSample: b.rN,
            insufficient: b.count < SPARSE_THRESHOLD,
          });
        }
        // Keep user-specified order; append any unexpected values at the end.
        const ordered = [
          ...valueOrder
            .map((v) => slices.find((s) => s.value === v))
            .filter((s): s is RegimeSlice => !!s),
          ...slices.filter((s) => !valueOrder.includes(s.value)),
        ];
        const ranked = ordered.filter((s) => !s.insufficient);
        const best = ranked.length > 0
          ? ranked.reduce((a, b) => (a.winRate >= b.winRate ? a : b))
          : null;
        const worst = ranked.length > 0
          ? ranked.reduce((a, b) => (a.winRate <= b.winRate ? a : b))
          : null;
        return { dim, label, slices: ordered, best, worst };
      }

      const dimensions: DimensionReport[] = [
        aggregate('gamma', 'Gamma regime', (t) => t.gamma, [
          'positive',
          'negative',
          'unknown',
        ]),
        aggregate('iv', 'IV regime', (t) => t.iv, ['low', 'mid', 'high', 'unknown']),
        aggregate('session', 'Session slice', (t) => t.session, [
          'open',
          'midday',
          'close',
          'other',
        ]),
        aggregate('catalyst', 'Catalyst window (24h)', (t) => t.catalyst, [
          'yes',
          'no',
        ]),
        aggregate('dow', 'Day of week', (t) => t.dow, [
          'Mon',
          'Tue',
          'Wed',
          'Thu',
          'Fri',
          'weekend',
        ]),
        aggregate('opex', 'OPEX week', (t) => t.opex, ['opex_week', 'normal']),
      ];

      // ─── cross: gamma × session ──────────────────────────────────────────
      const gammaVals: Array<CrossCell['gamma']> = ['positive', 'negative', 'unknown'];
      const sessionVals: Array<CrossCell['session']> = ['open', 'midday', 'close', 'other'];
      const crossGammaSession: CrossCell[] = [];
      for (const gv of gammaVals) {
        for (const sv of sessionVals) {
          const subset = tagged.filter((t) => t.gamma === gv && t.session === sv);
          const s = subset.filter((t) => t.verdict !== 'ambiguous');
          const w = s.filter((t) => t.verdict === 'right').length;
          crossGammaSession.push({
            gamma: gv,
            session: sv,
            count: subset.length,
            winRate: s.length > 0 ? w / s.length : 0,
            insufficient: subset.length < SPARSE_THRESHOLD,
          });
        }
      }

      const sample = tagged.length;
      const dataThin = sample < MIN_SAMPLE_FOR_CLAIMS;
      const dataThinNote = dataThin
        ? `Only ${sample} graded claims survived the 30d regime join — buckets will be mostly sparse. Interpret slices as directional only.`
        : null;

      return {
        sample,
        overallWinRate,
        overallAvgReturnPct,
        dimensions,
        crossGammaSession,
        dataThin,
        dataThinNote,
      };
    },
  });
}
