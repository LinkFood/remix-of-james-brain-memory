// get_eod_summary — Tier 1 v2 tool.
//
// Returns Co-Trader's end-of-day session summary for a given trading session.
// Combines `ct_eod_summaries` (long-form narrative + headline stats) and
// `ct_eod_reports` (structured per-ticker close + recap blocks). Joined by
// `session_date` (1:1 in production) and via `eod_summary_id`.
//
// Per Phase A audit (`docs/audit/2026-05-05-cotrader-mcp-v2-tier1-phase-a.md`):
//   - Default mode is SLIM (~3k tokens) — keeps under the 8k budget.
//     `verbose: true` opts into the full long-form markdown (~12.7k tokens).
//   - Default date: most-recent-available given current ET clock. During RTH
//     the EOD for today doesn't exist yet — fall back to last completed
//     session via `marketClock.lastMarketClose`.
//   - 1:1 join — every report has a summary; not every summary has a report.
//
// Read-only (SELECT). Best-effort telemetry to `ct_brain_telemetry`.

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { resolveAuth } from '../lib/auth.ts';
import { isMarketOpen, lastMarketClose } from '../../../supabase/functions/_shared/marketClock.ts';
import { dateInTz } from '../../../supabase/functions/_shared/clock.ts';

const CONSUMER_NAME = 'cotrader-mcp';
const TOOL_NAME = 'tool:get_eod_summary';
const ET_TZ = 'America/New_York';

export interface GetEodSummaryArgs {
  date?: string; // YYYY-MM-DD ET session_date. Default: most-recent-available.
  verbose?: boolean; // default false — opt-in to full long-form markdown.
}

export interface EodSlimResult {
  session_date: string;
  // From ct_eod_reports (canonical when present)
  session_summary: string | null;
  regime_close: string | null;
  regime_shift_today: string | null;
  per_ticker_close: unknown;
  tomorrow_watchlist: unknown;
  lessons_today: unknown;
  morning_brief_scorecard: unknown;
  scorecard_summary: unknown;
  // From ct_eod_summaries (headline stats)
  regime_tag: string | null;
  snapshot_hit_rate: number | null;
  tracks_realized_today: number | null;
  generated_at: string | null;
  cost_usd_total: number | null;
}

export interface EodVerboseResult extends EodSlimResult {
  // Full payload — long-form markdown + every JSONB block
  summary_text: string | null;
  specialist_stats: unknown;
  ticker_stats: unknown;
  market_stats: unknown;
  edge_attribution: unknown;
  slow_burn_pays_today: unknown;
  top_print_grades: unknown;
  top_realized_tracks: unknown;
  specialist_scorecard: unknown;
  carryover_themes: unknown;
  overnight_catalysts: unknown;
  breaking_events_today: unknown;
  flow_recap: unknown;
  stack_recap: unknown;
  realized_recap: unknown;
  script: string | null;
}

export interface GetEodSummaryResult {
  payload: EodSlimResult | EodVerboseResult | null;
  meta: {
    consumerName: string;
    tool: string;
    requestedSessionDate: string;
    verbose: boolean;
    summaryRowFound: boolean;
    reportRowFound: boolean;
    latencyMs: number;
    generatedAt: string;
    warnings: string[];
  };
}

/**
 * Resolve the most-recent-available session_date in ET. During RTH the brief
 * for today's session hasn't fired yet (EOD cron at ~16:30 ET). Pre-open we
 * also want yesterday's. The simplest correct rule: take the last market
 * close. lastMarketClose returns "today's 16:00 ET" only if we've already
 * passed it; otherwise it walks back.
 */
function defaultSessionDate(): string {
  const ts = new Date();
  // If we're inside RTH (open), today's EOD definitely doesn't exist yet ⇒
  // use the previous trading day's close. lastMarketClose handles both
  // pre-open (returns yesterday) and after-hours (returns today's close).
  // During RTH it would return yesterday's close — exactly what we want.
  const refDate = isMarketOpen(ts)
    ? lastMarketClose(ts)
    : lastMarketClose(ts);
  return dateInTz(refDate, ET_TZ);
}

async function emitTelemetry(
  supabase: SupabaseClient,
  args: { latencyMs: number; outputBytes: number; error?: string | null },
): Promise<void> {
  try {
    await supabase.from('ct_brain_telemetry').insert({
      helper_name: TOOL_NAME,
      audience: 'cotrader',
      ticker_focus: null,
      consumer_name: CONSUMER_NAME,
      latency_ms: args.latencyMs,
      output_size_bytes: args.outputBytes,
      cache_hit: false,
      error: args.error ?? null,
    });
  } catch (_e) {
    // never block
  }
}

