/**
 * ct-book-manager — every 15min during market hours (14:00-19:45 UTC).
 *
 * For every ct_trades row with status='open' (or 'planned' on first tick
 * which we flip to 'open' at current fill), Claude reviews the live tape
 * and decides per position: HOLD / CUT / SCALE_IN / SCALE_OUT / FLIP.
 * Hard stops + targets are checked deterministically FIRST (Claude
 * doesn't get to argue with a stop).
 *
 * Auth: service role only.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { isKillSwitchActive, killSwitchSkipResponse } from '../_shared/killSwitch.ts';
import { callClaude, CLAUDE_MODELS, parseTextContent, ClaudeError } from '../_shared/anthropic.ts';
import { getCurrentPrice } from '../_shared/ctGrader.ts';
import { logClaudeUsage } from '../_shared/claudeUsageLog.ts';
import { POST_MORTEM_SYSTEM } from '../_shared/ctPrompts.ts';
import { firePostTradeQuality } from '../_shared/tradeQuality.ts';
import { getOptionContracts } from '../_shared/uwClient.ts';
import {
  computeOptionLivePnlFromChainRow,
  isExpired as isOptionExpired,
  matchContract,
  type OptionChainRow,
  type OptionGreeks,
  type OptionTradeLike,
} from '../_shared/optionsPricing.ts';

// Coerce a greek field that UW may return as number | string | null.
// Missing/unparseable → 0 and a "missing" flag the caller can count.
function greekOrZero(v: unknown): { value: number; missing: boolean } {
  if (v == null) return { value: 0, missing: true };
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return { value: 0, missing: true };
  return { value: n, missing: false };
}

const SYSTEM_PROMPT = `You manage a live paper book. 15min has passed. Each open trade has current price, unrealized P&L, and a reason it was opened.

For each trade emit ONE action:
  - HOLD: thesis intact, no change. Default if nothing changed.
  - CUT: close the trade now. Use when thesis is invalidated but stop not hit.
  - SCALE_OUT: reduce size (trim to lock profit). delta_size_pct = negative (e.g. -10).
  - SCALE_IN: add to winner. Only if conviction ≥4 AND room in book. delta_size_pct = positive.
  - FLIP: close + open opposite side. Only on clear thesis inversion with new signal.

Return EXACTLY:
{
  "actions": [
    {
      "trade_id": "uuid",
      "action": "hold" | "cut" | "scale_out" | "scale_in" | "flip",
      "delta_size_pct": -10 | null,
      "rationale": "one sentence"
    }
  ]
}

HARD RULES:
- Default to HOLD. Churning the book eats edge.
- Don't argue with a winner unless structure changed.
- Never CUT just because you're uncomfortable — only on thesis invalidation.
- SCALE_IN only after you're already in the green.`;

interface OpenTrade {
  id: string;
  instrument: string;
  side: 'long' | 'short';
  size_pct: number;
  size_usd: number;
  entry_price: number;
  stop_price: number | null;
  target_price: number | null;
  thesis: string;
  conviction: number;
  opened_at: string | null;
  status: string;
  contract_type: 'underlying' | 'call' | 'put';
  strike: number | null;
  expiry: string | null;
  contracts: number | null;
  entry_premium: number | null;
  pre_trade_quality: number | null;
  pre_trade_quality_reasoning: string | null;
}

const TRADE_SELECT_COLS =
  'id, instrument, side, size_pct, size_usd, entry_price, stop_price, target_price, thesis, conviction, opened_at, status, contract_type, strike, expiry, contracts, entry_premium, pre_trade_quality, pre_trade_quality_reasoning';

interface Action {
  trade_id: string;
  action: 'hold' | 'cut' | 'scale_out' | 'scale_in' | 'flip';
  delta_size_pct: number | null;
  rationale: string;
}

function unrealizedPct(side: 'long' | 'short', entry: number, current: number): number {
  const raw = ((current - entry) / entry) * 100;
  return side === 'long' ? raw : -raw;
}

/**
 * Fire-and-forget post-mortem. Spawns a Haiku call, writes claude_notes +
 * journal_updated_at on success, logs the usage. Never throws out — the
 * close path must not block on this.
 *
 * Pass the trade row AFTER the close UPDATE has been issued, plus the
 * realized_pnl_pct and close_reason that were written.
 */
