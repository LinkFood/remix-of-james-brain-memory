/**
 * ct-contract-poller — Co-Trader contract-grading Phase B.
 *
 * Polls UW for live mid/bid/ask per active contract, updates ct_contract_tracks
 * (current_pct, peak_pct, max_drawdown, time-to-X), appends to
 * ct_contract_quotes (truth time-series for the chart drill).
 *
 * Cadence (RTH, weekdays):
 *   - High-conviction tracks → contract_poller_high_conv_cadence_min (default 5)
 *   - Low-conviction tracks  → contract_poller_low_cadence_min (default 30)
 *   - Off-hours mode         → contract_poller_post_close_cadence_min (default 240)
 *
 * High-conviction filter (v1 fallback per spec):
 *   We do NOT join to specialist scores in Phase B. Resolving per-alert
 *   specialist scores would mean joining ct_flow_alerts → ct_signatures →
 *   ct_specialist_predictions, with multiple ambiguity points (which
 *   specialist's score? which generation?). The spec sanctioned a fallback:
 *   short-DTE prints (≤7) are theta-sensitive and need the fast cadence.
 *   That cleanly maps to the "watch this carefully" intent without dragging
 *   in three more tables.
 *
 * Concurrency:
 *   UW caps at 3 concurrent requests. We run at 2 (contract_poller_uw_concurrency)
 *   via an inline pLimit. NEVER Promise.all UW calls — that 429s.
 *
 * Spread/penny filter (don't pollute peaks with noise):
 *   - mid < contract_min_mid_for_quote     → write the quote (truth) but
 *   - spread_pct > contract_max_spread_pct → DON'T update peak/trough/time_to_*
 *   The current_* fields update either way so the latest snapshot stays
 *   honest; only history-defining peaks are gated.
 *
 * Status state machine (NOT terminal except EXPIRED_*):
 *   - WORKING → WIN/LOSS based on peak_pct vs DTE-bucket threshold and
 *     max_drawdown vs contract_loss_threshold_pct.
 *   - WIN/LOSS can re-flip on later movement (a contract can WIN +120%
 *     then crash to LOSS -70% — both are true, latest snapshot wins).
 *   - EXPIRED_* is terminal.
 *   - STALE = quote failed AND last_quoted_at >120 min ago in RTH. Next
 *     successful quote moves it back to WORKING.
 *
 * Auth: service_role only. Mirror of ct-print-grader.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { getOptionContractLatestMid, uwBudgetOk, uwBudgetTier, setUwCaller, type UwBudgetTier } from '../_shared/uwClient.ts';
import { ctSlackPushDirect } from '../_shared/ctSlack.ts';

// ---------------------------------------------------------------------------
// Hard rails — caps that keep us under the 150s edge wall regardless of config.
// ---------------------------------------------------------------------------
const MAX_TRACKS_PER_RUN_FETCH = 400;     // raw scan cap; cadence filter narrows further
const MAX_UPDATE_ERRORS = 5;              // bail after this many track-update DB errors
const STALE_MIN = 120;                    // quote miss + last_quoted_at >this min → STALE
const FN_NAME = 'ct-contract-poller';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type Mode = 'rth' | 'offhours';
type TrackStatus = 'WORKING' | 'WIN' | 'LOSS' | 'EXPIRED_WIN' | 'EXPIRED_LOSS' | 'EXPIRED_FLAT' | 'STALE';
type DteBucket = '0dte' | 'short' | 'mid' | 'long';

interface ContractTrack {
  id: string;
  alert_id: string;
  option_symbol: string;
  ticker: string;
  side: string | null;
  expiry: string | null;
  dte_at_print: number | null;
  predicted_direction: string;
  entry_contract_price: number | null;
  entry_source: string;
  peak_contract_pct: number | null;
  max_drawdown_pct: number | null;
  peak_contract_price: number | null;
  trough_contract_price: number | null;
  time_to_50pct: string | null;     // pg interval comes back as ISO duration string
  time_to_100pct: string | null;
  time_to_200pct: string | null;
  first_tracked_at: string | null;
  last_quoted_at: string | null;
  sweep_count: number | null;
  tracking_until: string;
  print_time: string;
  track_status: TrackStatus;
}

interface PollerConfig {
  highConvictionScore: number;          // unused in v1 fallback (kept for the moment we wire scores)
  highConvCadenceMin: number;
  lowCadenceMin: number;
  maxPerRun: number;
  uwConcurrency: number;
  postCloseCadenceMin: number;
  minMidForQuote: number;
  maxSpreadPct: number;
  // DTE-bucket WIN thresholds for status flips
  winThresholds: Record<DteBucket, number>;
  lossThreshold: number;
}

interface Stats {
  ok: boolean;
  elapsed_ms: number;
  mode: Mode;
  tracks_eligible: number;
  unique_symbols: number;
  tracks_updated: number;
  quotes_inserted: number;
  win_flips: number;
  loss_flips: number;
  expired_flips: number;
  stale_flips: number;
  spread_filtered: number;
  tracks_filtered_off_watchlist: number;
  budget_exhausted: boolean;
  budget_tier: UwBudgetTier;
  budget_pct_used: number | null;
  uw_calls: number;
  /** When tier-modulo throttle skips this run, this records the reason. */
  skipped_reason: string | null;
  errors: string[];
}

// Filter applied at the SQL level when budget tier restricts polling.
// `dteMax` caps dte_at_print; `staleMin` requires last_quoted_at older than
// N minutes (or NULL). Both null → no restriction (unrestricted tier).
interface TierFilter {
  dteMax: number | null;
  staleMin: number | null;
}

