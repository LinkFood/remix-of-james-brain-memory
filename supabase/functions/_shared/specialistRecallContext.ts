/**
 * specialistRecallContext — per-ticker recall organ. The first install of the
 * "components remember their own past being graded" property.
 *
 * Why this exists: each per-ticker specialist (NVDA, MSFT, …) fires every
 * ~6 minutes during RTH and reads the world fresh each time. They write rich
 * prose to ct_specialist_reads but never see their *own* prior reads. The
 * scorer scores them post-hoc; the specialist itself remains amnesiac.
 *
 * This organ closes the loop: each fire pulls the specialist's recent prior
 * reads + the grades attached to flagged reads, and the orchestrator injects
 * them into the next system prompt. The specialist becomes self-aware about
 * its own track record on the ticker — narrative positions persist across
 * fires, streaks become visible, and (per Tenet 25) the system gets to
 * evolve in structure not just within structure.
 *
 * ---------------------------------------------------------------------------
 * The two-set N choice (locked in at build time, document for future tuning):
 * ---------------------------------------------------------------------------
 *   FLAGGED_CAP    = 5 — the last 5 flagged reads on the ticker.
 *   UNFLAGGED_CAP  = 5 — the last 5 unflagged reads with conviction ≥ 50,
 *                        within the last 5 days.
 *
 * Rationale: flagged reads are the actionable history (each carries a flag_id
 * and an eventually-graded outcome), so the model needs them at full depth.
 * Unflagged-but-conviction-≥50 are the "I almost flagged" moments — the
 * specialist's near-misses. They're load-bearing because they represent
 * narrative positions the specialist held strongly without committing.
 * Without them, recall would over-index on commit moments and miss the
 * background bias.
 *
 * Why not include all unflagged reads: at ~6-min cadence the unflagged-low-
 * conviction stream is mostly noise ("conviction 22 — waiting"); injecting
 * those would dilute the recall signal and cost tokens.
 *
 * Future tuning: if narrative continuity (Phase C C4) shows weak coupling
 * across days, raise UNFLAGGED_CAP or extend the 5-day window. If streak
 * bias surfaces (lean changes driven by streak rather than flow), drop
 * FLAGGED_CAP to 3. Both knobs are intentional, not accidental.
 * ---------------------------------------------------------------------------
 *
 * Substrate: ct_specialist_reads is alive (315+ rows over 7 days, 10 tickers).
 * ct_specialist_memory is dead-on-arrival (2 rows, writer path is dead v1
 * code that gates on `flag.source === 'specialist'` which v2 never produces).
 * This helper deliberately reads from the live substrate, NOT from the dead
 * one. See the 2026-05-01 audit memory for the architectural rationale.
 *
 * audienceFilter: ['cotrader'] only. paper_claude's research-layer firewall
 * stays clean of operational specialist history per the v2 reset thesis —
 * paper-Claude must judge specialist quality from the outside, not be fed
 * the specialist's track record on its own grading test.
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import type {
  ContextHelper,
  HelperFetchContext,
  HelperOpts,
  HelperResult,
  HelperDescription,
  AudienceMode,
  OrganMetadata,
  OrganStatus,
} from './contextHelper.ts';
import {
  fetchV2Enrichment,
  type ConvictionCurveRow,
  type LifecycleRow,
  type MultiAxisStats,
  type RegimeConditionalRow,
  type V2EnrichmentResult,
} from './specialistRecallV2.ts';

const HELPER_NAME = 'specialist_recall';
const HELPER_VERSION = 'v2';

const FLAGGED_CAP = 5;
const UNFLAGGED_CAP = 5;
const UNFLAGGED_LOOKBACK_DAYS = 5;
const UNFLAGGED_CONVICTION_FLOOR = 50;

const AUDIENCE_FILTER: ReadonlyArray<AudienceMode> = ['cotrader'];

// ---------------------------------------------------------------------------
// Types — exported for consumers
// ---------------------------------------------------------------------------

export type RecallOutcome = 'win' | 'loss' | 'partial' | 'pending' | 'unflagged';

export interface RecallEntry {
  /** ISO timestamp of the read (ct_specialist_reads.updated_at). */
  ts: string;
  ticker: string;
  direction_lean: 'bullish' | 'bearish' | 'neutral' | 'mixed' | null;
  conviction: number | null;
  flagged: boolean;
  /** ct_flags.id — null when unflagged. */
  flag_id: string | null;
  /** Parsed from flag's option_symbol when flagged: e.g. "250P 2026-05-15". */
  flag_label: string | null;
  /** 'unflagged' when not flagged, 'pending' when flagged but no grade yet. */
  outcome: RecallOutcome;
  alpha_pct: number | null;
}