function firePostMortem(
  supabase: SupabaseClient,
  args: {
    tradeId: string;
    instrument: string;
    side: 'long' | 'short';
    entry: number | null;
    stop: number | null;
    target: number | null;
    thesis: string | null;
    exit: number;
    closeReason: string;
    realizedPnlPct: number | null;
    openedAt: string | null;
    closedAt: string;
    contractType?: string | null;
  },
): void {
  (async () => {
    try {
      const durationMin = args.openedAt
        ? Math.max(0, Math.round((new Date(args.closedAt).getTime() - new Date(args.openedAt).getTime()) / 60_000))
        : null;
      const userMessage = JSON.stringify({
        instrument: args.instrument,
        side: args.side,
        contract_type: args.contractType ?? 'underlying',
        entry_price: args.entry,
        stop_price: args.stop,
        target_price: args.target,
        thesis: args.thesis,
        actual_exit_price: args.exit,
        close_reason: args.closeReason,
        realized_pnl_pct: args.realizedPnlPct,
        duration_minutes: durationMin,
        note: 'Write the 2-3 sentence post-mortem per the system prompt. Plain prose only.',
      });
      const started = Date.now();
      const res = await callClaude({
        model: CLAUDE_MODELS.haiku,
        system: POST_MORTEM_SYSTEM,
        messages: [{ role: 'user', content: userMessage }],
        max_tokens: 400,
        temperature: 0.3,
      });
      const text = parseTextContent(res).trim();
      if (!text) return;
      await supabase.from('ct_trades').update({
        claude_notes: text,
        journal_updated_at: new Date().toISOString(),
      }).eq('id', args.tradeId);
      logClaudeUsage(supabase, {
        source: 'trade-post-mortem',
        model: CLAUDE_MODELS.haiku,
        usage: res.usage,
        duration_ms: Date.now() - started,
        metadata: { trade_id: args.tradeId, instrument: args.instrument, close_reason: args.closeReason },
      });
    } catch (e) {
      console.warn('[post-mortem] failed for', args.tradeId, e instanceof Error ? e.message : e);
    }
  })();
}

async function checkHardStops(
  supabase: SupabaseClient,
  trade: OpenTrade,
  currentPrice: number,
): Promise<boolean> {
  const hitStop = trade.stop_price != null && (
    (trade.side === 'long' && currentPrice <= trade.stop_price) ||
    (trade.side === 'short' && currentPrice >= trade.stop_price)
  );
  const hitTarget = trade.target_price != null && (
    (trade.side === 'long' && currentPrice >= trade.target_price) ||
    (trade.side === 'short' && currentPrice <= trade.target_price)
  );
  if (!hitStop && !hitTarget) return false;

  const pct = unrealizedPct(trade.side, trade.entry_price, currentPrice);
  const reason = hitStop ? 'stop_hit' : 'target_hit';
  const closedAt = new Date().toISOString();
  await supabase.from('ct_trades').update({
    status: 'closed',
    close_price: currentPrice,
    closed_at: closedAt,
    close_reason: reason,
    realized_pnl_pct: +pct.toFixed(3),
    realized_pnl_usd: null, // computed at EOD
  }).eq('id', trade.id);
  await supabase.from('ct_trade_actions').insert({
    trade_id: trade.id, action: 'cut', price: currentPrice,
    rationale: `deterministic ${reason} @ ${currentPrice}`,
  });
  firePostMortem(supabase, {
    tradeId: trade.id,
    instrument: trade.instrument,
    side: trade.side,
    entry: trade.entry_price,
    stop: trade.stop_price,
    target: trade.target_price,
    thesis: trade.thesis,
    exit: currentPrice,
    closeReason: reason,
    realizedPnlPct: +pct.toFixed(3),
    openedAt: trade.opened_at,
    closedAt,
    contractType: trade.contract_type,
  });
  firePostTradeQuality(supabase, {
    tradeId: trade.id,
    instrument: trade.instrument,
    side: trade.side,
    entry_price: trade.entry_price,
    stop_price: trade.stop_price,
    target_price: trade.target_price,
    close_price: currentPrice,
    close_reason: reason,
    realized_pnl_pct: +pct.toFixed(3),
    thesis: trade.thesis,
    opened_at: trade.opened_at,
    closed_at: closedAt,
    pre_trade_quality: trade.pre_trade_quality,
    pre_trade_quality_reasoning: trade.pre_trade_quality_reasoning,
    contract_type: trade.contract_type,
    source: 'book-manager-hard-stop',
  });
  return true;
}

serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  const corsHeaders = getCorsHeaders(req);

  // Regenerate-post-mortem path: callable from the authenticated frontend
  // via supabase.functions.invoke (JWT auth, not service role). Runs a
  // single Haiku call against one trade, bumps journal_version, writes
  // claude_notes. Does NOT touch decision logic, stops, scales, or any
  // other trade row. This is an intentional carve-out from the
  // isServiceRoleRequest gate — every other path still requires it.
  let regenTradeId: string | null = null;
  try {
    if (req.method === 'POST') {
      const cloned = req.clone();
      const body = await cloned.json().catch(() => null);
      if (body && typeof body === 'object' && typeof (body as { regen_trade_id?: unknown }).regen_trade_id === 'string') {
        regenTradeId = (body as { regen_trade_id: string }).regen_trade_id;
      }
    }
  } catch { /* body read is best-effort */ }

  if (regenTradeId) {
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: t, error } = await supabase
      .from('ct_trades')
      .select('id, instrument, side, entry_price, stop_price, target_price, thesis, close_price, close_reason, realized_pnl_pct, opened_at, closed_at, contract_type, status, journal_version')
      .eq('id', regenTradeId)
      .maybeSingle();
    if (error || !t) {
      return new Response(JSON.stringify({ error: 'trade not found', detail: error?.message }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    if (t.status !== 'closed' || t.close_price == null) {
      return new Response(JSON.stringify({ error: 'trade is not closed yet — nothing to post-mortem' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    // Bump version immediately so the UI can reflect "regenerating".
    await supabase.from('ct_trades')
      .update({ journal_version: (t.journal_version ?? 1) + 1 })
      .eq('id', t.id as string);
    firePostMortem(supabase, {
      tradeId: t.id as string,
      instrument: t.instrument as string,
      side: t.side as 'long' | 'short',
      entry: t.entry_price as number | null,
      stop: t.stop_price as number | null,
      target: t.target_price as number | null,
      thesis: t.thesis as string | null,
      exit: t.close_price as number,
      closeReason: `regenerate:${t.close_reason ?? 'unknown'}`,
      realizedPnlPct: t.realized_pnl_pct as number | null,
      openedAt: t.opened_at as string | null,
      closedAt: (t.closed_at as string | null) ?? new Date().toISOString(),
      contractType: t.contract_type as string | null,
    });
    return new Response(JSON.stringify({ ok: true, regenerating: t.id, new_version: (t.journal_version ?? 1) + 1 }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  // Kill switch — skip the whole tick. Does NOT forcibly close open positions
  // (that is a separate operation by design).
  if (await isKillSwitchActive(supabase)) {
    return killSwitchSkipResponse(supabase, 'ct-book-manager', corsHeaders);
  }

  const sessionDate = new Date().toISOString().slice(0, 10);

  // Flip any 'planned' trades to 'open' at current (fill) price on the first tick
  const { data: planned } = await supabase
    .from('ct_trades')
    .select(TRADE_SELECT_COLS)
    .eq('session_date', sessionDate)
    .eq('status', 'planned');

  for (const t of (planned ?? []) as OpenTrade[]) {
    const fill = await getCurrentPrice(t.instrument);
    if (fill == null) continue;
    // Gap check: if the 9:30 fill has already blown past the planned stop
    // or overshot the planned target, cancel the trade honestly rather than
    // pretending we entered at fill (which would zero-out the overnight
    // move and mask whether Claude's thesis was right). "You couldn't have
    // been in the trade before the gap — you missed it."
    const gapPastTarget = t.target_price != null && (
      (t.side === 'long' && fill >= t.target_price) ||
      (t.side === 'short' && fill <= t.target_price)
    );
    const gapPastStop = t.stop_price != null && (
      (t.side === 'long' && fill <= t.stop_price) ||
      (t.side === 'short' && fill >= t.stop_price)
    );
    if (gapPastTarget || gapPastStop) {
      const reason = gapPastTarget ? 'gap_past_target' : 'gap_past_stop';
      // Compute the overnight move from planned entry to fill so we can
      // LOG the size of the missed move (for post-mortem), but don't
      // credit it to P&L since we wouldn't have been filled there.
      const plannedEntry = t.entry_price;
      const overnightPct = ((fill - plannedEntry) / plannedEntry) * 100 * (t.side === 'short' ? -1 : 1);
      await supabase.from('ct_trades').update({
        status: 'cancelled',
        close_price: fill,
        closed_at: new Date().toISOString(),
        close_reason: reason,
        realized_pnl_pct: 0,
      }).eq('id', t.id);
      await supabase.from('ct_trade_actions').insert({
        trade_id: t.id,
        action: 'cancel',
        price: fill,
        rationale: `${reason}: planned entry ${plannedEntry}, fill ${fill}, overnight move ${overnightPct.toFixed(2)}% (not captured — couldn't have entered before gap)`,
      });
      continue;
    }
    await supabase.from('ct_trades').update({
      status: 'open',
      entry_price: fill,     // reset to actual fill
      opened_at: new Date().toISOString(),
    }).eq('id', t.id);
  }

  // Pull current open book
  const { data: openTrades } = await supabase
    .from('ct_trades')
    .select(TRADE_SELECT_COLS)
    .eq('session_date', sessionDate)
    .eq('status', 'open');

  const open = (openTrades ?? []) as OpenTrade[];
  if (open.length === 0) {
    return new Response(JSON.stringify({ ok: true, open: 0, note: 'no live trades' }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Fetch current prices + deterministic stop/target hits + live P&L refresh.
  //
  // live_pnl_pct / live_pnl_usd surface unrealized P&L per trade in the UI.
  // Underlying uses current price; options use per-contract premium mark from
  // UW's option-contracts endpoint (closed in Wave 17, was deferred in Wave 16).
  //
  // The checkHardStops call may close a trade — in which case we skip the
  // live-P&L write (realized_pnl_pct already populated by the close).
  const priceMap: Record<string, number> = {};
  const nowTs = new Date().toISOString();
  for (const t of open) {
    const p = await getCurrentPrice(t.instrument);
    if (p == null) continue;
    priceMap[t.id] = p;
    const closed = await checkHardStops(supabase, t, p);
    if (closed) continue;

    // Underlying: mark-to-market on instrument price.
    // Options handled in the dedicated loop below (needs chain pull per ticker).
    if (t.contract_type !== 'underlying') continue;

    const livePct = unrealizedPct(t.side, t.entry_price, p);
    const liveUsd = (livePct / 100) * (t.size_usd ?? 0);
    await supabase.from('ct_trades').update({
      live_pnl_pct: +livePct.toFixed(3),
      live_pnl_usd: +liveUsd.toFixed(2),
      live_pnl_updated_at: nowTs,
    }).eq('id', t.id);
  }

  // ---- Options live P&L loop ----
  //
  // Group still-open option trades by ticker, pull /option-contracts ONCE per
  // ticker (not per trade), parse OCC symbols to match strike+expiry+type,
  // and write live_pnl_{pct,usd,updated_at}.
  //
  // Budget impact: 1 UW call per unique ticker with open options per 15min
  // tick. With ~12 watched tickers and typically <5 option trades live, that's
  // <5 extra UW calls per tick (bounded by unique tickers, not trades).
  //
  // Expired options get skipped — expiry < today means settlement already
  // happened; the last mark stays sticky and EOD reconciliation handles close.
  // Chain-row miss (UW didn't return this strike) → warn, skip update.
  const optionTrades = open.filter(t =>
    t.contract_type !== 'underlying' &&
    t.strike != null &&
    t.expiry != null &&
    t.contracts != null &&
    t.entry_premium != null,
  );
  // Book-level Greeks aggregation — collected inside the options loop below
  // so we reuse the already-fetched /option-contracts response (zero extra UW
  // calls). Per-position contributions land in `positionBreakdown`; totals in
  // `greekTotals`. A row is inserted into ct_book_greeks after the loop only
  // when ≥1 position contributed (zero-options ticks don't spam the table).
  const greekTotals = { delta: 0, gamma: 0, theta: 0, vega: 0, rho: 0 };
  const positionBreakdown: Array<Record<string, unknown>> = [];
  const uniqueTickersWithOptions = new Set<string>();
  let missingGreeksCount = 0;

  if (optionTrades.length > 0) {
    const byTicker = new Map<string, OpenTrade[]>();
    for (const t of optionTrades) {
      const key = t.instrument.toUpperCase();
      const bucket = byTicker.get(key);
      if (bucket) bucket.push(t);
      else byTicker.set(key, [t]);
    }

    for (const [ticker, trades] of byTicker) {
      // Skip ticker entirely if ALL its open option trades have already expired.
      const liveTrades = trades.filter(t => !isOptionExpired(t as OptionTradeLike));
      if (liveTrades.length === 0) {
        console.log(`[ct-book-manager] ${ticker}: all ${trades.length} option trades expired, skipping`);
        continue;
      }

      let chain: OptionChainRow[] = [];
      try {
        const raw = await getOptionContracts(ticker) as unknown;
        // UW wraps chain rows in { data: [...] }. Fall back to raw array if shape differs.
        const arr =
          Array.isArray(raw) ? raw :
          (raw && typeof raw === 'object' && Array.isArray((raw as { data?: unknown[] }).data))
            ? (raw as { data: unknown[] }).data
            : [];
        chain = arr as OptionChainRow[];
      } catch (e) {
        console.warn(`[ct-book-manager] getOptionContracts(${ticker}) failed:`, e instanceof Error ? e.message : e);
        continue;
      }

      for (const t of liveTrades) {
        const tradeLike: OptionTradeLike = {
          instrument: t.instrument,
          contract_type: t.contract_type,
          strike: t.strike,
          expiry: t.expiry,
          contracts: t.contracts,
          entry_premium: t.entry_premium,
          side: t.side,
        };
        const row = matchContract(tradeLike, chain);
        if (!row) {
          console.warn(`[ct-book-manager] no chain row for ${t.instrument} ${t.contract_type} ${t.strike} ${t.expiry} (trade ${t.id})`);
          continue;
        }
        const pnl = computeOptionLivePnlFromChainRow(tradeLike, row);
        if (!pnl) continue;
        await supabase.from('ct_trades').update({
          live_pnl_pct: pnl.live_pnl_pct,
          live_pnl_usd: pnl.live_pnl_usd,
          live_pnl_updated_at: nowTs,
        }).eq('id', t.id);

        // ----- Greeks aggregation -----
        //
        // Formula (per position, per greek):
        //   position_greek = chain_greek * contracts * 100 * side_sign
        //     side_sign = +1 for 'long', -1 for 'short'
        //
        // Missing greeks default to 0 and are counted in `missingGreeksCount`
        // so the UI can flag "N of M positions missing greeks."
        const contracts = t.contracts ?? 0;
        const sideSign = t.side === 'long' ? 1 : -1;
        const mult = contracts * 100 * sideSign;
        const g: OptionGreeks = row.greeks ?? {};
        const d = greekOrZero(g.delta);
        const gm = greekOrZero(g.gamma);
        const th = greekOrZero(g.theta);
        const v = greekOrZero(g.vega);
        const r = greekOrZero(g.rho);
        if (d.missing || gm.missing || th.missing || v.missing || r.missing) {
          missingGreeksCount++;
        }
        const contribDelta = d.value * mult;
        const contribGamma = gm.value * mult;
        const contribTheta = th.value * mult;
        const contribVega  = v.value  * mult;
        const contribRho   = r.value  * mult;
        greekTotals.delta += contribDelta;
        greekTotals.gamma += contribGamma;
        greekTotals.theta += contribTheta;
        greekTotals.vega  += contribVega;
        greekTotals.rho   += contribRho;
        uniqueTickersWithOptions.add(t.instrument.toUpperCase());
        positionBreakdown.push({
          trade_id: t.id,
          instrument: t.instrument,
          type: t.contract_type,
          strike: t.strike,
          expiry: t.expiry,
          contracts,
          side: t.side,
          greeks: {
            delta: d.value, gamma: gm.value, theta: th.value, vega: v.value, rho: r.value,
          },
          contributions: {
            delta: +contribDelta.toFixed(4),
            gamma: +contribGamma.toFixed(4),
            theta: +contribTheta.toFixed(4),
            vega:  +contribVega.toFixed(4),
            rho:   +contribRho.toFixed(4),
          },
          missing_any_greek: d.missing || gm.missing || th.missing || v.missing || r.missing,
        });
      }
    }
  }

  // Insert book-level Greeks row — only when ≥1 position contributed.
  // Pure-underlying books skip the write entirely (don't spam zero rows).
  if (positionBreakdown.length > 0) {
    const { error: greeksErr } = await supabase.from('ct_book_greeks').insert({
      captured_at: nowTs,
      session_date: sessionDate,
      total_delta: +greekTotals.delta.toFixed(4),
      total_gamma: +greekTotals.gamma.toFixed(4),
      total_vega:  +greekTotals.vega.toFixed(4),
      total_theta: +greekTotals.theta.toFixed(4),
      total_rho:   +greekTotals.rho.toFixed(4),
      open_options_count: positionBreakdown.length,
      unique_tickers: Array.from(uniqueTickersWithOptions),
      metadata: {
        positions: positionBreakdown,
        missing_greeks_count: missingGreeksCount,
      },
    });
    if (greeksErr) {
      console.warn('[ct-book-manager] ct_book_greeks insert failed:', greeksErr.message);
    }
  }

  // Re-pull open after stops/targets
  const { data: stillOpen } = await supabase
    .from('ct_trades')
    .select(TRADE_SELECT_COLS)
    .eq('session_date', sessionDate)
    .eq('status', 'open');

  const live = (stillOpen ?? []) as OpenTrade[];
  if (live.length === 0) {
    return new Response(JSON.stringify({ ok: true, closed_by_stops: open.length, open: 0 }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Context for Claude
  const [heartbeat, flow, biases] = await Promise.all([
    supabase.from('ct_heartbeats').select('status_line, current_reads, created_at').order('created_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('ct_flow_alerts').select('ticker, side, premium, executed_at').gte('ingested_at', new Date(Date.now() - 30 * 60_000).toISOString()).in('ticker', live.map(l => l.instrument)).order('premium', { ascending: false }).limit(20),
    supabase.from('ct_biases').select('pattern, severity').eq('active', true).order('severity', { ascending: false }).limit(3),
  ]);

  const userMessage = JSON.stringify({
    open_trades: live.map(t => ({
      trade_id: t.id,
      instrument: t.instrument,
      side: t.side,
      size_pct: t.size_pct,
      entry_price: t.entry_price,
      current_price: priceMap[t.id] ?? null,
      unrealized_pct: priceMap[t.id] != null ? +unrealizedPct(t.side, t.entry_price, priceMap[t.id]).toFixed(2) : null,
      stop_price: t.stop_price,
      target_price: t.target_price,
      thesis: t.thesis,
      conviction: t.conviction,
      opened_at: t.opened_at,
    })),
    latest_market_state: heartbeat.data ?? null,
    recent_flow_last_30min: flow.data ?? [],
    known_biases: biases.data ?? [],
    note: 'Review each open trade. Emit ONE action per trade_id per the system schema. Return ONLY the JSON.',
  });

  let claudeText = '';
  try {
    const res = await callClaude({
      model: CLAUDE_MODELS.haiku,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
      max_tokens: 1200,
      temperature: 0.1,
    });
    claudeText = parseTextContent(res);
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const cleaned = claudeText.replace(/^\s*```(?:json)?\s*/, '').replace(/\s*```\s*$/, '').trim();
  let parsed: { actions?: Action[] };
  try { parsed = JSON.parse(cleaned); } catch {
    return new Response(JSON.stringify({ error: 'invalid json', raw: claudeText.slice(0, 300) }), {
      status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  let closed = 0, scaled = 0, held = 0, flipped = 0;
  const now = new Date().toISOString();
  for (const a of parsed.actions ?? []) {
    const trade = live.find(t => t.id === a.trade_id);
    if (!trade) continue;
    const price = priceMap[trade.id];
    if (price == null) continue;

    if (a.action === 'hold') {
      await supabase.from('ct_trade_actions').insert({ trade_id: trade.id, action: 'hold', price, rationale: a.rationale });
      held++;
    } else if (a.action === 'cut') {
      const pct = unrealizedPct(trade.side, trade.entry_price, price);
      await supabase.from('ct_trades').update({
        status: 'closed', close_price: price, closed_at: now, close_reason: 'manual_cut', realized_pnl_pct: +pct.toFixed(3),
      }).eq('id', trade.id);
      await supabase.from('ct_trade_actions').insert({ trade_id: trade.id, action: 'cut', price, rationale: a.rationale });
      firePostMortem(supabase, {
        tradeId: trade.id, instrument: trade.instrument, side: trade.side,
        entry: trade.entry_price, stop: trade.stop_price, target: trade.target_price,
        thesis: trade.thesis, exit: price, closeReason: 'manual_cut',
        realizedPnlPct: +pct.toFixed(3), openedAt: trade.opened_at, closedAt: now,
        contractType: trade.contract_type,
      });
      firePostTradeQuality(supabase, {
        tradeId: trade.id, instrument: trade.instrument, side: trade.side,
        entry_price: trade.entry_price, stop_price: trade.stop_price, target_price: trade.target_price,
        close_price: price, close_reason: 'manual_cut', realized_pnl_pct: +pct.toFixed(3),
        thesis: trade.thesis, opened_at: trade.opened_at, closed_at: now,
        pre_trade_quality: trade.pre_trade_quality,
        pre_trade_quality_reasoning: trade.pre_trade_quality_reasoning,
        contract_type: trade.contract_type, source: 'book-manager-cut',
      });
      closed++;
    } else if (a.action === 'scale_out') {
      const delta = Math.abs(a.delta_size_pct ?? 10);
      const newSize = Math.max(0, trade.size_pct - delta);
      if (newSize === 0) {
        const pct = unrealizedPct(trade.side, trade.entry_price, price);
        await supabase.from('ct_trades').update({ status: 'closed', close_price: price, closed_at: now, close_reason: 'scaled_to_zero', realized_pnl_pct: +pct.toFixed(3) }).eq('id', trade.id);
        firePostMortem(supabase, {
          tradeId: trade.id, instrument: trade.instrument, side: trade.side,
          entry: trade.entry_price, stop: trade.stop_price, target: trade.target_price,
          thesis: trade.thesis, exit: price, closeReason: 'scaled_to_zero',
          realizedPnlPct: +pct.toFixed(3), openedAt: trade.opened_at, closedAt: now,
          contractType: trade.contract_type,
        });
        firePostTradeQuality(supabase, {
          tradeId: trade.id, instrument: trade.instrument, side: trade.side,
          entry_price: trade.entry_price, stop_price: trade.stop_price, target_price: trade.target_price,
          close_price: price, close_reason: 'scaled_to_zero', realized_pnl_pct: +pct.toFixed(3),
          thesis: trade.thesis, opened_at: trade.opened_at, closed_at: now,
          pre_trade_quality: trade.pre_trade_quality,
          pre_trade_quality_reasoning: trade.pre_trade_quality_reasoning,
          contract_type: trade.contract_type, source: 'book-manager-scale-zero',
        });
        closed++;
      } else {
        await supabase.from('ct_trades').update({ size_pct: newSize }).eq('id', trade.id);
        scaled++;
      }
      await supabase.from('ct_trade_actions').insert({ trade_id: trade.id, action: 'scale_out', price, delta_size_pct: -delta, rationale: a.rationale });
    } else if (a.action === 'scale_in') {
      const delta = Math.abs(a.delta_size_pct ?? 10);
      const newSize = Math.min(40, trade.size_pct + delta);
      await supabase.from('ct_trades').update({ size_pct: newSize }).eq('id', trade.id);
      await supabase.from('ct_trade_actions').insert({ trade_id: trade.id, action: 'scale_in', price, delta_size_pct: delta, rationale: a.rationale });
      scaled++;
    } else if (a.action === 'flip') {
      const pct = unrealizedPct(trade.side, trade.entry_price, price);
      await supabase.from('ct_trades').update({ status: 'closed', close_price: price, closed_at: now, close_reason: 'flipped', realized_pnl_pct: +pct.toFixed(3) }).eq('id', trade.id);
      firePostMortem(supabase, {
        tradeId: trade.id, instrument: trade.instrument, side: trade.side,
        entry: trade.entry_price, stop: trade.stop_price, target: trade.target_price,
        thesis: trade.thesis, exit: price, closeReason: 'flipped',
        realizedPnlPct: +pct.toFixed(3), openedAt: trade.opened_at, closedAt: now,
        contractType: trade.contract_type,
      });
      firePostTradeQuality(supabase, {
        tradeId: trade.id, instrument: trade.instrument, side: trade.side,
        entry_price: trade.entry_price, stop_price: trade.stop_price, target_price: trade.target_price,
        close_price: price, close_reason: 'flipped', realized_pnl_pct: +pct.toFixed(3),
        thesis: trade.thesis, opened_at: trade.opened_at, closed_at: now,
        pre_trade_quality: trade.pre_trade_quality,
        pre_trade_quality_reasoning: trade.pre_trade_quality_reasoning,
        contract_type: trade.contract_type, source: 'book-manager-flip',
      });
      await supabase.from('ct_trades').insert({
        session_date: sessionDate,
        instrument: trade.instrument,
        side: trade.side === 'long' ? 'short' : 'long',
        size_pct: trade.size_pct,
        size_usd: 0, // recomputed at EOD
        entry_price: price,
        stop_price: null,
        target_price: null,
        thesis: `flipped from ${trade.side}: ${a.rationale}`,
        horizon: 'intraday',
        conviction: 3,
        status: 'open',
        opened_at: now,
      });
      await supabase.from('ct_trade_actions').insert({ trade_id: trade.id, action: 'flip', price, rationale: a.rationale });
      flipped++;
    }
  }

  return new Response(JSON.stringify({ ok: true, held, closed, scaled, flipped, reviewed: live.length }), {
    status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