function tierFilterFor(tier: UwBudgetTier): TierFilter {
  switch (tier) {
    case 'critical':  return { dteMax: 7,  staleMin: 60 };
    case 'tightened': return { dteMax: 30, staleMin: 30 };
    default:          return { dteMax: null, staleMin: null };
  }
}

// ---------------------------------------------------------------------------
// Watchlist loader — single source of truth in ct_config.watcher.watchlist.
// Defaults to the canonical 10-ticker list if config lookup fails so the
// poller never silently runs unfiltered (UW budget discipline, see CLAUDE.md).
// ---------------------------------------------------------------------------
const DEFAULT_WATCHLIST = ['SPY','QQQ','IWM','AAPL','MSFT','GOOGL','AMZN','META','NVDA','TSLA'];

async function loadWatchlist(supabase: SupabaseClient): Promise<Set<string>> {
  const defaults = new Set(DEFAULT_WATCHLIST);
  const { data, error } = await supabase
    .from('ct_config')
    .select('value')
    .eq('key', 'watcher.watchlist')
    .maybeSingle();
  if (error || !data?.value) return defaults;
  const arr = data.value as unknown;
  if (!Array.isArray(arr)) return defaults;
  const set = new Set<string>();
  for (const t of arr) {
    if (typeof t === 'string' && t.length > 0) set.add(t.toUpperCase());
  }
  return set.size > 0 ? set : defaults;
}

// ---------------------------------------------------------------------------
// Config loader — one read, all keys.
// ---------------------------------------------------------------------------
async function loadPollerConfig(supabase: SupabaseClient): Promise<PollerConfig> {
  const defaults: PollerConfig = {
    highConvictionScore: 70,
    highConvCadenceMin: 5,
    lowCadenceMin: 30,
    maxPerRun: 60,
    uwConcurrency: 2,
    postCloseCadenceMin: 240,
    minMidForQuote: 0.05,
    maxSpreadPct: 0.30,
    winThresholds: { '0dte': 0.50, short: 0.50, mid: 1.00, long: 2.00 },
    lossThreshold: 0.50,
  };

  const keys = [
    'contract_poller_high_conviction_score',
    'contract_poller_high_conv_cadence_min',
    'contract_poller_low_cadence_min',
    'contract_poller_max_per_run',
    'contract_poller_uw_concurrency',
    'contract_poller_post_close_cadence_min',
    'contract_min_mid_for_quote',
    'contract_max_spread_pct',
    'contract_grade_threshold_0dte',
    'contract_grade_threshold_short',
    'contract_grade_threshold_mid',
    'contract_grade_threshold_long',
    'contract_loss_threshold_pct',
  ];

  const { data, error } = await supabase
    .from('ct_config')
    .select('key, value')
    .in('key', keys);
  if (error || !data) return defaults;

  const out: PollerConfig = JSON.parse(JSON.stringify(defaults));
  for (const row of data) {
    const v = row.value;
    const n = typeof v === 'number' ? v : (typeof v === 'string' ? parseFloat(v) : NaN);
    if (!Number.isFinite(n) || n < 0) continue;
    switch (row.key) {
      case 'contract_poller_high_conviction_score': out.highConvictionScore = n; break;
      case 'contract_poller_high_conv_cadence_min': out.highConvCadenceMin = n; break;
      case 'contract_poller_low_cadence_min': out.lowCadenceMin = n; break;
      case 'contract_poller_max_per_run': out.maxPerRun = Math.floor(n); break;
      case 'contract_poller_uw_concurrency': out.uwConcurrency = Math.max(1, Math.min(3, Math.floor(n))); break;
      case 'contract_poller_post_close_cadence_min': out.postCloseCadenceMin = n; break;
      case 'contract_min_mid_for_quote': out.minMidForQuote = n; break;
      case 'contract_max_spread_pct': out.maxSpreadPct = n; break;
      case 'contract_grade_threshold_0dte': out.winThresholds['0dte'] = n; break;
      case 'contract_grade_threshold_short': out.winThresholds.short = n; break;
      case 'contract_grade_threshold_mid': out.winThresholds.mid = n; break;
      case 'contract_grade_threshold_long': out.winThresholds.long = n; break;
      case 'contract_loss_threshold_pct': out.lossThreshold = n; break;
    }
  }
  return out;
}

function dteBucket(dte: number | null): DteBucket {
  if (dte === null || !Number.isFinite(dte)) return 'long';
  if (dte <= 0) return '0dte';
  if (dte <= 7) return 'short';
  if (dte <= 30) return 'mid';
  return 'long';
}

function winThresholdForDte(dte: number | null, t: PollerConfig['winThresholds']): number {
  return t[dteBucket(dte)];
}

// ---------------------------------------------------------------------------
// Inline concurrency limiter. Never Promise.all UW (429s at 3+).
// ---------------------------------------------------------------------------
function pLimit<T>(concurrency: number, jobs: Array<() => Promise<T>>): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const results: T[] = new Array(jobs.length);
    let idx = 0;
    let inflight = 0;
    let completed = 0;
    let failed = false;

    const launch = () => {
      if (failed) return;
      while (inflight < concurrency && idx < jobs.length) {
        const myIdx = idx++;
        inflight += 1;
        jobs[myIdx]()
          .then((v) => { results[myIdx] = v; })
          .catch((e) => { if (!failed) { failed = true; reject(e); } })
          .finally(() => {
            inflight -= 1;
            completed += 1;
            if (completed === jobs.length && !failed) resolve(results);
            else launch();
          });
      }
    };
    if (jobs.length === 0) resolve([]);
    else launch();
  });
}