export async function getEodSummary(args: GetEodSummaryArgs): Promise<GetEodSummaryResult> {
  const t0 = performance.now();
  const warnings: string[] = [];

  let sessionDate: string;
  if (args.date && /^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
    sessionDate = args.date;
  } else {
    if (args.date) warnings.push(`invalid_date_format:${args.date} — using default`);
    sessionDate = defaultSessionDate();
  }

  const verbose = args.verbose === true;

  const { supabaseUrl, serviceRoleKey } = await resolveAuth();
  const supabase: SupabaseClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  // Fetch summary row (always needed for headline stats)
  const summarySelectSlim =
    'id, session_date, regime_tag, snapshot_hit_rate, tracks_realized_today, generated_at, cost_usd';
  const summarySelectVerbose =
    summarySelectSlim +
    ', summary_text, specialist_stats, ticker_stats, market_stats, edge_attribution, slow_burn_pays_today, top_print_grades, top_realized_tracks, specialist_scorecard, model';

  const summaryQ = supabase
    .from('ct_eod_summaries')
    .select(verbose ? summarySelectVerbose : summarySelectSlim)
    .eq('session_date', sessionDate)
    .order('id', { ascending: false })
    .limit(1);

  // Fetch report row (per-ticker close + recap blocks)
  const reportSelectSlim =
    'id, session_date, session_summary, regime_close, regime_shift_today, per_ticker_close, tomorrow_watchlist, lessons_today, morning_brief_scorecard, scorecard_summary, generated_at, cost_usd';
  const reportSelectVerbose =
    reportSelectSlim +
    ', carryover_themes, overnight_catalysts, breaking_events_today, flow_recap, stack_recap, realized_recap, script, eod_summary_id, morning_brief_id';

  const reportQ = supabase
    .from('ct_eod_reports')
    .select(verbose ? reportSelectVerbose : reportSelectSlim)
    .eq('session_date', sessionDate)
    .order('generated_at', { ascending: false })
    .limit(1);

  const [summaryRes, reportRes] = await Promise.all([summaryQ, reportQ]);

  const latencyMs = Math.round(performance.now() - t0);

  if (summaryRes.error) {
    const msg = `ct_eod_summaries query failed: ${summaryRes.error.message}`;
    void emitTelemetry(supabase, { latencyMs, outputBytes: 0, error: msg });
    throw new Error(msg);
  }
  if (reportRes.error) {
    const msg = `ct_eod_reports query failed: ${reportRes.error.message}`;
    void emitTelemetry(supabase, { latencyMs, outputBytes: 0, error: msg });
    throw new Error(msg);
  }

  const summaryRow = (summaryRes.data && summaryRes.data[0]) as Record<string, unknown> | undefined;
  const reportRow = (reportRes.data && reportRes.data[0]) as Record<string, unknown> | undefined;

  if (!summaryRow && !reportRow) {
    warnings.push(`no_eod_data_for_session:${sessionDate}`);
    const result: GetEodSummaryResult = {
      payload: null,
      meta: {
        consumerName: CONSUMER_NAME,
        tool: TOOL_NAME,
        requestedSessionDate: sessionDate,
        verbose,
        summaryRowFound: false,
        reportRowFound: false,
        latencyMs,
        generatedAt: new Date().toISOString(),
        warnings,
      },
    };
    void emitTelemetry(supabase, {
      latencyMs,
      outputBytes: JSON.stringify(result).length,
      error: null,
    });
    return result;
  }
  if (!reportRow) warnings.push(`no_eod_report_for_session:${sessionDate} — report block omitted`);
  if (!summaryRow) warnings.push(`no_eod_summary_for_session:${sessionDate} — headline stats null`);

  const summaryCost = (summaryRow?.cost_usd as number | null) ?? null;
  const reportCost = (reportRow?.cost_usd as number | null) ?? null;
  const totalCost =
    summaryCost === null && reportCost === null
      ? null
      : (summaryCost ?? 0) + (reportCost ?? 0);

  const slim: EodSlimResult = {
    session_date: sessionDate,
    session_summary: (reportRow?.session_summary as string | null) ?? null,
    regime_close: (reportRow?.regime_close as string | null) ?? null,
    regime_shift_today: (reportRow?.regime_shift_today as string | null) ?? null,
    per_ticker_close: reportRow?.per_ticker_close ?? null,
    tomorrow_watchlist: reportRow?.tomorrow_watchlist ?? null,
    lessons_today: reportRow?.lessons_today ?? null,
    morning_brief_scorecard: reportRow?.morning_brief_scorecard ?? null,
    scorecard_summary: reportRow?.scorecard_summary ?? null,
    regime_tag: (summaryRow?.regime_tag as string | null) ?? null,
    snapshot_hit_rate: (summaryRow?.snapshot_hit_rate as number | null) ?? null,
    tracks_realized_today: (summaryRow?.tracks_realized_today as number | null) ?? null,
    generated_at:
      (reportRow?.generated_at as string | null) ??
      (summaryRow?.generated_at as string | null) ??
      null,
    cost_usd_total: totalCost,
  };

  const payload: EodSlimResult | EodVerboseResult = verbose
    ? ({
        ...slim,
        summary_text: (summaryRow?.summary_text as string | null) ?? null,
        specialist_stats: summaryRow?.specialist_stats ?? null,
        ticker_stats: summaryRow?.ticker_stats ?? null,
        market_stats: summaryRow?.market_stats ?? null,
        edge_attribution: summaryRow?.edge_attribution ?? null,
        slow_burn_pays_today: summaryRow?.slow_burn_pays_today ?? null,
        top_print_grades: summaryRow?.top_print_grades ?? null,
        top_realized_tracks: summaryRow?.top_realized_tracks ?? null,
        specialist_scorecard: summaryRow?.specialist_scorecard ?? null,
        carryover_themes: reportRow?.carryover_themes ?? null,
        overnight_catalysts: reportRow?.overnight_catalysts ?? null,
        breaking_events_today: reportRow?.breaking_events_today ?? null,
        flow_recap: reportRow?.flow_recap ?? null,
        stack_recap: reportRow?.stack_recap ?? null,
        realized_recap: reportRow?.realized_recap ?? null,
        script: (reportRow?.script as string | null) ?? null,
      } satisfies EodVerboseResult)
    : slim;

  const result: GetEodSummaryResult = {
    payload,
    meta: {
      consumerName: CONSUMER_NAME,
      tool: TOOL_NAME,
      requestedSessionDate: sessionDate,
      verbose,
      summaryRowFound: !!summaryRow,
      reportRowFound: !!reportRow,
      latencyMs,
      generatedAt: new Date().toISOString(),
      warnings,
    },
  };

  const outputBytes = JSON.stringify(result).length;
  void emitTelemetry(supabase, { latencyMs, outputBytes, error: null });

  return result;
}
