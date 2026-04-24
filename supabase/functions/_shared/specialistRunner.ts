/**
 * specialistRunner — shared logic for all 10 Co-Trader v2 per-ticker specialists.
 *
 * Each specialist edge function (ct-specialist-NVDA, ct-specialist-AAPL, ...) is
 * a thin wrapper that constructs a SupabaseClient + ticker and calls
 * runSpecialistWakeup(). All heavy lifting — config load, cooldown check,
 * candidate scoring filter, memory + hit-rate recall, Claude call, flag write,
 * decision journal, usage logging — lives here.
 *
 * Contract:
 *   - Service-role supabase client passed by caller.
 *   - Never throws on Claude errors / bad JSON — returns ok:false with
 *     skip_reason. Callers can forward the result as JSON.
 *   - Writes 0-3 flags per wakeup. Flags are written one at a time so one
 *     failure doesn't poison the batch.
 *
 * See CO_TRADER_V2_SCOPE.md § "Specialist framework".
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { callClaude, CLAUDE_MODELS, parseTextContent, ClaudeError } from './anthropic.ts';
import { logClaudeUsage } from './claudeUsageLog.ts';
import { isKillSwitchActive } from './killSwitch.ts';
import { recordDecision } from './decisionJournal.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SpecialistContext {
  ticker: string;
  prompt: string;
  wakeupThreshold: number;
  cooldownMinutes: number;
  maxFlagsPerDay: number;
}

export interface SpecialistWakeupArgs {
  supabase: SupabaseClient;
  ticker: string;
  reason: 'scheduled' | 'event_driven' | 'manual';
  forcedEventIds?: string[];
}

export interface SpecialistWakeupResult {
  ok: boolean;
  ticker: string;
  reason: string;
  skip_reason?: string;
  events_considered: number;
  flags_written: number;
  flag_ids: string[];
  cost_usd: number;
  elapsed_ms: number;
  error?: string;
}

interface FlagDecision {
  option_symbol?: string | null;
  direction: 'bullish' | 'bearish' | 'neutral';
  tags: string[];
  thesis: string;
  invalidation: string;
  horizon_hours: number;
  target_price?: number | null;
  score?: number | null;
  source_flow_ids?: string[];
}

interface ClaudeVerdict {
  flags: FlagDecision[];
  pass_reason?: string | null;
}

const GENERIC_PROMPT_FALLBACK = `You are a per-ticker options-flow specialist in Co-Trader v2.
Your job: given recent scored flow events on this ticker plus your own graded history,
decide whether any setup warrants issuing a flag. You must PASS most of the time.

Return JSON: { "flags": [...], "pass_reason": string|null }.
Each flag: { option_symbol, direction, tags[], thesis, invalidation, horizon_hours, target_price, score }.
Max 3 flags per wakeup. Score 60-100. Every flag needs thesis + invalidation + horizon.`;

// Appended to every specialist's system prompt — cross-facet reasoning
// contract. Keeps per-ticker config portable while guaranteeing all
// specialists reason against the three new anchors.
const CROSS_FACET_PROMPT_SUFFIX = `

You now see three cross-facet signals:
- TAPE-READER'S CURRENT READ: the floor-level macro narrative. Use as macro anchor.
- YOUR TICKER'S LEAN SCORE: your ticker's composite direction. Flag direction should align OR you must justify contrarian.
- PEER SPECIALIST FLAGS: what your siblings just did. If peers are heavily bearish and you're bullish, say why.

Your job is still ticker-specific, but you must reason against these anchors before firing.`;

const DEFAULT_COOLDOWN_MIN = 15;
const DEFAULT_WAKEUP_THRESHOLD = 60;
const DEFAULT_MAX_FLAGS_PER_DAY = 10;
const CANDIDATE_WINDOW_MIN = 30;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getConfigValue<T>(
  supabase: SupabaseClient,
  key: string,
  fallback: T,
): Promise<T> {
  try {
    const { data, error } = await supabase.rpc('ct_config_get', { p_key: key });
    if (error || data === null || data === undefined) return fallback;
    return data as T;
  } catch {
    return fallback;
  }
}

function stripFences(s: string): string {
  return s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
}

function parseClaudeVerdict(raw: string): ClaudeVerdict | { error: string } {
  const body = stripFences(raw).trim();
  if (!body) return { error: 'empty response' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    const match = body.match(/\{[\s\S]*\}/);
    if (!match) return { error: 'no JSON found' };
    try { parsed = JSON.parse(match[0]); }
    catch { return { error: 'JSON parse failed' }; }
  }

  const p = parsed as Record<string, unknown>;
  const flagsRaw = Array.isArray(p.flags) ? p.flags : [];
  const flags: FlagDecision[] = [];

  for (const f of flagsRaw.slice(0, 3)) {
    const r = f as Record<string, unknown>;
    const direction = String(r.direction ?? '').toLowerCase();
    if (!['bullish', 'bearish', 'neutral'].includes(direction)) continue;
    const thesis = typeof r.thesis === 'string' ? r.thesis.trim() : '';
    const invalidation = typeof r.invalidation === 'string' ? r.invalidation.trim() : '';
    const horizonHours = Number(r.horizon_hours);
    if (!thesis || !invalidation || !Number.isFinite(horizonHours) || horizonHours <= 0) continue;

    const tagsRaw = Array.isArray(r.tags) ? r.tags : [];
    const tags = tagsRaw.map(t => String(t)).slice(0, 12);

    flags.push({
      option_symbol: typeof r.option_symbol === 'string' ? r.option_symbol : null,
      direction: direction as 'bullish' | 'bearish' | 'neutral',
      tags,
      thesis: thesis.slice(0, 2000),
      invalidation: invalidation.slice(0, 1000),
      horizon_hours: Math.min(720, Math.max(1, Math.round(horizonHours))),
      target_price: Number.isFinite(Number(r.target_price)) ? Number(r.target_price) : null,
      score: Number.isFinite(Number(r.score)) ? Number(r.score) : null,
    });
  }

  return {
    flags,
    pass_reason: typeof p.pass_reason === 'string' ? p.pass_reason.slice(0, 500) : null,
  };
}

// ---------------------------------------------------------------------------
// Context loaders
// ---------------------------------------------------------------------------

async function loadCandidateEvents(
  supabase: SupabaseClient,
  ticker: string,
  wakeupThreshold: number,
  forcedEventIds?: string[],
) {
  if (forcedEventIds && forcedEventIds.length > 0) {
    const { data, error } = await supabase
      .from('ct_scored_flow')
      .select('id, ticker, option_symbol, event_ts, classification, direction, score, raw_score, score_breakdown, penalty_breakdown, strike, expiry, dte, delta_est, premium, volume, open_interest, ask_side_perc, iv_rank_at_event')
      .in('id', forcedEventIds);
    if (error) {
      console.warn('[specialistRunner] forced events load failed:', error.message);
      return [];
    }
    return data ?? [];
  }

  const cutoff = new Date(Date.now() - CANDIDATE_WINDOW_MIN * 60_000).toISOString();
  const { data, error } = await supabase
    .from('ct_scored_flow')
    .select('id, ticker, option_symbol, event_ts, classification, direction, score, raw_score, score_breakdown, penalty_breakdown, strike, expiry, dte, delta_est, premium, volume, open_interest, ask_side_perc, iv_rank_at_event')
    .eq('ticker', ticker)
    .gte('score', wakeupThreshold)
    .gte('event_ts', cutoff)
    .order('score', { ascending: false })
    .limit(15);
  if (error) {
    console.warn('[specialistRunner] candidate events load failed:', error.message);
    return [];
  }
  return data ?? [];
}

async function loadTickerSnapshot(supabase: SupabaseClient, ticker: string) {
  const { data } = await supabase
    .from('ct_ticker_snapshots')
    .select('ticker, spot, iv_rank, iv_percentile, gamma_flip, call_wall, put_wall, net_gamma, regime, next_earnings_date, earnings_expected_move, nope_latest, put_call_ratio')
    .eq('ticker', ticker)
    .maybeSingle();
  return data ?? null;
}

async function loadNextEarnings(supabase: SupabaseClient, ticker: string) {
  const today = new Date().toISOString().slice(0, 10);
  const { data } = await supabase
    .from('ct_events')
    .select('event_type, event_date, title')
    .eq('event_type', 'earnings')
    .eq('ticker', ticker)
    .gte('event_date', today)
    .order('event_date', { ascending: true })
    .limit(1);
  return data?.[0] ?? null;
}

async function loadRecentOiBuilds(supabase: SupabaseClient, ticker: string) {
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600_000).toISOString().slice(0, 10);
  const { data } = await supabase
    .from('ct_oi_snapshots')
    .select('option_symbol, strike, expiry, side, oi, oi_delta_1d, oi_delta_5d, snap_date, snap_slot')
    .eq('ticker', ticker)
    .gte('snap_date', twoDaysAgo)
    .gt('oi_delta_1d', 10000)
    .order('oi_delta_1d', { ascending: false })
    .limit(10);
  return data ?? [];
}

/**
 * Load aggregate directional imbalance for this ticker via the ct_flow_pulse
 * RPC. 6h window (RTH session) with 30d baseline deviation — shows the
 * specialist the REGIME, not just individual prints. Unusual skew (2x or
 * 0.5x baseline) is one of the strongest floor-level signals.
 */
