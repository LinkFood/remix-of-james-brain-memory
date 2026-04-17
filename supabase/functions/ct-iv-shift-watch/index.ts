/**
 * ct-iv-shift-watch — day-over-day IV rank shift detector.
 *
 * iv_rank lives in ct_iv_rank_daily (written once per day per ticker by
 * ct-eod-positioning at 21:00 UTC). Heartbeats do NOT carry iv_rank, so the
 * earlier intraday-spike approach was architecturally blocked. Instead we run
 * right after EOD positioning lands and emit a ct_iv_shifts row whenever the
 * watchlist ticker's iv_rank moved by >= 10 between the two most recent
 * distinct dates in ct_iv_rank_daily.
 *
 * "SPY IV rank 22 → 48 (+26 day-over-day)" = vol regime shift, surfaced as
 * a pill on the always-on flag strip and (for big moves) pushed to Slack.
 *
 * Attention ladder: |delta| >= 30 → 85, >= 20 → 75, >= 10 → 60.
 * Dedupe: one row per (ticker, ref_day). If this ticker already has a row
 *          for today's ref_day, skip.
 * Slack:  push (via ctSlackPushDirect — digest-style, bypasses flag-dedupe
 *         logic) when attention_score >= 75.
 *
 * Zero new UW calls — this function only reads ct_iv_rank_daily.
 *
 * Cadence: pg_cron at 21:05 UTC weekdays (see 20260419000004_iv_shifts.sql).
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { ctSlackPushDirect } from '../_shared/ctSlack.ts';
import { WATCHLIST, MARKET_BANNER_SYMBOL } from '../_shared/uwClient.ts';

// Window to pull recent iv-rank rows from — wide enough to safely cover
// the last 2 distinct dates across all tickers even after a long weekend
// or holiday (7 days is plenty for a daily-cadence series).
const LOOKBACK_DAYS = 10;

// Attention ladder (magnitude only — direction is separate).
function attentionFor(absDelta: number): number {
  if (absDelta >= 30) return 85;
  if (absDelta >= 20) return 75;
  if (absDelta >= 10) return 60;
  return 0; // below threshold — caller should skip
}

interface IvRankRow {
  ticker: string;
  date: string;       // YYYY-MM-DD
  iv_rank: number | null;
}

interface ShiftCandidate {
  ticker: string;
  prev_rank: number;
  new_rank: number;
  delta: number;              // signed
  direction: 'up' | 'down';
  attention_score: number;
  ref_day: string;
  prev_day: string;
}

/**
 * For a ticker, pick the two most recent distinct dates where iv_rank is
 * non-null. Returns null if we don't have two such rows — can't compute a
 * delta from a single data point (first day ever case).
 */
function pickLatestTwo(rows: IvRankRow[]): { latest: IvRankRow; prior: IvRankRow } | null {
  // rows arrive sorted by date DESC from the query. Filter to non-null iv_rank,
  // then pick the first two distinct dates.
  const seen = new Set<string>();
  const picked: IvRankRow[] = [];
  for (const r of rows) {
    if (r.iv_rank === null || r.iv_rank === undefined) continue;
    if (seen.has(r.date)) continue;
    seen.add(r.date);
    picked.push(r);
    if (picked.length === 2) break;
  }
  if (picked.length < 2) return null;
  return { latest: picked[0], prior: picked[1] };
}

/**
 * Dedupe: skip if we already emitted a row for this ticker on this ref_day.
 * Returns true iff safe to insert.
 */
async function notAlreadyEmitted(
  supabase: SupabaseClient,
  ticker: string,
  refDay: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('ct_iv_shifts')
    .select('id')
    .eq('ticker', ticker)
    .eq('ref_day', refDay)
    .limit(1);
  if (error) {
    // Fail open — duplicate beats silent miss. Log it.
    console.warn('[ct-iv-shift-watch] dedupe query failed:', error.message);
    return true;
  }
  return (data?.length ?? 0) === 0;
}

serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
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
  const sessionDate = new Date().toISOString().slice(0, 10);

  try {
    // Candidate universe: watchlist + market banner (SPX). ct-eod-positioning
    // writes ct_iv_rank_daily for the same universe, so we mirror it.
    const tickers: string[] = Array.from(new Set([...WATCHLIST, MARKET_BANNER_SYMBOL]));

    // One query — pull all recent ct_iv_rank_daily rows for these tickers
    // in the lookback window, group by ticker client-side, pick latest two
    // distinct dates per ticker. This avoids a PostgREST-hostile per-ticker
    // window-function RPC and keeps the function simple.
    const since = new Date(Date.now() - LOOKBACK_DAYS * 86400_000)
      .toISOString().slice(0, 10);
    const { data: rankRows, error: rankErr } = await supabase
      .from('ct_iv_rank_daily')
      .select('ticker, date, iv_rank')
      .in('ticker', tickers)
      .gte('date', since)
      .order('ticker', { ascending: true })
      .order('date', { ascending: false })
      .limit(1000);
    if (rankErr) {
      return new Response(JSON.stringify({ error: `iv_rank_read:${rankErr.message}` }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Group rows by ticker (preserves date DESC within each group).
    const byTicker = new Map<string, IvRankRow[]>();
    for (const r of (rankRows ?? []) as IvRankRow[]) {
      const arr = byTicker.get(r.ticker);
      if (arr) arr.push(r); else byTicker.set(r.ticker, [r]);
    }

    // Pull user_id for Slack push.
    const { data: users } = await supabase.from('profiles').select('id').limit(1);
    const userId = (users?.[0]?.id as string | undefined) ?? null;

    const perTicker: Record<string, {
      scanned: boolean;
      has_pair: boolean;
      delta: number | null;
      emitted: boolean;
      skipped_reason?: string;
    }> = {};
    for (const t of tickers) {
      perTicker[t] = { scanned: true, has_pair: false, delta: null, emitted: false };
    }

    const candidates: ShiftCandidate[] = [];
    for (const t of tickers) {
      const rows = byTicker.get(t) ?? [];
      const pair = pickLatestTwo(rows);
      if (!pair) {
        perTicker[t].skipped_reason = rows.length === 0
          ? 'no_iv_rank_rows'
          : 'only_one_distinct_date';
        continue;
      }
      perTicker[t].has_pair = true;
      const newRank = pair.latest.iv_rank as number;
      const prevRank = pair.prior.iv_rank as number;
      const delta = newRank - prevRank;
      perTicker[t].delta = delta;
      const abs = Math.abs(delta);
      if (abs < 10) {
        perTicker[t].skipped_reason = `below_threshold_${abs.toFixed(1)}`;
        continue;
      }
      candidates.push({
        ticker: t,
        prev_rank: prevRank,
        new_rank: newRank,
        delta,
        direction: delta >= 0 ? 'up' : 'down',
        attention_score: attentionFor(abs),
        ref_day: pair.latest.date,
        prev_day: pair.prior.date,
      });
    }

    let emitted = 0;
    let slack_pushes = 0;
    for (const c of candidates) {
      const ok = await notAlreadyEmitted(supabase, c.ticker, c.ref_day);
      if (!ok) {
        perTicker[c.ticker].skipped_reason = `already_emitted_for_ref_day_${c.ref_day}`;
        continue;
      }
      const { error: insErr } = await supabase.from('ct_iv_shifts').insert({
        session_date:    sessionDate,
        ticker:          c.ticker,
        prev_rank:       c.prev_rank,
        new_rank:        c.new_rank,
        delta:           c.delta,
        direction:       c.direction,
        attention_score: c.attention_score,
        ref_day:         c.ref_day,
      });
      if (insErr) {
        console.warn('[ct-iv-shift-watch] insert failed:', insErr.message);
        perTicker[c.ticker].skipped_reason = `insert_error:${insErr.message.slice(0, 60)}`;
        continue;
      }
      perTicker[c.ticker].emitted = true;
      emitted++;

      // Slack push — only for material moves (>=75). ctSlackPushDirect skips
      // the flag-dedupe window (this is a daily digest-style signal — dedupe
      // is handled by the ref_day DB check above, not the 30-min slack window).
      if (userId && c.attention_score >= 75) {
        const sign = c.delta >= 0 ? '+' : '';
        const line = `:chart_with_upwards_trend: *IV SHIFT* · ${c.ticker} IV rank ${c.prev_rank.toFixed(0)} → ${c.new_rank.toFixed(0)} (${sign}${c.delta.toFixed(0)} day-over-day)`;
        await ctSlackPushDirect(supabase, userId, line, 'iv_shift');
        slack_pushes++;
      }
    }

    return new Response(JSON.stringify({
      session_date: sessionDate,
      tickers_scanned: tickers.length,
      candidates: candidates.length,
      emitted,
      slack_pushes,
      per_ticker: perTicker,
      duration_ms: Date.now() - startedAt,
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[ct-iv-shift-watch] fatal:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'failed',
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