// ---------------------------------------------------------------------------
// Eligible-track fetch — LRU on last_quoted_at NULLS FIRST.
// Watchlist filter applied server-side via .in() — off-watchlist tracks
// never enter the pipeline (UW budget discipline).
// ---------------------------------------------------------------------------
// Sweep WORKING/STALE tracks past their tracking_until and flip them to a
// terminal EXPIRED_* status. fetchEligibleTracks below filters by
// `tracking_until > now` for UW efficiency, which means past-due tracks
// would never be polled and would silently zombie in WORKING forever
// without this sweep. No UW calls — we already have peak + current pcts
// stored from earlier polls (or 0/0 if never polled).
async function expirePastDueTracks(
  supabase: SupabaseClient,
  cfg: PollerConfig,
  watchlist: Set<string>,
  stats: Stats,
): Promise<void> {
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from('ct_contract_tracks')
    .select('id, dte_at_print, peak_contract_pct, max_drawdown_pct')
    .in('track_status', ['WORKING', 'STALE', 'WIN', 'LOSS'])
    .in('ticker', Array.from(watchlist))
    .lte('tracking_until', nowIso)
    .limit(2000);
  if (error) {
    stats.errors.push(`expire sweep fetch: ${error.message}`);
    return;
  }
  if (!data || data.length === 0) return;

  const updates: Array<{ id: string; status: TrackStatus }> = [];
  for (const t of data as Array<{ id: string; dte_at_print: number | null; peak_contract_pct: number | null; max_drawdown_pct: number | null }>) {
    const peak = t.peak_contract_pct ?? 0;
    const winT = winThresholdForDte(t.dte_at_print, cfg.winThresholds);
    let status: TrackStatus;
    if (peak >= winT) status = 'EXPIRED_WIN';
    else if ((t.max_drawdown_pct ?? 0) >= cfg.lossThreshold) status = 'EXPIRED_LOSS';
    else status = 'EXPIRED_FLAT';
    updates.push({ id: t.id, status });
  }

  // Group by status — three batched UPDATEs, not N individual writes.
  const byStatus = new Map<TrackStatus, string[]>();
  for (const u of updates) {
    const arr = byStatus.get(u.status) ?? [];
    arr.push(u.id);
    byStatus.set(u.status, arr);
  }
  for (const [status, ids] of byStatus.entries()) {
    const { error: upErr } = await supabase
      .from('ct_contract_tracks')
      .update({ track_status: status, last_tracked_at: nowIso })
      .in('id', ids);
    if (upErr) {
      stats.errors.push(`expire sweep update ${status}: ${upErr.message}`);
      continue;
    }
    stats.expired_flips += ids.length;
  }
}

