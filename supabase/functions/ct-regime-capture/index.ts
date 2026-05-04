/**
 * ct-regime-capture — Pulse v2 producer.
 *
 * Fired every 5 min RTH + hourly off-hours. For each ticker (watchlist + a
 * market-wide NULL row) it:
 *   1. Computes regime signals (momentum, breadth, trajectory, dispersion,
 *      duration, macro_proximity) over the current 5-min bucket.
 *   2. UPSERTs ct_regime_signals on (ticker, bucket_ts) NULLS NOT DISTINCT.
 *   3. Classifies via active ct_regime_config rules (priority DESC, first match).
 *   4. UPSERTs ct_regime_classifications.
 *   5. Builds rich_text + voyageEmbed -> 512-dim vector.
 *   6. INSERTs into ct_regime_history (append-only).
 *
 * Defensive:
 *   - voyage failure -> INSERT history row with embedded_state=NULL + warn log
 *     (warden invariant `regime_embedding_present` will catch >5% NULL rate).
 *   - Per-ticker errors don't block other tickers (try/catch per loop iter).
 *   - Idempotent on re-fire within same 5-min bucket (UPSERT semantics).
 *     History gets a fresh row each fire — append-only is the design.
 *
 * Tenets: 24 (cross-component), 25 (rules are rows, not code), 13 (structural).
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { getWatchlist } from '../_shared/watchlist.ts';
import { voyageEmbed } from '../_shared/ctEmbed.ts';

// ---------------------------------------------------------------------------
// Constants — windows + scaling
// ---------------------------------------------------------------------------
const BUCKET_MINUTES = 5;
const MOMENTUM_WINDOW_MINUTES = 30;
const MOMENTUM_NORMALIZER = 1_000_000; // $1M scaling -> usually -5..+5
const MACRO_LOOKAHEAD_DAYS = 3;
const MARKET_WIDE_KEY = '__MARKET__'; // sentinel for in-memory keying only

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type Trajectory = 'accelerating' | 'steady' | 'decaying';

interface MacroProximity {
  fomc_days: number | null;
  cpi_days: number | null;
  jobs_days: number | null;
  earnings_clusters: Array<{ ticker: string; days: number }>;
}

interface RegimeSignal {
  ticker: string | null; // NULL = market-wide
  bucket_ts: string;
  momentum: number | null;
  breadth: number | null;
  trajectory: Trajectory;
  dispersion: number | null;
  duration_minutes: number;
  macro_proximity: MacroProximity;
}

interface ConfigRule {
  classification_name: string;
  signal_thresholds: Record<string, unknown>;
  priority: number;
  active: boolean;
  description: string | null;
}

interface ClassificationResult {
  classification: string;
  confidence: number;
  config_priority: number | null;
  rationale: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Bucket helpers
// ---------------------------------------------------------------------------
function roundDownToBucket(d: Date, minutes: number): Date {
  const ms = minutes * 60 * 1000;
  return new Date(Math.floor(d.getTime() / ms) * ms);
}

function bucketBefore(bucket: Date, stepsBack: number, minutes: number): Date {
  return new Date(bucket.getTime() - stepsBack * minutes * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Momentum + breadth from ct_pulse_events
// ---------------------------------------------------------------------------
// ct_pulse_events.direction is SMALLINT (+1 / 0 / -1). usd_weight is nullable —
// news/insider/congress events typically have no dollar-volume context, so we
// fall back to base_weight × magnitude_mult (the canonical "signal weight"
// Pulse v1's ct_pulse_timeline already uses for non-flow signals).
interface PulseEventRow {
  ticker: string;
  event_ts: string;
  direction: number | null;
  usd_weight: number | null;
  base_weight: number | null;
  magnitude_mult: number | null;
}

async function fetchPulseEvents(
  supabase: SupabaseClient,
  watchlist: string[],
  fromTs: Date,
  toTs: Date,
): Promise<PulseEventRow[]> {
  const { data, error } = await supabase
    .from('ct_pulse_events')
    .select('ticker, event_ts, direction, usd_weight, base_weight, magnitude_mult')
    .in('ticker', watchlist)
    .gte('event_ts', fromTs.toISOString())
    .lt('event_ts', toTs.toISOString());
  if (error) {
    console.warn('[regime-capture] pulse_events fetch error:', error.message);
    return [];
  }
  return (data ?? []) as PulseEventRow[];
}

/**
 * Net momentum for a ticker = sum(signed weight) / NORMALIZER over events
 * within [fromTs, toTs). Weight = usd_weight when present (flow events),
 * else base_weight * magnitude_mult * SIGNAL_WEIGHT_SCALE (news / insider /
 * congress / claude_alert events that have no dollar context). direction is
 * SMALLINT (+1/0/-1) per ct_pulse_events schema. Returns null if no events.
 */
