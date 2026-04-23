/**
 * hallucinationGuard — cheap server-side claim validator.
 *
 * Claude sometimes writes "because bullets" citing concrete numbers or events
 * that aren't in the data. This guard validates each bullet against source
 * tables and returns per-bullet pass/fail. The writer function decides what to
 * do — we DO NOT block the write. We flag so the decision journal carries
 * hallucination_flag=true and James can audit.
 *
 * Heuristics (all optional — bullets that don't match any pattern pass through
 * as 'unverifiable'):
 *   1. "dark pool accumulation >$X in last Y hours" → sum ct_dark_pool_prints.
 *   2. "GEX flip at X" (gamma flip level) → latest ct_gex_timeseries for ticker,
 *      compute zero-gamma strike, compare within ±2%.
 *   3. "news: …" | "headline: …" | "[event]" → keyword search
 *      ct_breaking_news + ct_news_analyses last 48h.
 *
 * Non-throwing. Failures in one heuristic don't tank the batch — that bullet
 * gets marked unverifiable with the DB error for context.
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';

export interface HallucinationFlag {
  bullet: string;
  reason: string;
  /** The source-truth value we computed, for journaling. */
  actual?: string;
}

export interface HallucinationResult {
  valid: boolean;
  flagged: HallucinationFlag[];
  /**
   * When flagged.length >= AUTO_REJECT_THRESHOLD, the whole proposal should be
   * rejected. Callers insert a hallucination_flagged decision row and skip the
   * hypothesis insert entirely.
   */
  accepted: boolean;
  rejected_reason?: string;
}

/** Threshold — this many hallucinated bullets on a single proposal = auto-reject. */
export const AUTO_REJECT_THRESHOLD = 2;

// ---- Pattern detection ------------------------------------------------------

interface DarkPoolClaim {
  ticker?: string;
  minNotional: number;
  lookbackHours: number;
}

/** "dark pool(s) accumulation >$500M in last 4 hours" etc. */
function parseDarkPoolClaim(bullet: string): DarkPoolClaim | null {
  const low = bullet.toLowerCase();
  if (!low.includes('dark pool')) return null;

  // Look for dollar threshold, e.g. "$500M", "$1.2B", "$50,000,000"
  const amountMatch = low.match(/\$\s*([\d,.]+)\s*([mbk])?/i);
  if (!amountMatch) return null;
  const num = parseFloat(amountMatch[1].replace(/,/g, ''));
  if (!Number.isFinite(num)) return null;
  const unit = (amountMatch[2] ?? '').toLowerCase();
  const mul = unit === 'b' ? 1e9 : unit === 'm' ? 1e6 : unit === 'k' ? 1e3 : 1;
  const minNotional = num * mul;

  // Lookback: "last 4 hours", "last 2h", "past 24h"
  const hourMatch = low.match(/(?:last|past)\s+(\d+)\s*(?:h|hour|hours)/);
  const lookbackHours = hourMatch ? parseInt(hourMatch[1], 10) : 24;

  // Optional ticker pick-up: first all-caps token 2-5 chars
  const tickerMatch = bullet.match(/\b[A-Z]{2,5}\b/);
  const ticker = tickerMatch ? tickerMatch[0] : undefined;

  return { ticker, minNotional, lookbackHours };
}

interface GexFlipClaim {
  ticker: string;
  flipLevel: number;
}

/** "SPY gamma flip at 550" / "GEX flip near 4850 on SPX" */
function parseGexFlipClaim(bullet: string): GexFlipClaim | null {
  const low = bullet.toLowerCase();
  if (!low.includes('gex') && !low.includes('gamma flip')) return null;

  // Extract a number (flip level)
  const numMatch = bullet.match(/\b(\d{2,6}(?:\.\d+)?)\b/);
  if (!numMatch) return null;
  const flipLevel = parseFloat(numMatch[1]);
  if (!Number.isFinite(flipLevel)) return null;

  // Extract a ticker — first all-caps token 2-5 chars
  const tickerMatch = bullet.match(/\b[A-Z]{2,5}\b/);
  if (!tickerMatch) return null;

  return { ticker: tickerMatch[0], flipLevel };
}

