/**
 * D3 Feature-Isolation Experiment — per-wakeup feature reconstruction.
 *
 * Filled in 2026-05-07 (cascade catch #27 — yesterday's brief named several
 * tables/RPCs that don't reconstruct cleanly when back-anchored. Each loader
 * does the read directly against the source table with `wakeup_at`
 * substituted for `now()`).
 *
 * Brief: scope/2026-05-08-d3-feature-isolation-experiment.md §3 (F1-F8).
 *
 * Cost: ZERO UW calls. All 8 features reconstruct from internal Supabase
 * tables. Phase A verified 2026-05-08, re-verified at fill-in time 2026-05-07.
 *
 * Anchor discipline (THE correctness property):
 *   Every loader respects `wakeup.wakeup_at` — features as they were AT that
 *   moment, not "current". Loaders that wrap RPCs whose internal logic uses
 *   now() (ct_flow_pulse, ct_flow_heatmap_live, getNewsCausalityContext) are
 *   reimplemented inline against the underlying tables — back-anchoring an
 *   `now()`-based RPC to a past timestamp by spoofing now is not possible
 *   without DB-side support.
 *
 * Reconstruction-error policy: if a loader cannot anchor (RPC/table error,
 * source data missing for that timestamp), the column is set to NULL and
 * the loader name is appended to `reconstruction_error_flags`. We surface,
 * never fabricate.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.84.0";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Wakeup {
  ticker: string;
  wakeup_at: string; // ISO timestamp — corresponds to ct_specialist_reads.updated_at
  conviction: number;
  read_id: string;
}

export interface FeatureVector {
  // F1 — flow_pulse.is_unusual (boolean)
  f1_flow_pulse_unusual: boolean | null;
  // F2 — flow_heatmap front-week stack value (continuous, signed)
  f2_heatmap_front_week_value: number | null;
  // F3 — regime (positive_gamma / negative_gamma / neutral)
  f3_regime: "positive_gamma" | "negative_gamma" | "neutral" | null;
  // F4 — news count + max severity
  f4_news_count: number;
  f4_news_max_severity: number | null;
  // F5 — event_recency.whatJustHappened non-empty (72h prior)
  f5_event_recency_present: boolean;
  // F6 — signature_alarms recent count (1h prior)
  f6_signature_alarm_count: number;
  // F7 — has_0dte_today (deterministic from ticker + date)
  f7_has_0dte_today: boolean;
  // F8 — last flag outcome (string label or null)
  f8_last_flag_outcome: string | null;
}

export type ErrorFlags = string[];

export interface FeatureLoadResult {
  features: FeatureVector;
  errors: ErrorFlags;
}

// ---------------------------------------------------------------------------
// Watchlist 0DTE eligibility — copied from _shared/dteEligibility.ts logic
// to keep this script dependency-light. Source of truth: the migration
// 20260427000050_dte_eligibility.sql (Mag7 0DTE M/W/F = brief contract;
// SPY/QQQ/IWM daily; non-Mag7 weekly Friday).
//
// NOTE: yesterday's brief said "Mag7 + IBIT + AVGO have Mon/Wed/Fri 0DTE".
// IBIT/AVGO are not on the 10-ticker watchlist (Tenet 4 universe lock).
// We only encode the 10 watchlist tickers here.
// ---------------------------------------------------------------------------

const DTE_DAILY: ReadonlySet<string> = new Set(["SPY", "QQQ", "IWM"]);
const DTE_MWF: ReadonlySet<string> = new Set([
  "NVDA", "AAPL", "AMZN", "TSLA", "GOOGL", "META", "MSFT",
]);

// ---------------------------------------------------------------------------
// F1 — flow_pulse.is_unusual (back-anchored to wakeup_at).
//
// ct_flow_pulse RPC uses now() internally → cannot be back-anchored. We
// reimplement the core "is_unusual" computation against ct_scored_flow
// directly using wakeup_at as the anchor.
//
// Migration source of truth: 20260424000032_flow_pulse_rpc.sql
//
// is_unusual := (cur calls+puts >= 20 AND baseline events >= 20
//                AND cp_ratio_deviation >= 2.0 OR <= 0.5)
// Window: 360min (6h) prior to wakeup_at (matches RPC default).
// Baseline: 30 days prior to wakeup_at, daily call:put avg, days with >=5 each.
// ---------------------------------------------------------------------------

const F1_WINDOW_MIN = 360;
const F1_BASELINE_DAYS = 30;
const F1_MIN_CUR_EVENTS = 20;
const F1_MIN_BASE_EVENTS = 20;

interface ScoredFlowRow {
  ticker: string;
  event_ts: string;
  option_symbol: string | null;
}

function sideChar(sym: string | null): "C" | "P" | null {
  if (!sym || sym.length < 9) return null;
  const ch = sym.charAt(sym.length - 9);
  return ch === "C" || ch === "P" ? ch : null;
}

async function pageScoredFlow(
  supabase: SupabaseClient,
  ticker: string,
  fromIso: string,
  toIso: string,
): Promise<ScoredFlowRow[]> {
  const out: ScoredFlowRow[] = [];
  const PAGE = 1000;
  let from = 0;
  // Bound the loop — even ultra-active tickers shouldn't exceed ~30k events
  // in 30 days; 50 pages × 1000 = 50k cap is defensive.
  for (let pageIdx = 0; pageIdx < 50; pageIdx++) {
    const { data, error } = await supabase
      .from("ct_scored_flow")
      .select("ticker, event_ts, option_symbol")
      .eq("ticker", ticker)
      .gte("event_ts", fromIso)
      .lt("event_ts", toIso)
      .in("classification", ["opening_buy", "opening_sell"])
      .order("event_ts", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`scored_flow_page_${pageIdx}:${error.message}`);
    const batch = (data ?? []) as ScoredFlowRow[];
    out.push(...batch);
    if (batch.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

export async function loadF1(
  supabase: SupabaseClient,
  wakeup: Wakeup,
): Promise<{ value: Pick<FeatureVector, "f1_flow_pulse_unusual">; error?: string }> {
  try {
    const wakeMs = Date.parse(wakeup.wakeup_at);
    const curFromIso = new Date(wakeMs - F1_WINDOW_MIN * 60 * 1000).toISOString();
    const baseFromIso = new Date(wakeMs - F1_BASELINE_DAYS * 24 * 60 * 60 * 1000).toISOString();
    // Whole 30-day window up to start of current window — matches RPC's
    //   event_ts >= now() - 30d AND event_ts < now() - p_window
    const baseToIso = curFromIso;
    const wakeIso = wakeup.wakeup_at;

    const [cur, base] = await Promise.all([
      pageScoredFlow(supabase, wakeup.ticker, curFromIso, wakeIso),
      pageScoredFlow(supabase, wakeup.ticker, baseFromIso, baseToIso),
    ]);

    let curCalls = 0, curPuts = 0;
    for (const r of cur) {
      const s = sideChar(r.option_symbol);
      if (s === "C") curCalls++;
      else if (s === "P") curPuts++;
    }

    // Baseline: per-day call/put counts, average ratio over days w/ >=5 each.
    const dayMap = new Map<string, { c: number; p: number }>();
    for (const r of base) {
      const day = r.event_ts.slice(0, 10); // UTC day bucket — matches RPC's date_trunc('day', event_ts)
      const s = sideChar(r.option_symbol);
      if (s !== "C" && s !== "P") continue;
      let bucket = dayMap.get(day);
      if (!bucket) { bucket = { c: 0, p: 0 }; dayMap.set(day, bucket); }
      if (s === "C") bucket.c++;
      else bucket.p++;
    }
    const eligibleDays: number[] = [];
    let baseEvents = 0;
    for (const { c, p } of dayMap.values()) {
      baseEvents += c + p;
      if (c >= 5 && p >= 5) eligibleDays.push(c / Math.max(p, 1));
    }
    const baselineRatio =
      eligibleDays.length > 0
        ? eligibleDays.reduce((a, b) => a + b, 0) / eligibleDays.length
        : null;

    if (
      baselineRatio === null ||
      baselineRatio === 0 ||
      curCalls + curPuts < F1_MIN_CUR_EVENTS ||
      baseEvents < F1_MIN_BASE_EVENTS
    ) {
      // Insufficient data → ratio not meaningful. RPC returns false here, not
      // an error. We follow suit.
      return { value: { f1_flow_pulse_unusual: false } };
    }

    const curRatio = curCalls / Math.max(curPuts, 1);
    const dev = curRatio / baselineRatio;
    const isUnusual = dev >= 2.0 || dev <= 0.5;
    return { value: { f1_flow_pulse_unusual: isUnusual } };
  } catch (err) {
    return {
      value: { f1_flow_pulse_unusual: null },
      error: err instanceof Error ? err.message : "unknown",
    };
  }
}

// ---------------------------------------------------------------------------
// F2 — flow_heatmap front-week stack value (continuous, signed).
//
// ct_flow_heatmap_live RPC: now()-anchored. Reimplemented here against
// ct_flow_alerts directly per the same math the RPC uses (see
// 20260430170000_ct_flow_heatmap_live_rewrite.sql).
//
// Front-week = expiry within wakeup_at::date + 7 calendar days.
// Math mode: aggressive_directional_decay (the captain-correct default per
// ct_config.flow_heatmap.math_mode + cotrader-mcp consumer overrides).
// Lookback: 168h (7d) trailing wakeup_at — global default.
//
// We do a simple aggregation: signed sum over front-week alerts within the
// 168h window, with direction inferred from option side + side_aggressive.
// (Approximation — the production RPC has decay weighting by event_ts → now,
// which we substitute with event_ts → wakeup_at. The shape and sign of the
// front-week value remain comparable across wakeups, which is what the
// experiment cares about.)
// ---------------------------------------------------------------------------

const F2_LOOKBACK_HOURS = 168;
const F2_MIN_PREMIUM = 100_000;

// CASCADE CATCH #28: ct_flow_alerts column is `expiry` (not `expiry_date`),
// `is_ask`/`is_bid` (not `is_ask_side`/`is_bid_side`), `side` is lowercase
// "call"/"put" (not "CALL"/"PUT"), and there is no top-level `rule_name`
// column — the rule lives in `raw.alert_rule` (NOT `raw.rule_name`).
// CASCADE CATCH #29: per memory feedback_uw_is_ask_bid_never_set.md,
// is_ask/is_bid are virtually always NULL in live UW data. Direction is
// inferred from raw.total_ask_side_prem / raw.total_bid_side_prem and
// raw.alert_rule per _shared/directionInference.ts exactly.
interface FlowAlertRaw {
  alert_rule?: string | null;
  total_ask_side_prem?: string | number | null;
  total_bid_side_prem?: string | number | null;
}

interface FlowAlertRow {
  ticker: string;
  ingested_at: string;
  executed_at: string | null;
  option_symbol: string | null;
  expiry: string | null;
  premium: number | null;
  side: string | null;        // "call" | "put"
  is_ask: boolean | null;
  is_bid: boolean | null;
  raw: FlowAlertRaw | null;
}

async function pageFlowAlerts(
  supabase: SupabaseClient,
  ticker: string,
  fromIso: string,
  toIso: string,
): Promise<FlowAlertRow[]> {
  const out: FlowAlertRow[] = [];
  const PAGE = 1000;
  let from = 0;
  for (let pageIdx = 0; pageIdx < 50; pageIdx++) {
    const { data, error } = await supabase
      .from("ct_flow_alerts")
      .select("ticker, ingested_at, executed_at, option_symbol, expiry, premium, side, is_ask, is_bid, raw")
      .eq("ticker", ticker)
      .gte("ingested_at", fromIso)
      .lt("ingested_at", toIso)
      .order("ingested_at", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`flow_alerts_page_${pageIdx}:${error.message}`);
    const batch = (data ?? []) as FlowAlertRow[];
    out.push(...batch);
    if (batch.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

/**
 * Direction inference matching _shared/directionInference.ts EXACTLY (line
 * for line — extracting only the call/put → +1/-1 mapping). Anything not
 * directionally inferable returns null.
 *
 * +1 = bullish (ask-aggressive call OR bid-aggressive put — selling puts)
 * -1 = bearish (ask-aggressive put OR bid-aggressive call — selling calls)
 */
