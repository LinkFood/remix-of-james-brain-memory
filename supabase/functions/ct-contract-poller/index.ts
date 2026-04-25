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
import { getOptionContractLatestMid, uwBudgetOk, setUwCaller } from '../_shared/uwClient.ts';

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
  uw_calls: number;
  errors: string[];
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
async function fetchEligibleTracks(
  supabase: SupabaseClient,
  watchlist: Set<string>,
): Promise<ContractTrack[]> {
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
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
    .order('last_quoted_at', { ascending: true, nullsFirst: true })
    .limit(MAX_TRACKS_PER_RUN_FETCH);

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
    uw_calls: 0,
    errors: [],
  };

  try {
    let mode: Mode = 'rth';
    try {
      const body = await req.json().catch(() => ({}));
      if (body && body.mode === 'offhours') mode = 'offhours';
    } catch { /* ignore */ }
    stats.mode = mode;

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const cfg = await loadPollerConfig(supabase);
    const watchlist = await loadWatchlist(supabase);

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

    const allTracks = await fetchEligibleTracks(supabase, watchlist);
    const dueTracks = filterByCadence(allTracks, cfg, mode);
    stats.tracks_eligible = dueTracks.length;

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
    const symbols = [...bySymbol.keys()].slice(0, cfg.maxPerRun);
    stats.unique_symbols = symbols.length;

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
      if (stats.budget_exhausted) return;
      const ok = await uwBudgetOk();
      if (!ok) {
        stats.budget_exhausted = true;
        return;
      }
      stats.uw_calls += 1;
      try {
        const q = await getOptionContractLatestMid(symbol);
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
      } catch (e) {
        quoteResults.push({ symbol, ok: false, mid: null, bid: null, ask: null, last: null, spreadPct: null, ts: null });
        stats.errors.push(`uw ${symbol}: ${e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200)}`);
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

  return new Response(JSON.stringify(stats), {
    status: 200,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  });
});
