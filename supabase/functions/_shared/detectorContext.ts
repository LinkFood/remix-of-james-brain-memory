/**
 * detectorContext — brain organ exposing recent detector flags.
 * Source: ct_flags joined with ct_detectors. Phase 1 of Synthesis Layer
 * (see docs/SYNTHESIS_LAYER_ARCHITECTURE.md §5b, _shared/contextHelper.ts).
 * Pulse-pattern detectors (flow_stack_v1, commit 5141c31) embed
 * heatmap_state_at_fire inside score_breakdown. Pulse-as-context columns
 * (pulse_*_at_fire) capture regime state at fire time per Tenet 9.
 * Read-only. Never throws. Defensive empty `data` on any error.
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import type {
  ContextHelper,
  HelperDescription,
  HelperFetchContext,
  HelperOpts,
  HelperResult,
} from './contextHelper.ts';

export type FlagDirection = 'bullish' | 'bearish' | 'neutral';

export interface DetectorFlag {
  flag_id: string;
  detector_id: string | null;
  detector_name: string | null;
  detector_status: string | null;
  source: string | null; // 'specialist' | 'james_star' | 'signature_alarm' | 'detector_alarm'
  ticker: string;
  option_symbol: string | null;
  direction: FlagDirection;
  score: number;
  tags: string[];
  thesis: string | null;
  // Pulse-as-context (tenet 9, captured at fire time)
  pulse_regime_at_fire: string | null;
  pulse_net_premium_at_fire: number | null;
  pulse_slope_5min_at_fire: number | null;
  // Full breakdown JSON — pulse-pattern detectors stuff `heatmap_state_at_fire`
  // and other detector-specific provenance in here. Surfaced verbatim.
  score_breakdown: Record<string, unknown> | null;
  created_at: string;
}

export interface DetectorContextResult {
  flags: DetectorFlag[];
  per_ticker?: Array<{ ticker: string; flags: DetectorFlag[] }>;
  lookback_hours: number;
  generated_at: string;
}

const HELPER_NAME = 'detector';
const HELPER_VERSION = 'v1';
const DEFAULT_CAP = 20;
const DEFAULT_LOOKBACK_HOURS = 24;

interface FlagRow {
  id: string;
  detector_id: string | null;
  source: string | null;
  specialist_ticker: string | null;
  instrument: string;
  option_symbol: string | null;
  direction: FlagDirection;
  score: number | null;
  tags: string[] | null;
  thesis: string | null;
  pulse_regime_at_fire: string | null;
  pulse_net_premium_at_fire: number | null;
  pulse_slope_5min_at_fire: number | null;
  score_breakdown: Record<string, unknown> | null;
  created_at: string;
  ct_detectors:
    | { id: string; name: string | null; status: string | null }
    | { id: string; name: string | null; status: string | null }[]
    | null;
}

function emptyResult(reason: string, latencyMs: number, lookback: number): HelperResult<DetectorContextResult> {
  return {
    data: {
      flags: [],
      lookback_hours: lookback,
      generated_at: new Date().toISOString(),
    },
    meta: {
      helperName: HELPER_NAME,
      helperVersion: HELPER_VERSION,
      fetchedAt: new Date().toISOString(),
      rowCount: 0,
      cacheHit: false,
      latencyMs,
      truncated: false,
      warning: reason,
    },
  };
}

function normalizeDetector(
  raw: FlagRow['ct_detectors'],
): { id: string; name: string | null; status: string | null } | null {
  if (!raw) return null;
  // PostgREST embeds may come back as object OR single-element array
  if (Array.isArray(raw)) return raw[0] ?? null;
  return raw;
}

async function fetchDetectorContext(
  ctx: HelperFetchContext,
  opts: HelperOpts,
): Promise<HelperResult<DetectorContextResult>> {
  const start = Date.now();
  const cap = Math.max(1, opts.cap ?? DEFAULT_CAP);
  const lookbackHours = Math.max(
    1,
    Number(opts.lookbackHours) > 0 ? Number(opts.lookbackHours) : DEFAULT_LOOKBACK_HOURS,
  );
  const perTickerTop = Number(opts.perTickerTop) > 0 ? Number(opts.perTickerTop) : null;
  const sinceIso = new Date(Date.now() - lookbackHours * 3600_000).toISOString();

  // Resolve target tickers — single focus or full watchlist (case-insensitive)
  const tickers = opts.tickerFocus
    ? [opts.tickerFocus.toUpperCase()]
    : ctx.watchlist.map((t) => t.toUpperCase());

  if (tickers.length === 0) {
    return emptyResult('empty_watchlist', Date.now() - start, lookbackHours);
  }

  try {
    // PostgREST embed: ct_flags joined with ct_detectors via detector_id FK.
    // Over-pull beyond cap so per-ticker grouping has room before truncation.
    const fetchLimit = Math.min(cap * 5, 200);
    const { data, error } = await ctx.supabase
      .from('ct_flags')
      .select(
        `id,
         detector_id,
         source,
         specialist_ticker,
         instrument,
         option_symbol,
         direction,
         score,
         tags,
         thesis,
         pulse_regime_at_fire,
         pulse_net_premium_at_fire,
         pulse_slope_5min_at_fire,
         score_breakdown,
         created_at,
         ct_detectors:detector_id ( id, name, status )`,
      )
      .in('instrument', tickers)
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: false })
      .limit(fetchLimit);

    if (error) return emptyResult(`db_error:${error.message}`, Date.now() - start, lookbackHours);
    if (!Array.isArray(data) || data.length === 0) {
      return emptyResult('no_rows', Date.now() - start, lookbackHours);
    }

    const allFlags: DetectorFlag[] = (data as FlagRow[]).map((row) => {
      const detector = normalizeDetector(row.ct_detectors);
      return {
        flag_id: row.id,
        detector_id: row.detector_id,
        detector_name: detector?.name ?? null,
        detector_status: detector?.status ?? null,
        source: row.source,
        ticker: row.instrument,
        option_symbol: row.option_symbol,
        direction: row.direction,
        score: row.score == null ? 0 : Number(row.score),
        tags: Array.isArray(row.tags) ? row.tags : [],
        thesis: row.thesis,
        pulse_regime_at_fire: row.pulse_regime_at_fire,
        pulse_net_premium_at_fire:
          row.pulse_net_premium_at_fire == null ? null : Number(row.pulse_net_premium_at_fire),
        pulse_slope_5min_at_fire:
          row.pulse_slope_5min_at_fire == null ? null : Number(row.pulse_slope_5min_at_fire),
        score_breakdown: row.score_breakdown,
        created_at: row.created_at,
      };
    });

    // Top-N by recency (already ordered DESC by created_at)
    const truncatedTop = allFlags.length > cap;
    const flags = allFlags.slice(0, cap);

    // Optional per-ticker grouping with its own cap
    let per_ticker: DetectorContextResult['per_ticker'];
    if (perTickerTop !== null) {
      const perTickerCap = Math.max(1, perTickerTop);
      const grouped = new Map<string, DetectorFlag[]>();
      for (const flag of allFlags) {
        if (!grouped.has(flag.ticker)) grouped.set(flag.ticker, []);
        const arr = grouped.get(flag.ticker)!;
        if (arr.length < perTickerCap) arr.push(flag);
      }
      per_ticker = Array.from(grouped.entries()).map(([ticker, fs]) => ({
        ticker,
        flags: fs,
      }));
    }

    return {
      data: {
        flags,
        per_ticker,
        lookback_hours: lookbackHours,
        generated_at: new Date().toISOString(),
      },
      meta: {
        helperName: HELPER_NAME,
        helperVersion: HELPER_VERSION,
        fetchedAt: new Date().toISOString(),
        rowCount: flags.length,
        cacheHit: false,
        latencyMs: Date.now() - start,
        truncated: truncatedTop,
      },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return emptyResult(`exception:${msg}`, Date.now() - start, lookbackHours);
  }
}

const detectorContextHelper: ContextHelper<DetectorContextResult> = {
  name: HELPER_NAME,
  version: HELPER_VERSION,
  defaultCap: DEFAULT_CAP,
  isExpensive: false,
  minRefreshSeconds: 60,
  dependencies: [],
  // audienceFilter intentionally omitted — all audiences see detector flags

  fetch: fetchDetectorContext,

  describe(): HelperDescription {
    return {
      name: HELPER_NAME,
      version: HELPER_VERSION,
      defaultCap: DEFAULT_CAP,
      expensive: false,
      minRefreshSeconds: 60,
      dependencies: [],
      outputShape:
        'Recent detector flags from ct_flags joined with ct_detectors. Default last 24h, top 20 by recency. Each flag carries detector_id + detector_name + detector_status, score, direction, tags, thesis, pulse-at-fire context (regime, net premium, slope), and full score_breakdown JSON (pulse-pattern detectors include heatmap_state_at_fire there). Pass opts.perTickerTop to also group as per_ticker top-N. opts.lookbackHours overrides default 24.',
      exampleResult: {
        flags: [{
          flag_id: '7a3f...',
          detector_id: 'flow_stack_v1',
          detector_name: 'Flow Stack v1',
          detector_status: 'trial',
          source: 'detector_alarm',
          ticker: 'NVDA',
          option_symbol: 'NVDA260502C00130000',
          direction: 'bullish',
          score: 82,
          tags: ['flow_stack'],
          thesis: 'NVDA flow stack on 2026-05-02 — z=2.85 (bullish)...',
          pulse_regime_at_fire: 'trending_positive',
          pulse_net_premium_at_fire: 1240000,
          pulse_slope_5min_at_fire: 145000,
          score_breakdown: { detector: 'flow_stack_v1', z_score: 2.85, heatmap_state_at_fire: { ticker: 'NVDA' } },
          created_at: '2026-04-30T19:32:00Z',
        }],
        lookback_hours: 24,
        generated_at: '2026-04-30T19:45:00Z',
      } satisfies DetectorContextResult,
    };
  },
};

export default detectorContextHelper;

export interface GetDetectorContextOpts extends HelperOpts {
  watchlist?: readonly string[];
  audience?: HelperFetchContext['audience'];
  sessionDate?: string;
  consumerName?: string;
}

/** Convenience wrapper around `detectorContextHelper.fetch()` for direct callers. */
export async function getDetectorContext(
  supabase: SupabaseClient,
  opts: GetDetectorContextOpts = {},
): Promise<DetectorContextResult> {
  const ctx: HelperFetchContext = {
    supabase,
    audience: opts.audience ?? 'cotrader',
    sessionDate: opts.sessionDate ?? new Date().toISOString().slice(0, 10),
    watchlist: opts.watchlist ?? [],
    consumerName: opts.consumerName ?? 'unknown',
  };
  const result = await detectorContextHelper.fetch(ctx, opts);
  return result.data;
}