const SIGNAL_WEIGHT_SCALE = 100_000;  // 0.3 * 1.0 → $30k-equivalent for a base news event

function computeMomentum(
  events: PulseEventRow[],
  ticker: string | null,
): number | null {
  const filtered = ticker === null
    ? events
    : events.filter((e) => e.ticker === ticker);
  if (filtered.length === 0) return null;
  let sum = 0;
  for (const e of filtered) {
    const dir = Number(e.direction);
    if (!Number.isFinite(dir) || dir === 0) continue;
    const sign = dir > 0 ? 1 : -1;
    let w = Number(e.usd_weight);
    if (!Number.isFinite(w) || w === 0) {
      // Fall back to signal weight (base * magnitude) scaled to dollar-equivalent.
      const bw = Number(e.base_weight ?? 0);
      const mm = Number(e.magnitude_mult ?? 1);
      w = bw * mm * SIGNAL_WEIGHT_SCALE;
    }
    if (!Number.isFinite(w)) continue;
    sum += sign * w;
  }
  return sum / MOMENTUM_NORMALIZER;
}

/**
 * Breadth = fraction of watchlist tickers with positive net momentum in window.
 * Only meaningful market-wide.
 */
function computeBreadth(events: PulseEventRow[], watchlist: string[]): number {
  let advancers = 0;
  let countedWithEvents = 0;
  for (const t of watchlist) {
    const m = computeMomentum(events, t);
    if (m === null) continue;
    countedWithEvents += 1;
    if (m > 0) advancers += 1;
  }
  if (countedWithEvents === 0) return 0;
  return advancers / countedWithEvents;
}

/**
 * Dispersion = stddev of per-ticker momentum across watchlist.
 * Tickers with NULL momentum (no events) are skipped. Returns null if <2.
 */
function computeDispersion(events: PulseEventRow[], watchlist: string[]): number | null {
  const xs: number[] = [];
  for (const t of watchlist) {
    const m = computeMomentum(events, t);
    if (m !== null) xs.push(m);
  }
  if (xs.length < 2) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((acc, x) => acc + (x - mean) * (x - mean), 0) / xs.length;
  return Math.sqrt(variance);
}

// ---------------------------------------------------------------------------
// Trajectory + duration — needs prior bucket signals
// ---------------------------------------------------------------------------
interface PriorSignalRow {
  ticker: string | null;
  bucket_ts: string;
  momentum: number | null;
  trajectory: Trajectory | null;
  duration_minutes: number | null;
}

/**
 * trajectory rules:
 *   - need momentum at t (current), t-1 (5min ago), t-2 (10min ago)
 *   - 'accelerating': |m_t| > |m_t1| AND sign(m_t) == sign(m_t1) (intensifying same direction)
 *   - 'decaying':     |m_t| < |m_t1| (reverting toward zero)
 *   - 'steady':       otherwise (or insufficient history)
 *   - sign-flip: treated as 'accelerating' in the new direction iff |m_t| > |m_t1|
 */
function computeTrajectory(
  mNow: number | null,
  mPrev1: number | null,
  _mPrev2: number | null,
): Trajectory {
  if (mNow === null || mPrev1 === null) return 'steady';
  const aNow = Math.abs(mNow);
  const aPrev = Math.abs(mPrev1);
  // Sign flip: if magnitude grew, that's accelerating in the new direction
  if (Math.sign(mNow) !== Math.sign(mPrev1) && Math.sign(mNow) !== 0) {
    return aNow > aPrev ? 'accelerating' : 'decaying';
  }
  if (aNow > aPrev * 1.05) return 'accelerating'; // 5% buffer to avoid jitter
  if (aNow < aPrev * 0.95) return 'decaying';
  return 'steady';
}

/**
 * Duration: scan back through prior signals; count minutes since trajectory
 * last differed from current. If prior chain has same trajectory N buckets,
 * duration = N * BUCKET_MINUTES.
 */