interface NewsClaim {
  keywords: string[];
}

/** Any bullet citing "news:", "headline:", "per report", "reports of X". */
function parseNewsClaim(bullet: string): NewsClaim | null {
  const low = bullet.toLowerCase();
  const markers = ['news:', 'headline:', 'reports of', 'per report', 'reported that', 'announced'];
  const hasMarker = markers.some((m) => low.includes(m));
  if (!hasMarker) return null;
  // Pull content-bearing words (4+ chars, alpha), drop stopwords.
  const stop = new Set([
    'news', 'headline', 'reports', 'report', 'reported', 'announced', 'with',
    'that', 'this', 'from', 'into', 'over', 'under', 'about',
  ]);
  const words = bullet
    .split(/\W+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length >= 4 && !stop.has(w));
  if (words.length === 0) return null;
  // Top 3 longest distinct tokens as keywords.
  const uniq = Array.from(new Set(words)).sort((a, b) => b.length - a.length).slice(0, 3);
  return { keywords: uniq };
}

// ---- Validators -------------------------------------------------------------

async function validateDarkPool(
  supabase: SupabaseClient,
  claim: DarkPoolClaim,
): Promise<{ ok: boolean; detail: string; actual: string }> {
  const sinceIso = new Date(Date.now() - claim.lookbackHours * 3_600_000).toISOString();
  let query = supabase
    .from('ct_dark_pool_prints')
    .select('notional_value')
    .gte('executed_at', sinceIso);
  if (claim.ticker) query = query.eq('ticker', claim.ticker);
  const { data, error } = await query.limit(5000);
  if (error) return { ok: true, detail: `dark-pool query failed: ${error.message} (passing)`, actual: 'query_error' };
  const total = (data ?? []).reduce((s, r) => s + (Number(r.notional_value) || 0), 0);
  const ok = total >= claim.minNotional;
  const actual = `${claim.lookbackHours}h notional${claim.ticker ? ` ${claim.ticker}` : ''} = $${total.toFixed(0)}`;
  return {
    ok,
    detail: `actual ${actual} vs claim >= $${claim.minNotional.toFixed(0)}`,
    actual,
  };
}

async function validateGexFlip(
  supabase: SupabaseClient,
  claim: GexFlipClaim,
): Promise<{ ok: boolean; detail: string; actual: string }> {
  const { data, error } = await supabase
    .from('ct_gex_timeseries')
    .select('strike, net_gex, snapshot_at')
    .eq('ticker', claim.ticker)
    .order('snapshot_at', { ascending: false })
    .limit(400);
  if (error) return { ok: true, detail: `gex query failed: ${error.message} (passing)`, actual: 'query_error' };
  if (!data || data.length === 0) return { ok: false, detail: `no gex rows for ${claim.ticker}`, actual: 'no_data' };

  // Use only the latest snapshot.
  const latest = data[0].snapshot_at;
  const snap = data.filter((r) => r.snapshot_at === latest);
  // Gamma flip ≈ the strike where net_gex crosses zero. Sort by strike, find
  // the crossing.
  const sorted = snap
    .map((r) => ({ strike: Number(r.strike), gex: Number(r.net_gex) }))
    .filter((r) => Number.isFinite(r.strike) && Number.isFinite(r.gex))
    .sort((a, b) => a.strike - b.strike);
  let flipStrike: number | null = null;
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    if (prev.gex === 0) { flipStrike = prev.strike; break; }
    if ((prev.gex < 0 && curr.gex >= 0) || (prev.gex > 0 && curr.gex <= 0)) {
      // Linear interp between prev.strike and curr.strike for the zero crossing.
      const span = curr.gex - prev.gex;
      const t = span === 0 ? 0 : -prev.gex / span;
      flipStrike = prev.strike + (curr.strike - prev.strike) * t;
      break;
    }
  }
  if (flipStrike == null) return { ok: false, detail: `no gex flip found for ${claim.ticker} in latest snap`, actual: 'no_flip' };
  const deltaPct = Math.abs(flipStrike - claim.flipLevel) / claim.flipLevel * 100;
  const ok = deltaPct <= 2;
  const actual = `${claim.ticker} gex flip ≈ ${flipStrike.toFixed(2)}`;
  return {
    ok,
    detail: `actual ${actual} vs claim ${claim.flipLevel} (Δ ${deltaPct.toFixed(2)}%)`,
    actual,
  };
}