async function loadFlowPulse(supabase: SupabaseClient, ticker: string) {
  const { data, error } = await supabase.rpc('ct_flow_pulse', {
    p_window_min: 360,
    p_ticker: ticker,
  });
  if (error) {
    console.warn(`[specialistRunner] ${ticker} flow pulse load failed:`, error.message);
    return null;
  }
  const row = Array.isArray(data) ? data[0] : data;
  return (row ?? null) as Record<string, unknown> | null;
}

function formatFlowPulseBlock(ticker: string, row: Record<string, unknown> | null): string {
  if (!row) {
    return `[FLOW PULSE — no directional flow detected in 6h window]`;
  }
  const calls = Number(row.calls_count ?? 0);
  const puts = Number(row.puts_count ?? 0);
  if (calls === 0 && puts === 0) {
    return `[FLOW PULSE — no directional flow detected in 6h window]`;
  }
  const callsOtm = Number(row.calls_otm_count ?? 0);
  const callsItm = Number(row.calls_itm_count ?? 0);
  const putsOtm = Number(row.puts_otm_count ?? 0);
  const putsItm = Number(row.puts_itm_count ?? 0);
  const callsPrem = Number(row.calls_premium ?? 0);
  const putsPrem = Number(row.puts_premium ?? 0);
  const ratio = Number(row.call_put_ratio ?? 0);
  const baseline = row.cp_ratio_baseline_30d === null || row.cp_ratio_baseline_30d === undefined
    ? null
    : Number(row.cp_ratio_baseline_30d);
  const deviation = row.cp_ratio_deviation === null || row.cp_ratio_deviation === undefined
    ? null
    : Number(row.cp_ratio_deviation);
  const premNet = Number(row.premium_net ?? 0);
  const isUnusual = row.is_unusual === true;

  const callsPremM = (callsPrem / 1e6).toFixed(1);
  const putsPremM = (putsPrem / 1e6).toFixed(1);
  const premNetM = (premNet / 1e6);
  const premNetStr = `${premNetM >= 0 ? '+' : ''}${premNetM.toFixed(1)}M`;
  const leanStr = premNetM >= 0 ? 'bullish' : 'bearish';
  const baselineStr = baseline !== null && Number.isFinite(baseline)
    ? `30d baseline ${baseline.toFixed(2)}x`
    : `30d baseline n/a`;
  const deviationStr = deviation !== null && Number.isFinite(deviation)
    ? `${deviation.toFixed(1)}x today`
    : `deviation n/a`;
  const unusualStr = isUnusual
    ? '⚠ UNUSUAL direction skew vs 30d baseline'
    : 'within normal range';

  return [
    `[FLOW PULSE — current ${ticker} directional imbalance, 6h window]`,
    `  Calls: ${calls} prints ($${callsPremM}M) — ${callsOtm} OTM / ${callsItm} ITM`,
    `  Puts:  ${puts} prints ($${putsPremM}M) — ${putsOtm} OTM / ${putsItm} ITM`,
    `  Call:Put ratio = ${ratio.toFixed(2)}x  (${baselineStr} — ${deviationStr})`,
    `  Net premium bias = ${premNetStr} (${leanStr} lean)`,
    `  ${unusualStr}`,
  ].join('\n');
}