async function fetchEligibleTracks(
  supabase: SupabaseClient,
  watchlist: Set<string>,
  oldestFirst = false,
  printTimeGte: string | null = null,
  tierFilter: TierFilter = { dteMax: null, staleMin: null },
): Promise<ContractTrack[]> {
  const nowIso = new Date().toISOString();
  // CUT 2 — skip dead 0DTE contracts. After the underlying close the contract
  // is worthless or 100% intrinsic; either way the price stops moving. We
  // exclude:
  //   - expiry < today (always — those are post-expiry, value is locked)
  //   - expiry == today AND now ET >= 16:00 (RTH closed; same logic)
  // Today's expiry pre-close stays in the pool because that's where the
  // theta-pop lottery tickets live.
  const todayUtc = new Date();
  const todayDateStr = todayUtc.toISOString().slice(0, 10); // YYYY-MM-DD UTC
  // ET hour: UTC - 4 (EDT) is good enough for 4 PM gating (DST window). The
  // poller only fires `13-20 UTC` weekdays per cron, so we just need the
  // boundary right during RTH hours.
  const utcHour = todayUtc.getUTCHours();
  // 16:00 ET = 20:00 UTC (EDT) / 21:00 UTC (EST). Use 20:00 UTC as the cutoff
  // since cron stops at 20 UTC anyway — past that point we're post-close.
  const isPastEtClose = utcHour >= 20;
  const expiryFloor = isPastEtClose
    // After 4 PM ET — exclude today's expiry too, so floor is tomorrow.
    ? new Date(todayUtc.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    // Pre-close — today's expiry still polls.
    : todayDateStr;
  // Primary order: nulls-first on last_quoted_at (unpolled get priority).
  // Tiebreaker on print_time: DESC by default (newest unpolled first — steady
  // state wants fresh prints visible fast). With oldestFirst=true (backfill
  // mode), flip to ASC so the queue drains from market open forward — gives
  // the operator a deterministic walk to fill in early-day chips on /tape.
  let q = supabase
    .from('ct_contract_tracks')
    .select(
      'id, alert_id, option_symbol, ticker, side, expiry, dte_at_print, ' +
      'predicted_direction, entry_contract_price, entry_source, ' +
      'peak_contract_pct, max_drawdown_pct, peak_contract_price, ' +
      'trough_contract_price, time_to_50pct, time_to_100pct, time_to_200pct, ' +
      'first_tracked_at, last_quoted_at, sweep_count, tracking_until, print_time, track_status',
    )
    .in('track_status', ['WORKING', 'STALE'])
    .in('ticker', Array.from(watchlist))
    .gt('tracking_until', nowIso)
    .gte('expiry', expiryFloor);
  if (printTimeGte) q = q.gte('print_time', printTimeGte);
  // Tiered budget restriction — applied at SQL level so off-tier tracks
  // never enter the symbol-dedup pool and never compete for cfg.maxPerRun slots.
  if (tierFilter.dteMax !== null) {
    q = q.lte('dte_at_print', tierFilter.dteMax);
  }
  if (tierFilter.staleMin !== null) {
    const staleCutoff = new Date(Date.now() - tierFilter.staleMin * 60_000).toISOString();
    q = q.or(`last_quoted_at.is.null,last_quoted_at.lt.${staleCutoff}`);
  }
  q = q.order('last_quoted_at', { ascending: true, nullsFirst: true })
    .order('print_time', { ascending: oldestFirst });
  const { data, error } = await q.limit(MAX_TRACKS_PER_RUN_FETCH);

  if (error) {
    console.error(`[${FN_NAME}] eligible fetch: ${error.message}`);
    return [];
  }
  return (data ?? []) as ContractTrack[];
}

// ---------------------------------------------------------------------------
// Cadence filter — choose tracks that are DUE for a quote.
// ---------------------------------------------------------------------------
function filterByCadence(
  tracks: ContractTrack[],
  cfg: PollerConfig,
  mode: Mode,
): ContractTrack[] {
  const nowMs = Date.now();
  const offhoursMin = cfg.postCloseCadenceMin;
  return tracks.filter((t) => {
    if (!t.last_quoted_at) return true;
    const lastMs = new Date(t.last_quoted_at).getTime();
    if (!Number.isFinite(lastMs)) return true;
    const minutesSince = (nowMs - lastMs) / 60_000;
    if (mode === 'offhours') return minutesSince >= offhoursMin;
    // High-conviction proxy (v1 fallback): short-DTE = polls fast.
    const isHighConv = (t.dte_at_print ?? 999) <= 7;
    const cadence = isHighConv ? cfg.highConvCadenceMin : cfg.lowCadenceMin;
    return minutesSince >= cadence;
  });
}

// ---------------------------------------------------------------------------
// time_to_X helpers. Convert ms → ISO interval string Postgres accepts.
// ---------------------------------------------------------------------------
function msToIsoInterval(ms: number): string {
  // Postgres accepts ISO-8601 durations: PT1H30M5S
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  let out = 'P';
  if (days > 0) out += `${days}D`;
  if (hours > 0 || minutes > 0 || seconds > 0 || days === 0) {
    out += 'T';
    if (hours > 0) out += `${hours}H`;
    if (minutes > 0) out += `${minutes}M`;
    if (seconds > 0 || (hours === 0 && minutes === 0)) out += `${seconds}S`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Compute the per-track update from a fresh quote.
// Contract semantics: UP IS GOOD for both calls and puts (the option owner
// wants the contract to gain value regardless of side). predicted_direction
// is for the UNDERLYING; the contract owner's P&L is unsigned in side.
// ---------------------------------------------------------------------------
interface QuoteApplied {
  update: Record<string, unknown>;
  newStatus: TrackStatus;
  flippedToWin: boolean;
  flippedToLoss: boolean;
  flippedToExpired: boolean;
  flippedToStale: boolean;
  spreadFiltered: boolean;
}

function applyQuoteToTrack(
  track: ContractTrack,
  quote: { mid: number | null; bid: number | null; ask: number | null; last: number | null; spreadPct: number | null; ts: string | null },
  cfg: PollerConfig,
  nowIso: string,
): QuoteApplied {
  const printTimeMs = new Date(track.print_time).getTime();
  const nowMs = Date.now();

  // Resolve effective price: prefer mid, fall back to last.
  const effectivePrice = quote.mid !== null ? quote.mid : quote.last;
  const entry = track.entry_contract_price;

  const update: Record<string, unknown> = {
    sweep_count: (track.sweep_count ?? 0) + 1,
    last_quoted_at: nowIso,
    last_tracked_at: nowIso,
  };

  let newStatus: TrackStatus = track.track_status;
  let flippedToWin = false;
  let flippedToLoss = false;
  let flippedToExpired = false;
  let flippedToStale = false;
  let spreadFiltered = false;

  // Always update current_*
  if (effectivePrice !== null && entry !== null && entry > 0) {
    const currentPct = (effectivePrice - entry) / entry;
    update.current_contract_price = Number(effectivePrice.toFixed(4));
    update.current_contract_pct = Number(currentPct.toFixed(6));
  } else if (effectivePrice !== null) {
    update.current_contract_price = Number(effectivePrice.toFixed(4));
    // Without entry, we can't compute pct — leave unset.
  }

  // Spread/penny filter — do we trust this for peak/trough updates?
  const trustForPeaks = (
    quote.mid !== null &&
    quote.mid >= cfg.minMidForQuote &&
    (quote.spreadPct === null || quote.spreadPct <= cfg.maxSpreadPct)
  );

  if (!trustForPeaks) {
    spreadFiltered = true;
  } else if (effectivePrice !== null && entry !== null && entry > 0) {
    const currentPct = (effectivePrice - entry) / entry;
    const prevPeak = Number(track.peak_contract_pct ?? 0);
    const prevDrawdown = Number(track.max_drawdown_pct ?? 0);

    const newPeak = Math.max(prevPeak, currentPct);
    const newDrawdown = Math.max(prevDrawdown, -currentPct);

    if (newPeak > prevPeak) {
      update.peak_contract_pct = Number(newPeak.toFixed(6));
      update.peak_contract_price = Number(effectivePrice.toFixed(4));
      update.peak_contract_at = nowIso;
    }
    if (newDrawdown > prevDrawdown) {
      update.max_drawdown_pct = Number(newDrawdown.toFixed(6));
      update.trough_contract_price = Number(effectivePrice.toFixed(4));
      update.trough_contract_at = nowIso;
    }

    // First-cross intervals — only set once.
    const elapsedMs = nowMs - printTimeMs;
    if (!track.time_to_50pct && newPeak >= 0.5) {
      update.time_to_50pct = msToIsoInterval(elapsedMs);
    }
    if (!track.time_to_100pct && newPeak >= 1.0) {
      update.time_to_100pct = msToIsoInterval(elapsedMs);
    }
    if (!track.time_to_200pct && newPeak >= 2.0) {
      update.time_to_200pct = msToIsoInterval(elapsedMs);
    }

    // Status flips. EXPIRED_* is terminal — handled below in expiry check.
    const winThreshold = winThresholdForDte(track.dte_at_print, cfg.winThresholds);
    const isTerminal = newStatus === 'EXPIRED_WIN' || newStatus === 'EXPIRED_LOSS' || newStatus === 'EXPIRED_FLAT';
    if (!isTerminal) {
      if (newPeak >= winThreshold) {
        if (track.track_status !== 'WIN') flippedToWin = true;
        newStatus = 'WIN';
      } else if (newDrawdown >= cfg.lossThreshold) {
        if (track.track_status !== 'LOSS') flippedToLoss = true;
        newStatus = 'LOSS';
      } else if (track.track_status === 'STALE') {
        // Recovery: STALE → WORKING when we get a successful quote.
        newStatus = 'WORKING';
      }
    }
  }

  // Expiry check — terminal flip if we're past tracking_until.
  const trackingUntilMs = new Date(track.tracking_until).getTime();
  if (Number.isFinite(trackingUntilMs) && nowMs >= trackingUntilMs) {
    const isTerminal = newStatus === 'EXPIRED_WIN' || newStatus === 'EXPIRED_LOSS' || newStatus === 'EXPIRED_FLAT';
    if (!isTerminal) {
      const winThreshold = winThresholdForDte(track.dte_at_print, cfg.winThresholds);
      const peakForExpiry = Math.max(
        Number(track.peak_contract_pct ?? 0),
        update.peak_contract_pct !== undefined ? Number(update.peak_contract_pct) : -Infinity,
      );
      const currentForExpiry = update.current_contract_pct !== undefined ? Number(update.current_contract_pct) : 0;
      if (peakForExpiry >= winThreshold) newStatus = 'EXPIRED_WIN';
      else if (currentForExpiry < 0) newStatus = 'EXPIRED_LOSS';
      else newStatus = 'EXPIRED_FLAT';
      flippedToExpired = true;
    }
  }

  if (newStatus !== track.track_status) {
    update.track_status = newStatus;
  }

  return { update, newStatus, flippedToWin, flippedToLoss, flippedToExpired, flippedToStale, spreadFiltered };
}

// On a quote miss — bump sweep_count, optionally flip STALE.
function applyMissToTrack(
  track: ContractTrack,
  nowIso: string,
): { update: Record<string, unknown>; flippedToStale: boolean } {
  const update: Record<string, unknown> = {
    sweep_count: (track.sweep_count ?? 0) + 1,
    last_tracked_at: nowIso,
  };
  // STALE detection — last successful quote >120 min ago AND not already terminal.
  let flippedToStale = false;
  const isTerminal = track.track_status === 'EXPIRED_WIN' || track.track_status === 'EXPIRED_LOSS' || track.track_status === 'EXPIRED_FLAT';
  if (!isTerminal && track.track_status !== 'STALE' && track.last_quoted_at) {
    const lastMs = new Date(track.last_quoted_at).getTime();
    const minutesSince = (Date.now() - lastMs) / 60_000;
    if (Number.isFinite(minutesSince) && minutesSince >= STALE_MIN) {
      update.track_status = 'STALE';
      flippedToStale = true;
    }
  }
  return { update, flippedToStale };
}

// ---------------------------------------------------------------------------
// Budget-tier Slack alarm — one fire per day per tier (critical / exhausted).
// Tracked in ct_uw_alarm_state (single-row table, id=1).
// ---------------------------------------------------------------------------
async function maybeFireBudgetAlarm(
  supabase: SupabaseClient,
  tier: 'critical' | 'exhausted',
  pctUsed: number | null,
): Promise<void> {
  const today = new Date().toISOString().slice(0, 10); // UTC YYYY-MM-DD
  const col = tier === 'critical' ? 'last_critical_alarm_date' : 'last_exhausted_alarm_date';

  const { data: state } = await supabase
    .from('ct_uw_alarm_state')
    .select(col)
    .eq('id', 1)
    .maybeSingle();
  const lastFired = (state as Record<string, string | null> | null)?.[col] ?? null;
  if (lastFired === today) return;

  const pctStr = pctUsed !== null ? `${(pctUsed * 100).toFixed(0)}%` : 'unknown';
  const text = tier === 'critical'
    ? `:warning: UW budget at ${pctStr} — ct-contract-poller restricting to short-DTE active contracts only.`
    : `:octagonal_sign: UW budget exhausted (${pctStr}) — ct-contract-poller halted for today. Resumes at next UTC day rollover.`;

  // Single-user pattern (mirror of ct-cron-health-check).
  const { data: users } = await supabase.from('profiles').select('id').limit(1);
  const userId = (users?.[0]?.id as string | undefined) ?? null;
  if (userId) {
    await ctSlackPushDirect(supabase, userId, text, `uw_budget_${tier}`);
  }

  // Stamp the date BEFORE the push would normally complete to avoid race on
  // back-to-back invocations within the same minute.
  await supabase
    .from('ct_uw_alarm_state')
    .upsert({ id: 1, [col]: today, updated_at: new Date().toISOString() }, { onConflict: 'id' });
}

// ---------------------------------------------------------------------------
// Ship 2 — per-attempt telemetry flush. One batched insert at function exit,
// fire-and-forget (catch + swallow). Never block the existing update path.
// ---------------------------------------------------------------------------
async function flushPollerLog(
  supabase: SupabaseClient,
  rows: Array<{
    run_id: string;
    option_symbol: string;
    ticker: string | null;
    dte: number | null;
    sweep_reason: string;
    latency_ms: number | null;
    error_msg: string | null;
  }>,
): Promise<void> {
  if (rows.length === 0) return;
  try {
    // error_msg cap to 500 chars so a runaway UW message doesn't blow the row.
    const slim = rows.map((r) => ({
      run_id: r.run_id,
      option_symbol: r.option_symbol,
      ticker: r.ticker,
      dte: r.dte,
      sweep_reason: r.sweep_reason,
      latency_ms: r.latency_ms,
      error_msg: r.error_msg ? r.error_msg.slice(0, 500) : null,
    }));
    const chunkSize = 200;
    for (let i = 0; i < slim.length; i += chunkSize) {
      const slice = slim.slice(i, i + chunkSize);
      const { error } = await supabase.from('ct_contract_poller_log').insert(slice);
      if (error) {
        console.error(`[${FN_NAME}] poller-log flush: ${error.message}`);
        break;
      }
    }
  } catch (e) {
    console.error(`[${FN_NAME}] poller-log flush threw: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---------------------------------------------------------------------------
// Main entry
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

  setUwCaller(FN_NAME);

  const startedAt = Date.now();
  // Ship 2 — per-attempt telemetry. One run_id per invocation; rows pushed at
  // every decision point and flushed fire-and-forget at function exit so they
  // never block the existing update path.
  const runId = crypto.randomUUID();
  type PollerLogRow = {
    run_id: string;
    option_symbol: string;
    ticker: string | null;
    dte: number | null;
    sweep_reason:
      | 'tightened_throttle'
      | 'critical_throttle'
      | 'exhausted_full_halt'
      | 'skipped_cadence'
      | 'skipped_cap'
      | 'skipped_budget'
      | 'quote_written'
      | 'quote_dropped'
      | 'uw_error';
    latency_ms: number | null;
    error_msg: string | null;
  };
  const pollerLog: PollerLogRow[] = [];
  const logSkip = (
    sweep_reason: PollerLogRow['sweep_reason'],
    option_symbol: string,
    ticker: string | null = null,
    dte: number | null = null,
    latency_ms: number | null = null,
    error_msg: string | null = null,
  ) => {
    pollerLog.push({ run_id: runId, option_symbol, ticker, dte, sweep_reason, latency_ms, error_msg });
  };
  const stats: Stats = {
    ok: true,
    elapsed_ms: 0,
    mode: 'rth',
    tracks_eligible: 0,
    unique_symbols: 0,
    tracks_updated: 0,
    quotes_inserted: 0,
    win_flips: 0,
    loss_flips: 0,
    expired_flips: 0,
    stale_flips: 0,
    spread_filtered: 0,
    tracks_filtered_off_watchlist: 0,
    budget_exhausted: false,
    budget_tier: 'unrestricted',
    budget_pct_used: null,
    uw_calls: 0,
    skipped_reason: null,
    errors: [],
  };

  // Hoisted to function scope so the final fire-and-forget poller-log flush
  // (Ship 2) can see it even if the try block bails early.
  let supabase: SupabaseClient | undefined;

  try {
    let mode: Mode = 'rth';
    let oldestFirst = false;
    let printTimeGte: string | null = null;
    try {
      const body = await req.json().catch(() => ({}));
      if (body && body.mode === 'offhours') mode = 'offhours';
      if (body && body.oldest_first === true) oldestFirst = true;
      if (body && typeof body.print_time_gte === 'string') printTimeGte = body.print_time_gte;
    } catch { /* ignore */ }
    stats.mode = mode;

    supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const cfg = await loadPollerConfig(supabase);
    const watchlist = await loadWatchlist(supabase);

    // Cache the budget tier ONCE per run — the per-call uwBudgetOk() inside
    // each job stays in place as a final safety net for cliff-edge exhaustion.
    const tierResult = await uwBudgetTier();
    stats.budget_tier = tierResult.tier;
    stats.budget_pct_used = tierResult.pct_used;
    const tierFilter = tierFilterFor(tierResult.tier);

    // Fire one Slack alarm per day per tier when we cross into critical /
    // exhausted. Alarm-state row is single-row by PK convention so we just
    // upsert id=1.
    if (tierResult.tier === 'critical' || tierResult.tier === 'exhausted') {
      try { await maybeFireBudgetAlarm(supabase, tierResult.tier, tierResult.pct_used); }
      catch (e) { stats.errors.push(`alarm: ${e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200)}`); }
    }

    // CUT 1 — Tier-aware cadence throttle (LB8 UW budget reduction).
    // Cron fires every 4 min RTH. When the budget tier tightens, we keep the
    // cron schedule but skip work on most invocations:
    //   tightened (>=70% used) → effective */5 (skip if min % 5 !== 0)
    //   critical  (>=85% used) → effective */7 (skip if min % 7 !== 0)
    //   exhausted (>=95% used) → handled below (full short-circuit)
    // The minute-modulo gate is intentionally simple — the cron's */4 spacing
    // means most modulo values land on a fire window; we lose ~70-80% of
    // invocations under tightened/critical, which is the goal.
    const minuteOfHour = new Date().getMinutes();
    if (tierResult.tier === 'tightened' && minuteOfHour % 5 !== 0) {
      stats.skipped_reason = `tightened_throttle_min_${minuteOfHour}_mod5`;
      logSkip('tightened_throttle', '__cron_skip__', null, null, null, stats.skipped_reason);
      stats.elapsed_ms = Date.now() - startedAt;
      await flushPollerLog(supabase, pollerLog);
      return new Response(JSON.stringify(stats), {
        status: 200,
        headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
      });
    }
    if (tierResult.tier === 'critical' && minuteOfHour % 7 !== 0) {
      stats.skipped_reason = `critical_throttle_min_${minuteOfHour}_mod7`;
      logSkip('critical_throttle', '__cron_skip__', null, null, null, stats.skipped_reason);
      stats.elapsed_ms = Date.now() - startedAt;
      await flushPollerLog(supabase, pollerLog);
      return new Response(JSON.stringify(stats), {
        status: 200,
        headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
      });
    }

    // Exhausted tier — short-circuit before doing any UW-spending work.
    if (tierResult.tier === 'exhausted') {
      stats.budget_exhausted = true;
      stats.skipped_reason = 'exhausted_full_halt';
      logSkip('exhausted_full_halt', '__cron_skip__', null, null, null, stats.skipped_reason);
      stats.elapsed_ms = Date.now() - startedAt;
      await flushPollerLog(supabase, pollerLog);
      return new Response(JSON.stringify(stats), {
        status: 200,
        headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
      });
    }

    // Sweep past-due WORKING/STALE tracks to terminal EXPIRED_*. Must run
    // before fetchEligibleTracks because that query filters tracking_until>now,
    // so past-due tracks would never be polled or graduated otherwise.
    await expirePastDueTracks(supabase, cfg, watchlist, stats);

    // Visibility: how many otherwise-eligible WORKING/STALE tracks we skip
    // because they're off-watchlist. Cheap HEAD count, no row payload.
    const nowIsoForCount = new Date().toISOString();
    const { count: offWatchlistCount } = await supabase
      .from('ct_contract_tracks')
      .select('id', { count: 'estimated', head: true })
      .in('track_status', ['WORKING', 'STALE'])
      .not('ticker', 'in', `(${Array.from(watchlist).map((t) => `"${t}"`).join(',')})`)
      .gt('tracking_until', nowIsoForCount);
    stats.tracks_filtered_off_watchlist = offWatchlistCount ?? 0;

    const allTracks = await fetchEligibleTracks(supabase, watchlist, oldestFirst, printTimeGte, tierFilter);
    const dueTracks = filterByCadence(allTracks, cfg, mode);
    stats.tracks_eligible = dueTracks.length;

    // Ship 2 telemetry — log tracks dropped by the cadence filter. Dedup by
    // option_symbol here so we log one row per unique contract not yet due
    // (matches how skipped_cap is bucketed below).
    {
      const dueSet = new Set(dueTracks.map((t) => t.option_symbol).filter(Boolean));
      const loggedCadence = new Set<string>();
      for (const t of allTracks) {
        if (!t.option_symbol) continue;
        if (dueSet.has(t.option_symbol)) continue;
        if (loggedCadence.has(t.option_symbol)) continue;
        loggedCadence.add(t.option_symbol);
        logSkip('skipped_cadence', t.option_symbol, t.ticker, t.dte_at_print);
      }
    }

    // Dedup by option_symbol — many tracks can share a contract.
    const bySymbol = new Map<string, ContractTrack[]>();
    for (const t of dueTracks) {
      if (!t.option_symbol) continue;
      const arr = bySymbol.get(t.option_symbol);
      if (arr) arr.push(t);
      else bySymbol.set(t.option_symbol, [t]);
    }

    // Cap unique symbols at maxPerRun (LRU within bySymbol — Map preserves
    // insertion order, and dueTracks was already LRU-sorted by last_quoted_at).
    const allSymbols = [...bySymbol.keys()];
    const symbols = allSymbols.slice(0, cfg.maxPerRun);
    stats.unique_symbols = symbols.length;

    // Ship 2 telemetry — log unique contracts dropped by the maxPerRun cap.
    // These are the LRU tail that wasn't budget-blocked, just past the slice.
    for (const sym of allSymbols.slice(cfg.maxPerRun)) {
      const arr = bySymbol.get(sym);
      const first = arr?.[0];
      logSkip('skipped_cap', sym, first?.ticker ?? null, first?.dte_at_print ?? null);
    }

    // Pull quotes with controlled concurrency. Inline pLimit cap at uwConcurrency.
    type QuoteResult = {
      symbol: string;
      ok: boolean;
      mid: number | null;
      bid: number | null;
      ask: number | null;
      last: number | null;
      spreadPct: number | null;
      ts: string | null;
    };
    const quoteResults: QuoteResult[] = [];
    let updateErrors = 0;
    const nowIso = new Date().toISOString();

    // Build job array — each job is one UW call. We check budget INSIDE the
    // job so a mid-loop exhaustion stops new calls but in-flight ones complete.
    const jobs: Array<() => Promise<void>> = symbols.map((symbol) => async () => {
      const tracksForSym = bySymbol.get(symbol);
      const head = tracksForSym?.[0];
      const symTicker = head?.ticker ?? null;
      const symDte = head?.dte_at_print ?? null;
      if (stats.budget_exhausted) {
        logSkip('skipped_budget', symbol, symTicker, symDte, null, 'budget_exhausted_pre_check');
        return;
      }
      const ok = await uwBudgetOk();
      if (!ok) {
        stats.budget_exhausted = true;
        logSkip('skipped_budget', symbol, symTicker, symDte, null, 'uw_budget_ok_false');
        return;
      }
      stats.uw_calls += 1;
      const t0 = Date.now();
      try {
        const q = await getOptionContractLatestMid(symbol);
        const latency = Date.now() - t0;
        quoteResults.push({
          symbol,
          ok: q.ok,
          mid: q.mid,
          bid: q.bid,
          ask: q.ask,
          last: q.last,
          spreadPct: q.spreadPct,
          ts: q.ts,
        });
        if (q.ok && q.mid !== null) {
          logSkip('quote_written', symbol, symTicker, symDte, latency);
        } else {
          logSkip('quote_dropped', symbol, symTicker, symDte, latency,
            `ok=${q.ok}|mid=${q.mid === null ? 'null' : q.mid}`);
        }
      } catch (e) {
        const latency = Date.now() - t0;
        quoteResults.push({ symbol, ok: false, mid: null, bid: null, ask: null, last: null, spreadPct: null, ts: null });
        const msg = e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200);
        stats.errors.push(`uw ${symbol}: ${msg}`);
        logSkip('uw_error', symbol, symTicker, symDte, latency, msg);
      }
    });

    await pLimit(cfg.uwConcurrency, jobs);

    // Insert quotes for successful pulls (truth — even spread-filtered get written).
    const quoteRows = quoteResults
      .filter((q) => q.ok && q.mid !== null)
      .map((q) => ({
        option_symbol: q.symbol,
        ts: q.ts ?? nowIso,
        bid: q.bid,
        ask: q.ask,
        mid: q.mid,
        last: q.last,
        spread_pct: q.spreadPct,
        source: 'uw_flow_latest',
      }));
    if (quoteRows.length > 0) {
      const chunkSize = 100;
      for (let i = 0; i < quoteRows.length; i += chunkSize) {
        const slice = quoteRows.slice(i, i + chunkSize);
        const { error: insErr, count } = await supabase
          .from('ct_contract_quotes')
          .insert(slice, { count: 'exact' });
        if (insErr) {
          stats.errors.push(`quote-insert: ${insErr.message.slice(0, 200)}`);
          continue;
        }
        stats.quotes_inserted += count ?? slice.length;
      }
    }

    // Apply per-track updates.
    const quoteBySymbol = new Map<string, QuoteResult>();
    for (const q of quoteResults) quoteBySymbol.set(q.symbol, q);

    for (const symbol of symbols) {
      if (updateErrors >= MAX_UPDATE_ERRORS) {
        stats.errors.push(`update-error cap (${MAX_UPDATE_ERRORS}) reached — bailing`);
        break;
      }
      const linkedTracks = bySymbol.get(symbol) ?? [];
      const q = quoteBySymbol.get(symbol);
      const succeeded = q && q.ok && q.mid !== null;

      for (const track of linkedTracks) {
        try {
          let update: Record<string, unknown>;
          let flippedToWin = false;
          let flippedToLoss = false;
          let flippedToExpired = false;
          let flippedToStale = false;
          let spreadFiltered = false;

          if (succeeded && q) {
            const r = applyQuoteToTrack(track, q, cfg, nowIso);
            update = r.update;
            flippedToWin = r.flippedToWin;
            flippedToLoss = r.flippedToLoss;
            flippedToExpired = r.flippedToExpired;
            spreadFiltered = r.spreadFiltered;
          } else {
            const r = applyMissToTrack(track, nowIso);
            update = r.update;
            flippedToStale = r.flippedToStale;
          }

          const { error: updErr } = await supabase
            .from('ct_contract_tracks')
            .update(update)
            .eq('id', track.id);
          if (updErr) {
            updateErrors += 1;
            stats.errors.push(`track ${track.alert_id}: ${updErr.message.slice(0, 200)}`);
            continue;
          }
          stats.tracks_updated += 1;
          if (flippedToWin) stats.win_flips += 1;
          if (flippedToLoss) stats.loss_flips += 1;
          if (flippedToExpired) stats.expired_flips += 1;
          if (flippedToStale) stats.stale_flips += 1;
          if (spreadFiltered) stats.spread_filtered += 1;
        } catch (e) {
          updateErrors += 1;
          stats.errors.push(`track ${track.alert_id}: ${e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200)}`);
        }
      }
    }
  } catch (e) {
    stats.ok = false;
    stats.errors.push(`fatal: ${e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200)}`);
  }

  stats.elapsed_ms = Date.now() - startedAt;
  // Cap errors array
  stats.errors = stats.errors.slice(0, 20);

  // Ship 2 — flush poller-log telemetry. Fire-and-forget shape inside; even if
  // the insert fails we still return stats to the caller. Awaited only so the
  // edge runtime doesn't kill the isolate before the insert lands.
  try {
    if (supabase) await flushPollerLog(supabase, pollerLog);
  } catch { /* ignore */ }

  return new Response(JSON.stringify(stats), {
    status: 200,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  });
});