async function validateNews(
  supabase: SupabaseClient,
  claim: NewsClaim,
): Promise<{ ok: boolean; detail: string; actual: string }> {
  if (claim.keywords.length === 0) return { ok: true, detail: 'no keywords to validate', actual: 'no_keywords' };
  const sinceIso = new Date(Date.now() - 48 * 3_600_000).toISOString();

  // Build ilike pattern for the strongest keyword; we'll require at least one
  // match that also hits a second keyword (to avoid incidental matches).
  const [k1, k2, k3] = claim.keywords;

  const [breaking, analyses] = await Promise.all([
    supabase
      .from('ct_breaking_news')
      .select('headline, summary, created_at')
      .gte('created_at', sinceIso)
      .ilike('headline', `%${k1}%`)
      .limit(50),
    supabase
      .from('ct_news_analyses')
      .select('news_headline, created_at')
      .gte('created_at', sinceIso)
      .ilike('news_headline', `%${k1}%`)
      .limit(50),
  ]);
  const hits: string[] = [];
  for (const row of breaking.data ?? []) {
    const text = `${row.headline ?? ''} ${row.summary ?? ''}`.toLowerCase();
    if (!k2 || text.includes(k2) || (k3 && text.includes(k3))) hits.push(`breaking: ${row.headline}`);
  }
  for (const row of analyses.data ?? []) {
    const text = `${row.news_headline ?? ''}`.toLowerCase();
    if (!k2 || text.includes(k2) || (k3 && text.includes(k3))) hits.push(`analyses: ${row.news_headline}`);
  }
  const ok = hits.length > 0;
  const actual = ok
    ? `${hits.length} headline(s) match [${claim.keywords.join(', ')}] in 48h`
    : `0 headlines match [${claim.keywords.join(', ')}] in 48h`;
  return {
    ok,
    detail: actual,
    actual,
  };
}

// ---- Public API -------------------------------------------------------------

/**
 * Validate a list of "because bullets" from a Claude hypothesis proposal.
 * Returns one flag per bullet that failed validation. Bullets with no detected
 * pattern pass through unflagged (unverifiable ≠ hallucination).
 *
 * Never throws.
 */
export async function validateHypothesisClaims(
  supabase: SupabaseClient,
  because: string[],
): Promise<HallucinationResult> {
  const flagged: HallucinationFlag[] = [];
  for (const bullet of because ?? []) {
    if (!bullet || typeof bullet !== 'string') continue;

    try {
      // DP claims flagged if Claude cites them post-retirement (2026-04-23).
      // System prompts no longer mention DP; this guard catches drift.
      const dp = parseDarkPoolClaim(bullet);
      if (dp) {
        flagged.push({
          bullet,
          reason: 'dark-pool: cited after retirement 2026-04-23 (signal unreliable, should not be referenced)',
          actual: 'dp_retired',
        });
        continue;
      }
      const gex = parseGexFlipClaim(bullet);
      if (gex) {
        const r = await validateGexFlip(supabase, gex);
        if (!r.ok) flagged.push({ bullet, reason: `gex-flip: ${r.detail}`, actual: r.actual });
        continue;
      }
      const news = parseNewsClaim(bullet);
      if (news) {
        const r = await validateNews(supabase, news);
        if (!r.ok) flagged.push({ bullet, reason: `news: ${r.detail}`, actual: r.actual });
        continue;
      }
      // No pattern matched — unverifiable, passes through silently.
    } catch (e) {
      // Catch anything — never block the caller.
      console.warn(`[hallucinationGuard] bullet check threw: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const accepted = flagged.length < AUTO_REJECT_THRESHOLD;
  const rejected_reason = accepted
    ? undefined
    : `${flagged.length} bullets failed source-truth validation (threshold ${AUTO_REJECT_THRESHOLD})`;
  return { valid: flagged.length === 0, flagged, accepted, rejected_reason };
}