export interface RecallStats {
  flagged_total: number;
  flagged_graded: number;
  flagged_won: number;
  flagged_lost: number;
  flagged_partial: number;
  flagged_pending: number;
  hit_rate_when_graded: number | null;
  current_streak_kind: 'win' | 'loss' | 'mixed' | 'none';
  current_streak_length: number;

  // ---- v2 enrichment (all optional — older callers keep working) -----------
  /**
   * Multi-axis stats from ct_specialist_scoreboard_v2 WHERE regime='all' AND
   * window_label='lifetime'. Premium = option-price P&L; underlying_*=spot
   * move at horizon. Blended = combined verdict. Drift slope = pp/week of
   * rolling 7d hit_rate over last 30d. undefined when v2 row missing.
   */
  multi_axis_stats?: MultiAxisStats;
  /**
   * Top regime-conditional rows for this specialist, ordered by sample size
   * (n_graded DESC), capped at REGIME_COND_LIMIT. Empty array when v2 has no
   * regime-specific rows yet.
   */
  regime_conditional?: RegimeConditionalRow[];
  /**
   * Conviction-bucket calibration. Per-specialist when N ≥ config-driven
   * threshold (default 30); else falls back to cross-specialist '__ALL__'
   * row. is_per_specialist flags which source was used per bucket. Empty
   * array when neither source has data.
   */
  conviction_calibration_curve?: ConvictionCurveRow[];
  /**
   * Live prompt-version lifecycle row from ct_specialist_prompt_lifecycle.
   * Picks status='live' (most active version). undefined when no live row.
   */
  lifecycle?: LifecycleRow;
}

export interface SpecialistRecallResult {
  /** Resolved ticker. UPPERCASE. Null when no tickerFocus was supplied. */
  ticker: string | null;
  /** Newest-first, capped at FLAGGED_CAP + UNFLAGGED_CAP. */
  reads: RecallEntry[];
  stats: RecallStats;
  generated_at: string;
}

// ---------------------------------------------------------------------------
// Internal — flag-grade lookup
// ---------------------------------------------------------------------------

interface RawRead {
  id: string;
  ticker: string;
  updated_at: string;
  direction_lean: string | null;
  conviction: number | null;
  flagged: boolean;
  flag_id: string | null;
}

interface RawFlag {
  id: string;
  option_symbol: string | null;
  strike: number | null;
  expiry: string | null;
  side: string | null;
}

interface RawGrade {
  flag_id: string;
  outcome: string;
  alpha_pct: number | null;
}

/** Format e.g. "250P 2026-05-15" from flag fields; falls back to option_symbol. */
function flagLabelFromFlag(flag: RawFlag | undefined): string | null {
  if (!flag) return null;
  if (flag.strike != null && flag.side && flag.expiry) {
    const sideLetter = flag.side.toLowerCase().startsWith('c') ? 'C' : 'P';
    return `${flag.strike}${sideLetter} ${flag.expiry}`;
  }
  return flag.option_symbol ?? null;
}

function normalizeLean(v: string | null): RecallEntry['direction_lean'] {
  if (v === 'bullish' || v === 'bearish' || v === 'neutral' || v === 'mixed') return v;
  return null;
}

function normalizeOutcome(v: string | null | undefined): 'win' | 'loss' | 'partial' | null {
  if (v === 'win' || v === 'loss' || v === 'partial') return v;
  return null;
}

function computeStats(entries: RecallEntry[]): RecallStats {
  const flagged = entries.filter((e) => e.flagged);
  const graded = flagged.filter((e) => e.outcome !== 'pending' && e.outcome !== 'unflagged');
  const won = graded.filter((e) => e.outcome === 'win').length;
  const lost = graded.filter((e) => e.outcome === 'loss').length;
  const partial = graded.filter((e) => e.outcome === 'partial').length;
  const pending = flagged.filter((e) => e.outcome === 'pending').length;

  const decisive = won + lost;
  const hit_rate_when_graded = decisive > 0 ? won / decisive : null;

  // Streak: walk newest-first through *graded* flagged entries; stop at first flip.
  let streak_kind: RecallStats['current_streak_kind'] = 'none';
  let streak_length = 0;
  for (const e of flagged) {
    if (e.outcome !== 'win' && e.outcome !== 'loss') continue;
    if (streak_kind === 'none') {
      streak_kind = e.outcome;
      streak_length = 1;
    } else if (streak_kind === e.outcome) {
      streak_length += 1;
    } else {
      streak_kind = 'mixed';
      break;
    }
  }

  return {
    flagged_total: flagged.length,
    flagged_graded: graded.length,
    flagged_won: won,
    flagged_lost: lost,
    flagged_partial: partial,
    flagged_pending: pending,
    hit_rate_when_graded,
    current_streak_kind: streak_kind,
    current_streak_length: streak_length,
  };
}

