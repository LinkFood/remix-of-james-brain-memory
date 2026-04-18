/**
 * ct-debate-outcome-scorer — resolves James's /debate picks into right/wrong.
 *
 * Daily at 22:00 UTC (after US close). For each ct_debates row where:
 *   - user_pick IS NOT NULL               (James committed)
 *   - outcome_verdict IS NULL             (not yet scored)
 *   - created_at > now() - 24h            (wait a full day before grading)
 *
 * Scoring approach — per build spec:
 *   1. Derive the picked-side expectation:
 *        - bull pick  → bull_case.best_trade should be PROFITABLE
 *        - bear pick  → bear_case.best_trade should be PROFITABLE
 *        - neither    → NEITHER side's best_trade should be profitable
 *          (both moves weak → right; one side clearly won → wrong)
 *   2. Extract horizon_hrs (from best_trade.horizon_hrs if structured, else
 *      default to 24h — matches the "created_at > 24h ago" pickup rule).
 *   3. Extract the instrument from ct_debates.instrument. If null, we can't
 *      measure price → fall back to Haiku ("given what we know, did the
 *      picked side prevail?").
 *   4. Pull ct_price_ticks for that instrument across the debate window
 *      [created_at, created_at + horizon_hrs]. Price change = last tick
 *      minus first tick (percent move).
 *   5. Threshold: |move| >= 0.5% = directional signal. Below that, the
 *      move is noise → fall back to Haiku.
 *   6. Map price move → picked-side verdict:
 *        bull pick, move up   → right
 *        bull pick, move down → wrong
 *        bear pick, move down → right
 *        bear pick, move up   → wrong
 *        neither, |move| < 0.5% → right
 *        neither, |move| >= 0.5% → wrong
 *   7. If ct_price_ticks is sparse (<5 ticks in window) or instrument is
 *      null → Haiku fallback. Prompt gives Haiku both cases, the pick, and
 *      "given what we know, did the picked side prevail?". Haiku returns
 *      right/wrong/pending. We honor pending — that means insufficient
 *      info, so we leave outcome_verdict untouched (or mark pending for
 *      audit, same semantic).
 *
 * Weekly aggregate: James's win rate across the last 7 days is written as
 * a brain_insight (type=debate_weekly) so it surfaces in the morning brief.
 * Not blocking — failure here doesn't fail the scorer run.
 *
 * Auth: service role only. Called by pg_cron at 22:00 UTC.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { callClaude, CLAUDE_MODELS, parseTextContent, ClaudeError } from '../_shared/anthropic.ts';

// Bound Haiku fan-out per run. 50 pending debates/day would be extraordinary
// single-user volume — a 20 cap is plenty headroom.
const MAX_PER_RUN = 20;

// Minimum price move to count as "directional." Below this we punt to Haiku.
const DIRECTIONAL_THRESHOLD_PCT = 0.5;

// Default horizon when best_trade.horizon_hrs is missing / malformed.
const DEFAULT_HORIZON_HRS = 24;

// Minimum ticks in the window before we trust the price-based verdict.
const MIN_TICKS_FOR_PRICE_VERDICT = 5;

// -----------------------------------------------------------------------------
// Types (loose — the JSONB sides come straight from Sonnet's output)
// -----------------------------------------------------------------------------
interface DebateRow {
  id: string;
  user_id: string;
  created_at: string;
  topic: string;
  instrument: string | null;
  bull_case: Record<string, unknown>;
  bear_case: Record<string, unknown>;
  user_pick: 'bull' | 'bear' | 'neither';
  synthesis: string | null;
}

interface PriceTick {
  tick_time: string;
  price: number;
}

// -----------------------------------------------------------------------------
// Horizon extraction
// -----------------------------------------------------------------------------
function extractHorizonHrs(bestTrade: unknown): number {
  // best_trade is a string per DebateSide.best_trade type, but older rows or
  // future variants might stuff a {horizon_hrs: N} object in. Handle both.
  if (bestTrade && typeof bestTrade === 'object') {
    const v = (bestTrade as Record<string, unknown>).horizon_hrs;
    if (typeof v === 'number' && v > 0 && v <= 24 * 14) return v;
  }
  if (typeof bestTrade === 'string') {
    // Try to parse "over 4h", "next 2 hours", "24h" patterns.
    const m = bestTrade.match(/(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)/i);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > 0 && n <= 24 * 14) return n;
    }
  }
  return DEFAULT_HORIZON_HRS;
}

// -----------------------------------------------------------------------------
// Pull ct_price_ticks for an instrument across [start, end]. Returns ticks
// sorted by time asc so first/last are meaningful.
// -----------------------------------------------------------------------------
async function fetchTicks(
  supabase: SupabaseClient,
  instrument: string,
  startISO: string,
  endISO: string,
): Promise<PriceTick[]> {
  const { data, error } = await supabase
    .from('ct_price_ticks')
    .select('tick_time, price')
    .eq('ticker', instrument.toUpperCase())
    .gte('tick_time', startISO)
    .lte('tick_time', endISO)
    .order('tick_time', { ascending: true });
  if (error) {
    console.warn(`[ct-debate-outcome-scorer] tick fetch ${instrument}: ${error.message}`);
    return [];
  }
  return (data ?? []).map((r) => ({
    tick_time: r.tick_time as string,
    price: Number(r.price),
  })).filter((t) => Number.isFinite(t.price));
}

// -----------------------------------------------------------------------------
// Price-based verdict. Returns null when the move is sub-threshold (caller
// should fall back to Haiku).
// -----------------------------------------------------------------------------
function verdictFromPriceMove(
  movePct: number,
  pick: 'bull' | 'bear' | 'neither',
): 'right' | 'wrong' | null {
  const abs = Math.abs(movePct);
  if (pick === 'neither') {
    // "Neither side's trade works" = quiet tape. Big move = one side won
    // = James's neither call was wrong.
    if (abs < DIRECTIONAL_THRESHOLD_PCT) return 'right';
    return 'wrong';
  }
  if (abs < DIRECTIONAL_THRESHOLD_PCT) return null; // Haiku territory.
  const up = movePct > 0;
  if (pick === 'bull') return up ? 'right' : 'wrong';
  return up ? 'wrong' : 'right'; // bear
}

// -----------------------------------------------------------------------------
// Haiku fallback — asked a narrow yes/no. Returns right/wrong/pending.
// -----------------------------------------------------------------------------
interface HaikuVerdict {
  verdict: 'right' | 'wrong' | 'pending';
  reasoning: string;
}

const HAIKU_VERDICT_SYSTEM = `You're grading ONE trade debate. James picked a side. Your job:
given the two cases and what we know (price move if available, elapsed time,
and context), decide whether the picked side PREVAILED.

Return strictly JSON:
  { "verdict": "right" | "wrong" | "pending", "reasoning": "1 sentence, cite the specific evidence" }

Rules:
  - "right"   = the picked side's best_trade would have worked
  - "wrong"   = it wouldn't have
  - "pending" = you genuinely cannot tell from the payload (use sparingly)
  - Don't grade on narrative fit — grade on whether the SPECIFIC TRADE CONDITION
    in the picked side's best_trade held over the horizon.
  - "neither" pick = correct iff BOTH sides' trades would have failed
    (i.e., neither bull nor bear got their move).`;

async function haikuVerdict(
  debate: DebateRow,
  priceContext: { move_pct: number | null; ticks: number; horizon_hrs: number },
): Promise<HaikuVerdict | null> {
  const payload = {
    topic: debate.topic,
    instrument: debate.instrument,
    bull_case: debate.bull_case,
    bear_case: debate.bear_case,
    synthesis: debate.synthesis,
    user_pick: debate.user_pick,
    elapsed_hrs_since_debate: (Date.now() - new Date(debate.created_at).getTime()) / 3_600_000,
    price_context: priceContext,
  };
  try {
    const res = await callClaude({
      model: CLAUDE_MODELS.haiku,
      system: HAIKU_VERDICT_SYSTEM,
      messages: [{ role: 'user', content: JSON.stringify(payload) }],
      max_tokens: 250,
      temperature: 0.1,
    });
    const raw = parseTextContent(res).trim();
    const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed = JSON.parse(stripped) as Record<string, unknown>;
    const verdict = parsed.verdict;
    if (verdict !== 'right' && verdict !== 'wrong' && verdict !== 'pending') return null;
    return {
      verdict,
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
    };
  } catch (e) {
    const detail = e instanceof ClaudeError ? `Claude ${e.status}` : String(e);
    console.warn(`[ct-debate-outcome-scorer] haiku failed for debate=${debate.id}: ${detail}`);
    return null;
  }
}

// -----------------------------------------------------------------------------
// Score a single debate. Writes outcome_verdict + outcome_at + outcome_detail.
// Returns which path was used (price/haiku) + the verdict for aggregation.
// -----------------------------------------------------------------------------
async function scoreDebate(
  supabase: SupabaseClient,
  debate: DebateRow,
): Promise<{ path: 'price' | 'haiku' | 'skip'; verdict: 'right' | 'wrong' | 'pending' | null }> {
  // Determine horizon from the picked side's best_trade.
  const pickedSide = debate.user_pick === 'bull'
    ? debate.bull_case
    : debate.user_pick === 'bear'
      ? debate.bear_case
      : null;
  const horizonHrs = pickedSide
    ? extractHorizonHrs((pickedSide as Record<string, unknown>).best_trade)
    // 'neither' uses whichever side has the longer horizon — the window must
    // cover both cases for "nothing happened" to be honest.
    : Math.max(
        extractHorizonHrs((debate.bull_case as Record<string, unknown>).best_trade),
        extractHorizonHrs((debate.bear_case as Record<string, unknown>).best_trade),
      );

  const startMs = new Date(debate.created_at).getTime();
  const endMs = startMs + horizonHrs * 3_600_000;
  if (endMs > Date.now()) {
    // Horizon not yet fully elapsed. Skip — the pickup query already filters
    // on 24h, but a custom 48h best_trade horizon might still be open.
    return { path: 'skip', verdict: null };
  }

  // Price path: only possible if we have an instrument.
  let movePct: number | null = null;
  let tickCount = 0;
  if (debate.instrument) {
    const ticks = await fetchTicks(
      supabase,
      debate.instrument,
      new Date(startMs).toISOString(),
      new Date(endMs).toISOString(),
    );
    tickCount = ticks.length;
    if (tickCount >= MIN_TICKS_FOR_PRICE_VERDICT) {
      const first = ticks[0].price;
      const last = ticks[ticks.length - 1].price;
      if (first > 0) movePct = ((last - first) / first) * 100;
    }
  }

  let verdict: 'right' | 'wrong' | 'pending' | null = null;
  let detail: Record<string, unknown> = {
    horizon_hrs: horizonHrs,
    instrument: debate.instrument,
    tick_count: tickCount,
    move_pct: movePct,
  };
  let path: 'price' | 'haiku' | 'skip' = 'skip';

  if (movePct != null) {
    const pv = verdictFromPriceMove(movePct, debate.user_pick);
    if (pv) {
      verdict = pv;
      path = 'price';
      detail = { ...detail, method: 'price_move', threshold_pct: DIRECTIONAL_THRESHOLD_PCT };
    }
  }

  // Haiku fallback: no price data, or move was sub-threshold for a bull/bear pick.
  if (verdict == null) {
    const h = await haikuVerdict(debate, {
      move_pct: movePct,
      ticks: tickCount,
      horizon_hrs: horizonHrs,
    });
    if (h) {
      verdict = h.verdict;
      path = 'haiku';
      detail = { ...detail, method: 'haiku_fallback', haiku_reasoning: h.reasoning };
    }
  }

  if (verdict == null) {
    // Couldn't score. Mark as pending so we don't retry forever; operator
    // can unset outcome_verdict manually if they want another pass.
    verdict = 'pending';
    path = path === 'skip' ? 'haiku' : path;
    detail = { ...detail, method: 'unresolved' };
  }

  const { error } = await supabase
    .from('ct_debates')
    .update({
      outcome_verdict: verdict,
      outcome_at: new Date().toISOString(),
      outcome_detail: detail,
    })
    .eq('id', debate.id);
  if (error) {
    console.warn(`[ct-debate-outcome-scorer] update failed debate=${debate.id}: ${error.message}`);
  }

  return { path, verdict };
}

// -----------------------------------------------------------------------------
// Weekly aggregate — per user, over the last 7 days. Non-blocking.
// -----------------------------------------------------------------------------
async function writeWeeklyAggregate(supabase: SupabaseClient): Promise<void> {
  try {
    const since = new Date(Date.now() - 7 * 24 * 3_600_000).toISOString();
    const { data, error } = await supabase
      .from('ct_debates')
      .select('user_id, user_pick, outcome_verdict')
      .gte('created_at', since)
      .not('user_pick', 'is', null)
      .in('outcome_verdict', ['right', 'wrong']);
    if (error || !data) return;

    // Group by user_id.
    const byUser = new Map<string, { right: number; wrong: number; total: number; by_side: Record<string, { r: number; w: number }> }>();
    for (const r of data as Array<{ user_id: string; user_pick: string; outcome_verdict: string }>) {
      const bucket = byUser.get(r.user_id) ?? {
        right: 0, wrong: 0, total: 0,
        by_side: { bull: { r: 0, w: 0 }, bear: { r: 0, w: 0 }, neither: { r: 0, w: 0 } },
      };
      bucket.total++;
      if (r.outcome_verdict === 'right') bucket.right++;
      else bucket.wrong++;
      const side = bucket.by_side[r.user_pick];
      if (side) {
        if (r.outcome_verdict === 'right') side.r++;
        else side.w++;
      }
      byUser.set(r.user_id, bucket);
    }

    for (const [user_id, stats] of byUser) {
      const winRate = stats.total > 0 ? stats.right / stats.total : 0;
      const body = [
        `Debate win rate (last 7d): ${(winRate * 100).toFixed(0)}% (n=${stats.total})`,
        `  bull picks: ${stats.by_side.bull.r}/${stats.by_side.bull.r + stats.by_side.bull.w}`,
        `  bear picks: ${stats.by_side.bear.r}/${stats.by_side.bear.r + stats.by_side.bear.w}`,
        `  neither:    ${stats.by_side.neither.r}/${stats.by_side.neither.r + stats.by_side.neither.w}`,
      ].join('\n');
      await supabase.from('brain_insights').insert({
        user_id,
        type: 'debate_weekly',
        title: `Debate track record — ${(winRate * 100).toFixed(0)}% win rate`,
        body,
        priority: 'medium',
        expires_at: new Date(Date.now() + 8 * 24 * 3_600_000).toISOString(),
      });
    }
  } catch (e) {
    console.warn(`[ct-debate-outcome-scorer] weekly aggregate failed: ${e instanceof Error ? e.message : e}`);
  }
}

// -----------------------------------------------------------------------------
// Entrypoint
// -----------------------------------------------------------------------------
serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  const corsHeaders = getCorsHeaders(req);

  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'Service role required' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
  const startedAt = Date.now();

  // Pickup: picked debates, not-yet-scored, older than 24h.
  const cutoff = new Date(Date.now() - 24 * 3_600_000).toISOString();
  const { data: pending, error } = await supabase
    .from('ct_debates')
    .select('id, user_id, created_at, topic, instrument, bull_case, bear_case, user_pick, synthesis')
    .not('user_pick', 'is', null)
    .is('outcome_verdict', null)
    .lt('created_at', cutoff)
    .order('created_at', { ascending: true })
    .limit(MAX_PER_RUN);

  if (error) {
    return new Response(JSON.stringify({ ok: false, error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const rows = (pending ?? []) as DebateRow[];
  let right = 0, wrong = 0, pendingCount = 0;
  let pricePath = 0, haikuPath = 0, skipped = 0;

  for (const row of rows) {
    try {
      const r = await scoreDebate(supabase, row);
      if (r.path === 'price') pricePath++;
      else if (r.path === 'haiku') haikuPath++;
      else skipped++;
      if (r.verdict === 'right') right++;
      else if (r.verdict === 'wrong') wrong++;
      else if (r.verdict === 'pending') pendingCount++;
    } catch (e) {
      console.warn(`[ct-debate-outcome-scorer] scoring failed debate=${row.id}: ${e instanceof Error ? e.message : e}`);
    }
  }

  await writeWeeklyAggregate(supabase);

  const body = {
    ok: true,
    processed: rows.length,
    right,
    wrong,
    pending: pendingCount,
    via_price: pricePath,
    via_haiku: haikuPath,
    skipped,
    duration_ms: Date.now() - startedAt,
  };
  console.log('[ct-debate-outcome-scorer]', JSON.stringify(body));
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
