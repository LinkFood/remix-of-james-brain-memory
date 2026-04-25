/**
 * ct-signature-watcher — tiered live trade-signal alarm.
 *
 * Walks forward through new ct_flow_alerts since the last invocation. For
 * each alert, computes its signature class (ticker, side, predicted_source,
 * dte_bucket), looks up historical magnitude stats via
 * ct_signature_magnitude_stats AND the per-alert flow score from
 * ct_scored_flow, then routes to one of three tiers:
 *
 *   gold   → Slack push (priority format) + ct_flags row tagged 'gold'
 *   silver → Slack push (standard format)  + ct_flags row tagged 'silver'
 *   bronze → ct_flags row tagged 'bronze'  (NO Slack — UI glow only)
 *
 * Tier evaluation runs AFTER the 0DTE eligibility skip and dedupe checks.
 * Watermark advances at the end so the next sweep picks up where this one
 * left off.
 *
 * Auth: service_role only.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { ctSlackPushDirect } from '../_shared/ctSlack.ts';
import {
  loadDteEligibility,
  ticker0DteEligibleOn,
  type DteEligibilityMap,
} from '../_shared/dteEligibility.ts';
import {
  evaluateTier,
  loadTierThresholds,
  loadScoreForAlert,
  type TierThresholds,
} from '../_shared/alarmTiering.ts';

// ---------------------------------------------------------------------------
// Tunables — page size mirrors PostgREST 1000-row cap. SCAN cap bounds total
// rows we'll page through per invocation (60 = 60s of new prints during RTH).
// ---------------------------------------------------------------------------
const PAGE_SIZE = 1000;
const SCAN_LIMIT = 4000;

type DteBucket = '0dte' | 'short' | 'mid' | 'long';

interface FlowAlertRow {
  alert_id: string;
  ticker: string;
  side: string | null;
  is_ask: boolean | null;
  is_bid: boolean | null;
  strike: number | null;
  expiry: string | null;
  premium: number | null;
  price: number | null;
  executed_at: string | null;
  ingested_at: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw: any;
}

type Direction = 'bullish' | 'bearish' | 'neutral';

interface SignatureStat {
  signature_label: string;
  ticker: string;
  side: string;
  dte_bucket: string;
  predicted_source: string;
  n_tracks: number;
  median_peak_pct: number | string;
}

interface Stats {
  ok: boolean;
  replay_mode: boolean;
  alerts_scanned: number;
  alarms_total_evaluated: number;
  alarms_fired_gold: number;
  alarms_fired_silver: number;
  alarms_fired_bronze: number;
  bronze_silent_writes: number;
  alarms_deduped: number;
  alarms_no_signature_match: number;
  alarms_below_threshold: number;
  alarms_no_direction: number;
  alarms_off_watchlist: number;
  alarms_no_symbol: number;
  alarms_skipped_0dte_ineligible: number;
  watermark_before: string | null;
  watermark_after: string | null;
  thresholds: TierThresholds;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Direction / source inference — mirrors ct-print-grader.inferDirection so
// the predicted_source label matches what the contract grader writes into
// ct_contract_tracks (and therefore what ct_signature_magnitude_stats keys on).
// Returns null if the print is mid / undeterminable.
// ---------------------------------------------------------------------------
function inferPredictedSource(row: FlowAlertRow): string | null {
  const side = (row.side ?? '').toLowerCase();
  if (side !== 'call' && side !== 'put') return null;

  const raw = row.raw ?? {};
  const askPremRaw = raw['total_ask_side_prem'];
  const bidPremRaw = raw['total_bid_side_prem'];
  const askPrem = askPremRaw == null ? null : Number(askPremRaw);
  const bidPrem = bidPremRaw == null ? null : Number(bidPremRaw);
  const askPremValid = askPrem !== null && Number.isFinite(askPrem);
  const bidPremValid = bidPrem !== null && Number.isFinite(bidPrem);

  if (askPremValid && bidPremValid && askPrem < 1 && bidPrem < 1) return null;

  let sourceTag: 'ask' | 'bid' | null = null;
  if (row.is_ask === true) sourceTag = 'ask';
  else if (row.is_bid === true) sourceTag = 'bid';
  else {
    // Mirror ct-print-grader fix: RepeatedHits* IS accumulation by definition;
    // premium-side bear-tagged the 9:33 NVDA 0DTE +475% print on 2026-04-24.
    const alertRule = typeof raw['alert_rule'] === 'string' ? raw['alert_rule'] : '';
    if (alertRule.startsWith('RepeatedHits')) {
      sourceTag = side === 'call' ? 'ask' : 'bid';
    } else if (askPremValid && bidPremValid) {
      if (askPrem > bidPrem) sourceTag = 'ask';
      else if (bidPrem > askPrem) sourceTag = 'bid';
      else return null;
    } else if (askPremValid && askPrem > 0 && (!bidPremValid || bidPrem === 0)) sourceTag = 'ask';
    else if (bidPremValid && bidPrem > 0 && (!askPremValid || askPrem === 0)) sourceTag = 'bid';
    else return null;
  }

  return `aggressive_${sourceTag}_${side}`;
}

// ---------------------------------------------------------------------------
// DTE bucket — must match ct-print-grader.dteBucket and the bucketing in
// ct_signature_magnitude_stats SQL (CASE on dte_at_print).
// ---------------------------------------------------------------------------
function dteBucket(dte: number | null): DteBucket {
  if (dte === null || !Number.isFinite(dte)) return 'long';
  if (dte <= 0) return '0dte';
  if (dte <= 7) return 'short';
  if (dte <= 30) return 'mid';
  return 'long';
}

function computeDte(printTime: Date, expiry: string | null): number | null {
  if (!expiry) return null;
  const m = expiry.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const exp = Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10), 20, 0, 0);
  const days = Math.floor((exp - printTime.getTime()) / (24 * 3600_000));
  return Number.isFinite(days) ? days : null;
}

// ---------------------------------------------------------------------------
// OCC-symbol synthesis — same shape as ct-print-grader.buildOccSymbol so the
// dedupe key matches what the contract poller / grader use.
// ---------------------------------------------------------------------------
function buildOccSymbol(
  ticker: string | null | undefined,
  expiry: string | null | undefined,
  side: string | null | undefined,
  strike: number | null | undefined,
): string | null {
  if (!ticker || !expiry || strike == null || !Number.isFinite(strike) || strike <= 0) return null;
  const sideStr = (side ?? '').toLowerCase();
  if (sideStr !== 'call' && sideStr !== 'put') return null;
  const sideChar = sideStr === 'put' ? 'P' : 'C';
  const m = expiry.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const yymmdd = `${m[1].slice(2)}${m[2]}${m[3]}`;
  const strikeInt = Math.round(strike * 1000);
  if (!Number.isFinite(strikeInt) || strikeInt < 0) return null;
  return `${ticker.toUpperCase()}${yymmdd}${sideChar}${String(strikeInt).padStart(8, '0')}`;
}

function resolvePrintTime(a: FlowAlertRow): Date {
  if (a.executed_at) {
    const d = new Date(a.executed_at);
    if (!Number.isNaN(d.getTime())) return d;
  }
  const raw = a.raw ?? {};
  if (typeof raw.created_at === 'string') {
    const d = new Date(raw.created_at);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date(a.ingested_at);
}

const DEFAULT_WATCHLIST = ['SPY','QQQ','IWM','AAPL','MSFT','GOOGL','AMZN','META','NVDA','TSLA'];

async function loadWatchlist(supabase: SupabaseClient): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('ct_config')
    .select('value')
    .eq('key', 'watcher.watchlist')
    .maybeSingle();
  if (error || !data?.value) return new Set(DEFAULT_WATCHLIST);
  const arr = data.value as unknown;
  if (!Array.isArray(arr)) return new Set(DEFAULT_WATCHLIST);
  const set = new Set<string>();
  for (const t of arr) if (typeof t === 'string' && t.length > 0) set.add(t.toUpperCase());
  return set.size > 0 ? set : new Set(DEFAULT_WATCHLIST);
}

async function loadWatermark(supabase: SupabaseClient): Promise<string> {
  const { data, error } = await supabase
    .from('ct_signature_alarm_state')
    .select('last_processed_ingested_at')
    .eq('id', 1)
    .maybeSingle();
  if (error || !data) {
    return new Date(Date.now() - 5 * 60_000).toISOString();
  }
  return data.last_processed_ingested_at as string;
}

async function saveWatermark(supabase: SupabaseClient, ts: string): Promise<void> {
  await supabase
    .from('ct_signature_alarm_state')
    .update({ last_processed_ingested_at: ts, updated_at: new Date().toISOString() })
    .eq('id', 1);
}

// ---------------------------------------------------------------------------
// Signature stats lookup — one RPC call per invocation, cached as a Map
// keyed by signature_label (ticker:side:dte_bucket:predicted_source).
// Uses the lowest-tier min_n so bronze candidates aren't pre-filtered.
// ---------------------------------------------------------------------------
async function loadSignatureStats(
  supabase: SupabaseClient,
  thresholds: TierThresholds,
): Promise<Map<string, SignatureStat>> {
  const since = new Date(Date.now() - thresholds.lookbackDays * 24 * 3600_000).toISOString();
  const { data, error } = await supabase.rpc('ct_signature_magnitude_stats', {
    p_since: since,
    p_min_n: thresholds.rpcMinN,
  });
  if (error || !data) return new Map();
  const map = new Map<string, SignatureStat>();
  for (const row of data as SignatureStat[]) {
    map.set(row.signature_label, row);
  }
  return map;
}

// Label casing mirrors ct_signature_magnitude_stats RPC output exactly —
// ticker stays UPPER, side/bucket/source stay lower. Mismatched case = miss.
function buildSignatureLabel(ticker: string, side: string, bucket: DteBucket, source: string): string {
  return `${ticker.toUpperCase()}:${side}:${bucket}:${source}`;
}

// ---------------------------------------------------------------------------
// Slack body builders — gold gets a priority prefix, silver gets standard.
// Bronze never builds Slack text.
// ---------------------------------------------------------------------------
function buildSlackText(
  tier: 'gold' | 'silver',
  args: {
    ticker: string;
    side: string;
    strike: number | null;
    expiry: string | null;
    bucketStr: string;
    source: string;
    peakPctStr: string;
    nTracks: number;
    premKstr: string;
    scoreStr: string;
    alertId: string;
  },
): string {
  const prefix = tier === 'gold' ? ':first_place_medal: *GOLD ALARM*' : ':second_place_medal: *Silver alarm*';
  return (
    `${prefix} — ${args.ticker} ${args.side} $${args.strike} ${args.expiry} (${args.bucketStr})\n` +
    `Class: \`${args.source}\` → historical median peak +${args.peakPctStr} on n=${args.nTracks}\n` +
    `Premium: ${args.premKstr} · ${args.scoreStr}\n` +
    `Alert: \`${args.alertId}\``
  );
}

// ---------------------------------------------------------------------------
// Main sweep.
// ---------------------------------------------------------------------------
async function runSweep(supabase: SupabaseClient, thresholds: TierThresholds, replayMode: boolean): Promise<Stats> {
  const stats: Stats = {
    ok: true,
    replay_mode: replayMode,
    alerts_scanned: 0,
    alarms_total_evaluated: 0,
    alarms_fired_gold: 0,
    alarms_fired_silver: 0,
    alarms_fired_bronze: 0,
    bronze_silent_writes: 0,
    alarms_deduped: 0,
    alarms_no_signature_match: 0,
    alarms_below_threshold: 0,
    alarms_no_direction: 0,
    alarms_off_watchlist: 0,
    alarms_no_symbol: 0,
    alarms_skipped_0dte_ineligible: 0,
    watermark_before: null,
    watermark_after: null,
    thresholds,
    errors: [],
  };

  const watermark = await loadWatermark(supabase);
  stats.watermark_before = watermark;

  const watchlist = await loadWatchlist(supabase);
  const sigStats = await loadSignatureStats(supabase, thresholds);
  const eligibility: DteEligibilityMap = await loadDteEligibility(supabase);

  // Resolve userId for Slack push (single-user pattern, matches ct-eod-summary).
  const { data: users } = await supabase.from('profiles').select('id').limit(1);
  const userId = users?.[0]?.id as string | undefined;

  // Page forward through ct_flow_alerts since the watermark, oldest-first so
  // the watermark advances monotonically.
  const alerts: FlowAlertRow[] = [];
  for (let offset = 0; offset < SCAN_LIMIT; offset += PAGE_SIZE) {
    const end = Math.min(offset + PAGE_SIZE - 1, SCAN_LIMIT - 1);
    const { data: page, error } = await supabase
      .from('ct_flow_alerts')
      .select('alert_id, ticker, side, is_ask, is_bid, strike, expiry, premium, price, executed_at, ingested_at, raw')
      .gt('ingested_at', watermark)
      .in('ticker', Array.from(watchlist))
      .order('ingested_at', { ascending: true })
      .range(offset, end);
    if (error) {
      stats.errors.push(`fetch page ${offset}: ${error.message}`);
      break;
    }
    if (!page || page.length === 0) break;
    alerts.push(...(page as FlowAlertRow[]));
    if (page.length < pageBreakSize(end, offset)) break;
  }
  stats.alerts_scanned = alerts.length;

  let latestIngested = watermark;
  const dedupeWindowMs = thresholds.dedupeMin * 60_000;

  for (const a of alerts) {
    try {
      if (a.ingested_at > latestIngested) latestIngested = a.ingested_at;

      if (!a.alert_id) continue;
      const ticker = (a.ticker ?? '').toUpperCase();
      if (!watchlist.has(ticker)) {
        stats.alarms_off_watchlist += 1;
        continue;
      }

      const side = (a.side ?? '').toLowerCase();
      if (side !== 'call' && side !== 'put') {
        stats.alarms_no_direction += 1;
        continue;
      }

      const source = inferPredictedSource(a);
      if (!source) {
        stats.alarms_no_direction += 1;
        continue;
      }

      const optionSymbol = buildOccSymbol(ticker, a.expiry, side, a.strike);
      if (!optionSymbol) {
        stats.alarms_no_symbol += 1;
        continue;
      }

      const printTime = resolvePrintTime(a);
      const dte = computeDte(printTime, a.expiry);
      const bucket = dteBucket(dte);
      const label = buildSignatureLabel(ticker, side, bucket, source);

      // 0DTE eligibility filter — kills false "NVDA 0DTE alarm" on a
      // Tuesday, when NVDA's earliest expiry is the upcoming Friday.
      // SPY/QQQ/IWM always pass; NVDA only on Friday; the rest never.
      if (bucket === '0dte' && !ticker0DteEligibleOn(ticker, eligibility, printTime)) {
        stats.alarms_skipped_0dte_ineligible += 1;
        continue;
      }

      const stat = sigStats.get(label);
      // Signature stat is optional now — bronze can fire on score alone.
      // Track the no-match count as a hint, but don't skip outright.
      const sigMedian = stat
        ? (typeof stat.median_peak_pct === 'string'
            ? parseFloat(stat.median_peak_pct)
            : Number(stat.median_peak_pct))
        : null;
      const sigN = stat?.n_tracks ?? null;
      const validSigMedian = sigMedian != null && Number.isFinite(sigMedian) ? sigMedian : null;

      // Score lives on ct_scored_flow, not ct_flow_alerts — shared helper.
      const score: number | null = await loadScoreForAlert(supabase, a.alert_id);

      stats.alarms_total_evaluated += 1;
      const tier = evaluateTier(score, validSigMedian, sigN, thresholds);

      if (tier === null) {
        // Bookkeep the dominant reason it didn't qualify.
        if (!stat) stats.alarms_no_signature_match += 1;
        else stats.alarms_below_threshold += 1;
        continue;
      }

      // Dedupe — same option_symbol within the dedupe window. Applies to
      // ALL tiers (bronze writes ct_flags too — don't double-write).
      const dedupeCutoff = new Date(Date.now() - dedupeWindowMs).toISOString();
      const { data: recent } = await supabase
        .from('ct_signature_alarm_log')
        .select('id')
        .eq('option_symbol', optionSymbol)
        .gte('fired_at', dedupeCutoff)
        .limit(1);
      if (recent && recent.length > 0) {
        stats.alarms_deduped += 1;
        continue;
      }

      // Build display strings (used for Slack + ct_flags thesis).
      const premium = a.premium == null ? null : Number(a.premium);
      const premKstr = premium != null && Number.isFinite(premium)
        ? `$${(premium / 1000).toFixed(1)}k`
        : 'n/a';
      const dteStr = dte == null ? '?' : String(dte);
      const peakPctStr = validSigMedian != null
        ? `${Math.round(validSigMedian * 100)}%`
        : 'n/a';
      const nForDisplay = sigN ?? 0;
      const scoreStr = score != null ? `Score: ${score.toFixed(0)}` : 'Score: —';
      const eligLabel = eligibility[ticker]?.label;
      const bucketStr = bucket === '0dte' && eligLabel
        ? `0DTE — ${eligLabel}`
        : `${dteStr}DTE`;

      // Per-tier Slack routing — bronze NEVER fires Slack.
      if ((tier === 'gold' || tier === 'silver') && userId) {
        const text = buildSlackText(tier, {
          ticker, side, strike: a.strike, expiry: a.expiry, bucketStr,
          source, peakPctStr, nTracks: nForDisplay, premKstr, scoreStr,
          alertId: a.alert_id,
        });
        await ctSlackPushDirect(supabase, userId, text, 'signature_alarm');
      }

      // Audit trail — write log row for ALL tiers (gold/silver/bronze).
      // median_peak_pct is NOT NULL on the table, so synthesize 0 when the
      // alarm fired purely on score (no matching signature class).
      const { error: insertErr } = await supabase
        .from('ct_signature_alarm_log')
        .insert({
          alert_id: a.alert_id,
          option_symbol: optionSymbol,
          ticker,
          signature_class: label,
          median_peak_pct: validSigMedian ?? 0,
          n: nForDisplay,
          premium,
          score,
          replay_run: replayMode,
        });
      if (insertErr) stats.errors.push(`log insert ${a.alert_id}: ${insertErr.message}`);

      // Mirror into the unified ct_flags table — visible on /flags + future
      // /tape tier-glow. tags carry both the signature class and the tier so
      // the UI can filter/style without re-evaluating thresholds.
      const direction: Direction = source === 'aggressive_ask_call' || source === 'aggressive_bid_put'
        ? 'bullish'
        : source === 'aggressive_bid_call' || source === 'aggressive_ask_put'
        ? 'bearish'
        : 'neutral';
      const horizonHours = 4;
      const horizonTs = new Date(Date.now() + horizonHours * 60 * 60_000).toISOString();
      const entryPrice = a.price == null ? null : Number(a.price);
      // Target uses signature median when present; falls back to 0 (no projected target).
      const targetPrice = entryPrice != null && Number.isFinite(entryPrice) && validSigMedian != null
        ? Number((entryPrice * (1 + validSigMedian)).toFixed(4))
        : null;
      const thesis = validSigMedian != null
        ? `[${tier.toUpperCase()}] Signature class match: ${label}. Historical median peak +${peakPctStr} on n=${nForDisplay}. Premium ${premKstr}. ${scoreStr}.`
        : `[${tier.toUpperCase()}] Score-only fire: ${scoreStr}. Class ${label} (no historical match). Premium ${premKstr}.`;

      const { error: flagErr } = await supabase
        .from('ct_flags')
        .insert({
          source: 'signature_alarm',
          specialist_ticker: null,
          instrument: ticker,
          option_symbol: optionSymbol,
          strike: a.strike,
          expiry: a.expiry,
          side,
          direction,
          score: score ?? 0,
          tags: replayMode
            ? ['signature_alarm', label, tier, 'replay']
            : ['signature_alarm', label, tier],
          thesis,
          horizon_hours: horizonHours,
          horizon_ts: horizonTs,
          entry_price: entryPrice,
          target_price: targetPrice,
          status: 'active',
        });
      if (flagErr) stats.errors.push(`flag insert ${a.alert_id}: ${flagErr.message}`);

      if (tier === 'gold') stats.alarms_fired_gold += 1;
      else if (tier === 'silver') stats.alarms_fired_silver += 1;
      else {
        stats.alarms_fired_bronze += 1;
        stats.bronze_silent_writes += 1;
      }
    } catch (e) {
      stats.errors.push(`alert ${a.alert_id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (latestIngested !== watermark) {
    await saveWatermark(supabase, latestIngested);
  }
  stats.watermark_after = latestIngested;
  return stats;
}

// Page-size guard so a short final page also breaks the loop.
function pageBreakSize(end: number, offset: number): number {
  return end - offset + 1;
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------
serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  const corsHeaders = getCorsHeaders(req);
  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const startedAt = Date.now();
  // Parse body for replay_mode flag — non-fatal on parse failure (cron
  // sends '{}' anyway). Replay mode tags rows so they're filterable later.
  let replayMode = false;
  try {
    const text = await req.text();
    if (text && text.length > 0) {
      const body = JSON.parse(text);
      if (body && body.replay_mode === true) replayMode = true;
    }
  } catch (_) { /* body optional */ }

  try {
    const thresholds = await loadTierThresholds(supabase);
    const stats = await runSweep(supabase, thresholds, replayMode);
    return new Response(JSON.stringify({
      ...stats,
      elapsed_ms: Date.now() - startedAt,
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      elapsed_ms: Date.now() - startedAt,
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
