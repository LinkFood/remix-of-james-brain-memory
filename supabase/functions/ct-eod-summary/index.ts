/**
 * ct-eod-summary — Daily 4:30pm ET narrative + grades for Co-Trader.
 *
 * Cron: 30 20 * * 1-5 (20:30 UTC weekdays). Aggregates the day's
 *   - flags + grades (per-specialist breakdown)
 *   - specialist reads (direction lean + conviction)
 *   - top scored flow events (top 5 by premium)
 *   - top contract stacks (top 3 per ticker via ct_contract_stacking RPC)
 *   - FlowPulse open vs close (first vs last tick)
 *   - tape-reader first vs last commentary
 *   - watchlist underlying day moves (open vs close from ct_price_bars)
 *
 * Sends the structured JSON to Sonnet 4.6 for a 400-500 word narrative.
 * UPSERTs into ct_eod_summaries (UNIQUE on session_date — re-running the
 * day overwrites). Pushes Block Kit summary to Slack via ctSlackPushDirect.
 *
 * Slack is best-effort — never throws. Missing data sources gracefully
 * degrade to "[no data yet]" tokens in the prompt.
 *
 * Tenets: meta-layer eats its own outputs (17), real-time contextual
 * awareness (10), every number tunable (7).
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { callClaude, CLAUDE_MODELS, CLAUDE_RATES, ClaudeError } from '../_shared/anthropic.ts';
import { ctSlackPushDirect } from '../_shared/ctSlack.ts';
import { getFlowHeatmapContext } from '../_shared/flowHeatmapContext.ts';
import { getTemporalContext, tagIsoTimestamp } from '../_shared/temporalContext.ts';
import { validateTemporalCoherence } from '../_shared/temporalValidator.ts';

const WATCHLIST = ['SPY', 'QQQ', 'IWM', 'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'TSLA'];

interface FlagRow {
  id: string;
  specialist_ticker: string;
  direction: string;
  score: number | null;
  status: string;
  thesis: string | null;
  created_at: string;
}

interface GradeRow {
  flag_id: string;
  specialist_ticker: string;
  outcome: string;
  alpha_pct: number | null;
}

interface ReadRow {
  ticker: string;
  direction_lean: string | null;
  conviction: number | null;
  flagged: boolean;
  updated_at: string;
}

interface ScoredFlowRow {
  id: number;
  ticker: string;
  option_symbol: string | null;
  classification: string | null;
  direction: string | null;
  premium: number | null;
  score: number | null;
  strike: number | null;
  expiry: string | null;
}

interface StackRow {
  option_symbol: string;
  ticker: string;
  strike: number | null;
  expiry: string | null;
  side: string;
  prints_count: number;
  premium_total: number;
  ask_dominant_pct: number | null;
  opening_buy_count: number;
  opening_sell_count: number;
}

interface FlowPulseTickRow {
  tick_time: string;
  ticker: string;
  premium_net: number | string;
  call_put_ratio: number | string | null;
  is_unusual: boolean;
}

interface PriceBarRow {
  ticker: string;
  ts: string;
  open: number | string;
  close: number | string;
}

interface TapeCommentaryRow {
  created_at: string;
  commentary: string;
}

// ---------------------------------------------------------------------------
// Hedge-fund-grade attribution types — all rows defensively read. Downstream
// tables (ct_edge_daily, ct_print_grades, ct_print_tracks, ct_signatures) are
// populated by parallel agents. Anything missing → empty fallback.
// ---------------------------------------------------------------------------

interface EdgeDailyRow {
  session_date: string;
  top_winning_signatures: unknown;
  top_losing_signatures: unknown;
  by_ticker: unknown;
  by_time_bucket: unknown;
  by_dte_bucket?: unknown;
  slow_burn_pays_today?: unknown;
  regime_tag: string | null;
  total_graded: number | null;
  total_wins: number | null;
  total_losses: number | null;
  overall_hit_rate: number | null;
  tracks_realized_today?: number | null;
}

interface PrintGradeRow {
  id: string;
  alert_id: string;
  ticker: string;
  horizon: string;
  print_time: string;
  predicted_direction: string;
  predicted_source: string;
  actual_move_pct: number | string | null;
  magnitude_pct: number | string | null;
  grade: string;
  graded_at: string;
}

interface FlowAlertJoin {
  alert_id?: string | null;
  id?: string | null;
  ticker?: string | null;
  side?: string | null;
  strike?: number | string | null;
  expiry?: string | null;
  signature_key?: string | null;
  option_symbol?: string | null;
  premium?: number | string | null;
}

interface PrintTrackRow {
  print_id: string;
  alert_id?: string | null;
  ticker: string;
  signature_key?: string | null;
  print_time: string;
  peak_favorable_pct?: number | string | null;
  peak_favorable_at?: string | null;
  peak_adverse_pct?: number | string | null;
  threshold_pct?: number | string | null;
  track_status: string;
  realized_at?: string | null;
  dte_bucket?: string | null;
}

interface SignatureRow {
  id: string;
  signature_key: string;
  ticker: string;
  hit_rate: number | string | null;
  edge_score: number | string | null;
  sample_count: number | null;
  promoted: boolean;
  last_updated_at: string;
}

function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  const sign = v >= 0 ? '+' : '-';
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

function fmtPremium(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(Number(n))) return '?';
  const v = Math.abs(Number(n));
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(2)}%`;
}

function interpretStackLabel(r: StackRow): string {
  const side = (r.side || '').toUpperCase().startsWith('C') ? 'C' : 'P';
  const total = Math.max(1, (r.opening_buy_count ?? 0) + (r.opening_sell_count ?? 0));
  const buyShare = (r.opening_buy_count ?? 0) / total;
  const sellShare = (r.opening_sell_count ?? 0) / total;
  const askLow = r.ask_dominant_pct != null && Number(r.ask_dominant_pct) < 30;
  if (buyShare >= 0.8) return side === 'C' ? 'call accumulation (bullish)' : 'put accumulation (bearish)';
  if (sellShare >= 0.8 && askLow) return side === 'P' ? 'put writing (bullish)' : 'call writing (bearish)';
  if (sellShare >= 0.8) return side === 'C' ? 'call distribution' : 'put distribution';
  return '2-sided mixed';
}

serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  const corsHeaders = getCorsHeaders(req);

  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Optional body — `{ "skip_slack": true }` for re-fires so we don't
  // double-Slack the channel (cron fires once at 20:30 UTC; manual re-runs
  // exist only to repair the row). Body parse is best-effort; missing or
  // malformed body is fine.
  let skipSlack = false;
  try {
    if (req.method === 'POST') {
      const text = await req.text();
      if (text && text.trim().length > 0) {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && parsed.skip_slack === true) {
          skipSlack = true;
        }
      }
    }
  } catch {
    // ignore — empty/invalid body just means default behavior (Slack on)
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // Temporal anchor — pre-tag every date in the prompt + prepend preamble.
  // See _shared/temporalContext.ts. Resolves session_date in NY tz; matches
  // the locally-computed sessionDate below.
  const tctx = getTemporalContext();

  // ----- Date bounds in NY tz -------------------------------------------------
  const now = new Date();
  // session_date — NY-tz date (matches ct_tape_commentary, ct_specialist_reads convention)
  const nyParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const yyyy = nyParts.find(p => p.type === 'year')?.value ?? '1970';
  const mm = nyParts.find(p => p.type === 'month')?.value ?? '01';
  const dd = nyParts.find(p => p.type === 'day')?.value ?? '01';
  const sessionDate = `${yyyy}-${mm}-${dd}`;

  // NY-tz midnight as UTC for filtering created_at columns
  // 04:00 UTC ≈ 00:00 EDT, 05:00 UTC ≈ 00:00 EST. ET 4pm = 20:00 UTC EST or 20:00 EDT.
  // For day boundary use a generous window: previous day 04:00 UTC up through call time.
  const dayStartIso = `${sessionDate}T04:00:00Z`; // catches all of NY business day
  const dayEndIso = now.toISOString();

  // Underlying spot moves — pull last 2 days of daily bars and compute today's % move
  const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60_000);

  // ----- Pull data in parallel -----------------------------------------------
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb: any = supabase;

  const [
    flagsRes,
    gradesRes,
    readsRes,
    scoredFlowRes,
    stackingRes,
    flowPulseSeriesRes,
    tapeRes,
    barsRes,
  ] = await Promise.all([
    sb.from('ct_flags')
      .select('id, specialist_ticker, direction, score, status, thesis, created_at')
      .gte('created_at', dayStartIso)
      .lte('created_at', dayEndIso)
      .order('created_at', { ascending: true }),
    sb.from('ct_flag_grades')
      .select('flag_id, specialist_ticker, outcome, alpha_pct, graded_at')
      .gte('graded_at', dayStartIso)
      .lte('graded_at', dayEndIso),
    sb.from('ct_specialist_reads')
      .select('ticker, direction_lean, conviction, flagged, updated_at')
      .gte('updated_at', dayStartIso)
      .lte('updated_at', dayEndIso),
    sb.from('ct_scored_flow')
      .select('id, ticker, option_symbol, classification, direction, premium, score, strike, expiry, event_ts')
      .gte('event_ts', dayStartIso)
      .lte('event_ts', dayEndIso)
      .in('ticker', WATCHLIST)
      .order('premium', { ascending: false })
      .limit(50),
    sb.rpc('ct_contract_stacking', {
      p_window_min: 480, // ~8h covers full RTH
      p_min_prints: 3,
      p_min_premium: 100_000,
      p_ticker: null,
      p_limit: 30,
    }),
    sb.rpc('ct_flow_pulse_series', { p_since: dayStartIso }),
    sb.from('ct_tape_commentary')
      .select('created_at, commentary')
      .eq('session_date', sessionDate)
      .order('created_at', { ascending: true }),
    sb.from('ct_price_bars')
      .select('ticker, ts, open, close')
      .in('ticker', WATCHLIST)
      .eq('timeframe', '1d')
      .gte('ts', twoDaysAgo.toISOString())
      .order('ts', { ascending: false })
      .limit(40),
  ]);

  const flags = (flagsRes.data ?? []) as FlagRow[];
  const grades = (gradesRes.data ?? []) as GradeRow[];
  const reads = (readsRes.data ?? []) as ReadRow[];
  const scoredFlow = (scoredFlowRes.data ?? []) as ScoredFlowRow[];
  const stacks = (stackingRes.data ?? []) as StackRow[];
  const pulseSeries = (flowPulseSeriesRes.data ?? []) as FlowPulseTickRow[];
  const tape = (tapeRes.data ?? []) as TapeCommentaryRow[];
  const bars = (barsRes.data ?? []) as PriceBarRow[];

  // Flow-heatmap regime context — top 3 expiry-week stacks per watchlist ticker
  // (168h lookback, aggressive_directional_decay math). Best-effort; helper
  // returns empty per_ticker on any failure so the EOD report never blocks.
  const flowHeatmapContext = await getFlowHeatmapContext(supabase, WATCHLIST);

  // -------------------------------------------------------------------------
  // Hedge-fund attribution pulls — all defensive. Empty fallback on any error
  // so the summary still ships when the downstream tables haven't been
  // populated by their respective agent yet.
  // -------------------------------------------------------------------------

  // Session-date NY → UTC midnight bounds for filtering "today" on tracks
  // realized + grades graded.
  const sessionDayStartUtc = `${sessionDate}T00:00:00Z`;
  const sessionDayEndUtc = `${sessionDate}T23:59:59Z`;

  let edgeDaily: EdgeDailyRow | null = null;
  try {
    const { data, error } = await sb
      .from('ct_edge_daily')
      .select('session_date, top_winning_signatures, top_losing_signatures, by_ticker, by_time_bucket, by_dte_bucket, slow_burn_pays_today, regime_tag, total_graded, total_wins, total_losses, overall_hit_rate, tracks_realized_today')
      .eq('session_date', sessionDate)
      .maybeSingle();
    if (error) {
      console.warn('[ct-eod-summary] ct_edge_daily load failed:', error.message);
    } else if (data) {
      edgeDaily = data as EdgeDailyRow;
    }
  } catch (e) {
    console.warn('[ct-eod-summary] ct_edge_daily threw:', String(e));
  }

  let printGradesToday: PrintGradeRow[] = [];
  try {
    const { data, error } = await sb
      .from('ct_print_grades')
      .select('id, alert_id, ticker, horizon, print_time, predicted_direction, predicted_source, actual_move_pct, magnitude_pct, grade, graded_at')
      .gte('graded_at', sessionDayStartUtc)
      .lte('graded_at', sessionDayEndUtc)
      .eq('grade', 'WIN')
      .order('magnitude_pct', { ascending: false, nullsFirst: false })
      .limit(40);
    if (error) {
      console.warn('[ct-eod-summary] ct_print_grades load failed:', error.message);
    } else {
      printGradesToday = (data ?? []) as PrintGradeRow[];
    }
  } catch (e) {
    console.warn('[ct-eod-summary] ct_print_grades threw:', String(e));
  }

  // Pull signature_key + flow context for those alerts (best-effort join)
  const flowContextByAlertId = new Map<string, FlowAlertJoin>();
  if (printGradesToday.length > 0) {
    try {
      const alertIds = Array.from(new Set(printGradesToday.map(g => g.alert_id).filter(Boolean)));
      if (alertIds.length > 0) {
        const { data, error } = await sb
          .from('ct_flow_alerts')
          .select('alert_id, ticker, side, strike, expiry, signature_key, option_symbol, premium')
          .in('alert_id', alertIds);
        if (error) {
          console.warn('[ct-eod-summary] ct_flow_alerts join failed:', error.message);
        } else {
          for (const r of (data ?? []) as FlowAlertJoin[]) {
            const key = r.alert_id ?? r.id;
            if (key) flowContextByAlertId.set(String(key), r);
          }
        }
      }
    } catch (e) {
      console.warn('[ct-eod-summary] ct_flow_alerts threw:', String(e));
    }
  }

  let realizedTracksToday: PrintTrackRow[] = [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (sb.from('ct_print_tracks' as never) as any)
      .select('print_id, alert_id, ticker, signature_key, print_time, peak_favorable_pct, peak_favorable_at, peak_adverse_pct, threshold_pct, track_status, realized_at, dte_bucket')
      .eq('track_status', 'REALIZED')
      .gte('realized_at', sessionDayStartUtc)
      .lte('realized_at', sessionDayEndUtc)
      .order('peak_favorable_pct', { ascending: false, nullsFirst: false })
      .limit(20);
    if (error) {
      console.warn('[ct-eod-summary] ct_print_tracks REALIZED load failed:', error.message);
    } else {
      realizedTracksToday = (data ?? []) as PrintTrackRow[];
    }
  } catch (e) {
    console.warn('[ct-eod-summary] ct_print_tracks threw:', String(e));
  }

  // ct_contract_tracks (Pass 3 grader, added 2026-04-25) — the contract-axis
  // grader where today's actual WIN/LOSS lives. EOD pre-dates this layer and
  // was reading 0 realized tracks despite real WINs (TSLA P 365 +109%, SPY
  // 714C +85%, etc.). Load WIN + LOSS for today's session as parallel source.
  // Adapted to PrintTrackRow shape so it merges cleanly into downstream
  // counts and topRealizedTracks slicing — column-mapping below preserves
  // the legacy interface.
  let contractRealizedToday: PrintTrackRow[] = [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (sb.from('ct_contract_tracks' as never) as any)
      .select('alert_id, ticker, option_symbol, peak_contract_pct, peak_contract_at, max_drawdown_pct, track_status, first_tracked_at, last_tracked_at, dte_at_print')
      .in('track_status', ['WIN', 'LOSS'])
      .gte('first_tracked_at', sessionDayStartUtc)
      .lte('first_tracked_at', sessionDayEndUtc)
      .order('peak_contract_pct', { ascending: false, nullsFirst: false })
      .limit(50);
    if (error) {
      console.warn('[ct-eod-summary] ct_contract_tracks WIN/LOSS load failed:', error.message);
    } else {
      // Map contract-axis schema → PrintTrackRow shape for downstream merge.
      // dte_bucket synthesized from dte_at_print (0=0DTE, 1-5=weekly, 6+=swing).
      contractRealizedToday = ((data ?? []) as Array<Record<string, unknown>>).map((r) => {
        const dte = typeof r.dte_at_print === 'number' ? r.dte_at_print : null;
        const dte_bucket = dte === null ? null
          : dte === 0 ? '0DTE'
          : dte <= 5 ? 'weekly'
          : 'swing';
        return {
          print_id: (r.alert_id as string) ?? '',
          alert_id: (r.alert_id as string) ?? '',
          ticker: (r.ticker as string) ?? '',
          signature_key: (r.option_symbol as string) ?? null,
          print_time: (r.first_tracked_at as string) ?? '',
          peak_favorable_pct: r.peak_contract_pct as number | null,
          peak_favorable_at: r.peak_contract_at as string | null,
          peak_adverse_pct: r.max_drawdown_pct as number | null,
          threshold_pct: null,
          track_status: r.track_status as string,
          realized_at: (r.last_tracked_at as string) ?? (r.first_tracked_at as string) ?? '',
          dte_bucket,
        } as PrintTrackRow;
      });
      console.log(`[ct-eod-summary] contract-axis WIN/LOSS today: ${contractRealizedToday.length}`);
    }
  } catch (e) {
    console.warn('[ct-eod-summary] ct_contract_tracks threw:', String(e));
  }

  // Merge: print-axis tracks (legacy) + contract-axis tracks (new layer).
  // Sort descending by peak_favorable_pct so topRealizedTracks captures the
  // best of both axes.
  realizedTracksToday = [...realizedTracksToday, ...contractRealizedToday]
    .sort((a, b) => (b.peak_favorable_pct ?? 0) - (a.peak_favorable_pct ?? 0));

  // ct_signatures library health
  let signaturesAll: SignatureRow[] = [];
  let signaturesPromoted: SignatureRow[] = [];
  let signaturesPromotedToday: SignatureRow[] = [];
  try {
    const { data, error } = await sb
      .from('ct_signatures')
      .select('id, signature_key, ticker, hit_rate, edge_score, sample_count, promoted, last_updated_at')
      .order('edge_score', { ascending: false, nullsFirst: false })
      .limit(500);
    if (error) {
      console.warn('[ct-eod-summary] ct_signatures load failed:', error.message);
    } else {
      signaturesAll = (data ?? []) as SignatureRow[];
      signaturesPromoted = signaturesAll.filter(s => s.promoted === true);
      signaturesPromotedToday = signaturesPromoted.filter(s => {
        const ts = String(s.last_updated_at ?? '');
        return ts.startsWith(sessionDate);
      });
    }
  } catch (e) {
    console.warn('[ct-eod-summary] ct_signatures threw:', String(e));
  }

  // ----- Aggregate: gradesByFlagId -------------------------------------------
  const gradeByFlag = new Map<string, GradeRow>();
  for (const g of grades) gradeByFlag.set(g.flag_id, g);

  // ----- specialist_stats per ticker -----------------------------------------
  const specialistStats: Record<string, {
    flags_count: number;
    bull_count: number;
    bear_count: number;
    mixed_count: number; // neutral
    avg_conviction: number | null;
    reads_count: number;
    grade_breakdown: { win: number; loss: number; partial: number; invalidated_early: number; ungraded: number };
  }> = {};

  for (const t of WATCHLIST) {
    specialistStats[t] = {
      flags_count: 0,
      bull_count: 0,
      bear_count: 0,
      mixed_count: 0,
      avg_conviction: null,
      reads_count: 0,
      grade_breakdown: { win: 0, loss: 0, partial: 0, invalidated_early: 0, ungraded: 0 },
    };
  }

  for (const f of flags) {
    const t = f.specialist_ticker;
    if (!specialistStats[t]) continue; // only watchlist
    specialistStats[t].flags_count++;
    if (f.direction === 'bullish') specialistStats[t].bull_count++;
    else if (f.direction === 'bearish') specialistStats[t].bear_count++;
    else specialistStats[t].mixed_count++;
    const g = gradeByFlag.get(f.id);
    const gb = specialistStats[t].grade_breakdown;
    if (!g) gb.ungraded++;
    else if (g.outcome === 'win') gb.win++;
    else if (g.outcome === 'loss') gb.loss++;
    else if (g.outcome === 'partial') gb.partial++;
    else if (g.outcome === 'invalidated_early') gb.invalidated_early++;
    else gb.ungraded++;
  }

  // Reads: per-ticker count + avg conviction
  const convAcc: Record<string, { sum: number; n: number }> = {};
  for (const t of WATCHLIST) convAcc[t] = { sum: 0, n: 0 };
  for (const r of reads) {
    if (!specialistStats[r.ticker]) continue;
    specialistStats[r.ticker].reads_count++;
    if (r.conviction != null && Number.isFinite(Number(r.conviction))) {
      convAcc[r.ticker].sum += Number(r.conviction);
      convAcc[r.ticker].n++;
    }
  }
  for (const t of WATCHLIST) {
    if (convAcc[t].n > 0) {
      specialistStats[t].avg_conviction = Math.round(convAcc[t].sum / convAcc[t].n * 10) / 10;
    }
  }

  // ----- ticker_stats per ticker ---------------------------------------------
  // Spot moves from daily bars
  const todaySpotByTicker = new Map<string, { open: number; close: number; ts: string }>();
  // bars sorted DESC by ts; first hit per ticker = latest day
  for (const b of bars) {
    if (!todaySpotByTicker.has(b.ticker)) {
      const o = Number(b.open);
      const c = Number(b.close);
      if (Number.isFinite(o) && Number.isFinite(c)) {
        todaySpotByTicker.set(b.ticker, { open: o, close: c, ts: b.ts });
      }
    }
  }

  // Top scored flow per ticker
  const topFlowByTicker = new Map<string, ScoredFlowRow>();
  for (const r of scoredFlow) {
    if (!topFlowByTicker.has(r.ticker)) topFlowByTicker.set(r.ticker, r);
  }

  // Top stack per ticker
  const topStackByTicker = new Map<string, StackRow>();
  for (const s of stacks) {
    if (!topStackByTicker.has(s.ticker)) topStackByTicker.set(s.ticker, s);
  }

  // FlowPulse: first/last tick per ticker
  const pulseFirstByTicker = new Map<string, FlowPulseTickRow>();
  const pulseLastByTicker = new Map<string, FlowPulseTickRow>();
  // pulseSeries comes ordered by ticker, tick_time ASC from the RPC
  for (const tick of pulseSeries) {
    if (!pulseFirstByTicker.has(tick.ticker)) pulseFirstByTicker.set(tick.ticker, tick);
    pulseLastByTicker.set(tick.ticker, tick); // last write wins
  }

  const tickerStats: Record<string, {
    open_spot: number | null;
    close_spot: number | null;
    day_pct_change: number | null;
    top_flow: { symbol: string; premium: number; score: number | null } | null;
    top_stack: { symbol: string; prints: number; signal_label: string; premium: number } | null;
    flow_pulse_open: { premium_net: number; cp_ratio: number | null } | null;
    flow_pulse_close: { premium_net: number; cp_ratio: number | null } | null;
    regime_shift: string | null;
  }> = {};

  for (const t of WATCHLIST) {
    const spot = todaySpotByTicker.get(t);
    const open = spot?.open ?? null;
    const close = spot?.close ?? null;
    const pct = (open != null && close != null && open !== 0)
      ? ((close - open) / open) * 100
      : null;

    const tf = topFlowByTicker.get(t);
    const ts = topStackByTicker.get(t);
    const pulseFirst = pulseFirstByTicker.get(t);
    const pulseLast = pulseLastByTicker.get(t);

    const firstNet = pulseFirst ? Number(pulseFirst.premium_net) : null;
    const lastNet = pulseLast ? Number(pulseLast.premium_net) : null;
    let regimeShift: string | null = null;
    if (firstNet != null && lastNet != null) {
      if (firstNet < 0 && lastNet > 0) regimeShift = 'bearish→bullish';
      else if (firstNet > 0 && lastNet < 0) regimeShift = 'bullish→bearish';
      else if (Math.abs(lastNet - firstNet) > 1_000_000) {
        regimeShift = lastNet > firstNet ? 'bullish acceleration' : 'bearish acceleration';
      }
    }

    tickerStats[t] = {
      open_spot: open,
      close_spot: close,
      day_pct_change: pct != null ? Math.round(pct * 100) / 100 : null,
      top_flow: tf ? {
        symbol: tf.option_symbol ?? `${tf.ticker} ${tf.strike ?? '?'}${tf.expiry ?? ''}`,
        premium: Number(tf.premium ?? 0),
        score: tf.score,
      } : null,
      top_stack: ts ? {
        symbol: ts.option_symbol,
        prints: ts.prints_count,
        signal_label: interpretStackLabel(ts),
        premium: Number(ts.premium_total ?? 0),
      } : null,
      flow_pulse_open: pulseFirst ? {
        premium_net: firstNet ?? 0,
        cp_ratio: pulseFirst.call_put_ratio != null ? Number(pulseFirst.call_put_ratio) : null,
      } : null,
      flow_pulse_close: pulseLast ? {
        premium_net: lastNet ?? 0,
        cp_ratio: pulseLast.call_put_ratio != null ? Number(pulseLast.call_put_ratio) : null,
      } : null,
      regime_shift: regimeShift,
    };
  }

  // ----- market_stats ---------------------------------------------------------
  const marketFirst = pulseFirstByTicker.get('MARKET') ?? null;
  const marketLast = pulseLastByTicker.get('MARKET') ?? null;
  const mktPremOpen = marketFirst ? Number(marketFirst.premium_net) : null;
  const mktPremClose = marketLast ? Number(marketLast.premium_net) : null;
  const mktPremDelta = (mktPremOpen != null && mktPremClose != null)
    ? mktPremClose - mktPremOpen : null;

  const tapeFirst = tape[0]?.commentary ?? null;
  const tapeLast = tape.length > 0 ? tape[tape.length - 1].commentary : null;

  let unusualPulseCount = 0;
  for (const tick of pulseSeries) {
    if (tick.ticker !== 'MARKET' && tick.is_unusual) unusualPulseCount++;
  }

  const marketStats = {
    tape_first: tapeFirst,
    tape_last: tapeLast,
    market_premium_open: mktPremOpen,
    market_premium_close: mktPremClose,
    market_premium_delta: mktPremDelta,
    total_flags: flags.length,
    total_reads: reads.length,
    total_stacks: stacks.length,
    unusual_pulse_count: unusualPulseCount,
    total_grades: grades.length,
    grade_breakdown: {
      win: grades.filter(g => g.outcome === 'win').length,
      loss: grades.filter(g => g.outcome === 'loss').length,
      partial: grades.filter(g => g.outcome === 'partial').length,
      invalidated_early: grades.filter(g => g.outcome === 'invalidated_early').length,
    },
    // Positioning regime snapshot used to inform the EOD narrative — persisted
    // for grading provenance (no dedicated context_snapshot column on the
    // ct_eod_summaries table; market_stats is the JSONB catch-all).
    flow_heatmap_per_ticker: flowHeatmapContext.per_ticker,
    flow_heatmap_meta: {
      generated_at: flowHeatmapContext.generated_at,
      lookback_hours: flowHeatmapContext.lookback_hours,
      math_mode: flowHeatmapContext.math_mode,
    },
  };

  // -------------------------------------------------------------------------
  // Build per-specialist scorecard: flags today × WINs × REALIZED tracks for
  // the ticker. Uses the data already pulled above — no extra reads.
  // -------------------------------------------------------------------------
  const printGradesByTicker = new Map<string, PrintGradeRow[]>();
  for (const g of printGradesToday) {
    const arr = printGradesByTicker.get(g.ticker) ?? [];
    arr.push(g);
    printGradesByTicker.set(g.ticker, arr);
  }
  const realizedByTicker = new Map<string, PrintTrackRow[]>();
  for (const t of realizedTracksToday) {
    const arr = realizedByTicker.get(t.ticker) ?? [];
    arr.push(t);
    realizedByTicker.set(t.ticker, arr);
  }

  const specialistScorecard: Record<string, {
    flags_today: number;
    wins_today: number;     // graded WIN prints from ct_print_grades
    losses_today: number;   // ct_flag_grades.outcome=loss
    realized_tracks_today: number;
    best_call: { signature_key: string | null; magnitude_pct: number | null; horizon: string } | null;
    worst_call: { thesis_slice: string | null; alpha_pct: number | null } | null;
  }> = {};

  for (const t of WATCHLIST) {
    const flagsT = flags.filter(f => f.specialist_ticker === t);
    const flagsWithGrades = flagsT.map(f => ({ flag: f, grade: gradeByFlag.get(f.id) ?? null }));
    const lossGraded = flagsWithGrades.filter(fg => fg.grade?.outcome === 'loss' || fg.grade?.outcome === 'invalidated_early');
    let worstCall: { thesis_slice: string | null; alpha_pct: number | null } | null = null;
    if (lossGraded.length > 0) {
      // Pick the loss with the worst (most negative) alpha_pct.
      const sorted = [...lossGraded].sort((a, b) => {
        const av = Number(a.grade?.alpha_pct ?? 0);
        const bv = Number(b.grade?.alpha_pct ?? 0);
        return av - bv;
      });
      const w = sorted[0];
      worstCall = {
        thesis_slice: w.flag.thesis ? w.flag.thesis.slice(0, 140) : null,
        alpha_pct: w.grade?.alpha_pct != null ? Number(w.grade.alpha_pct) : null,
      };
    }

    const printWinsT = printGradesByTicker.get(t) ?? [];
    let bestCall: { signature_key: string | null; magnitude_pct: number | null; horizon: string } | null = null;
    if (printWinsT.length > 0) {
      const sorted = [...printWinsT].sort((a, b) => {
        const av = Number(a.magnitude_pct ?? 0);
        const bv = Number(b.magnitude_pct ?? 0);
        return bv - av;
      });
      const top = sorted[0];
      const ctx = flowContextByAlertId.get(top.alert_id);
      bestCall = {
        signature_key: ctx?.signature_key ?? null,
        magnitude_pct: top.magnitude_pct != null ? Number(top.magnitude_pct) : null,
        horizon: top.horizon,
      };
    }

    specialistScorecard[t] = {
      flags_today: flagsT.length,
      wins_today: printWinsT.length,
      losses_today: lossGraded.length,
      realized_tracks_today: (realizedByTicker.get(t) ?? []).length,
      best_call: bestCall,
      worst_call: worstCall,
    };
  }

  // -------------------------------------------------------------------------
  // Slow-burn extraction — prints from 3+ days ago whose tracks REALIZED
  // today. ct_edge_daily.slow_burn_pays_today is canonical; fall back to
  // computing from realizedTracksToday if the edge-miner column isn't
  // populated yet.
  // -------------------------------------------------------------------------
  const slowBurnFromEdge = (() => {
    const raw = edgeDaily?.slow_burn_pays_today;
    if (Array.isArray(raw)) return raw as Array<Record<string, unknown>>;
    if (raw && typeof raw === 'object') {
      const arr = (raw as Record<string, unknown>).items;
      if (Array.isArray(arr)) return arr as Array<Record<string, unknown>>;
    }
    return null;
  })();

  const SLOW_BURN_DAYS = 3;
  const todayDate = new Date(`${sessionDate}T00:00:00Z`).getTime();
  const slowBurnFallback = realizedTracksToday
    .filter(t => {
      const printedTs = new Date(String(t.print_time ?? '')).getTime();
      if (!Number.isFinite(printedTs)) return false;
      const daysOld = (todayDate - printedTs) / (24 * 3600_000);
      return daysOld >= SLOW_BURN_DAYS;
    })
    .map(t => ({
      ticker: t.ticker,
      signature_key: t.signature_key,
      print_time: t.print_time,
      realized_at: t.realized_at ?? null,
      peak_favorable_pct: t.peak_favorable_pct,
      days_to_realization:
        Number.isFinite(new Date(String(t.realized_at ?? '')).getTime())
          ? Math.round(
              (new Date(String(t.realized_at)).getTime() - new Date(String(t.print_time)).getTime()) /
              (24 * 3600_000) * 10
            ) / 10
          : null,
    }));

  const slowBurnList: Array<Record<string, unknown>> = slowBurnFromEdge ?? slowBurnFallback;

  // -------------------------------------------------------------------------
  // Top 10 print grades + Top 10 realized tracks (already sorted from query)
  // -------------------------------------------------------------------------
  const topPrintGrades = printGradesToday.slice(0, 10).map(g => {
    const ctx = flowContextByAlertId.get(g.alert_id);
    return {
      ticker: g.ticker,
      horizon: g.horizon,
      print_time: g.print_time,
      predicted_direction: g.predicted_direction,
      predicted_source: g.predicted_source,
      actual_move_pct: g.actual_move_pct != null ? Number(g.actual_move_pct) : null,
      magnitude_pct: g.magnitude_pct != null ? Number(g.magnitude_pct) : null,
      signature_key: ctx?.signature_key ?? null,
      option_symbol: ctx?.option_symbol ?? null,
    };
  });

  const topRealizedTracks = realizedTracksToday.slice(0, 10).map(t => {
    const printedTs = new Date(String(t.print_time ?? '')).getTime();
    const realizedTs = new Date(String(t.realized_at ?? '')).getTime();
    const daysToRealization = Number.isFinite(printedTs) && Number.isFinite(realizedTs)
      ? Math.round((realizedTs - printedTs) / (24 * 3600_000) * 10) / 10
      : null;
    return {
      ticker: t.ticker,
      signature_key: t.signature_key ?? null,
      print_time: t.print_time,
      peak_favorable_pct: t.peak_favorable_pct != null ? Number(t.peak_favorable_pct) : null,
      peak_favorable_at: t.peak_favorable_at ?? null,
      realized_at: t.realized_at ?? null,
      days_to_realization: daysToRealization,
    };
  });

  // -------------------------------------------------------------------------
  // Edge attribution rollup — copy what exists, omit what doesn't.
  // -------------------------------------------------------------------------
  const edgeAttribution: Record<string, unknown> = edgeDaily
    ? {
        regime_tag: edgeDaily.regime_tag,
        overall_hit_rate: edgeDaily.overall_hit_rate,
        total_graded: edgeDaily.total_graded,
        total_wins: edgeDaily.total_wins,
        total_losses: edgeDaily.total_losses,
        top_winning_signatures: edgeDaily.top_winning_signatures ?? [],
        top_losing_signatures: edgeDaily.top_losing_signatures ?? [],
        by_ticker: edgeDaily.by_ticker ?? {},
        by_time_bucket: edgeDaily.by_time_bucket ?? {},
        by_dte_bucket: edgeDaily.by_dte_bucket ?? {},
      }
    : {};

  const tracksRealizedTodayCount = edgeDaily?.tracks_realized_today ?? realizedTracksToday.length;

  // ---- Derive regime_tag + snapshot_hit_rate locally when ct_edge_daily
  // hasn't populated yet. Edge miner runs after this report, so most days
  // these columns came back null and the Slack message read "regime
  // untagged · n/a hit rate". Now we compute from data already in scope.
  // ct_edge_daily values still take precedence when present.
  // -----------------------------------------------------------------------

  // 1) snapshot_hit_rate from market grade_breakdown.
  //    wins / (wins + losses + partial) * 100. Returns null if denom = 0.
  //    Stored as 0..100 percent (NOT a 0..1 ratio) to match the Slack
  //    template expectation. Edge-daily's overall_hit_rate is 0..1, so
  //    when it lands we multiply for display in the same line.
  const gb = marketStats.grade_breakdown;
  const denom = gb.win + gb.loss + gb.partial;
  const derivedSnapshotHitRate: number | null =
    denom > 0 ? Math.round((gb.win / denom) * 1000) / 10 : null;

  // 2) regime_tag from market premium delta + per-ticker regime_shift majority.
  //    Reuses the $1M threshold from the ticker-level computation upstream
  //    so market-level tagging matches per-ticker semantics. If MARKET pulse
  //    didn't write (open=0 race or sparse session), fall back to the most
  //    common ticker-level regime_shift across the watchlist.
  function deriveRegimeTagLocal(): string | null {
    if (mktPremOpen != null && mktPremClose != null) {
      if (mktPremOpen < 0 && mktPremClose > 0) return 'bearish→bullish';
      if (mktPremOpen > 0 && mktPremClose < 0) return 'bullish→bearish';
      const delta = mktPremClose - mktPremOpen;
      if (Math.abs(delta) > 1_000_000) {
        return delta > 0 ? 'bullish acceleration' : 'bearish acceleration';
      }
      // Within noise band — call it balanced rather than untagged.
      return 'balanced';
    }
    // Pulse missing — promote the most-common per-ticker regime_shift.
    const shiftCounts = new Map<string, number>();
    for (const t of WATCHLIST) {
      const shift = tickerStats[t]?.regime_shift;
      if (!shift) continue;
      shiftCounts.set(shift, (shiftCounts.get(shift) ?? 0) + 1);
    }
    if (shiftCounts.size === 0) return null;
    let best: string | null = null;
    let bestN = 0;
    for (const [k, n] of shiftCounts) {
      if (n > bestN) { best = k; bestN = n; }
    }
    return best;
  }

  const derivedRegimeTag = deriveRegimeTagLocal();

  // edge_daily wins when present; otherwise local derivation. Edge daily's
  // overall_hit_rate is 0..1 — convert to 0..100 to match column scale.
  const edgeHitRatePct = edgeDaily?.overall_hit_rate != null
    ? Math.round(Number(edgeDaily.overall_hit_rate) * 1000) / 10
    : null;
  const snapshotHitRate: number | null = edgeHitRatePct ?? derivedSnapshotHitRate;
  const regimeTag: string | null = edgeDaily?.regime_tag ?? derivedRegimeTag;

  // ----- Build Sonnet prompt --------------------------------------------------
  const promptLines: string[] = [];
  promptLines.push(`Session date: ${sessionDate} (${tctx.session_day_name})`);
  promptLines.push(`Generated at: ${tctx.now_et} (${tctx.now_utc} UTC)`);
  promptLines.push('');
  promptLines.push('=== MARKET-WIDE ===');
  promptLines.push(`Total flags written today: ${flags.length} (${marketStats.grade_breakdown.win} win, ${marketStats.grade_breakdown.loss} loss, ${marketStats.grade_breakdown.partial} partial, ${marketStats.grade_breakdown.invalidated_early} invalidated_early, ${flags.length - grades.length} ungraded so far)`);
  promptLines.push(`Total specialist reads (every wakeup): ${reads.length}`);
  promptLines.push(`Total stacking patterns surfaced: ${stacks.length}`);
  promptLines.push(`Unusual FlowPulse ticks today: ${unusualPulseCount}`);
  if (mktPremOpen != null && mktPremClose != null) {
    promptLines.push(`Market net premium open→close: ${fmtUsd(mktPremOpen)} → ${fmtUsd(mktPremClose)} (Δ ${fmtUsd(mktPremDelta)})`);
  } else {
    promptLines.push('Market net premium: [no data yet]');
  }
  if (tapeFirst) promptLines.push(`First tape read of day: "${tapeFirst.replace(/\s+/g, ' ').slice(0, 240)}"`);
  else promptLines.push('First tape read: [no data yet]');
  if (tapeLast && tapeLast !== tapeFirst) promptLines.push(`Last tape read of day:  "${tapeLast.replace(/\s+/g, ' ').slice(0, 240)}"`);
  promptLines.push('');

  promptLines.push('=== PER TICKER ===');
  for (const t of WATCHLIST) {
    const ts = tickerStats[t];
    const ss = specialistStats[t];
    const moveStr = ts.day_pct_change != null
      ? `${fmtPct(ts.day_pct_change)} (${ts.open_spot?.toFixed(2)} → ${ts.close_spot?.toFixed(2)})`
      : '[no spot data]';
    const flagSummary = ss.flags_count > 0
      ? `${ss.flags_count} flags (${ss.bull_count}bull/${ss.bear_count}bear/${ss.mixed_count}neutral)`
      : 'no flags';
    const gb = ss.grade_breakdown;
    const gradeStr = ss.flags_count > 0
      ? ` | grades: ${gb.win}W/${gb.loss}L/${gb.partial}P/${gb.invalidated_early}IE/${gb.ungraded}ung`
      : '';
    const readStr = ss.reads_count > 0
      ? ` | ${ss.reads_count} reads, avg conv ${ss.avg_conviction ?? '—'}`
      : ' | 0 reads';
    promptLines.push(`${t}: ${moveStr} | ${flagSummary}${gradeStr}${readStr}`);

    if (ts.top_flow) {
      promptLines.push(`  Top flow: ${ts.top_flow.symbol} | premium ${fmtPremium(ts.top_flow.premium)} | score ${ts.top_flow.score ?? '—'}`);
    }
    if (ts.top_stack) {
      promptLines.push(`  Top stack: ${ts.top_stack.symbol} | ${ts.top_stack.prints} prints | ${fmtPremium(ts.top_stack.premium)} | ${ts.top_stack.signal_label}`);
    }
    if (ts.regime_shift) {
      promptLines.push(`  Regime shift: ${ts.regime_shift} (open net ${fmtUsd(ts.flow_pulse_open?.premium_net ?? null)} → close ${fmtUsd(ts.flow_pulse_close?.premium_net ?? null)})`);
    }
  }
  promptLines.push('');

  // Top market-wide flow events (top 5)
  promptLines.push('=== TOP 5 SCORED FLOW EVENTS (by premium) ===');
  if (scoredFlow.length === 0) promptLines.push('[no data yet]');
  else {
    for (const r of scoredFlow.slice(0, 5)) {
      const cls = r.classification ? ` ${r.classification}` : '';
      const dir = r.direction ? ` ${r.direction}` : '';
      promptLines.push(`  ${r.ticker} ${r.option_symbol ?? '?'} | ${fmtPremium(r.premium)} | score ${r.score ?? '—'}${dir}${cls}`);
    }
  }
  promptLines.push('');

  // Top stacks
  promptLines.push('=== TOP 5 CONTRACT STACKS ===');
  if (stacks.length === 0) promptLines.push('[no data yet]');
  else {
    for (const s of stacks.slice(0, 5)) {
      promptLines.push(`  ${s.ticker} ${s.option_symbol} | ${s.prints_count} prints | ${fmtPremium(Number(s.premium_total))} | ${interpretStackLabel(s)}`);
    }
  }
  promptLines.push('');

  // === EDGE ATTRIBUTION (ct_edge_daily) =====================================
  promptLines.push('=== EDGE ATTRIBUTION (ct_edge_daily) ===');
  if (!edgeDaily) {
    promptLines.push('[ct_edge_daily not populated for this session yet — edge miner runs at 21:00 UTC, after this report]');
  } else {
    const hr = edgeDaily.overall_hit_rate != null ? `${(Number(edgeDaily.overall_hit_rate) * 100).toFixed(1)}%` : '—';
    promptLines.push(`Regime: ${edgeDaily.regime_tag ?? 'untagged'}`);
    promptLines.push(`Snapshot hit rate: ${hr} (${edgeDaily.total_wins ?? 0}W / ${edgeDaily.total_losses ?? 0}L of ${edgeDaily.total_graded ?? 0} graded prints)`);
    const winners = Array.isArray(edgeDaily.top_winning_signatures) ? edgeDaily.top_winning_signatures as Array<Record<string, unknown>> : [];
    if (winners.length > 0) {
      promptLines.push(`Top winning signatures today:`);
      for (const w of winners.slice(0, 8)) {
        const k = w.signature_key ?? '?';
        const wins = w.wins ?? w.win_count ?? '?';
        const losses = w.losses ?? w.loss_count ?? '?';
        const edge = w.edge_score != null ? Number(w.edge_score).toFixed(2) : '—';
        promptLines.push(`  - ${k} | ${wins}W/${losses}L | edge ${edge}`);
      }
    } else {
      promptLines.push('Top winning signatures today: [none reported]');
    }
    const losers = Array.isArray(edgeDaily.top_losing_signatures) ? edgeDaily.top_losing_signatures as Array<Record<string, unknown>> : [];
    if (losers.length > 0) {
      promptLines.push(`Top losing signatures today:`);
      for (const l of losers.slice(0, 5)) {
        const k = l.signature_key ?? '?';
        const wins = l.wins ?? l.win_count ?? '?';
        const losses = l.losses ?? l.loss_count ?? '?';
        const edge = l.edge_score != null ? Number(l.edge_score).toFixed(2) : '—';
        promptLines.push(`  - ${k} | ${wins}W/${losses}L | edge ${edge}`);
      }
    }
    if (edgeDaily.by_dte_bucket && typeof edgeDaily.by_dte_bucket === 'object') {
      promptLines.push(`DTE bucket performance: ${JSON.stringify(edgeDaily.by_dte_bucket).slice(0, 600)}`);
    }
    if (edgeDaily.by_time_bucket && typeof edgeDaily.by_time_bucket === 'object') {
      promptLines.push(`Time bucket performance: ${JSON.stringify(edgeDaily.by_time_bucket).slice(0, 600)}`);
    }
  }
  promptLines.push('');

  // === FLOW HEATMAP — POSITIONING REGIME (168h decay) =======================
  promptLines.push('=== FLOW HEATMAP — POSITIONING REGIME (168h, aggressive-directional decay) ===');
  if (flowHeatmapContext.per_ticker.length === 0) {
    promptLines.push('[no heatmap data — RPC returned empty]');
  } else {
    for (const t of WATCHLIST) {
      const row = flowHeatmapContext.per_ticker.find(p => p.ticker === t);
      if (!row || row.stacks.length === 0) continue;
      const stackStr = row.stacks
        .map(s => `${s.expiry_bucket_week} ${fmtUsd(s.value)} (n=${s.source_alert_count})`)
        .join(' · ');
      promptLines.push(`  ${t}: ${stackStr}`);
    }
  }
  promptLines.push('');

  // === SLOW-BURN RETROACTIVE WINS ===========================================
  promptLines.push('=== SLOW-BURN RETROACTIVE WINS (prints 3+ days old that REALIZED today) ===');
  if (slowBurnList.length === 0) {
    promptLines.push('[no retroactive realizations today]');
  } else {
    for (const s of slowBurnList.slice(0, 12)) {
      const tk = s.ticker ?? '?';
      const sig = s.signature_key ?? '?';
      const printT = tagIsoTimestamp(String(s.print_time ?? ''), tctx.session_date);
      const realT = tagIsoTimestamp(String(s.realized_at ?? ''), tctx.session_date);
      const days = s.days_to_realization ?? '?';
      const peak = s.peak_favorable_pct;
      const peakStr = peak != null && Number.isFinite(Number(peak))
        ? `peak ${(Number(peak) * (Math.abs(Number(peak)) <= 1 ? 100 : 1)).toFixed(2)}%`
        : 'peak —';
      promptLines.push(`  - ${tk} \`${sig}\` | printed ${printT} → realized ${realT} (${days}d) | ${peakStr}`);
    }
  }
  promptLines.push('');

  // === TOP 10 GRADED PRINTS TODAY (WINs) ====================================
  promptLines.push('=== TOP 10 PRINT GRADES TODAY (WIN by magnitude) ===');
  if (topPrintGrades.length === 0) {
    promptLines.push('[no graded prints today — check ct-print-grader cron]');
  } else {
    for (const g of topPrintGrades) {
      const printT = tagIsoTimestamp(String(g.print_time ?? ''), tctx.session_date);
      const sig = g.signature_key ?? '?';
      const sym = g.option_symbol ?? '?';
      const move = g.actual_move_pct != null
        ? `${(g.actual_move_pct * (Math.abs(g.actual_move_pct) <= 1 ? 100 : 1)).toFixed(2)}%`
        : '—';
      promptLines.push(`  - ${g.ticker} ${sym} | ${printT} | ${g.horizon} | ${g.predicted_direction} (${g.predicted_source}) | underlying ${move} | sig ${sig}`);
    }
  }
  promptLines.push('');

  // === TOP 10 REALIZED TRACKS TODAY ========================================
  promptLines.push('=== TOP 10 REALIZED TRACKS TODAY (lifetime peak — any print date) ===');
  if (topRealizedTracks.length === 0) {
    promptLines.push('[no realized tracks today — track-status hasn\'t flipped]');
  } else {
    for (const t of topRealizedTracks) {
      const printT = tagIsoTimestamp(String(t.print_time ?? ''), tctx.session_date);
      const peakAtT = t.peak_favorable_at
        ? tagIsoTimestamp(String(t.peak_favorable_at), tctx.session_date)
        : '—';
      const peak = t.peak_favorable_pct;
      const peakStr = peak != null && Number.isFinite(Number(peak))
        ? `${(Number(peak) * (Math.abs(Number(peak)) <= 1 ? 100 : 1)).toFixed(2)}%`
        : '—';
      const days = t.days_to_realization ?? '?';
      const sig = t.signature_key ?? '?';
      promptLines.push(`  - ${t.ticker} | printed ${printT} → peak ${peakAtT} | peak ${peakStr} | ${days}d to realization | sig ${sig}`);
    }
  }
  promptLines.push('');

  // === PER-SPECIALIST SCORECARD ============================================
  promptLines.push('=== PER-SPECIALIST SCORECARD ===');
  for (const t of WATCHLIST) {
    const sc = specialistScorecard[t];
    const bestStr = sc.best_call
      ? ` | best print: ${sc.best_call.signature_key ?? '?'} ${sc.best_call.magnitude_pct != null ? (sc.best_call.magnitude_pct * (Math.abs(sc.best_call.magnitude_pct) <= 1 ? 100 : 1)).toFixed(2) + '%' : '—'} (${sc.best_call.horizon})`
      : '';
    const worstStr = sc.worst_call
      ? ` | worst flag: alpha ${sc.worst_call.alpha_pct != null ? sc.worst_call.alpha_pct.toFixed(2) + '%' : '—'} — ${(sc.worst_call.thesis_slice ?? '').slice(0, 80)}`
      : '';
    promptLines.push(`${t}: ${sc.flags_today} flags | ${sc.wins_today} WIN prints | ${sc.losses_today} loss-graded flags | ${sc.realized_tracks_today} realized tracks${bestStr}${worstStr}`);
  }
  promptLines.push('');

  // === SIGNATURE LIBRARY HEALTH ============================================
  promptLines.push('=== SIGNATURE LIBRARY HEALTH ===');
  promptLines.push(`Tracked: ${signaturesAll.length} | Promoted: ${signaturesPromoted.length} | Promoted today: ${signaturesPromotedToday.length}`);
  if (signaturesPromotedToday.length > 0) {
    promptLines.push(`Newly promoted today (top 5):`);
    for (const s of signaturesPromotedToday.slice(0, 5)) {
      const hr = s.hit_rate != null ? `${(Number(s.hit_rate) * 100).toFixed(1)}%` : '—';
      const edge = s.edge_score != null ? Number(s.edge_score).toFixed(2) : '—';
      promptLines.push(`  - \`${s.signature_key}\` | hit ${hr} (n=${s.sample_count ?? '?'}) | edge ${edge}`);
    }
  }
  promptLines.push('');

  // Data quality flags
  const dataQualityNotes: string[] = [];
  if (reads.length < 30) dataQualityNotes.push(`Only ${reads.length} specialist reads — system is brand-new (specialist_reads launched 2026-04-24).`);
  if (flags.length < 10) dataQualityNotes.push(`Only ${flags.length} flags written — sample is small.`);
  if (grades.length === 0 && flags.length > 0) dataQualityNotes.push('No grades landed yet — Tier 2 grader just shipped today, most flags still in active/horizon window.');
  if (pulseSeries.length === 0) dataQualityNotes.push('FlowPulse series is empty — Phase 1 capture cron may not have populated today.');
  if (!edgeDaily) dataQualityNotes.push('ct_edge_daily not populated — edge miner cron runs after this report; attribution sections will be empty.');
  if (printGradesToday.length === 0) dataQualityNotes.push('ct_print_grades empty — print grader hasn\'t run yet for this session OR no WIN-graded prints today.');
  if (realizedTracksToday.length === 0) dataQualityNotes.push('ct_print_tracks empty — track tracker hasn\'t run yet, retroactive attribution unavailable.');
  if (signaturesAll.length === 0) dataQualityNotes.push('ct_signatures empty — signature miner hasn\'t accumulated samples yet.');
  if (dataQualityNotes.length > 0) {
    promptLines.push('=== DATA QUALITY FLAGS ===');
    for (const note of dataQualityNotes) promptLines.push(`  - ${note}`);
    promptLines.push('');
  }

  const userMsg = promptLines.join('\n');

  const systemBody = `You are the head of risk attribution at a quantitative options-flow hedge fund. Co-Trader is the autonomous trader; you write the daily P&L attribution report that the partners read at 5pm. Target 900-1200 words.

Style: institutional. Concrete numbers, no hedging language ("seems", "appears", "may"), no disclaimers. Reference signature_keys verbatim (\`QQQ:call:0-7:ATM:ask:open:2h\` style). Reference tickers by symbol. Cite specific prints with timestamps when possible. If a section's data is empty, say so in one sentence and move on — don't pad.

Structure exactly:

**HEADLINE** — single block of 5-6 short sentences. Lead with regime tag, today's snapshot hit rate, total tracks realized, count of slow-burn attributions, count of newly-promoted signatures. Make it readable in 15 seconds.

**Section 1: Today's Edge** — which signatures paid in real-time today (snapshot WINs from ct_print_grades + REALIZED tracks whose print_time is today or yesterday). Cite at least 2-3 specific prints — ticker, contract, print time, signature_key, the underlying move. Be specific: "QQQ 655C 0DTE aggressive-ask at 10:47am peaked +3.2% by 12:15pm."

**Section 2: Retroactive Alpha (Slow-Burn)** — tracks from prints 3+ days old that REALIZED today. This is the second half of the attribution. Quote signature_keys. State the realization gap in days. Example structure: "On 2026-04-17 we captured 14 ask-side calls on NVDA 30-day expiry; 9 of them peaked today, 7 days into life. Signature \`NVDA:call:8-30:OTM-near:ask:midday:plus1d\` is now 18W/4L lifetime, edge 0.42." If list is empty, say "No slow-burn realizations today" in one line.

**Section 3: Failures to Repeat** — promoted signatures that fired today but DIDN'T pay. Pull from top_losing_signatures + per-specialist worst_call. Ask: what's different about today's regime that neutered them? Tie to regime_tag if relevant.

**Section 4: Per-Specialist Scorecard** — march through the 10 specialists in WATCHLIST order. One line each: name, flags written, WIN prints, loss-graded flags, realized tracks, best call, worst call. Tone is performance review — direct, factual, no padding.

**Section 5: Signature Library Health** — total tracked / promoted / newly promoted today. If any newly-promoted, name them and show hit rate + sample. This is the daily proof that the library is GROWING regardless of P&L (Tenet 5).

**Section 6: Tape Narrative** — keep it tight. Open vs close net premium, regime shifts, first-vs-last tape commentary. Concrete numbers from MARKET-WIDE block. 4-6 sentences.

**Section 7: Tomorrow's Watchlist** — call out (a) signatures with high edge_score that FAILED today (potential mean-revert setup tomorrow) and (b) signatures on a hot streak from today's winners. List 3-5 candidates with one-line "why".

End with a single closing sentence on the day's regime → tomorrow's setup.`;

  const system = tctx.temporalAnchorPreamble + '\n\n' + systemBody;

  // ----- Call Sonnet ----------------------------------------------------------
  let summaryText = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let modelUsed: string = CLAUDE_MODELS.sonnet_46;
  let apiError: string | null = null;

  try {
    const resp = await callClaude({
      model: CLAUDE_MODELS.sonnet_46,
      system,
      messages: [{ role: 'user', content: userMsg }],
      max_tokens: 3200,
      temperature: 0.3,
    });
    const textBlock = resp.content.find(b => b.type === 'text' && b.text);
    summaryText = (textBlock?.text ?? '').trim();
    inputTokens = resp.usage?.input_tokens ?? 0;
    outputTokens = resp.usage?.output_tokens ?? 0;
    modelUsed = resp.model ?? modelUsed;
  } catch (e) {
    apiError = e instanceof ClaudeError ? `${e.status}: ${e.message}` : (e instanceof Error ? e.message : String(e));
    summaryText = `[EOD generation offline] ${apiError.slice(0, 200)}\n\nMarket stats: ${flags.length} flags, ${reads.length} reads, ${stacks.length} stacks. Net premium open→close: ${fmtUsd(mktPremOpen)} → ${fmtUsd(mktPremClose)}.`;
  }

  const rates = CLAUDE_RATES[modelUsed as keyof typeof CLAUDE_RATES] ?? CLAUDE_RATES[CLAUDE_MODELS.sonnet_46];
  const costUsd = (inputTokens * rates.input + outputTokens * rates.output) / 1_000_000;

  // ----- Temporal-coherence validator (best-effort) --------------------------
  // Validates summaryText against session_date. Critical contradictions log
  // a warning and ride along on the upsert under
  // market_stats.temporal_validator_warnings (JSONB catch-all).
  let validatorOk = true;
  let validatorContradictions: Array<{ quote: string; issue: string; severity: 'critical' | 'warning' }> = [];
  if (summaryText && !apiError) {
    try {
      const validation = await validateTemporalCoherence(summaryText, tctx.session_date);
      validatorOk = validation.ok;
      validatorContradictions = validation.contradictions;
      const critical = validation.contradictions.filter(c => c.severity === 'critical');
      if (critical.length > 0) {
        console.warn(
          `[ct-eod-summary] temporal validator flagged ${critical.length} CRITICAL contradiction(s) for session ${tctx.session_date}:`,
          JSON.stringify(critical),
        );
      } else if (!validation.ok && validation.contradictions.length > 0) {
        console.warn(
          `[ct-eod-summary] temporal validator flagged ${validation.contradictions.length} warning(s) for session ${tctx.session_date}:`,
          JSON.stringify(validation.contradictions),
        );
      }
    } catch (e) {
      console.warn('[ct-eod-summary] temporal validator threw (non-blocking):', String(e));
    }
  }

  // Stamp validator warnings into market_stats so they ride the upsert.
  // No new column needed — market_stats is the JSONB catch-all per the
  // existing flow_heatmap_per_ticker precedent.
  (marketStats as Record<string, unknown>).temporal_validator_warnings = {
    ok: validatorOk,
    session_date: tctx.session_date,
    contradiction_count: validatorContradictions.length,
    critical_count: validatorContradictions.filter(c => c.severity === 'critical').length,
    contradictions: validatorContradictions,
  };

  // ----- Upsert into ct_eod_summaries ----------------------------------------
  // Includes new attribution columns from migration 20260425000012. Older
  // databases without the migration run will silently drop the new keys (PG
  // upsert on missing column = error — but the migration is checked into the
  // same release so prod is in sync). If a column is missing (defensive),
  // the upsert error is captured below and surfaced on the response.
  const upsertRow = {
    session_date: sessionDate,
    summary_text: summaryText,
    specialist_stats: specialistStats,
    ticker_stats: tickerStats,
    market_stats: marketStats,
    edge_attribution: edgeAttribution,
    slow_burn_pays_today: slowBurnList,
    top_print_grades: topPrintGrades,
    top_realized_tracks: topRealizedTracks,
    specialist_scorecard: specialistScorecard,
    regime_tag: regimeTag,
    snapshot_hit_rate: snapshotHitRate,
    tracks_realized_today: tracksRealizedTodayCount,
    generated_at: new Date().toISOString(),
    model: modelUsed,
    cost_usd: Math.round(costUsd * 1_000_000) / 1_000_000,
  };

  const { data: upserted, error: upsertErr } = await sb
    .from('ct_eod_summaries')
    .upsert(upsertRow, { onConflict: 'session_date' })
    .select('id, session_date, generated_at')
    .single();

  // ----- Slack push (best-effort) --------------------------------------------
  let slackOutcome: 'sent' | 'skipped_no_user' | 'error' | 'skipped_api_error' | 'skipped_manual' = 'skipped_no_user';
  let slackError: string | null = null;

  if (skipSlack) {
    slackOutcome = 'skipped_manual';
  } else if (!apiError) {
    try {
      // Single-user pattern matches ct-slack-digest
      const { data: users } = await sb.from('profiles').select('id').limit(1);
      const userId = users?.[0]?.id as string | undefined;

      if (userId) {
        // Pull headline (everything until the first **Section** marker) for
        // the Slack preview block. Falls back to first 320 chars.
        const sectionSplit = summaryText.search(/\*\*Section 1/i);
        const headline = sectionSplit > 50
          ? summaryText.slice(0, sectionSplit).trim()
          : summaryText.slice(0, 320).trim();
        const preview = headline.slice(0, 600) + (headline.length > 600 ? '…' : '');

        const winLossLine = grades.length > 0
          ? `${marketStats.grade_breakdown.win}W / ${marketStats.grade_breakdown.loss}L / ${marketStats.grade_breakdown.partial}P / ${marketStats.grade_breakdown.invalidated_early}IE`
          : 'no flag grades yet';
        // snapshotHitRate is stored 0..100 (percent), not 0..1.
        const hitRateStr = snapshotHitRate != null
          ? `${Number(snapshotHitRate).toFixed(1)}%`
          : 'n/a';
        const regimeStr = regimeTag ?? 'untagged';
        const slowBurnCount = slowBurnList.length;
        const promotedTodayCount = signaturesPromotedToday.length;

        const headerText = `Co-Trader EOD · ${sessionDate}`;

        const blocks: Array<Record<string, unknown>> = [
          { type: 'header', text: { type: 'plain_text', text: headerText, emoji: true } },
          { type: 'divider' },
          {
            type: 'section',
            fields: [
              { type: 'mrkdwn', text: `*Regime*\n${regimeStr}` },
              { type: 'mrkdwn', text: `*Snapshot hit rate*\n${hitRateStr}` },
              { type: 'mrkdwn', text: `*Tracks realized*\n${tracksRealizedTodayCount ?? 0}` },
              { type: 'mrkdwn', text: `*Slow-burn pays*\n${slowBurnCount}` },
              { type: 'mrkdwn', text: `*Newly promoted*\n${promotedTodayCount}` },
              { type: 'mrkdwn', text: `*Flag grades*\n${winLossLine}` },
            ],
          },
          { type: 'divider' },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Today's totals*\n${flags.length} flags · ${reads.length} reads · ${stacks.length} stacks · ${unusualPulseCount} unusual pulse ticks\n*Market net premium:* ${fmtUsd(mktPremOpen)} → ${fmtUsd(mktPremClose)} (Δ ${fmtUsd(mktPremDelta)})\n*Library:* ${signaturesAll.length} tracked · ${signaturesPromoted.length} promoted`,
            },
          },
          { type: 'divider' },
          {
            type: 'section',
            text: { type: 'mrkdwn', text: `:bar_chart: *Headline*\n${preview}` },
          },
          {
            type: 'context',
            elements: [
              { type: 'mrkdwn', text: `Read full report: <https://www.linkjac.cloud/eod|/eod> · model: ${modelUsed} · $${upsertRow.cost_usd.toFixed(4)}` },
            ],
          },
        ];

        const fallbackText = `Co-Trader EOD ${sessionDate}: regime ${regimeStr} · ${hitRateStr} hit rate · ${tracksRealizedTodayCount ?? 0} tracks realized · ${slowBurnCount} slow-burn pays`;
        await ctSlackPushDirect(supabase, userId, fallbackText, 'eod', blocks);
        slackOutcome = 'sent';
      }
    } catch (e) {
      slackOutcome = 'error';
      slackError = e instanceof Error ? e.message : String(e);
      console.warn('[ct-eod-summary] slack push failed (non-blocking):', slackError);
    }
  } else {
    slackOutcome = 'skipped_api_error';
  }

  return new Response(JSON.stringify({
    ok: !apiError && !upsertErr,
    session_date: sessionDate,
    id: upserted?.id ?? null,
    generated_at: upserted?.generated_at ?? null,
    model: modelUsed,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost_usd: upsertRow.cost_usd,
    summary_preview: summaryText.slice(0, 280),
    counts: {
      flags: flags.length,
      grades: grades.length,
      reads: reads.length,
      scored_flow: scoredFlow.length,
      stacks: stacks.length,
      pulse_ticks: pulseSeries.length,
      tape_rows: tape.length,
      bars: bars.length,
      print_grades_today: printGradesToday.length,
      realized_tracks_today: realizedTracksToday.length,
      slow_burn: slowBurnList.length,
      signatures_total: signaturesAll.length,
      signatures_promoted: signaturesPromoted.length,
      signatures_promoted_today: signaturesPromotedToday.length,
      edge_daily_present: edgeDaily !== null,
    },
    regime_tag: regimeTag,
    snapshot_hit_rate: snapshotHitRate,
    tracks_realized_today: tracksRealizedTodayCount,
    slack: { outcome: slackOutcome, error: slackError },
    api_error: apiError,
    upsert_error: upsertErr?.message ?? null,
    temporal_validator: {
      ok: validatorOk,
      contradiction_count: validatorContradictions.length,
      critical_count: validatorContradictions.filter(c => c.severity === 'critical').length,
    },
  }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});