// Bundle Phase 2 organ #10 ship 2026-05-07. Single-ticker organ (per-ticker
// granularity collapses to organ-level — there's no array to attach
// ticker_status to, see audit doc 2026-05-07-organ-10-specialist-recall-
// phase-a.md instance #38). organMetadata describes the ORGAN's state.
//
// CHRONOLOGICAL-VS-SEMANTIC contract boundary (Phase 7b ship 2026-05-13):
// - FLAGGED set stays chronological (last N flagged reads by updated_at DESC)
//   — the graded-outcomes trail needs temporal coherence so captain can read
//   "outcomes over time" rather than "outcomes from setup-similar prior reads
//   in no particular order".
// - UNFLAGGED set is now SEMANTIC — match_ct_specialist_reads_by_similarity
//   over the embedded substrate (Ship 3 of Bundle 2, 2026-05-13). Query
//   embedding = the most-recent ct_specialist_reads.embedding for this ticker
//   (the anchor pattern captain graded as meaningful in Ship 9). Falls back
//   gracefully to chronological if the anchor has no embedding yet (write-
//   time embed gap window — drainer is the 5-min backstop).
function buildOrganMetadata(
  asOf: string,
  ticker: string | null,
  status: OrganStatus,
  unflaggedMode: 'semantic' | 'chronological_fallback' = 'semantic',
): OrganMetadata {
  return {
    as_of: asOf,
    source: '_shared/specialistRecallContext.ts / ct_specialist_reads + ct_flags + ct_flag_grades + ct_specialist_scoreboard_v2 (FLAGGED chronological; UNFLAGGED semantic via match_ct_specialist_reads_by_similarity; cotrader audience only)',
    window: ticker
      ? `last ${FLAGGED_CAP} flagged (chronological) + top ${UNFLAGGED_CAP} ${unflaggedMode === 'semantic' ? 'semantically-similar' : 'chronological-fallback'} unflagged-conviction-≥${UNFLAGGED_CONVICTION_FLOOR} for ${ticker}`
      : 'no ticker focus (recall is per-entity)',
    status,
  };
}

function emptyResult(
  startedAt: number,
  ticker: string | null,
  warning?: string,
  status: OrganStatus = 'no_signal_detected',
): HelperResult<SpecialistRecallResult> {
  const asOf = new Date().toISOString();
  return {
    data: {
      ticker,
      reads: [],
      stats: {
        flagged_total: 0,
        flagged_graded: 0,
        flagged_won: 0,
        flagged_lost: 0,
        flagged_partial: 0,
        flagged_pending: 0,
        hit_rate_when_graded: null,
        current_streak_kind: 'none',
        current_streak_length: 0,
      },
      generated_at: asOf,
    },
    meta: {
      helperName: HELPER_NAME,
      helperVersion: HELPER_VERSION,
      fetchedAt: asOf,
      rowCount: 0,
      cacheHit: false,
      latencyMs: Date.now() - startedAt,
      truncated: false,
      ...(warning ? { warning } : {}),
    },
    organMetadata: buildOrganMetadata(asOf, ticker, status),
  };
}

// ---------------------------------------------------------------------------
// Convenience function — used by orchestrator + tests
// ---------------------------------------------------------------------------