/**
 * Load the top overnight OI shifts for this ticker via the ct_top_oi_shifts
 * RPC. Returns the biggest |oi_delta_1d| contracts between yesterday's
 * close and this morning's open, with dollars-at-risk and distance-from-spot.
 * Academic consensus (Lakonishok et al., Augustin et al.): positions held
 * overnight cost margin and reveal conviction in a way intraday flow cannot.
 */
async function loadOvernightPositioning(supabase: SupabaseClient, ticker: string) {
  const { data, error } = await supabase.rpc('ct_top_oi_shifts', {
    p_limit: 10,
    p_ticker: ticker,
  });
  if (error) {
    console.warn(`[specialistRunner] ${ticker} overnight positioning load failed:`, error.message);
    return [];
  }
  return (data ?? []) as Array<Record<string, unknown>>;
}

function formatOvernightPositioningBlock(ticker: string, rows: Array<Record<string, unknown>>): string {
  if (!rows || rows.length === 0) {
    return `[OVERNIGHT POSITIONING — no significant OI shifts detected overnight in ${ticker}]`;
  }
  const lines: string[] = [];
  for (const r of rows) {
    const sideRaw = String(r.side ?? '').toUpperCase();
    const sideCode = sideRaw.startsWith('C') ? 'C' : sideRaw.startsWith('P') ? 'P' : '?';
    const strike = Number(r.strike ?? 0);
    const expiry = String(r.expiry ?? '');
    const expiryShort = expiry.length >= 10 ? expiry.slice(5) : expiry; // MM-DD
    const delta = Number(r.delta_contracts ?? 0);
    const deltaSign = delta > 0 ? `+${delta.toLocaleString()}` : delta.toLocaleString();
    const dollars = Number(r.dollars_at_risk ?? 0);
    const dollarsM = (dollars / 1e6).toFixed(1);
    const distPct = Number(r.distance_from_spot_pct ?? 0);
    const distSign = distPct >= 0 ? `+${distPct.toFixed(1)}` : distPct.toFixed(1);
    lines.push(
      `  - ${sideCode} ${strike} ${expiryShort}: ${deltaSign} OI ($${dollarsM}M, ${distSign}% from spot)`,
    );
  }
  return [
    `[OVERNIGHT POSITIONING — what actually positioned in ${ticker} between yesterday's close and this morning's open]`,
    `Top OI shifts (|Δ1d|):`,
    ...lines,
    `(If delta_contracts > 0 and side=C, that's bullish accumulation. Side=P with +delta is bearish accumulation. Negative delta = unwind.)`,
  ].join('\n');
}

