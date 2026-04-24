/**
 * ct-score-self-grade — nightly retrospective audit of the scoring engine.
 *
 * For each score band (0-19, 20-39, 40-59, 60-79, 80-100), looks at
 * ct_scored_flow rows from the last N days and measures: did the underlying
 * actually move toward the strike? A call-buyer-opened print "wins" if spot
 * rises; a put-buyer-opened print "wins" if spot falls; opening_sell flips
 * the direction. Ambiguous / closing rows are excluded.
 *
 * Writes one ct_score_calibration row per band per day. After 14+ days,
 * we can see which bands are over- or under-indexed relative to realized
 * win rate and rebalance the scoring weights.
 *
 * Also writes a ticker_adv summary to stdout so we can see which tickers
 * drive the calibration.
 *
 * Ad-hoc POST body: { window_days?: number, as_of_date?: string }
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';

const WATCHLIST = ['SPY','QQQ','IWM','AAPL','MSFT','GOOGL','AMZN','META','NVDA','TSLA'];
const SCORE_BANDS: Array<[number, number]> = [[0,19],[20,39],[40,59],[60,79],[80,100]];
const HORIZON_HOURS = 72;   // look 72h past the event for realized outcome

interface ScoredRow {
  id: number;
  ticker: string;
  option_symbol: string;
  event_ts: string;
  classification: string;
  direction: string;
  score: number;
  strike: number | null;
  premium: number | null;
}

interface PriceBar {
  ticker: string;
  ts: string;
  close: number;
}

async function getSpotAt(
  supabase: SupabaseClient,
  ticker: string,
  at: string,
  windowMs = 2 * 3600_000,
): Promise<number | null> {
  const target = Date.parse(at);
  const windowStart = new Date(target - windowMs).toISOString();
  const windowEnd = new Date(target + windowMs).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (supabase.from('ct_price_bars' as never) as any)
    .select('ticker,ts,close')
    .eq('ticker', ticker)
    .gte('ts', windowStart)
    .lte('ts', windowEnd)
    .order('ts', { ascending: true });
  const rows = (data ?? []) as PriceBar[];
  if (rows.length === 0) return null;
  // Pick the bar closest to `at`
  let best: PriceBar | null = null;
  let bestDiff = Infinity;
  for (const r of rows) {
    const d = Math.abs(Date.parse(r.ts) - target);
    if (d < bestDiff) { bestDiff = d; best = r; }
  }
  return best?.close ?? null;
}

interface Outcome {
  right: number;   // moved in the predicted direction by >= 0.5%
  wrong: number;   // moved opposite by >= 0.5%
  flat: number;    // < 0.5% move either way
  totalMoveToStrike: number;  // sum of signed % toward strike
  totalAbsMove: number;
}

serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  const corsHeaders = getCorsHeaders(req);
  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }),
      { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const body = await req.json().catch(() => ({})) as { window_days?: number; as_of_date?: string };
  const windowDays = Math.min(Math.max(body.window_days ?? 7, 1), 30);
  const asOfDate = body.as_of_date ?? new Date().toISOString().slice(0, 10);

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  // Pull scored_flow rows in window — only opening_buy / opening_sell rows
  // have a testable directional prediction.
  const windowEnd = new Date(asOfDate + 'T00:00:00Z');
  const windowStart = new Date(windowEnd.getTime() - windowDays * 86_400_000);
  // Also require the row is >= HORIZON_HOURS old so we have realized data
  const maxEventTs = new Date(windowEnd.getTime() - HORIZON_HOURS * 3_600_000);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: scoredRaw } = await (supabase.from('ct_scored_flow' as never) as any)
    .select('id,ticker,option_symbol,event_ts,classification,direction,score,strike,premium')
    .in('ticker', WATCHLIST)
    .in('classification', ['opening_buy', 'opening_sell'])
    .gte('event_ts', windowStart.toISOString())
    .lte('event_ts', maxEventTs.toISOString())
    .limit(10_000);
  const scored = (scoredRaw ?? []) as ScoredRow[];

  // Bucket rows by score band
  const buckets: Map<string, ScoredRow[]> = new Map();
  for (const [lo, hi] of SCORE_BANDS) buckets.set(`${lo}-${hi}`, []);
  for (const r of scored) {
    if (r.score == null) continue;
    for (const [lo, hi] of SCORE_BANDS) {
      if (r.score >= lo && r.score <= hi) {
        buckets.get(`${lo}-${hi}`)!.push(r);
        break;
      }
    }
  }

  // Grade each bucket
  const report: Array<Record<string, unknown>> = [];

  for (const [lo, hi] of SCORE_BANDS) {
    const rows = buckets.get(`${lo}-${hi}`) ?? [];
    if (rows.length === 0) {
      report.push({ band: `${lo}-${hi}`, n: 0 });
      continue;
    }

    const outcome: Outcome = { right: 0, wrong: 0, flat: 0, totalMoveToStrike: 0, totalAbsMove: 0 };
    let gradedCount = 0;

    for (const r of rows) {
      const spotAtFlag = await getSpotAt(supabase, r.ticker, r.event_ts);
      const horizonTs = new Date(Date.parse(r.event_ts) + HORIZON_HOURS * 3_600_000).toISOString();
      const spotAtHorizon = await getSpotAt(supabase, r.ticker, horizonTs);
      if (spotAtFlag == null || spotAtHorizon == null || spotAtFlag <= 0) continue;

      const pctMove = (spotAtHorizon - spotAtFlag) / spotAtFlag * 100;
      // Predicted direction per classification
      // opening_buy call = predict up (strike above spot)
      // opening_buy put = predict down
      // opening_sell call = predict down/flat
      // opening_sell put = predict up/flat
      const side = r.option_symbol?.length > 8 && (r.option_symbol.charAt(r.option_symbol.length - 9) === 'C' || r.option_symbol.charAt(r.option_symbol.length - 9) === 'c') ? 'C' : 'P';
      const isCallBuy = r.classification === 'opening_buy' && side === 'C';
      const isPutBuy = r.classification === 'opening_buy' && side === 'P';
      const isCallSell = r.classification === 'opening_sell' && side === 'C';
      const isPutSell = r.classification === 'opening_sell' && side === 'P';

      // "Right" = direction you'd want if you shared the trader's thesis
      let directionalSign = 0;
      if (isCallBuy || isPutSell) directionalSign = 1;    // predict up
      if (isPutBuy || isCallSell) directionalSign = -1;   // predict down

      const absMove = Math.abs(pctMove);
      if (absMove < 0.5) outcome.flat++;
      else if (directionalSign === 1 && pctMove > 0) outcome.right++;
      else if (directionalSign === -1 && pctMove < 0) outcome.right++;
      else if (directionalSign !== 0) outcome.wrong++;
      else outcome.flat++;

      // Move to strike: if trader bet strike would be reached, positive means closer
      if (r.strike != null && spotAtFlag != null) {
        const distBefore = Math.abs(r.strike - spotAtFlag);
        const distAfter = Math.abs(r.strike - spotAtHorizon);
        const moveTowardStrike = distBefore - distAfter;  // positive = closer
        const moveToStrikePct = spotAtFlag > 0 ? (moveTowardStrike / spotAtFlag) * 100 : 0;
        outcome.totalMoveToStrike += moveToStrikePct;
      }
      outcome.totalAbsMove += absMove;
      gradedCount++;
    }

    const winRate = gradedCount > 0 ? outcome.right / gradedCount : null;
    const avgMoveToStrike = gradedCount > 0 ? outcome.totalMoveToStrike / gradedCount : null;
    const avgAbsMove = gradedCount > 0 ? outcome.totalAbsMove / gradedCount : null;

    // Upsert calibration row
    const calibRow = {
      calibration_date: asOfDate,
      window_days: windowDays,
      score_band_low: lo,
      score_band_high: hi,
      n_rows: gradedCount,
      n_right_direction: outcome.right,
      n_wrong_direction: outcome.wrong,
      n_flat: outcome.flat,
      realized_win_rate: winRate,
      avg_move_to_strike: avgMoveToStrike,
      avg_abs_move: avgAbsMove,
    };

    await supabase
      .from('ct_score_calibration')
      .upsert(calibRow, { onConflict: 'calibration_date,window_days,score_band_low' });

    report.push({
      band: `${lo}-${hi}`,
      n: gradedCount,
      win_rate: winRate != null ? Math.round(winRate * 1000) / 10 + '%' : null,
      avg_move_to_strike_pct: avgMoveToStrike != null ? Math.round(avgMoveToStrike * 100) / 100 : null,
      avg_abs_move_pct: avgAbsMove != null ? Math.round(avgAbsMove * 100) / 100 : null,
      right: outcome.right,
      wrong: outcome.wrong,
      flat: outcome.flat,
    });
  }

  return new Response(JSON.stringify({
    ok: true,
    as_of_date: asOfDate,
    window_days: windowDays,
    horizon_hours: HORIZON_HOURS,
    total_scored_in_window: scored.length,
    bands: report,
  }, null, 2), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});