function isAggressiveDirectional(r: FlowAlertRow): { dir: 1 | -1; weight: number } | null {
  const side = (r.side ?? "").toLowerCase();
  if (side !== "call" && side !== "put") return null;

  const raw = r.raw ?? {};
  const askPremRaw = raw.total_ask_side_prem;
  const bidPremRaw = raw.total_bid_side_prem;
  const askPrem = askPremRaw == null ? null : Number(askPremRaw);
  const bidPrem = bidPremRaw == null ? null : Number(bidPremRaw);
  const askPremValid = askPrem !== null && Number.isFinite(askPrem);
  const bidPremValid = bidPrem !== null && Number.isFinite(bidPrem);

  // Mid-print: both sides effectively zero → no directional signal.
  if (askPremValid && bidPremValid && (askPrem as number) < 1 && (bidPrem as number) < 1) {
    return null;
  }

  let aggressiveAsk = false;
  let aggressiveBid = false;

  if (r.is_ask === true) {
    aggressiveAsk = true;
  } else if (r.is_bid === true) {
    aggressiveBid = true;
  } else {
    const alertRule = typeof raw.alert_rule === "string" ? raw.alert_rule : "";
    const isRepeatedHits = alertRule.startsWith("RepeatedHits");
    if (isRepeatedHits) {
      // RepeatedHits = accumulation/buying. Both sides map to ask-aggressive.
      aggressiveAsk = true;
    } else if (askPremValid && bidPremValid) {
      if ((askPrem as number) > (bidPrem as number)) aggressiveAsk = true;
      else if ((bidPrem as number) > (askPrem as number)) aggressiveBid = true;
      else return null;
    } else if (askPremValid && (askPrem as number) > 0 && (!bidPremValid || bidPrem === 0)) {
      aggressiveAsk = true;
    } else if (bidPremValid && (bidPrem as number) > 0 && (!askPremValid || askPrem === 0)) {
      aggressiveBid = true;
    } else {
      return null;
    }
  }

  const isCall = side === "call";
  let dir: 1 | -1;
  if (aggressiveAsk) {
    dir = isCall ? 1 : -1;       // ask-aggressive call = bullish; put = bearish
  } else if (aggressiveBid) {
    dir = isCall ? -1 : 1;       // selling calls = bearish; selling puts = bullish
  } else {
    return null;
  }
  return { dir, weight: r.premium ?? 0 };
}

