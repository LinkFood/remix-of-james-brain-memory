/**
 * sessionEmbedding — build a condensed session snapshot (text + features)
 * from existing ct_heartbeats / ct_iv_rank_daily / ct_news_analyses data,
 * then embed it with Voyage 512-dim for analog matching.
 *
 * Philosophy:
 *   - Zero new UW calls. Everything is derived from what the watcher /
 *     eod-positioning / news-ingester have already persisted.
 *   - One row per (session_date, through_utc). Embed the text summary —
 *     language is the universal schema. Keep the structured features in
 *     JSONB so the UI can filter / display without re-parsing the text.
 *   - Defensive: missing inputs fall back to null / omit the clause, never
 *     throw. A thin session embedding is still a useful anchor.
 *
 * Used by ct-session-analog in BOTH modes:
 *   - build  → persist for nightly / manual backfill
 *   - search → build today's snapshot (not persisted), embed as `query`,
 *              RPC against past persisted rows.
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { voyageEmbed } from './ctEmbed.ts';

// ============================================================================
// Types
// ============================================================================

export type VixTier = 'low' | 'mid' | 'elevated' | 'stressed' | 'unknown';
export type IvTier = 'cold' | 'mid' | 'hot' | 'unknown';
export type GammaRegime = 'positive' | 'negative' | 'unknown';

/**
 * StateFeatures — structured shape persisted in ct_session_embeddings.state_features.
 * Keep it flat-ish so the UI can read without deep traversal.
 */
export interface StateFeatures {
  session_date: string;
  through_utc: string;
  spy_price: number | null;
  spx_regime: GammaRegime;
  spx_gamma_flip: number | null;
  call_wall: number | null;
  put_wall: number | null;
  vix: number | null;
  vix_tier: VixTier;
  iv_rank_spy: number | null;
  iv_tier: IvTier;
  breadth_advancers: number | null;
  breadth_decliners: number | null;
  breadth_net: number | null;
  net_call_premium: number | null;
  net_put_premium: number | null;
  put_call_ratio: number | null;
  catalyst_flags: string[];
  // free-form: anything we want to surface later without migrating
  extras: Record<string, unknown>;
}

export interface SessionSnapshot {
  session_date: string;       // 'YYYY-MM-DD'
  through_utc: string;        // ISO timestamp
  state_summary: string;      // prose for embedding + display
  state_features: StateFeatures;
}

// ============================================================================
// Tier helpers — give the LLM coarse-grained anchors the embedding can lean on.
// These tiers are *in the text*, not just the features, so the embedding
// captures "VIX elevated" as a concept (not just a scalar).
// ============================================================================

function vixTierOf(vix: number | null): VixTier {
  if (vix === null || !Number.isFinite(vix)) return 'unknown';
  if (vix < 14) return 'low';
  if (vix < 20) return 'mid';
  if (vix < 30) return 'elevated';
  return 'stressed';
}

function ivTierOf(rank: number | null): IvTier {
  if (rank === null || !Number.isFinite(rank)) return 'unknown';
  if (rank < 25) return 'cold';
  if (rank < 60) return 'mid';
  return 'hot';
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function fmtPrice(n: number | null, digits = 2): string {
  if (n === null) return '—';
  return n.toFixed(digits);
}

function fmtPct(n: number | null, digits = 1): string {
  if (n === null) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`;
}

function fmtBigDollar(n: number | null): string {
  if (n === null) return '—';
  const abs = Math.abs(n);
  const sign = n >= 0 ? '+' : '-';
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(0)}M`;
  return `${sign}$${abs.toFixed(0)}`;
}

// ============================================================================
// Data pulls — each is defensive, returns `null` shape on missing data.
// All restricted to `through` or earlier, scoped to `sessionDate` where it
// makes sense.
// ============================================================================

async function loadLatestHeartbeat(
  supabase: SupabaseClient,
  sessionDate: string,
  through: string,
): Promise<Record<string, unknown> | null> {
  const start = `${sessionDate}T00:00:00Z`;
  const { data, error } = await supabase
    .from('ct_heartbeats')
    .select('status_line, watching, current_reads, created_at')
    .gte('created_at', start)
    .lte('created_at', through)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) {
    console.warn('[sessionEmbedding] heartbeat fetch failed:', error.message);
    return null;
  }
  return (data?.[0] as Record<string, unknown> | undefined) ?? null;
}