/**
 * Load the last 2 tape-reader commentaries — the floor-level macro narrative
 * synthesized every 10 min during RTH. Specialists need macro anchor:
 * if the reader says "VIX spike, risk-off pivot", a specialist flagging
 * a bullish NVDA breakout should reconcile that against the tide.
 */
async function loadTapeReaderReads(supabase: SupabaseClient) {
  try {
    const { data, error } = await supabase
      .from('ct_tape_commentary')
      .select('created_at, commentary, market_tide, vix_level')
      .order('created_at', { ascending: false })
      .limit(2);
    if (error) {
      console.warn('[specialistRunner] tape reader load failed:', error.message);
      return [];
    }
    return (data ?? []) as Array<Record<string, unknown>>;
  } catch (e) {
    console.warn('[specialistRunner] tape reader load threw:', String(e));
    return [];
  }
}

function relTimeFromNow(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return 'unknown';
  const diffMin = Math.max(0, Math.round((Date.now() - then) / 60_000));
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const h = Math.floor(diffMin / 60);
  const m = diffMin % 60;
  return m === 0 ? `${h}h ago` : `${h}h${m}m ago`;
}

function formatTapeReaderBlock(rows: Array<Record<string, unknown>>): string {
  if (!rows || rows.length === 0) {
    return `[TAPE-READER'S CURRENT READ — no commentary yet this session]`;
  }
  const lines: string[] = [`[TAPE-READER'S CURRENT READ — what the floor-level reader just said]`];
  rows.forEach((r, i) => {
    const rel = relTimeFromNow(String(r.created_at ?? ''));
    const tide = r.market_tide ?? 'n/a';
    const vix = r.vix_level === null || r.vix_level === undefined ? 'n/a' : Number(r.vix_level).toFixed(1);
    const commentary = String(r.commentary ?? '').slice(0, 600);
    const prefix = i === 0 ? rel : `${rel} earlier`;
    lines.push(`${prefix} (market_tide=${tide}, VIX ${vix}): ${commentary}`);
  });
  return lines.join('\n');
}

/**
 * Load flags from peer specialists (other tickers) in the last 60 min.
 * If AMZN just went bearish 3x and META once, NVDA specialist reasoning about
 * a bullish flag should either align with the cross-book or explicitly justify
 * the divergence. This is the "what are my siblings seeing" signal.
 */
async function loadPeerFlags(supabase: SupabaseClient, ticker: string) {
  try {
    const cutoff = new Date(Date.now() - 60 * 60_000).toISOString();
    const { data, error } = await supabase
      .from('ct_flags')
      .select('specialist_ticker, direction, score, thesis, created_at')
      .neq('specialist_ticker', ticker)
      .gte('created_at', cutoff)
      .order('created_at', { ascending: false })
      .limit(10);
    if (error) {
      console.warn(`[specialistRunner] ${ticker} peer flags load failed:`, error.message);
      return [];
    }
    return (data ?? []) as Array<Record<string, unknown>>;
  } catch (e) {
    console.warn(`[specialistRunner] ${ticker} peer flags load threw:`, String(e));
    return [];
  }
}

function formatPeerFlagsBlock(rows: Array<Record<string, unknown>>): string {
  if (!rows || rows.length === 0) {
    return `[PEER SPECIALIST FLAGS — no peer flags in last 60 min]`;
  }
  const lines: string[] = [`[PEER SPECIALIST FLAGS — other tickers last 60 min]`];
  for (const r of rows) {
    const tk = String(r.specialist_ticker ?? '?');
    const dir = String(r.direction ?? '?');
    const score = r.score === null || r.score === undefined ? '?' : String(r.score);
    const thesisShort = String(r.thesis ?? '').slice(0, 80);
    lines.push(`  ${tk} ${dir} ${score}: ${thesisShort}`);
  }
  lines.push(`(If peers are heavily one-direction today, note whether your read aligns or diverges and why.)`);
  return lines.join('\n');
}