function computeDuration(
  currentTrajectory: Trajectory,
  priorRows: PriorSignalRow[], // ordered DESC by bucket_ts (most recent first)
): number {
  let mins = 0;
  for (const r of priorRows) {
    if (r.trajectory !== currentTrajectory) break;
    mins += BUCKET_MINUTES;
  }
  return mins;
}

// ---------------------------------------------------------------------------
// Macro proximity
// ---------------------------------------------------------------------------
interface EventRow {
  event_type: string;
  ticker: string | null;
  event_date: string;
  title?: string | null;
}

/**
 * Pull near-term events. ct_events.event_type IN ('earnings','fda','econ').
 * Macro = econ events whose title hints FOMC/CPI/Jobs.
 * Earnings clusters = upcoming earnings within MACRO_LOOKAHEAD_DAYS for watchlist.
 */
async function fetchUpcomingEvents(
  supabase: SupabaseClient,
  watchlist: string[],
  now: Date,
): Promise<EventRow[]> {
  const horizon = new Date(now.getTime() + MACRO_LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000);
  const { data, error } = await supabase
    .from('ct_events')
    .select('event_type, ticker, event_date, title')
    .gte('event_date', now.toISOString().slice(0, 10))
    .lte('event_date', horizon.toISOString().slice(0, 10));
  if (error) {
    console.warn('[regime-capture] ct_events fetch error:', error.message);
    return [];
  }
  const rows = (data ?? []) as EventRow[];
  // Per-ticker filter on earnings; macro events are global
  return rows.filter((r) => {
    if (r.event_type === 'econ' || r.event_type === 'fda') return true;
    if (r.event_type === 'earnings') {
      return r.ticker !== null && watchlist.includes(r.ticker);
    }
    return false;
  });
}