export async function getSpecialistRecallContext(
  supabase: SupabaseClient,
  opts: HelperOpts = {},
): Promise<HelperResult<SpecialistRecallResult>> {
  const startedAt = Date.now();
  const ticker = opts.tickerFocus ? opts.tickerFocus.toUpperCase() : null;

  // tickerFocus is required — recall is per-entity, not market-wide.
  // Contract violation, not data-state — map to 'error'.
  if (!ticker) {
    return emptyResult(startedAt, null, 'no_ticker_focus', 'error');
  }

  try {
    // 1. Last N flagged reads on this ticker.
    const flaggedQ = supabase
      .from('ct_specialist_reads')
      .select('id, ticker, updated_at, direction_lean, conviction, flagged, flag_id')
      .eq('ticker', ticker)
      .eq('flagged', true)
      .not('flag_id', 'is', null)
      .order('updated_at', { ascending: false })
      .limit(FLAGGED_CAP);

    // 2. UNFLAGGED set — Phase 7b semantic swap (2026-05-13). Query embedding
    //    = the most-recent ct_specialist_reads.embedding for this ticker (the
    //    anchor pattern captain graded as meaningful in Ship 9). Returns the
    //    top UNFLAGGED_CAP semantically-similar unflagged reads with
    //    conviction ≥ UNFLAGGED_CONVICTION_FLOOR. Falls back to chronological
    //    if the anchor has no embedding yet (write-time embed gap window —
    //    drainer cron is the 5-min backstop, so this fallback should be rare
    //    in steady state). The 5-day lookback window from the chronological
    //    era is dropped — semantic recall surfaces structurally-similar reads
    //    regardless of recency; the analog book reaches as far back as the
    //    embedded substrate goes.
    const lookback = new Date(Date.now() - UNFLAGGED_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

    // Anchor lookup: most-recent embedded read on this ticker.
    const anchorQ = supabase
      .from('ct_specialist_reads')
      .select('updated_at, embedding')
      .eq('ticker', ticker)
      .not('embedding', 'is', null)
      .order('updated_at', { ascending: false })
      .limit(1);

    // v2 enrichment runs in parallel with the existing recall reads. It is
    // best-effort — if the v2 tables are empty / missing / 4xx, the recall
    // organ still returns its v1 shape unchanged. Per-helper warnings surface
    // via meta.warning when the v2 layer was expected but came back blank.
    const v2EnrichmentP = fetchV2Enrichment(supabase, ticker);

    // Resolve flagged + anchor in parallel. UNFLAGGED is then either semantic
    // (RPC call with anchor's embedding) or chronological fallback.
    const [flaggedRes, anchorRes] = await Promise.all([flaggedQ, anchorQ]);

    type UnflaggedMode = 'semantic' | 'chronological_fallback';
    let unflaggedMode: UnflaggedMode = 'semantic';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let rawUnflaggedRows: any[] = [];
    let unflaggedErr: { message: string } | null = null;

    const anchorRow = (anchorRes.data?.[0] as { updated_at: string; embedding: string | null } | undefined) ?? null;
    if (anchorRow && anchorRow.embedding) {
      // Semantic recall via match RPC. exclude_after_ts = anchor's own
      // timestamp so the anchor itself is excluded from results; ticker_filter
      // narrows to this specialist; flagged_filter=false keeps the UNFLAGGED
      // contract; min_conviction preserves the conviction floor.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const semRes = await (supabase as any).rpc('match_ct_specialist_reads_by_similarity', {
        query_embedding: anchorRow.embedding,
        match_threshold: 0.5,
        match_count: UNFLAGGED_CAP,
        exclude_after_ts: anchorRow.updated_at,
        ticker_filter: ticker,
        min_conviction: UNFLAGGED_CONVICTION_FLOOR,
        flagged_filter: false,
      });
      if (semRes.error) {
        // RPC failed — fall back to chronological so the organ still produces
        // useful output. Log via warning so the consumer surface knows.
        unflaggedMode = 'chronological_fallback';
        unflaggedErr = { message: `semantic_recall_rpc_error:${semRes.error.message}` };
      } else {
        rawUnflaggedRows = (semRes.data ?? []) as Array<Record<string, unknown>>;
      }
    } else {
      // No anchor or no embedding yet (steady-state-rare after Ship 3 drainer).
      unflaggedMode = 'chronological_fallback';
    }

    if (unflaggedMode === 'chronological_fallback') {
      // Chronological fallback — same query shape as pre-Ship-10.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chronoRes = await (supabase
        .from('ct_specialist_reads') as any)
        .select('id, ticker, updated_at, direction_lean, conviction, flagged, flag_id')
        .eq('ticker', ticker)
        .eq('flagged', false)
        .gte('conviction', UNFLAGGED_CONVICTION_FLOOR)
        .gte('updated_at', lookback)
        .order('updated_at', { ascending: false })
        .limit(UNFLAGGED_CAP);
      if (chronoRes.error) {
        unflaggedErr = unflaggedErr ?? { message: chronoRes.error.message };
      } else {
        rawUnflaggedRows = (chronoRes.data ?? []) as Array<Record<string, unknown>>;
      }
    }
    const unflaggedRes = { data: rawUnflaggedRows, error: unflaggedErr };

    if (flaggedRes.error) {
      return emptyResult(startedAt, ticker, `flagged_query_error:${flaggedRes.error.message}`, 'error');
    }
    if (unflaggedRes.error) {
      return emptyResult(startedAt, ticker, `unflagged_query_error:${unflaggedRes.error.message}`, 'error');
    }

    const flaggedRows = (flaggedRes.data ?? []) as RawRead[];
    const unflaggedRows = (unflaggedRes.data ?? []) as RawRead[];

    if (flaggedRows.length === 0 && unflaggedRows.length === 0) {
      // No v1 history. Still await v2 to avoid orphaned promise; result is
      // discarded since stats stay empty.
      v2EnrichmentP.catch(() => undefined);
      return emptyResult(startedAt, ticker, 'no_history');
    }

    // 3. Look up flag details + grades for the flagged set.
    const flagIds = flaggedRows.map((r) => r.flag_id).filter((x): x is string => x !== null);

    const flagsByIdPromise = flagIds.length === 0
      ? Promise.resolve({ data: [] as RawFlag[], error: null })
      : supabase
          .from('ct_flags')
          .select('id, option_symbol, strike, expiry, side')
          .in('id', flagIds);

    const gradesByIdPromise = flagIds.length === 0
      ? Promise.resolve({ data: [] as RawGrade[], error: null })
      : supabase
          .from('ct_flag_grades')
          .select('flag_id, outcome, alpha_pct')
          .in('flag_id', flagIds);

    const [flagsRes, gradesRes] = await Promise.all([flagsByIdPromise, gradesByIdPromise]);

    const flagsById = new Map<string, RawFlag>();
    for (const f of (flagsRes.data ?? []) as RawFlag[]) flagsById.set(f.id, f);
    const gradesById = new Map<string, RawGrade>();
    for (const g of (gradesRes.data ?? []) as RawGrade[]) gradesById.set(g.flag_id, g);

    // 4. Shape into RecallEntry rows.
    const flaggedEntries: RecallEntry[] = flaggedRows.map((r) => {
      const flag = r.flag_id ? flagsById.get(r.flag_id) : undefined;
      const grade = r.flag_id ? gradesById.get(r.flag_id) : undefined;
      const normalized = normalizeOutcome(grade?.outcome ?? null);
      const outcome: RecallOutcome = normalized ?? 'pending';
      return {
        ts: r.updated_at,
        ticker: r.ticker,
        direction_lean: normalizeLean(r.direction_lean),
        conviction: r.conviction == null ? null : Number(r.conviction),
        flagged: true,
        flag_id: r.flag_id,
        flag_label: flagLabelFromFlag(flag),
        outcome,
        alpha_pct: grade?.alpha_pct == null ? null : Number(grade.alpha_pct),
      };
    });

    const unflaggedEntries: RecallEntry[] = unflaggedRows.map((r) => ({
      ts: r.updated_at,
      ticker: r.ticker,
      direction_lean: normalizeLean(r.direction_lean),
      conviction: r.conviction == null ? null : Number(r.conviction),
      flagged: false,
      flag_id: null,
      flag_label: null,
      outcome: 'unflagged',
      alpha_pct: null,
    }));

    // 5. Merge, sort newest-first.
    const reads: RecallEntry[] = [...flaggedEntries, ...unflaggedEntries].sort(
      (a, b) => Date.parse(b.ts) - Date.parse(a.ts),
    );

    const baseStats = computeStats(reads);

    // Resolve the v2 enrichment that's been racing alongside.
    let v2: V2EnrichmentResult = {};
    try {
      v2 = await v2EnrichmentP;
    } catch (e) {
      // Defensive — fetchV2Enrichment is already fail-soft, but a thrown
      // promise here must never crash the recall organ.
      const msg = e instanceof Error ? e.message : String(e);
      v2 = { warning: `v2_threw:${msg}` };
    }

    const stats: RecallStats = {
      ...baseStats,
      ...(v2.multi_axis_stats ? { multi_axis_stats: v2.multi_axis_stats } : {}),
      ...(v2.regime_conditional ? { regime_conditional: v2.regime_conditional } : {}),
      ...(v2.conviction_calibration_curve ? { conviction_calibration_curve: v2.conviction_calibration_curve } : {}),
      ...(v2.lifecycle ? { lifecycle: v2.lifecycle } : {}),
    };

    const asOf = new Date().toISOString();
    return {
      data: {
        ticker,
        reads,
        stats,
        generated_at: asOf,
      },
      meta: {
        helperName: HELPER_NAME,
        helperVersion: HELPER_VERSION,
        fetchedAt: asOf,
        rowCount: reads.length,
        cacheHit: false,
        latencyMs: Date.now() - startedAt,
        truncated: false,
        ...(v2.warning ? { warning: v2.warning } : {}),
      },
      organMetadata: buildOrganMetadata(asOf, ticker, 'populated', unflaggedMode),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return emptyResult(startedAt, ticker, `fetch_error:${msg}`, 'error');
  }
}