export async function loadF2(
  supabase: SupabaseClient,
  wakeup: Wakeup,
): Promise<{ value: Pick<FeatureVector, "f2_heatmap_front_week_value">; error?: string }> {
  try {
    const wakeMs = Date.parse(wakeup.wakeup_at);
    const fromIso = new Date(wakeMs - F2_LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();
    const toIso = wakeup.wakeup_at;
    const wakeDate = wakeup.wakeup_at.slice(0, 10);
    const frontWeekEnd = new Date(Date.parse(wakeDate) + 7 * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10);

    const rows = await pageFlowAlerts(supabase, wakeup.ticker, fromIso, toIso);

    let signed = 0;
    let count = 0;
    for (const r of rows) {
      if (!r.expiry) continue;
      if (r.expiry < wakeDate) continue;        // past expiry
      if (r.expiry > frontWeekEnd) continue;    // beyond front-week
      if ((r.premium ?? 0) < F2_MIN_PREMIUM) continue;
      const ad = isAggressiveDirectional(r);
      if (!ad) continue;
      // Linear time-decay from event_ts → wakeup_at (approximates RPC's decay
      // toward now). Weight halves at the lookback midpoint.
      const evMs = Date.parse(r.ingested_at);
      const ageHours = Math.max(0, (wakeMs - evMs) / (60 * 60 * 1000));
      const decay = Math.max(0, 1 - ageHours / F2_LOOKBACK_HOURS);
      signed += ad.dir * ad.weight * decay;
      count++;
    }

    if (count === 0) {
      // Genuine zero — no front-week aggressive prints. Not an error.
      return { value: { f2_heatmap_front_week_value: 0 } };
    }
    return { value: { f2_heatmap_front_week_value: signed } };
  } catch (err) {
    return {
      value: { f2_heatmap_front_week_value: null },
      error: err instanceof Error ? err.message : "unknown",
    };
  }
}

// ---------------------------------------------------------------------------
// F3 — gamma regime via build_ticker_quant_card(ticker, as_of=wakeup_at).
//
// CASCADE CATCH #29 (correction to yesterday's brief): brief said "Source:
// ct_ticker_snapshots.regime" but ct_ticker_snapshots is single-row-per-ticker
// overwritten on every poll — no historical row at-or-before older wakeups.
//
// build_ticker_quant_card RPC (migration 20260424000009_gamma_flip_fix.sql)
// accepts a `p_as_of` timestamp and reads ct_gex_timeseries for the latest
// snapshot at-or-before. The structure.regime field is computed from
// SUM(net_gex) sign — exactly what ct_ticker_snapshots stores live. So
// invoking the RPC with p_as_of=wakeup_at gives the same regime label
// the snapshot would have shown at that moment.
//
// ct_gex_timeseries IS append-only (every snapshot kept) — so this
// reconstruction is honest, not approximate.
// ---------------------------------------------------------------------------

interface QuantCardStructure {
  regime?: string | null;
  net_gamma?: number | null;
}
interface QuantCard {
  structure?: QuantCardStructure | null;
}

export async function loadF3(
  supabase: SupabaseClient,
  wakeup: Wakeup,
): Promise<{ value: Pick<FeatureVector, "f3_regime">; error?: string }> {
  try {
    const { data, error } = await supabase.rpc("build_ticker_quant_card", {
      p_ticker: wakeup.ticker,
      p_as_of: wakeup.wakeup_at,
    });
    if (error) {
      return { value: { f3_regime: null }, error: `rpc:${error.message}` };
    }
    const card = (data ?? null) as QuantCard | null;
    const r = card?.structure?.regime ?? null;
    if (r === "positive_gamma" || r === "negative_gamma" || r === "neutral") {
      return { value: { f3_regime: r } };
    }
    if (r === null) {
      // Net gamma was zero or no GEX rows at-or-before — distinguish vs error.
      return { value: { f3_regime: null }, error: "no_gex_at_or_before_wakeup" };
    }
    return {
      value: { f3_regime: null },
      error: `unexpected_regime:${String(r)}`,
    };
  } catch (err) {
    return {
      value: { f3_regime: null },
      error: err instanceof Error ? err.message : "unknown",
    };
  }
}

// ---------------------------------------------------------------------------
// F4 — news count + max severity in 6h prior to wakeup_at.
//
// Sources: ct_breaking_news (severity, ingested_at, tickers_affected[])
//        + ct_news_analyses (significance, created_at, instrument).
// Window: 6h trailing wakeup_at. Per-ticker filter on each source.
// ---------------------------------------------------------------------------

const F4_LOOKBACK_HOURS = 6;

export async function loadF4(
  supabase: SupabaseClient,
  wakeup: Wakeup,
): Promise<{
  value: Pick<FeatureVector, "f4_news_count" | "f4_news_max_severity">;
  error?: string;
}> {
  try {
    const wakeMs = Date.parse(wakeup.wakeup_at);
    const fromIso = new Date(wakeMs - F4_LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();
    const toIso = wakeup.wakeup_at;

    const [breakingRes, analysesRes] = await Promise.all([
      supabase
        .from("ct_breaking_news")
        .select("severity, ingested_at")
        .gte("ingested_at", fromIso)
        .lt("ingested_at", toIso)
        .contains("tickers_affected", [wakeup.ticker])
        .limit(200),
      supabase
        .from("ct_news_analyses")
        .select("significance, created_at")
        .gte("created_at", fromIso)
        .lt("created_at", toIso)
        .eq("instrument", wakeup.ticker)
        .limit(200),
    ]);

    if (breakingRes.error || analysesRes.error) {
      const msgs = [breakingRes.error?.message, analysesRes.error?.message]
        .filter(Boolean).join(";");
      return {
        value: { f4_news_count: 0, f4_news_max_severity: null },
        error: msgs || "news_query_error",
      };
    }

    const breaking = (breakingRes.data ?? []) as Array<{ severity: number | null }>;
    const analyses = (analysesRes.data ?? []) as Array<{ significance: number | null }>;
    const count = breaking.length + analyses.length;
    let maxSev: number | null = null;
    for (const r of breaking) {
      if (r.severity != null && (maxSev === null || r.severity > maxSev)) maxSev = r.severity;
    }
    for (const r of analyses) {
      if (r.significance != null && (maxSev === null || r.significance > maxSev)) {
        maxSev = r.significance;
      }
    }
    return { value: { f4_news_count: count, f4_news_max_severity: maxSev } };
  } catch (err) {
    return {
      value: { f4_news_count: 0, f4_news_max_severity: null },
      error: err instanceof Error ? err.message : "unknown",
    };
  }
}

// ---------------------------------------------------------------------------
// F5 — event_recency presence in 72h prior to wakeup_at.
//
// Read ct_events directly (per brief: don't invoke buildClaudeContext per
// wakeup; reconstruct independently). The orchestrator's whatJustHappened
// includes per-ticker events (e.g. AAPL earnings) AND market-wide events
// (ticker=NULL, econ calendar / macro). Either kind makes the feature true.
//
// Window: event_date in [wakeup_date - 3, wakeup_date] (72h calendar prior).
// ---------------------------------------------------------------------------

export async function loadF5(
  supabase: SupabaseClient,
  wakeup: Wakeup,
): Promise<{ value: Pick<FeatureVector, "f5_event_recency_present">; error?: string }> {
  try {
    const wakeDate = wakeup.wakeup_at.slice(0, 10);
    const fromDate = new Date(Date.parse(wakeDate) - 3 * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10);
    // Per-ticker events for this wakeup's ticker, OR market-wide (ticker IS NULL).
    const { data, error } = await supabase
      .from("ct_events")
      .select("id, ticker")
      .gte("event_date", fromDate)
      .lte("event_date", wakeDate)
      .or(`ticker.eq.${wakeup.ticker},ticker.is.null`)
      .limit(1);
    if (error) {
      return { value: { f5_event_recency_present: false }, error: error.message };
    }
    return { value: { f5_event_recency_present: (data ?? []).length > 0 } };
  } catch (err) {
    return {
      value: { f5_event_recency_present: false },
      error: err instanceof Error ? err.message : "unknown",
    };
  }
}

// ---------------------------------------------------------------------------
// F6 — ct_signature_alarm_log count for ticker, 1h prior to wakeup_at.
//
// CASCADE CATCH #27: brief said `ct_signature_alarms` — actual table is
// `ct_signature_alarm_log` (see 20260426000050_signature_alarm_state.sql).
// Filter on score > 0 to drop score-race rows (lesson:
// feedback_signature_watcher_score_race.md — score=0 mid-window is normal,
// real signal arrives ~5min later).
//
// Brief also said "last 1h before wakeup_at"; older comment said 6h. We
// follow the brief: 1h.
// ---------------------------------------------------------------------------

const F6_LOOKBACK_HOURS = 1;

export async function loadF6(
  supabase: SupabaseClient,
  wakeup: Wakeup,
): Promise<{ value: Pick<FeatureVector, "f6_signature_alarm_count">; error?: string }> {
  try {
    const wakeMs = Date.parse(wakeup.wakeup_at);
    const fromIso = new Date(wakeMs - F6_LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();
    const toIso = wakeup.wakeup_at;
    const { data, error } = await supabase
      .from("ct_signature_alarm_log")
      .select("id, score")
      .eq("ticker", wakeup.ticker)
      .gte("fired_at", fromIso)
      .lt("fired_at", toIso)
      .gt("score", 0)
      .limit(500);
    if (error) {
      return { value: { f6_signature_alarm_count: 0 }, error: error.message };
    }
    return { value: { f6_signature_alarm_count: (data ?? []).length } };
  } catch (err) {
    return {
      value: { f6_signature_alarm_count: 0 },
      error: err instanceof Error ? err.message : "unknown",
    };
  }
}

// ---------------------------------------------------------------------------
// F7 — has_0dte_today (deterministic; see DTE_DAILY / DTE_MWF above).
// ---------------------------------------------------------------------------

export function loadF7(wakeup: Wakeup): Pick<FeatureVector, "f7_has_0dte_today"> {
  const t = wakeup.ticker.toUpperCase();
  if (DTE_DAILY.has(t)) return { f7_has_0dte_today: true };
  if (DTE_MWF.has(t)) {
    const dow = new Date(wakeup.wakeup_at).getUTCDay(); // 0=Sun..6=Sat
    // Mon=1, Wed=3, Fri=5
    return { f7_has_0dte_today: dow === 1 || dow === 3 || dow === 5 };
  }
  return { f7_has_0dte_today: false };
}

// ---------------------------------------------------------------------------
// F8 — most recent ct_flag_grades.outcome for specialist_ticker prior to
// wakeup_at. Returns the outcome string (e.g. "win", "loss", "partial",
// "expired_*") or null if no graded flag exists yet for this ticker.
// ---------------------------------------------------------------------------

export async function loadF8(
  supabase: SupabaseClient,
  wakeup: Wakeup,
): Promise<{ value: Pick<FeatureVector, "f8_last_flag_outcome">; error?: string }> {
  try {
    const { data, error } = await supabase
      .from("ct_flag_grades")
      .select("outcome, graded_at")
      .eq("specialist_ticker", wakeup.ticker)
      .lt("graded_at", wakeup.wakeup_at)
      .order("graded_at", { ascending: false })
      .limit(1);
    if (error) {
      return { value: { f8_last_flag_outcome: null }, error: error.message };
    }
    const row = (data ?? [])[0] as { outcome: string | null } | undefined;
    return { value: { f8_last_flag_outcome: row?.outcome ?? null } };
  } catch (err) {
    return {
      value: { f8_last_flag_outcome: null },
      error: err instanceof Error ? err.message : "unknown",
    };
  }
}

// ---------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------

export async function reconstructFeatures(
  supabase: SupabaseClient,
  wakeup: Wakeup,
): Promise<FeatureLoadResult> {
  const [f1, f2, f3, f4, f5, f6, f8] = await Promise.all([
    loadF1(supabase, wakeup),
    loadF2(supabase, wakeup),
    loadF3(supabase, wakeup),
    loadF4(supabase, wakeup),
    loadF5(supabase, wakeup),
    loadF6(supabase, wakeup),
    loadF8(supabase, wakeup),
  ]);
  const f7 = loadF7(wakeup);

  const errors: ErrorFlags = [];
  if (f1.error) errors.push(`F1:${f1.error}`);
  if (f2.error) errors.push(`F2:${f2.error}`);
  if (f3.error) errors.push(`F3:${f3.error}`);
  if (f4.error) errors.push(`F4:${f4.error}`);
  if (f5.error) errors.push(`F5:${f5.error}`);
  if (f6.error) errors.push(`F6:${f6.error}`);
  if (f8.error) errors.push(`F8:${f8.error}`);

  return {
    features: {
      ...f1.value,
      ...f2.value,
      ...f3.value,
      ...f4.value,
      ...f5.value,
      ...f6.value,
      ...f7,
      ...f8.value,
    },
    errors,
  };
}