/**
 * Load the current Lean score for this ticker — the pre-computed composite
 * over flow + walls + news + OI momentum + IV. Specialist's flag direction
 * should be consistent with this Lean OR have a thesis justifying contrarian.
 */
async function loadTickerLean(supabase: SupabaseClient, ticker: string) {
  try {
    const { data, error } = await supabase
      .from('ct_ticker_lean_score')
      .select('ticker, score, lean, confidence, momentum_delta, breakdown, score_at')
      .eq('ticker', ticker)
      .order('score_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      console.warn(`[specialistRunner] ${ticker} lean score load failed:`, error.message);
      return null;
    }
    return (data ?? null) as Record<string, unknown> | null;
  } catch (e) {
    console.warn(`[specialistRunner] ${ticker} lean score load threw:`, String(e));
    return null;
  }
}

function formatLeanScoreBlock(ticker: string, row: Record<string, unknown> | null): string {
  if (!row) {
    return `[YOUR TICKER'S LEAN SCORE — no composite score yet for ${ticker}]`;
  }
  const score = row.score === null || row.score === undefined ? 'n/a' : Number(row.score).toFixed(1);
  const lean = row.lean ?? 'n/a';
  const conf = row.confidence ?? 'n/a';
  const delta = row.momentum_delta === null || row.momentum_delta === undefined
    ? 'n/a'
    : (Number(row.momentum_delta) >= 0 ? `+${Number(row.momentum_delta).toFixed(1)}` : Number(row.momentum_delta).toFixed(1));

  // Breakdown: each key has a .contribution number.
  const b = (row.breakdown ?? {}) as Record<string, { contribution?: number | null } | null>;
  const cmp = (k: string) => {
    const v = b?.[k]?.contribution;
    return v === null || v === undefined || !Number.isFinite(Number(v)) ? 'n/a' : Number(v).toFixed(1);
  };

  return [
    `[YOUR TICKER'S LEAN SCORE — pre-computed composite (flow + walls + news + oi + iv)]`,
    `${ticker}: Lean ${score}/100 · ${lean} · confidence ${conf} · momentum ${delta} vs 3h ago`,
    `Breakdown: flow ${cmp('flow')}, specialist ${cmp('specialist')}, news ${cmp('news')}, walls ${cmp('walls')}, oi_momentum ${cmp('oi_momentum')}, iv ${cmp('iv')}`,
    `(Your flag direction should be CONSISTENT with this Lean OR have a thesis explaining why you're contrarian.)`,
  ].join('\n');
}

/**
 * Load recent news affecting this ticker from ct_breaking_news (Tavily
 * sweep + macro watcher). Last 6 hours, severity >= 2 OR tagged for this
 * ticker. News moves stocks; options front-run news — specialists need
 * to see the catalyst backdrop when proposing flags.
 */
async function loadRecentNews(supabase: SupabaseClient, ticker: string) {
  const sixHoursAgo = new Date(Date.now() - 6 * 3600_000).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (supabase.from('ct_breaking_news' as never) as any)
    .select('headline,source,severity,sentiment,category,macro_wide,summary,tickers_affected,ingested_at,published_at')
    .gte('ingested_at', sixHoursAgo)
    .order('ingested_at', { ascending: false })
    .limit(50);
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  // Keep rows that mention this ticker OR are macro-wide (affect all watchlist).
  return rows
    .filter((r) => {
      const tickers = (r.tickers_affected as string[] | null) ?? [];
      return tickers.includes(ticker) || r.macro_wide === true;
    })
    .slice(0, 8)
    .map((r) => ({
      headline: r.headline,
      source: r.source,
      severity: r.severity,
      sentiment: r.sentiment,
      category: r.category,
      macro_wide: r.macro_wide,
      summary: r.summary,
      ingested_at: r.ingested_at,
    }));
}

async function loadSpecialistMemory(supabase: SupabaseClient, ticker: string) {
  // Last 10 graded flags for this specialist joined with grades. We fetch the
  // grades and pull each flag inline rather than relying on a Postgres join —
  // Supabase's implicit fk-join needs a named FK we can't guarantee yet.
  const { data: grades } = await supabase
    .from('ct_flag_grades')
    .select('flag_id, outcome, alpha_pct, price_change_pct, graded_at, notes')
    .eq('specialist_ticker', ticker)
    .order('graded_at', { ascending: false })
    .limit(10);

  if (!grades || grades.length === 0) return [];

  const flagIds = grades.map(g => g.flag_id).filter(Boolean);
  if (flagIds.length === 0) return [];

  const { data: flags } = await supabase
    .from('ct_flags')
    .select('id, direction, tags, thesis, horizon_hours, score')
    .in('id', flagIds);

  const flagMap = new Map<string, Record<string, unknown>>();
  for (const f of (flags ?? [])) {
    flagMap.set(f.id as string, f as Record<string, unknown>);
  }

  return grades.map(g => {
    const f = flagMap.get(g.flag_id as string);
    return {
      outcome: g.outcome,
      alpha_pct: g.alpha_pct,
      price_change_pct: g.price_change_pct,
      graded_at: g.graded_at,
      direction: f?.direction ?? null,
      tags: f?.tags ?? [],
      thesis_slice: typeof f?.thesis === 'string' ? (f.thesis as string).slice(0, 240) : null,
      horizon_hours: f?.horizon_hours ?? null,
      score: f?.score ?? null,
    };
  });
}

