/**
 * regimeContext — Pulse v2 brain organ. Surfaces current regime state +
 * historical analogs via the ContextHelper contract. Read-only.
 *
 * Substrate: ct_regime_signals, ct_regime_classifications,
 * ct_regime_history (vector(512) embedded_state), search_ct_regime_analogs RPC.
 *
 * audienceFilter: cotrader+analyst. paper_claude EXCLUDED (Tenet 6).
 *
 * Pre-2026-05-15: data exposed via `organs.regime` only — captain-framing
 * preamble wire is intentionally deferred until C1 hit-rate window closes.
 *
 * Defensive: NEVER throws. Failures return populated `data` + meta.warning.
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import type {
  AudienceMode,
  ContextHelper,
  HelperDescription,
  HelperFetchContext,
  HelperOpts,
  HelperResult,
  OrganStatus,
} from './contextHelper.ts';
import { voyageEmbed } from './ctEmbed.ts';

const HELPER_NAME = 'regime';
const HELPER_VERSION = '1.0.0';

const DEFAULT_ANALOG_CAP = 3;
const MAX_ANALOG_CAP = 10;
const DEFAULT_FRESHNESS_SECONDS = 30 * 60;        // 30 min — buckets are 5min, allow ~6 misses
const DEFAULT_ANALOG_THRESHOLD = 0.55;            // cosine similarity floor
const ANALOG_EMBED_TTL_MS = 60_000;               // 60s in-memory cache for embed lookups

const AUDIENCE_FILTER: ReadonlyArray<AudienceMode> = ['cotrader', 'analyst'];

// ---------------------------------------------------------------------------
// Types — exported. ticker=null on TickerRegime/RegimeAnalog = market-wide row.
// next_classification on RegimeAnalog = label of immediate-next bucket
// (regime persistence signal); undefined when no later bucket exists.
// ---------------------------------------------------------------------------

export type RegimeTrajectory = 'accelerating' | 'steady' | 'decaying' | null;

export interface TickerRegime {
  ticker: string | null;
  bucket_ts: string;
  classification: string;
  confidence: number;
  momentum: number | null;
  breadth: number | null;
  trajectory: RegimeTrajectory;
  dispersion: number | null;
  duration_minutes: number | null;
  rationale: {
    matched_rule?: string;
    signal_values?: Record<string, unknown>;
    why?: string;
    [k: string]: unknown;
  };
}

export interface RegimeAnalog {
  history_id: number;
  bucket_ts: string;
  ticker: string | null;
  classification: string;
  confidence: number;
  cosine_similarity: number;
  rich_text: string;
  next_classification?: string;
}

export interface RegimeResult {
  market_wide: TickerRegime | null;
  per_ticker: Record<string, TickerRegime>;
  top_analogs: RegimeAnalog[];
  generated_at: string;
}

// ---------------------------------------------------------------------------
// Internal raw row types
// ---------------------------------------------------------------------------

interface RawClassification {
  ticker: string | null;
  bucket_ts: string;
  classification: string;
  confidence: number | string;
  rationale: Record<string, unknown> | null;
}

interface RawSignals {
  ticker: string | null;
  bucket_ts: string;
  momentum: number | string | null;
  breadth: number | string | null;
  trajectory: string | null;
  dispersion: number | string | null;
  duration_minutes: number | null;
}

interface RawAnalog {
  id: number;
  ticker: string | null;
  bucket_ts: string;
  classification: string;
  confidence: number | string;
  rich_text: string | null;
  rationale: Record<string, unknown> | null;
  similarity: number | string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toNumOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeTrajectory(v: string | null): RegimeTrajectory {
  if (v === 'accelerating' || v === 'steady' || v === 'decaying') return v;
  return null;
}

function buildTickerRegime(
  c: RawClassification,
  s: RawSignals | undefined,
): TickerRegime {
  return {
    ticker: c.ticker == null ? null : c.ticker.toUpperCase(),
    bucket_ts: c.bucket_ts,
    classification: c.classification,
    confidence: toNumOrNull(c.confidence) ?? 0,
    momentum: s ? toNumOrNull(s.momentum) : null,
    breadth: s ? toNumOrNull(s.breadth) : null,
    trajectory: s ? normalizeTrajectory(s.trajectory) : null,
    dispersion: s ? toNumOrNull(s.dispersion) : null,
    duration_minutes: s?.duration_minutes ?? null,
    rationale: c.rationale ?? {},
  };
}

// Per-isolate 60s TTL cache for analog-embed lookups. Trims duplicate Voyage
// calls when same rich_text re-queries within bucket cadence.
const analogEmbedCache = new Map<string, { embedding: number[]; expires: number }>();

async function cachedEmbed(text: string): Promise<number[] | null> {
  const key = text.length > 256 ? text.slice(0, 256) : text;
  const hit = analogEmbedCache.get(key);
  const now = Date.now();
  if (hit && hit.expires > now) return hit.embedding;
  try {
    const emb = await voyageEmbed(text, 'query');
    analogEmbedCache.set(key, { embedding: emb, expires: now + ANALOG_EMBED_TTL_MS });
    if (analogEmbedCache.size > 32) {
      const firstKey = analogEmbedCache.keys().next().value;
      if (firstKey != null) analogEmbedCache.delete(firstKey);
    }
    return emb;
  } catch (_e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Latest classification + signals for one scope (ticker=null = market-wide).
// Falls back to MAX(bucket_ts) overall if nothing fresher than staleAfter;
// caller marks isStale. Null only when scope has literally no rows.
// ---------------------------------------------------------------------------

async function fetchLatestForScope(
  supabase: SupabaseClient,
  ticker: string | null,
  staleAfter: Date,
): Promise<{ regime: TickerRegime; isStale: boolean } | null> {
  // 1. Latest classification (any age — we'll mark stale if older than threshold).
  let q = supabase
    .from('ct_regime_classifications')
    .select('ticker, bucket_ts, classification, confidence, rationale')
    .order('bucket_ts', { ascending: false })
    .limit(1);
  q = ticker == null ? q.is('ticker', null) : q.eq('ticker', ticker);

  const { data: cRows, error: cErr } = await q;
  if (cErr) return null;
  const cArr = (cRows ?? []) as RawClassification[];
  if (cArr.length === 0) return null;
  const c = cArr[0];

  const bucketTime = Date.parse(c.bucket_ts);
  const isStale = Number.isFinite(bucketTime) && bucketTime < staleAfter.getTime();

  // 2. Matching signals row at same bucket_ts (best-effort enrichment).
  let sQ = supabase
    .from('ct_regime_signals')
    .select('ticker, bucket_ts, momentum, breadth, trajectory, dispersion, duration_minutes')
    .eq('bucket_ts', c.bucket_ts)
    .limit(1);
  sQ = ticker == null ? sQ.is('ticker', null) : sQ.eq('ticker', ticker);

  const { data: sRows } = await sQ;
  const s = (sRows ?? [])[0] as RawSignals | undefined;

  return {
    regime: buildTickerRegime(c, s),
    isStale,
  };
}

// ---------------------------------------------------------------------------
// Per-analog "what happened next" enrichment. Cap is 3 at alpha, so per-row
// round-trip cost is negligible. Errors silently dropped (defensive).
// ---------------------------------------------------------------------------

async function enrichNextClassifications(
  supabase: SupabaseClient,
  analogs: RegimeAnalog[],
): Promise<void> {
  await Promise.all(analogs.map(async (a) => {
    let q = supabase
      .from('ct_regime_classifications')
      .select('classification')
      .gt('bucket_ts', a.bucket_ts)
      .order('bucket_ts', { ascending: true })
      .limit(1);
    q = a.ticker == null ? q.is('ticker', null) : q.eq('ticker', a.ticker);
    const { data, error } = await q;
    if (error || !Array.isArray(data) || data.length === 0) return;
    const next = (data[0] as { classification?: string }).classification;
    if (typeof next === 'string') a.next_classification = next;
  }));
}

// ---------------------------------------------------------------------------
// Analog fetch — embed current rich_text, cosine search, enrich next bucket
// ---------------------------------------------------------------------------

async function fetchAnalogs(
  supabase: SupabaseClient,
  scope: TickerRegime | null,
  cap: number,
  threshold: number,
  warnings: string[],
): Promise<RegimeAnalog[]> {
  if (!scope) return [];

  // ct_regime_history is the only source of rich_text.
  let rtQ = supabase
    .from('ct_regime_history')
    .select('rich_text')
    .eq('bucket_ts', scope.bucket_ts)
    .order('id', { ascending: false })
    .limit(1);
  rtQ = scope.ticker == null ? rtQ.is('ticker', null) : rtQ.eq('ticker', scope.ticker);
  const { data: rtRows } = await rtQ;
  const richText = ((rtRows ?? [])[0] as { rich_text?: string } | undefined)?.rich_text ?? null;

  if (!richText || richText.length === 0) {
    warnings.push('no_rich_text_for_current_bucket');
    return [];
  }

  const queryEmbedding = await cachedEmbed(richText);
  if (!queryEmbedding) {
    warnings.push('analogs_skipped');
    return [];
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: rpcData, error: rpcErr } = await (supabase as any).rpc(
    'search_ct_regime_analogs',
    {
      query_embedding: queryEmbedding,
      match_threshold: threshold,
      match_count: cap,
      ticker_filter: scope.ticker,
      exclude_after_ts: scope.bucket_ts,
    },
  );

  if (rpcErr || !Array.isArray(rpcData)) {
    warnings.push(rpcErr ? `analogs_rpc_error:${rpcErr.message}` : 'analogs_no_rows');
    return [];
  }

  const analogs: RegimeAnalog[] = (rpcData as RawAnalog[]).map((r) => ({
    history_id: Number(r.id),
    bucket_ts: r.bucket_ts,
    ticker: r.ticker == null ? null : r.ticker.toUpperCase(),
    classification: r.classification,
    confidence: toNumOrNull(r.confidence) ?? 0,
    cosine_similarity: toNumOrNull(r.similarity) ?? 0,
    rich_text: r.rich_text ?? '',
  }));

  if (analogs.length > 0) {
    await enrichNextClassifications(supabase, analogs);
  }
  return analogs;
}

// ---------------------------------------------------------------------------
// Empty-result helper
// ---------------------------------------------------------------------------

// Bundle Phase 2 organMetadata sibling-sweep ship 2026-05-15 (goal #5 item 1).
// regime was structurally missing organMetadata on both return paths — every
// other helper composes it. Closes the class with same shape as
// pulseContext + flowHeatmapContext (inline organMetadata literal, no
// dedicated buildOrganMetadata helper since regime's window/source string
// only varies on the status field).
function emptyResult(
  startedAt: number,
  warning?: string,
  status: OrganStatus = 'no_signal_detected',
): HelperResult<RegimeResult> {
  const asOf = new Date().toISOString();
  return {
    data: {
      market_wide: null,
      per_ticker: {},
      top_analogs: [],
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
    organMetadata: {
      as_of: asOf,
      source: '_shared/regimeContext.ts / ct_regime_classifications + ct_regime_history (semantic analogs)',
      window: 'most-recent classification per market+watchlist; analogs over ct_regime_history.embedded_state',
      status,
    },
  };
}

// ---------------------------------------------------------------------------
// Convenience function
// ---------------------------------------------------------------------------

export async function getRegimeContext(
  ctx: HelperFetchContext,
  opts: HelperOpts = {},
): Promise<HelperResult<RegimeResult>> {
  const startedAt = Date.now();

  const requestedCap = typeof opts.cap === 'number' ? opts.cap : DEFAULT_ANALOG_CAP;
  const analogCap = Math.max(1, Math.min(MAX_ANALOG_CAP, requestedCap));
  const freshnessSec = typeof opts.freshnessSeconds === 'number'
    ? Math.max(60, opts.freshnessSeconds)
    : DEFAULT_FRESHNESS_SECONDS;
  const analogThreshold = typeof opts.analogThreshold === 'number'
    ? Math.max(0, Math.min(1, opts.analogThreshold))
    : DEFAULT_ANALOG_THRESHOLD;
  const tickerFocusRaw = typeof opts.tickerFocus === 'string' && opts.tickerFocus.length > 0
    ? opts.tickerFocus.toUpperCase()
    : null;

  const staleAfter = new Date(Date.now() - freshnessSec * 1000);

  try {
    // Scope: tickerFocus → only that ticker + market-wide.
    //        no focus → full watchlist + market-wide.
    const tickers: (string | null)[] = tickerFocusRaw
      ? [null, tickerFocusRaw]
      : [null, ...Array.from(ctx.watchlist ?? []).map((t) => t.toUpperCase())];

    // Dedupe.
    const seen = new Set<string>();
    const scopedTickers = tickers.filter((t) => {
      const key = t ?? '__MARKET__';
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const fetchResults = await Promise.all(
      scopedTickers.map((t) => fetchLatestForScope(ctx.supabase, t, staleAfter)),
    );

    let market_wide: TickerRegime | null = null;
    const per_ticker: Record<string, TickerRegime> = {};
    let anyStale = false;
    let anyData = false;

    for (let i = 0; i < scopedTickers.length; i++) {
      const t = scopedTickers[i];
      const r = fetchResults[i];
      if (!r) continue;
      anyData = true;
      if (r.isStale) anyStale = true;
      if (t == null) {
        market_wide = r.regime;
      } else {
        per_ticker[t] = r.regime;
      }
    }

    const warnings: string[] = [];
    if (!anyData) warnings.push('no_regime_data');
    if (anyStale) warnings.push('stale_data');

    // Analogs: embed focused-scope rich_text, cosine-search ct_regime_history.
    const analogScope: TickerRegime | null = tickerFocusRaw
      ? (per_ticker[tickerFocusRaw] ?? market_wide)
      : market_wide;
    const top_analogs = await fetchAnalogs(
      ctx.supabase,
      analogScope,
      analogCap,
      analogThreshold,
      warnings,
    );

    const totalRows =
      (market_wide ? 1 : 0) + Object.keys(per_ticker).length + top_analogs.length;
    const asOf = new Date().toISOString();
    // Status semantics match other helpers: populated when any data resolved,
    // no_signal_detected when fetch path completed but nothing came back.
    // anyStale → still populated; the warning conveys staleness.
    const status: OrganStatus = anyData ? 'populated' : 'no_signal_detected';

    return {
      data: {
        market_wide,
        per_ticker,
        top_analogs,
        generated_at: asOf,
      },
      meta: {
        helperName: HELPER_NAME,
        helperVersion: HELPER_VERSION,
        fetchedAt: asOf,
        rowCount: totalRows,
        cacheHit: false,
        latencyMs: Date.now() - startedAt,
        truncated: requestedCap > MAX_ANALOG_CAP,
        ...(warnings.length > 0 ? { warning: warnings.join(';') } : {}),
      },
      organMetadata: {
        as_of: asOf,
        source: '_shared/regimeContext.ts / ct_regime_classifications + ct_regime_history (semantic analogs)',
        window: `most-recent classification per market+watchlist (freshness ${freshnessSec}s); top-${analogCap} analogs over ct_regime_history.embedded_state @ threshold ${analogThreshold}`,
        status,
      },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return emptyResult(startedAt, `fetch_error:${msg}`, 'error');
  }
}

// ---------------------------------------------------------------------------
// ContextHelper instance — default export
// ---------------------------------------------------------------------------

const regimeHelper: ContextHelper<RegimeResult> = {
  name: HELPER_NAME,
  version: HELPER_VERSION,
  defaultCap: DEFAULT_ANALOG_CAP,
  // Voyage embed call on the analog query path → expensive in the
  // budget-mode sense. Same gate `BrainOpts.budgetMode` uses to skip.
  isExpensive: true,
  // 60s — bucket cadence is 5min so anything fresher than this is essentially
  // identical state. Cache cuts duplicate work across same-isolate fans.
  minRefreshSeconds: 60,
  dependencies: [],
  audienceFilter: AUDIENCE_FILTER,
  cacheTtlSeconds: 60,

  async fetch(
    ctx: HelperFetchContext,
    opts: HelperOpts,
  ): Promise<HelperResult<RegimeResult>> {
    return getRegimeContext(ctx, opts);
  },

  describe(): HelperDescription {
    return {
      name: HELPER_NAME,
      version: HELPER_VERSION,
      defaultCap: DEFAULT_ANALOG_CAP,
      expensive: true,
      minRefreshSeconds: 60,
      dependencies: [],
      audienceFilter: AUDIENCE_FILTER,
      outputShape:
        'Pulse v2 regime: market_wide + per-ticker latest classifications ' +
        '(momentum/breadth/trajectory/dispersion/duration), plus top-N analogs ' +
        'by cosine over ct_regime_history.embedded_state with next_classification. ' +
        'Defensive; weekend fallback warns stale_data; voyage failure warns ' +
        'analogs_skipped. cotrader+analyst only.',
    };
  },
};

export default regimeHelper;