// ---------------------------------------------------------------------------
// ContextHelper instance — default export
// ---------------------------------------------------------------------------

const specialistRecallHelper: ContextHelper<SpecialistRecallResult> = {
  name: HELPER_NAME,
  version: HELPER_VERSION,
  defaultCap: FLAGGED_CAP + UNFLAGGED_CAP,
  isExpensive: false,
  // Fresh data on every fire — recall must reflect the most recent prior
  // read. Cache short, not long. Specialist runs are 6+ min apart per
  // ticker so a 60s cache buys nothing operationally and risks staleness
  // if a flag was just resolved.
  minRefreshSeconds: 60,
  dependencies: [],
  // D3 firewall: cotrader only. paper_claude must judge specialist quality
  // from the outside without seeing the specialist's own track record.
  audienceFilter: AUDIENCE_FILTER,
  cacheTtlSeconds: 60,

  async fetch(
    ctx: HelperFetchContext,
    opts: HelperOpts,
  ): Promise<HelperResult<SpecialistRecallResult>> {
    return getSpecialistRecallContext(ctx.supabase, opts);
  },

  describe(): HelperDescription {
    return {
      name: HELPER_NAME,
      version: HELPER_VERSION,
      defaultCap: FLAGGED_CAP + UNFLAGGED_CAP,
      expensive: false,
      minRefreshSeconds: 60,
      dependencies: [],
      audienceFilter: AUDIENCE_FILTER,
      outputShape:
        'Per-ticker recall block: last 5 flagged reads (with grades joined ' +
        'from ct_flag_grades) plus last 5 unflagged-with-conviction≥50 reads ' +
        'within 5 days. Each entry carries ts, lean, conviction, flag_label, ' +
        'and outcome (win/loss/partial/pending/unflagged). Stats include ' +
        'hit_rate_when_graded and current_streak_kind+length. v2 enrichment ' +
        '(optional, best-effort): multi_axis_stats (premium / 4h / 1d / 3d / ' +
        'blended hit rates + drift slope), regime_conditional (top-5 by sample ' +
        'size), conviction_calibration_curve (per-specialist when N≥config; ' +
        'cross-specialist __ALL__ fallback), lifecycle (live prompt_version + ' +
        'status). Requires opts.tickerFocus — recall is per-entity. cotrader ' +
        'audience only.',
      exampleResult: {
        ticker: 'NVDA',
        reads: [
          {
            ts: '2026-05-01T14:24:00Z',
            ticker: 'NVDA',
            direction_lean: 'bearish',
            conviction: 76,
            flagged: true,
            flag_id: 'a1b2c3d4-...',
            flag_label: '250P 2026-05-15',
            outcome: 'pending',
            alpha_pct: null,
          },
          {
            ts: '2026-04-30T18:00:00Z',
            ticker: 'NVDA',
            direction_lean: 'bullish',
            conviction: 70,
            flagged: true,
            flag_id: 'e5f6g7h8-...',
            flag_label: '240C 2026-05-08',
            outcome: 'win',
            alpha_pct: 18.4,
          },
        ],
        stats: {
          flagged_total: 2,
          flagged_graded: 1,
          flagged_won: 1,
          flagged_lost: 0,
          flagged_partial: 0,
          flagged_pending: 1,
          hit_rate_when_graded: 1.0,
          current_streak_kind: 'win',
          current_streak_length: 1,
        },
        generated_at: '2026-05-01T14:30:00Z',
      },
    };
  },
};

export default specialistRecallHelper;