function daysUntil(now: Date, eventDateStr: string): number | null {
  // Returns signed days from today → event_date. null if the event is in the
  // past — past events are not "upcoming proximity," they're history. Earlier
  // version clamped negatives to 0 which made last week's FOMC eternally read
  // as "today" and triggered pre_event_macro forever.
  const evt = new Date(`${eventDateStr}T00:00:00Z`);
  const today = new Date(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  const ms = evt.getTime() - today.getTime();
  const days = Math.round(ms / (24 * 60 * 60 * 1000));
  return days < 0 ? null : days;
}

// Strict: a market-moving FOMC event is the meeting itself, the post-decision
// statement/presser (same date as the meeting), or the minutes release.
// Random Fed governor speeches in foreign cities are NOT FOMC events.
function isFomcEvent(title: string): boolean {
  return title.includes('fomc') || title.includes('interest-rate decision');
}

function buildMacroProximity(
  events: EventRow[],
  ticker: string | null,
  now: Date,
): MacroProximity {
  let fomc: number | null = null;
  let cpi: number | null = null;
  let jobs: number | null = null;
  const earningsClusters: Array<{ ticker: string; days: number }> = [];

  for (const e of events) {
    const days = daysUntil(now, e.event_date);
    if (days === null) continue;  // skip past events
    if (e.event_type === 'econ') {
      const title = (e.title ?? '').toLowerCase();
      if (isFomcEvent(title)) {
        fomc = fomc === null ? days : Math.min(fomc, days);
      } else if (title.includes('cpi') || title.includes('inflation')) {
        cpi = cpi === null ? days : Math.min(cpi, days);
      } else if (title.includes('jobs report') || title.includes('payroll') || title.includes('nfp') || title.includes('unemployment rate')) {
        jobs = jobs === null ? days : Math.min(jobs, days);
      }
    } else if (e.event_type === 'earnings' && e.ticker) {
      // For per-ticker rows, only this ticker. For market-wide, all watchlist earnings.
      if (ticker === null || e.ticker === ticker) {
        earningsClusters.push({ ticker: e.ticker, days });
      }
    }
  }

  return { fomc_days: fomc, cpi_days: cpi, jobs_days: jobs, earnings_clusters: earningsClusters };
}

// ---------------------------------------------------------------------------
// Classification — match signals to active config rules
// ---------------------------------------------------------------------------
interface RuleMatch {
  matched: boolean;
  // 0..1, where 1 == well within all thresholds, 0 == on the boundary
  strength: number;
  reasons: string[];
}

function evaluateRule(rule: ConfigRule, sig: RegimeSignal): RuleMatch {
  const t = rule.signal_thresholds;
  const reasons: string[] = [];
  // We compute "slack" — how comfortably we cleared each threshold.
  // strength = mean of clamped slacks; only counted thresholds contribute.
  const slacks: number[] = [];

  // Macro gate — if the rule requires macro proximity, must satisfy
  const macroAny = t.macro_proximity_any as string[] | undefined;
  const macroMaxDays = t.macro_proximity_max_days as number | undefined;
  if (Array.isArray(macroAny)) {
    const mp = sig.macro_proximity;
    const cap = typeof macroMaxDays === 'number' ? macroMaxDays : 2;
    let hit = false;
    for (const k of macroAny) {
      const v = k === 'fomc' ? mp.fomc_days
        : k === 'cpi' ? mp.cpi_days
        : k === 'jobs' ? mp.jobs_days
        : null;
      if (v !== null && v <= cap) { hit = true; break; }
    }
    if (!hit) return { matched: false, strength: 0, reasons: ['macro_proximity_any not satisfied'] };
    reasons.push('macro_proximity_any satisfied');
    slacks.push(1.0);
  }

  // breadth is structurally null for per-ticker rows (can't compute breadth
  // across 1 ticker). Skip null-fail when constraint applies to a per-ticker
  // row's breadth. dispersion is also per-ticker-null but is intentionally
  // left enforced — high vs low dispersion is a MARKET-scope concept;
  // per-ticker rows route to chop_neutral / trending / breaking rules that
  // don't reference dispersion. See ct_regime_config row 'chop_neutral'.
  const isPerTicker = sig.ticker !== null;
  const skipNullForPerTicker = (label: string) =>
    isPerTicker && label === 'breadth';

  // Numeric range thresholds
  const checkRange = (
    label: string,
    value: number | null,
    minKey: string,
    maxKey: string,
  ): RuleMatch | null => {
    const min = t[minKey] as number | undefined;
    const max = t[maxKey] as number | undefined;
    if (min === undefined && max === undefined) return null; // not constrained
    if (value === null) {
      if (skipNullForPerTicker(label)) return null; // structurally null at per-ticker scope
      return { matched: false, strength: 0, reasons: [`${label} is null but constrained`] };
    }
    if (typeof min === 'number' && value < min) {
      return { matched: false, strength: 0, reasons: [`${label}=${value.toFixed(2)} < ${minKey}=${min}`] };
    }
    if (typeof max === 'number' && value > max) {
      return { matched: false, strength: 0, reasons: [`${label}=${value.toFixed(2)} > ${maxKey}=${max}`] };
    }
    // Compute slack: distance from nearest boundary, normalized to a soft scale
    let slack = 1.0;
    if (typeof min === 'number' && typeof max === 'number') {
      const mid = (min + max) / 2;
      const half = Math.max(1e-6, (max - min) / 2);
      slack = Math.max(0, 1 - Math.abs(value - mid) / half);
    } else if (typeof min === 'number') {
      slack = Math.min(1, Math.max(0, (value - min) / Math.max(0.5, Math.abs(min) + 0.5)));
    } else if (typeof max === 'number') {
      slack = Math.min(1, Math.max(0, (max - value) / Math.max(0.5, Math.abs(max) + 0.5)));
    }
    slacks.push(slack);
    reasons.push(`${label}=${value.toFixed(2)} in range`);
    return null;
  };

  for (const fail of [
    checkRange('momentum',  sig.momentum,        'momentum_min',   'momentum_max'),
    checkRange('breadth',   sig.breadth,         'breadth_min',    'breadth_max'),
    checkRange('dispersion', sig.dispersion,     'dispersion_min', 'dispersion_max'),
  ]) {
    if (fail) return fail;
  }

  // Trajectory
  const trajIn = t.trajectory_in as string[] | undefined;
  if (Array.isArray(trajIn)) {
    if (!trajIn.includes(sig.trajectory)) {
      return { matched: false, strength: 0, reasons: [`trajectory=${sig.trajectory} not in [${trajIn.join(',')}]`] };
    }
    reasons.push(`trajectory=${sig.trajectory} matched`);
    slacks.push(1.0);
  }

  // Duration
  const durMin = t.duration_min_minutes as number | undefined;
  const durMax = t.duration_max_minutes as number | undefined;
  if (durMin !== undefined || durMax !== undefined) {
    if (typeof durMin === 'number' && sig.duration_minutes < durMin) {
      return { matched: false, strength: 0, reasons: [`duration=${sig.duration_minutes} < ${durMin}`] };
    }
    if (typeof durMax === 'number' && sig.duration_minutes > durMax) {
      return { matched: false, strength: 0, reasons: [`duration=${sig.duration_minutes} > ${durMax}`] };
    }
    slacks.push(1.0);
    reasons.push(`duration=${sig.duration_minutes}min in range`);
  }

  const strength = slacks.length > 0 ? slacks.reduce((a, b) => a + b, 0) / slacks.length : 0.5;
  return { matched: true, strength, reasons };
}

function classify(rules: ConfigRule[], sig: RegimeSignal): ClassificationResult {
  // Priority DESC, first match wins.
  const sorted = [...rules].sort((a, b) => b.priority - a.priority);
  for (const r of sorted) {
    if (!r.active) continue;
    const m = evaluateRule(r, sig);
    if (!m.matched) continue;
    // Confidence: 60 baseline + 40 * strength, clamp 0..100
    const conf = Math.max(0, Math.min(100, Math.round(60 + 40 * m.strength)));
    return {
      classification: r.classification_name,
      confidence: conf,
      config_priority: r.priority,
      rationale: {
        matched_rule: r.classification_name,
        strength: Number(m.strength.toFixed(3)),
        reasons: m.reasons,
        signal_values: {
          momentum: sig.momentum,
          breadth: sig.breadth,
          trajectory: sig.trajectory,
          dispersion: sig.dispersion,
          duration_minutes: sig.duration_minutes,
        },
      },
    };
  }
  // Fallback
  return {
    classification: 'unknown',
    confidence: 0,
    config_priority: 0,
    rationale: {
      matched_rule: null,
      reasons: ['no active rule matched'],
      signal_values: {
        momentum: sig.momentum,
        breadth: sig.breadth,
        trajectory: sig.trajectory,
        dispersion: sig.dispersion,
        duration_minutes: sig.duration_minutes,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// rich_text builder
// ---------------------------------------------------------------------------
function buildRichText(sig: RegimeSignal, cls: ClassificationResult): string {
  const tickerLabel = sig.ticker ?? 'MARKET';
  const m = sig.momentum === null ? 'na' : sig.momentum.toFixed(2);
  const b = sig.breadth === null ? 'na' : sig.breadth.toFixed(2);
  const d = sig.dispersion === null ? 'na' : sig.dispersion.toFixed(2);
  const macroBits: string[] = [];
  if (sig.macro_proximity.fomc_days !== null) macroBits.push(`fomc=${sig.macro_proximity.fomc_days}d`);
  if (sig.macro_proximity.cpi_days !== null) macroBits.push(`cpi=${sig.macro_proximity.cpi_days}d`);
  if (sig.macro_proximity.jobs_days !== null) macroBits.push(`jobs=${sig.macro_proximity.jobs_days}d`);
  if (sig.macro_proximity.earnings_clusters.length > 0) {
    const ec = sig.macro_proximity.earnings_clusters
      .slice(0, 5)
      .map((e) => `${e.ticker}=${e.days}d`)
      .join(',');
    macroBits.push(`earnings:${ec}`);
  }
  const macro = macroBits.length === 0 ? 'none' : macroBits.join(' ');
  return `REGIME | ${tickerLabel} | ${cls.classification} | momentum=${m} breadth=${b} trajectory=${sig.trajectory} dispersion=${d} duration=${sig.duration_minutes}min | macro: ${macro}`;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
serve(async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  const corsHeaders = getCorsHeaders(req);
  const jsonHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

  if (!isServiceRoleRequest(req)) {
    return new Response(
      JSON.stringify({ ok: false, error: 'unauthorized — service role required' }),
      { status: 401, headers: jsonHeaders },
    );
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) {
    return new Response(
      JSON.stringify({ ok: false, error: 'missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY' }),
      { status: 500, headers: jsonHeaders },
    );
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const t0 = Date.now();

  // ---- Bucket math --------------------------------------------------------
  const now = new Date();
  const bucketDate = roundDownToBucket(now, BUCKET_MINUTES);
  const bucketTs = bucketDate.toISOString();

  // ---- Load watchlist + config rules + universe of fetches ---------------
  const watchlist = await getWatchlist(supabase);
  if (watchlist.length === 0) {
    return new Response(
      JSON.stringify({ ok: false, error: 'empty watchlist' }),
      { status: 500, headers: jsonHeaders },
    );
  }

  const { data: rulesData, error: rulesErr } = await supabase
    .from('ct_regime_config')
    .select('classification_name, signal_thresholds, priority, active, description')
    .eq('active', true)
    .order('priority', { ascending: false });
  if (rulesErr) {
    return new Response(
      JSON.stringify({ ok: false, error: `read ct_regime_config failed: ${rulesErr.message}` }),
      { status: 500, headers: jsonHeaders },
    );
  }
  const rules = (rulesData ?? []) as ConfigRule[];

  // Pulse events for current bucket window (last 30 min ending at bucketDate + 5min)
  // We anchor the window at the bucket end so that on every fire we capture
  // exactly the [bucket_end - 30m, bucket_end) span deterministically.
  const bucketEnd = new Date(bucketDate.getTime() + BUCKET_MINUTES * 60 * 1000);
  const winStart = new Date(bucketEnd.getTime() - MOMENTUM_WINDOW_MINUTES * 60 * 1000);
  const eventsCurrent = await fetchPulseEvents(supabase, watchlist, winStart, bucketEnd);

  // For trajectory we need momentum at t-1 (5min ago) and t-2 (10min ago) buckets.
  // Each of those is its own 30-min window ending at that bucket's end.
  const tMinus1End = bucketDate; // == 5min before bucketEnd
  const tMinus1Start = new Date(tMinus1End.getTime() - MOMENTUM_WINDOW_MINUTES * 60 * 1000);
  const tMinus2End = bucketBefore(bucketDate, 1, BUCKET_MINUTES);
  const tMinus2Start = new Date(tMinus2End.getTime() - MOMENTUM_WINDOW_MINUTES * 60 * 1000);

  const eventsT1 = await fetchPulseEvents(supabase, watchlist, tMinus1Start, tMinus1End);
  const eventsT2 = await fetchPulseEvents(supabase, watchlist, tMinus2Start, tMinus2End);

  // Prior signals (for duration scan) — most recent ~36 buckets per ticker (~3h history).
  // We pull market-wide + per-ticker in one shot by ordering DESC and limiting.
  const priorScanFloor = new Date(bucketDate.getTime() - 36 * BUCKET_MINUTES * 60 * 1000);
  const { data: priorData } = await supabase
    .from('ct_regime_signals')
    .select('ticker, bucket_ts, momentum, trajectory, duration_minutes')
    .gte('bucket_ts', priorScanFloor.toISOString())
    .lt('bucket_ts', bucketTs)
    .order('bucket_ts', { ascending: false })
    .limit(800);
  const priorRows = (priorData ?? []) as PriorSignalRow[];
  const priorByTicker = new Map<string, PriorSignalRow[]>();
  for (const r of priorRows) {
    const k = r.ticker ?? MARKET_WIDE_KEY;
    if (!priorByTicker.has(k)) priorByTicker.set(k, []);
    priorByTicker.get(k)!.push(r);
  }

  // Upcoming events (FOMC/CPI/Jobs + earnings)
  const upcomingEvents = await fetchUpcomingEvents(supabase, watchlist, now);

  // ---- Build per-ticker (and market-wide) signals -------------------------
  const allKeys: Array<string | null> = [null, ...watchlist]; // null = market-wide
  const signalsToUpsert: Array<Record<string, unknown>> = [];
  const classificationsToUpsert: Array<Record<string, unknown>> = [];
  const historyInserts: Array<Record<string, unknown>> = [];
  const richTexts: string[] = []; // index-aligned with historyInserts pre-embed

  let signalsBuilt = 0;
  let classificationsBuilt = 0;

  // Pre-compute breadth + dispersion for market-wide once
  const marketBreadth = computeBreadth(eventsCurrent, watchlist);
  const marketDispersion = computeDispersion(eventsCurrent, watchlist);

  for (const ticker of allKeys) {
    try {
      const mNow = computeMomentum(eventsCurrent, ticker);
      const mPrev1 = computeMomentum(eventsT1, ticker);
      const mPrev2 = computeMomentum(eventsT2, ticker);

      const trajectory = computeTrajectory(mNow, mPrev1, mPrev2);

      const k = ticker ?? MARKET_WIDE_KEY;
      const priors = priorByTicker.get(k) ?? [];
      const duration = computeDuration(trajectory, priors);

      const breadth = ticker === null ? marketBreadth : null;
      const dispersion = ticker === null ? marketDispersion : null;

      const macro = buildMacroProximity(upcomingEvents, ticker, now);

      const sig: RegimeSignal = {
        ticker,
        bucket_ts: bucketTs,
        momentum: mNow,
        breadth,
        trajectory,
        dispersion,
        duration_minutes: duration,
        macro_proximity: macro,
      };

      signalsToUpsert.push({
        ticker: ticker, // null is fine — NULLS NOT DISTINCT unique index handles it
        bucket_ts: bucketTs,
        momentum: mNow,
        breadth,
        trajectory,
        dispersion,
        duration_minutes: duration,
        macro_proximity: macro,
        last_updated: new Date().toISOString(),
      });
      signalsBuilt += 1;

      const cls = classify(rules, sig);
      classificationsToUpsert.push({
        ticker,
        bucket_ts: bucketTs,
        classification: cls.classification,
        confidence: cls.confidence,
        rationale: cls.rationale,
        config_priority: cls.config_priority,
        last_updated: new Date().toISOString(),
      });
      classificationsBuilt += 1;

      const richText = buildRichText(sig, cls);
      richTexts.push(richText);
      historyInserts.push({
        ticker,
        bucket_ts: bucketTs,
        momentum: mNow,
        breadth,
        trajectory,
        dispersion,
        duration_minutes: duration,
        macro_proximity: macro,
        classification: cls.classification,
        confidence: cls.confidence,
        rationale: cls.rationale,
        embedded_state: null, // filled below
        rich_text: richText,
      });
    } catch (err) {
      console.warn(`[regime-capture] per-ticker error for ${ticker ?? 'MARKET'}:`, err instanceof Error ? err.message : err);
    }
  }

  // ---- UPSERT signals -----------------------------------------------------
  let signalsWritten = 0;
  if (signalsToUpsert.length > 0) {
    const { error } = await supabase
      .from('ct_regime_signals')
      .upsert(signalsToUpsert, { onConflict: 'ticker,bucket_ts' });
    if (error) {
      console.error('[regime-capture] ct_regime_signals upsert error:', error.message);
    } else {
      signalsWritten = signalsToUpsert.length;
    }
  }

  // ---- UPSERT classifications --------------------------------------------
  let classificationsWritten = 0;
  if (classificationsToUpsert.length > 0) {
    const { error } = await supabase
      .from('ct_regime_classifications')
      .upsert(classificationsToUpsert, { onConflict: 'ticker,bucket_ts' });
    if (error) {
      console.error('[regime-capture] ct_regime_classifications upsert error:', error.message);
    } else {
      classificationsWritten = classificationsToUpsert.length;
    }
  }

  // ---- Embed + INSERT history --------------------------------------------
  let embeddingsOk = 0;
  let embeddingsFailed = 0;
  for (let i = 0; i < historyInserts.length; i++) {
    try {
      const vec = await voyageEmbed(richTexts[i], 'document');
      // pgvector accepts an array; supabase-js client serializes it.
      // Cast to unknown then to string-compatible to satisfy the JSONB shape;
      // the column type is vector(512) and accepts this transparently.
      historyInserts[i].embedded_state = vec as unknown as number[];
      embeddingsOk += 1;
    } catch (err) {
      console.warn('[regime-capture] voyage embed failed:', err instanceof Error ? err.message : err);
      historyInserts[i].embedded_state = null;
      embeddingsFailed += 1;
    }
  }

  let historyInserted = 0;
  if (historyInserts.length > 0) {
    const { error } = await supabase
      .from('ct_regime_history')
      .insert(historyInserts);
    if (error) {
      console.error('[regime-capture] ct_regime_history insert error:', error.message);
    } else {
      historyInserted = historyInserts.length;
    }
  }

  const elapsedMs = Date.now() - t0;

  const body = {
    success: true,
    bucket_ts: bucketTs,
    watchlist_size: watchlist.length,
    signals_built: signalsBuilt,
    signals_written: signalsWritten,
    classifications_built: classificationsBuilt,
    classifications_written: classificationsWritten,
    history_inserted: historyInserted,
    embeddings_ok: embeddingsOk,
    embeddings_failed: embeddingsFailed,
    rules_loaded: rules.length,
    elapsed_ms: elapsedMs,
  };

  return new Response(JSON.stringify(body), { status: 200, headers: jsonHeaders });
});