async function loadHitRateByTag(supabase: SupabaseClient, ticker: string) {
  const { data } = await supabase
    .from('ct_flag_patterns')
    .select('signature_hash, signature, n_observations, n_wins, n_partials, n_losses, hit_rate, avg_alpha_pct')
    .eq('specialist_ticker', ticker)
    .gte('n_observations', 3)
    .order('hit_rate', { ascending: false })
    .limit(10);
  return data ?? [];
}

async function isWithinCooldown(
  supabase: SupabaseClient,
  ticker: string,
  cooldownMinutes: number,
): Promise<boolean> {
  const cutoff = new Date(Date.now() - cooldownMinutes * 60_000).toISOString();
  const { data, error } = await supabase
    .from('ct_flags')
    .select('id')
    .eq('specialist_ticker', ticker)
    .gte('created_at', cutoff)
    .limit(1);
  if (error) {
    console.warn('[specialistRunner] cooldown check failed:', error.message);
    return false;
  }
  return (data?.length ?? 0) > 0;
}

async function countFlagsWrittenToday(
  supabase: SupabaseClient,
  ticker: string,
): Promise<number> {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const { count, error } = await supabase
    .from('ct_flags')
    .select('id', { count: 'exact', head: true })
    .eq('specialist_ticker', ticker)
    .gte('created_at', startOfDay.toISOString());
  if (error) {
    console.warn('[specialistRunner] daily-cap count failed:', error.message);
    return 0;
  }
  return count ?? 0;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runSpecialistWakeup(
  args: SpecialistWakeupArgs,
): Promise<SpecialistWakeupResult> {
  const started = Date.now();
  const { supabase, ticker, reason, forcedEventIds } = args;

  const baseResult: Omit<SpecialistWakeupResult, 'ok'> = {
    ticker,
    reason,
    events_considered: 0,
    flags_written: 0,
    flag_ids: [],
    cost_usd: 0,
    elapsed_ms: 0,
  };

  // 1. Kill-switch.
  if (await isKillSwitchActive(supabase)) {
    return {
      ...baseResult,
      ok: false,
      skip_reason: 'kill_switch',
      elapsed_ms: Date.now() - started,
    };
  }

  // 2-4. Load per-ticker config.
  const prompt = await getConfigValue<string>(
    supabase,
    `specialist.${ticker}.prompt`,
    GENERIC_PROMPT_FALLBACK,
  );
  const wakeupThreshold = Number(await getConfigValue<number>(
    supabase,
    `specialist.${ticker}.wakeup_threshold`,
    DEFAULT_WAKEUP_THRESHOLD,
  )) || DEFAULT_WAKEUP_THRESHOLD;
  const cooldownMinutes = Number(await getConfigValue<number>(
    supabase,
    'specialist.cooldown_minutes',
    DEFAULT_COOLDOWN_MIN,
  )) || DEFAULT_COOLDOWN_MIN;
  const maxFlagsPerDay = Number(await getConfigValue<number>(
    supabase,
    `specialist.${ticker}.max_flags_per_day`,
    DEFAULT_MAX_FLAGS_PER_DAY,
  )) || DEFAULT_MAX_FLAGS_PER_DAY;

  // 5. Cooldown (skipped for manual).
  if (reason !== 'manual' && await isWithinCooldown(supabase, ticker, cooldownMinutes)) {
    return {
      ...baseResult,
      ok: true,
      skip_reason: 'cooldown',
      elapsed_ms: Date.now() - started,
    };
  }

  // 6. Candidate events.
  const events = await loadCandidateEvents(supabase, ticker, wakeupThreshold, forcedEventIds);
  baseResult.events_considered = events.length;

  if (events.length === 0) {
    return {
      ...baseResult,
      ok: true,
      skip_reason: 'no_events',
      elapsed_ms: Date.now() - started,
    };
  }

  // 13. Daily cap (checked early, before the Claude spend).
  const flagsToday = await countFlagsWrittenToday(supabase, ticker);
  if (flagsToday >= maxFlagsPerDay) {
    return {
      ...baseResult,
      ok: true,
      skip_reason: 'daily_cap',
      elapsed_ms: Date.now() - started,
    };
  }

  // 8-12. Context for Claude.
  const [snapshot, nextEarnings, oiBuilds, memory, hitRate, news, overnight, flowPulse, tapeReads, peerFlags, leanScore] = await Promise.all([
    loadTickerSnapshot(supabase, ticker),
    loadNextEarnings(supabase, ticker),
    loadRecentOiBuilds(supabase, ticker),
    loadSpecialistMemory(supabase, ticker),
    loadHitRateByTag(supabase, ticker),
    loadRecentNews(supabase, ticker),
    loadOvernightPositioning(supabase, ticker),
    loadFlowPulse(supabase, ticker),
    loadTapeReaderReads(supabase),
    loadPeerFlags(supabase, ticker),
    loadTickerLean(supabase, ticker),
  ]);

  const overnightBlock = formatOvernightPositioningBlock(ticker, overnight);
  const flowPulseBlock = formatFlowPulseBlock(ticker, flowPulse);
  const tapeReaderBlock = formatTapeReaderBlock(tapeReads);
  const peerFlagsBlock = formatPeerFlagsBlock(peerFlags);
  const leanScoreBlock = formatLeanScoreBlock(ticker, leanScore);

  const tickerContext = {
    ticker,
    spot: snapshot?.spot ?? null,
    iv_rank: snapshot?.iv_rank ?? null,
    gamma_flip: snapshot?.gamma_flip ?? null,
    call_wall: snapshot?.call_wall ?? null,
    put_wall: snapshot?.put_wall ?? null,
    net_gamma: snapshot?.net_gamma ?? null,
    regime: snapshot?.regime ?? null,
    next_earnings_date: nextEarnings?.event_date ?? snapshot?.next_earnings_date ?? null,
    earnings_title: nextEarnings?.title ?? null,
  };

  const userPayload = `[TICKER CONTEXT]
${JSON.stringify(tickerContext, null, 2)}

${tapeReaderBlock}

${leanScoreBlock}

${flowPulseBlock}

${overnightBlock}

${peerFlagsBlock}

[RECENT NEWS — last 6h affecting ${ticker} or macro-wide, Tavily + UW]
${JSON.stringify(news, null, 2)}

[YOUR LAST 10 GRADED FLAGS]
${JSON.stringify(memory, null, 2)}

[YOUR HIT RATE BY PATTERN SIGNATURE]
${JSON.stringify(hitRate, null, 2)}

[RECENT OI BUILDS — last 2 days, delta_1d > 10k]
${JSON.stringify(oiBuilds, null, 2)}

[CANDIDATE FLOW EVENTS — last ${CANDIDATE_WINDOW_MIN}min, score >= ${wakeupThreshold}]
${JSON.stringify(events, null, 2)}

[WAKEUP REASON] ${reason}
[FLAGS WRITTEN TODAY] ${flagsToday} / cap ${maxFlagsPerDay}

Decide: 0-3 flags OR pass cleanly. Return JSON only:
{
  "flags": [
    { "option_symbol": "...", "direction": "bullish|bearish|neutral", "tags": [...],
      "thesis": "...", "invalidation": "...", "horizon_hours": 48,
      "target_price": 185.5, "score": 72 }
  ],
  "pass_reason": null | "why you passed"
}`;

  // 14. Claude call (Haiku).
  const model = CLAUDE_MODELS.haiku;
  const claudeStart = Date.now();
  let claudeRes: Awaited<ReturnType<typeof callClaude>> | null = null;
  let responseText = '';
  try {
    claudeRes = await callClaude({
      model,
      system: `${prompt}${CROSS_FACET_PROMPT_SUFFIX}`,
      messages: [{ role: 'user', content: userPayload }],
      max_tokens: 2000,
      temperature: 0.2,
    });
    responseText = parseTextContent(claudeRes).trim();
  } catch (e) {
    const detail = e instanceof ClaudeError ? `Claude ${e.status}: ${e.message}` : String(e);
    console.error(`[specialistRunner] ${ticker} Claude call failed:`, detail);
    return {
      ...baseResult,
      ok: false,
      skip_reason: 'claude_error',
      error: detail.slice(0, 400),
      elapsed_ms: Date.now() - started,
    };
  }

  // Cost logging — fire-and-forget.
  const usage = claudeRes?.usage ?? null;
  const tokensIn = usage?.input_tokens ?? 0;
  const tokensOut = usage?.output_tokens ?? 0;
  const costUsd = Number((((tokensIn / 1_000_000) * 0.80) + ((tokensOut / 1_000_000) * 4.0)).toFixed(6));
  logClaudeUsage(supabase, {
    source: `ct-specialist-${ticker}`,
    model,
    usage,
    duration_ms: Date.now() - claudeStart,
    metadata: { reason, events_considered: events.length },
  });

  baseResult.cost_usd = costUsd;

  // 15. Parse.
  const parsed = parseClaudeVerdict(responseText);
  if ('error' in parsed) {
    console.warn(`[specialistRunner] ${ticker} parse error:`, parsed.error, 'raw:', responseText.slice(0, 400));
    return {
      ...baseResult,
      ok: false,
      skip_reason: 'parse_error',
      error: parsed.error,
      elapsed_ms: Date.now() - started,
    };
  }

  // 16. Insert flags.
  // ct_scored_flow.id is bigint; ct_flags.source_flow_ids is BIGINT[] (retyped
  // in migration 20260423000035). Keep numeric — don't coerce to string.
  const sourceFlowIds = events
    .map(e => (typeof e.id === 'number' ? e.id : Number(e.id)))
    .filter(n => Number.isFinite(n)) as number[];
  const topEvent = events[0];
  const entryPrice = snapshot?.spot ?? null;

  const writtenIds: string[] = [];

  if (parsed.flags.length === 0) {
    // Clean pass — journal it and return.
    await recordDecision(supabase, {
      decision_type: 'no_trade',
      model_tier: 'haiku',
      reasoning: `specialist.${ticker} wakeup: ${parsed.pass_reason ?? 'no pass_reason given'}`,
      outcome: 'no_flag',
      context_snapshot: {
        ticker,
        reason,
        events_considered: events.length,
        wakeup_threshold: wakeupThreshold,
      },
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      cost_usd: costUsd,
    });
    return {
      ...baseResult,
      ok: true,
      skip_reason: 'passed',
      elapsed_ms: Date.now() - started,
    };
  }

  for (const decision of parsed.flags) {
    // Flag score: Claude's self-assigned score wins, else top event's score,
    // else average of the event scores. Clamped to [0,100].
    let score = typeof decision.score === 'number' && Number.isFinite(decision.score)
      ? decision.score
      : (typeof topEvent?.score === 'number' ? Number(topEvent.score) : 0);
    const avgEventScore = events.length > 0
      ? events.reduce((acc, e) => acc + (Number(e.score) || 0), 0) / events.length
      : 0;
    if (!score || score <= 0) score = avgEventScore;
    score = Math.max(0, Math.min(100, Math.round(score)));

    // Direction → option side mapping (for reference, not enforced — Claude
    // may flag a put ticket on a bearish thesis).
    const scoreBreakdown = topEvent?.score_breakdown ?? null;

    // Parse option_symbol → strike + expiry + side if matches OCC pattern.
    const occMatch = decision.option_symbol?.match(/^([A-Z.]+)(\d{6})([CP])(\d{8})$/);
    let strike: number | null = null;
    let expiry: string | null = null;
    let side: 'call' | 'put' | null = null;
    if (occMatch) {
      const yy = occMatch[2].slice(0, 2);
      const mm = occMatch[2].slice(2, 4);
      const dd = occMatch[2].slice(4, 6);
      expiry = `20${yy}-${mm}-${dd}`;
      side = occMatch[3] === 'C' ? 'call' : 'put';
      strike = Number(occMatch[4]) / 1000;
    }

    const row = {
      specialist_ticker: ticker,
      instrument: ticker,
      option_symbol: decision.option_symbol ?? null,
      strike,
      expiry,
      side,
      direction: decision.direction,
      score,
      score_breakdown: scoreBreakdown,
      tags: decision.tags,
      thesis: decision.thesis,
      invalidation: decision.invalidation,
      horizon_hours: decision.horizon_hours,
      entry_price: entryPrice,
      target_price: decision.target_price,
      status: 'active',
      source_flow_ids: sourceFlowIds.length > 0 ? sourceFlowIds : null,
    };

    const { data: inserted, error: insErr } = await supabase
      .from('ct_flags')
      .insert(row)
      .select('id')
      .single();

    if (insErr || !inserted) {
      console.error(`[specialistRunner] ${ticker} flag insert failed:`, insErr?.message);
      continue;
    }
    const flagId = inserted.id as string;
    writtenIds.push(flagId);

    // Journal one decision per flag. Note: we do NOT set linked_trade_idea_id
    // — that column's FK still points at the legacy ct_trade_ideas table, not
    // v2 ct_flags. Flag ID is preserved in outcome + context_snapshot.
    await recordDecision(supabase, {
      decision_type: 'arm_trade_idea',
      model_tier: 'haiku',
      reasoning: decision.thesis,
      outcome: `flag:${flagId}`,
      context_snapshot: {
        ticker,
        reason,
        flag_id: flagId,
        events_considered: events.length,
        wakeup_threshold: wakeupThreshold,
        score,
        direction: decision.direction,
        tags: decision.tags,
        horizon_hours: decision.horizon_hours,
      },
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      cost_usd: costUsd,
    });
  }

  return {
    ok: true,
    ticker,
    reason,
    events_considered: events.length,
    flags_written: writtenIds.length,
    flag_ids: writtenIds,
    cost_usd: costUsd,
    elapsed_ms: Date.now() - started,
  };
}