async function loadIvRank(
  supabase: SupabaseClient,
  sessionDate: string,
): Promise<{ spy: number | null; spx: number | null }> {
  const { data, error } = await supabase
    .from('ct_iv_rank_daily')
    .select('ticker, iv_rank')
    .eq('date', sessionDate)
    .in('ticker', ['SPY', 'SPX']);
  if (error) {
    console.warn('[sessionEmbedding] iv-rank fetch failed:', error.message);
    return { spy: null, spx: null };
  }
  const rows = (data ?? []) as Array<{ ticker: string; iv_rank: number | null }>;
  const spy = rows.find(r => r.ticker === 'SPY')?.iv_rank ?? null;
  const spx = rows.find(r => r.ticker === 'SPX')?.iv_rank ?? null;
  return { spy, spx };
}

async function loadNewsCatalysts(
  supabase: SupabaseClient,
  sessionDate: string,
  through: string,
): Promise<Array<{ instrument: string; impact: string; significance: number; headline: string }>> {
  const start = `${sessionDate}T00:00:00Z`;
  const { data, error } = await supabase
    .from('ct_news_analyses')
    .select('instrument, impact, significance, news_headline, created_at')
    .gte('created_at', start)
    .lte('created_at', through)
    .gte('significance', 3)
    .order('significance', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(8);
  if (error) {
    console.warn('[sessionEmbedding] news fetch failed:', error.message);
    return [];
  }
  return ((data ?? []) as Array<Record<string, unknown>>).map(r => ({
    instrument: String(r.instrument ?? ''),
    impact: String(r.impact ?? 'neutral'),
    significance: Number(r.significance ?? 0),
    headline: String(r.news_headline ?? ''),
  }));
}

function extractSpxFromHeartbeat(hb: Record<string, unknown> | null): {
  spy_price: number | null;
  spx_regime: GammaRegime;
  spx_gamma_flip: number | null;
  call_wall: number | null;
  put_wall: number | null;
  put_call_ratio: number | null;
} {
  const empty = {
    spy_price: null,
    spx_regime: 'unknown' as GammaRegime,
    spx_gamma_flip: null,
    call_wall: null,
    put_wall: null,
    put_call_ratio: null,
  };
  if (!hb) return empty;
  const reads = hb.current_reads;
  if (!reads || typeof reads !== 'object') return empty;
  const r = reads as Record<string, unknown>;

  // current_reads shape varies — try a couple of known locations
  const snap = (r._snapshot ?? r.snapshot) as Record<string, unknown> | undefined;
  const perTicker = (snap?.per_ticker ?? r.per_ticker) as Record<string, Record<string, unknown>> | undefined;
  const spxMacro = (snap?.spx_macro ?? r.spx_macro) as Record<string, unknown> | undefined;

  const spy = perTicker?.SPY ?? null;
  const spy_price = spy ? numOrNull(spy.price) : null;

  // Prefer SPX for the index-level regime story
  const regimeSrc = spxMacro ?? spy ?? {};
  const regime: GammaRegime =
    regimeSrc.regime === 'positive' || regimeSrc.regime === 'negative'
      ? (regimeSrc.regime as GammaRegime)
      : 'unknown';

  return {
    spy_price,
    spx_regime: regime,
    spx_gamma_flip: spxMacro ? numOrNull(spxMacro.gamma_flip) : null,
    call_wall: spxMacro ? numOrNull(spxMacro.call_wall) : (spy ? numOrNull(spy.call_wall) : null),
    put_wall: spxMacro ? numOrNull(spxMacro.put_wall) : (spy ? numOrNull(spy.put_wall) : null),
    put_call_ratio: spy ? numOrNull(spy.day_put_call_ratio) : null,
  };
}

function extractBreadth(hb: Record<string, unknown> | null): {
  advancers: number | null;
  decliners: number | null;
} {
  if (!hb) return { advancers: null, decliners: null };
  const reads = hb.current_reads;
  if (!reads || typeof reads !== 'object') return { advancers: null, decliners: null };
  const r = reads as Record<string, unknown>;
  const snap = (r._snapshot ?? r.snapshot) as Record<string, unknown> | undefined;
  const perTicker = (snap?.per_ticker ?? r.per_ticker) as Record<string, Record<string, unknown>> | undefined;
  if (!perTicker) return { advancers: null, decliners: null };

  // Use near-ATM cumulative deltas as a cheap breadth proxy across the watchlist:
  // count tickers whose ticker.price sits above their gamma_flip (= positive regime).
  let advancers = 0;
  let decliners = 0;
  let counted = 0;
  for (const t of Object.values(perTicker)) {
    if (!t) continue;
    const reg = t.regime;
    if (reg === 'positive') { advancers++; counted++; }
    else if (reg === 'negative') { decliners++; counted++; }
  }
  if (counted === 0) return { advancers: null, decliners: null };
  return { advancers, decliners };
}

function extractMarketTide(hb: Record<string, unknown> | null): {
  net_call_premium: number | null;
  net_put_premium: number | null;
} {
  if (!hb) return { net_call_premium: null, net_put_premium: null };
  const reads = hb.current_reads;
  if (!reads || typeof reads !== 'object') return { net_call_premium: null, net_put_premium: null };
  const r = reads as Record<string, unknown>;
  const snap = (r._snapshot ?? r.snapshot) as Record<string, unknown> | undefined;
  const tide = (snap?.market_tide ?? r.market_tide) as Record<string, unknown> | undefined;
  if (!tide) return { net_call_premium: null, net_put_premium: null };
  return {
    net_call_premium: numOrNull(tide.net_call_premium),
    net_put_premium: numOrNull(tide.net_put_premium),
  };
}

// ============================================================================
// buildSessionSnapshot — assemble the text summary + features. Returns the
// snapshot without persisting or embedding. `embedSessionSnapshot` does that.
// ============================================================================

export async function buildSessionSnapshot(
  supabase: SupabaseClient,
  sessionDate: string,
  through: string,
): Promise<SessionSnapshot> {
  const [hb, iv, news] = await Promise.all([
    loadLatestHeartbeat(supabase, sessionDate, through),
    loadIvRank(supabase, sessionDate),
    loadNewsCatalysts(supabase, sessionDate, through),
  ]);

  const spx = extractSpxFromHeartbeat(hb);
  const breadth = extractBreadth(hb);
  const tide = extractMarketTide(hb);

  // Pull VIX from heartbeat per_ticker if available (watcher tracks it)
  let vix: number | null = null;
  const reads = hb?.current_reads as Record<string, unknown> | undefined;
  if (reads && typeof reads === 'object') {
    const snap = (reads._snapshot ?? reads.snapshot) as Record<string, unknown> | undefined;
    const perTicker = (snap?.per_ticker ?? reads.per_ticker) as Record<string, Record<string, unknown>> | undefined;
    if (perTicker?.VIX) vix = numOrNull(perTicker.VIX.price);
  }

  const vix_tier = vixTierOf(vix);
  const iv_tier = ivTierOf(iv.spy);

  // Derive catalyst flags from news: "earnings", "fomc", "cpi", etc., keyword scan.
  const catalyst_flags = deriveCatalystFlags(news);

  const breadth_net =
    breadth.advancers !== null && breadth.decliners !== null
      ? breadth.advancers - breadth.decliners
      : null;

  const features: StateFeatures = {
    session_date: sessionDate,
    through_utc: through,
    spy_price: spx.spy_price,
    spx_regime: spx.spx_regime,
    spx_gamma_flip: spx.spx_gamma_flip,
    call_wall: spx.call_wall,
    put_wall: spx.put_wall,
    vix,
    vix_tier,
    iv_rank_spy: iv.spy,
    iv_tier,
    breadth_advancers: breadth.advancers,
    breadth_decliners: breadth.decliners,
    breadth_net,
    net_call_premium: tide.net_call_premium,
    net_put_premium: tide.net_put_premium,
    put_call_ratio: spx.put_call_ratio,
    catalyst_flags,
    extras: {
      heartbeat_at: hb?.created_at ?? null,
      news_count: news.length,
    },
  };

  // Build the prose. Plain-English, comma-separated clauses. This is the
  // text that goes to Voyage — the denser and more structural, the better
  // the analog match. Raw numbers + tier labels both appear so the embedding
  // can generalize across scales.
  const clauses: string[] = [];
  clauses.push(`Session ${sessionDate} through ${through.slice(11, 16)} UTC`);
  if (features.spy_price !== null) clauses.push(`SPY ${fmtPrice(features.spy_price)}`);
  if (features.spx_regime !== 'unknown') clauses.push(`SPX ${features.spx_regime} gamma`);
  if (features.spx_gamma_flip !== null) clauses.push(`flip ${fmtPrice(features.spx_gamma_flip, 0)}`);
  if (features.call_wall !== null) clauses.push(`call wall ${fmtPrice(features.call_wall, 0)}`);
  if (features.put_wall !== null) clauses.push(`put wall ${fmtPrice(features.put_wall, 0)}`);
  if (vix !== null) clauses.push(`VIX ${fmtPrice(vix, 1)} (${vix_tier})`);
  if (iv.spy !== null) clauses.push(`SPY IV rank ${iv.spy.toFixed(0)} (${iv_tier})`);
  if (breadth_net !== null) {
    const sign = breadth_net >= 0 ? '+' : '';
    clauses.push(`breadth ${sign}${breadth_net} (${breadth.advancers}/${breadth.decliners})`);
  }
  if (features.net_call_premium !== null) clauses.push(`net call premium ${fmtBigDollar(features.net_call_premium)}`);
  if (features.net_put_premium !== null) clauses.push(`net put premium ${fmtBigDollar(features.net_put_premium)}`);
  if (features.put_call_ratio !== null) clauses.push(`P/C ${features.put_call_ratio.toFixed(2)}`);
  if (catalyst_flags.length > 0) clauses.push(`catalysts: ${catalyst_flags.join(', ')}`);

  // Top 3 news impacts as narrative seeds
  if (news.length > 0) {
    const top = news.slice(0, 3).map(n => `${n.instrument} ${n.impact} (${n.headline.slice(0, 60)})`).join('; ');
    clauses.push(`news: ${top}`);
  }

  const state_summary = clauses.join(', ');

  return {
    session_date: sessionDate,
    through_utc: through,
    state_summary,
    state_features: features,
  };
}

function deriveCatalystFlags(news: Array<{ headline: string }>): string[] {
  const flags = new Set<string>();
  for (const n of news) {
    const h = n.headline.toLowerCase();
    if (/\bearnings?\b|\beps\b|\bguidance\b/.test(h)) flags.add('earnings');
    if (/\bfomc\b|\bfed\b|\brate cut\b|\brate hike\b|\bpowell\b/.test(h)) flags.add('fomc');
    if (/\bcpi\b|\binflation\b/.test(h)) flags.add('cpi');
    if (/\bpce\b/.test(h)) flags.add('pce');
    if (/\bppi\b/.test(h)) flags.add('ppi');
    if (/\bnfp\b|\bpayroll\b|\bjobs report\b|\bunemployment\b/.test(h)) flags.add('jobs');
    if (/\btariff\b|\btrade war\b/.test(h)) flags.add('tariffs');
    if (/\bwar\b|\bconflict\b|\bstrike\b/.test(h)) flags.add('geopolitics');
  }
  return [...flags].sort();
}

// ============================================================================
// embedSessionSnapshot — build, embed, persist. Idempotent via
// (session_date, through_utc) UNIQUE upsert.
// ============================================================================

export async function embedSessionSnapshot(
  supabase: SupabaseClient,
  sessionDate: string,
  through: string,
): Promise<{ ok: boolean; snapshot?: SessionSnapshot; error?: string }> {
  try {
    const snap = await buildSessionSnapshot(supabase, sessionDate, through);

    // Bail on an utterly empty snapshot (no heartbeat data at all) — embedding
    // "Session YYYY-MM-DD through HH:MM UTC" with nothing else is a noise row.
    const meaningful =
      snap.state_features.spy_price !== null ||
      snap.state_features.vix !== null ||
      snap.state_features.call_wall !== null ||
      snap.state_features.put_wall !== null ||
      snap.state_features.catalyst_flags.length > 0;
    if (!meaningful) {
      return { ok: false, snapshot: snap, error: 'empty_snapshot' };
    }

    const embedding = await voyageEmbed(snap.state_summary, 'document');

    const { error } = await supabase.from('ct_session_embeddings').upsert(
      {
        session_date: snap.session_date,
        through_utc: snap.through_utc,
        state_summary: snap.state_summary,
        state_features: snap.state_features,
        embedding: embedding as unknown as string,
      },
      { onConflict: 'session_date,through_utc' }
    );
    if (error) return { ok: false, snapshot: snap, error: error.message };

    return { ok: true, snapshot: snap };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ============================================================================
// finalizeSessionOutcome — called after EOD once SPY close is known, so the
// "outcome" of that day's embedding is filled in for future analog queries.
// Non-blocking: not strictly needed for the match itself, but the UI uses it.
//
// Not wired to a cron in this migration — future step once a spy_daily EOD
// row is reliably populated. Exposed here for manual fills.
// ============================================================================

export async function finalizeSessionOutcome(
  supabase: SupabaseClient,
  sessionDate: string,
  through: string,
  eod_return_pct: number,
  eod_summary: string,
): Promise<{ ok: boolean; error?: string }> {
  const { error } = await supabase
    .from('ct_session_embeddings')
    .update({ eod_return_pct, eod_summary })
    .eq('session_date', sessionDate)
    .eq('through_utc', through);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
