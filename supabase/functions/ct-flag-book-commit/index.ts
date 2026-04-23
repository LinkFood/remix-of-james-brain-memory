/**
 * ct-flag-book-commit — exploratory-trade path.
 *
 * Mirror of ct-alert-book-commit but reads FLAGs (ct_flags, conv 3-4)
 * instead of ALERTs (ct_alerts, conv 5). Commits at smaller size (5%
 * default) with shorter cooldown (15 min) and tags trades
 * source='exploratory' so /edge attribution can bucket them apart from
 * conviction-5 alerts.
 *
 * Rationale: volume mode. 15 hypotheses in 4 days produced 0 conv-5 alerts.
 * We need graded trades to learn. Letting conv 3-4 FLAGs commit at reduced
 * size generates data without betting the farm on low-conviction reads.
 *
 * Guardrails mirror alert-book-commit but relaxed:
 *   1. Cooldown   — no exploratory trade in the last 15 min (vs 60)
 *   2. Capacity   — <5 open exploratory trades
 *   3. Bias       — no active ct_biases severity ≥4 match dir/instrument
 *   4. Whitelist  — 12-ticker underlying universe
 *   5. Price      — getCurrentPrice returns finite
 *
 * Auth: service role only.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { isKillSwitchActive, killSwitchSkipResponse } from '../_shared/killSwitch.ts';
import { getCurrentPrice } from '../_shared/ctGrader.ts';
import { getConfig } from '../_shared/configCache.ts';
import { getWatchlist } from '../_shared/watchlist.ts';
import { CT_PROMPT_VERSION } from '../_shared/systemPromptV1.ts';

const DEFAULT_FLAG_SIZE_PCT = 5;
const BOOK_EQUITY_USD = 50_000;          // Claude's book
const DEFAULT_COOLDOWN_MINUTES = 15;
const DEFAULT_MAX_CONCURRENT_EXPLORATORY = 5;
const LOOKBACK_MINUTES = 15;
const BIAS_MIN_SEVERITY = 4;

interface TradeSetup {
  instrument?: string;
  strike?: number;
  expiry?: string;
  entry_level?: number;
  stop_level?: number;
  target_level?: number;
  rationale?: string;
  strategy?: string;
}

interface Flag {
  id: string;
  instruments: string[];
  direction: string;
  conviction: number;
  horizon: string | null;
  trade_setup: TradeSetup | null;
  up_case: string | null;
  down_case: string | null;
  created_at: string;
}

serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  const corsHeaders = getCorsHeaders(req);

  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  if (await isKillSwitchActive(supabase)) {
    return killSwitchSkipResponse(supabase, 'ct-flag-book-commit', corsHeaders);
  }

  const [cooldownMin, sizePct, maxConcurrent, watchlist] = await Promise.all([
    getConfig<number>('flag_commit.cooldown_min',    DEFAULT_COOLDOWN_MINUTES),
    getConfig<number>('flag_commit.size_pct',        DEFAULT_FLAG_SIZE_PCT),
    getConfig<number>('flag_commit.max_concurrent',  DEFAULT_MAX_CONCURRENT_EXPLORATORY),
    getWatchlist(supabase),
  ]);
  const watchlistSet = new Set<string>(watchlist);
  const sizeUsd = Math.round(BOOK_EQUITY_USD * (sizePct / 100));

  const sessionDate = new Date().toISOString().slice(0, 10);
  const nowMs = Date.now();
  const lookbackIso = new Date(nowMs - LOOKBACK_MINUTES * 60_000).toISOString();
  const cooldownIso = new Date(nowMs - cooldownMin * 60_000).toISOString();

  // 1. Cooldown — no exploratory trade in last N min
  const { data: recentExploratory } = await supabase
    .from('ct_trades')
    .select('id, created_at')
    .eq('session_date', sessionDate)
    .eq('source', 'exploratory')
    .gte('created_at', cooldownIso)
    .limit(1);

  if (recentExploratory && recentExploratory.length > 0) {
    return new Response(JSON.stringify({
      committed: 0, cooldown_blocked: true,
      reason: `exploratory trade in last ${cooldownMin}min`,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  // 2. Capacity — max N concurrent exploratory
  const { count: openCount } = await supabase
    .from('ct_trades')
    .select('id', { count: 'exact', head: true })
    .eq('session_date', sessionDate)
    .eq('source', 'exploratory')
    .eq('status', 'open');

  if ((openCount ?? 0) >= maxConcurrent) {
    return new Response(JSON.stringify({
      committed: 0, capacity_blocked: true,
      reason: `${openCount} open exploratory trades at cap ${maxConcurrent}`,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  // 3. Candidate flags — uncommitted conv 3-4 with trade_setup, recent
  const { data: flagRows, error: flagErr } = await supabase
    .from('ct_flags')
    .select('id, instruments, direction, conviction, horizon, trade_setup, up_case, down_case, created_at, committed_trade_id')
    .is('committed_trade_id', null)
    .gte('created_at', lookbackIso)
    .gte('conviction', 3)
    .lte('conviction', 4)
    .not('trade_setup', 'is', null)
    .in('direction', ['bullish', 'bearish'])
    .order('conviction', { ascending: false })
    .order('created_at', { ascending: false });

  if (flagErr) {
    return new Response(JSON.stringify({ error: `flag query failed: ${flagErr.message}` }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const flags = (flagRows ?? []) as Flag[];
  if (flags.length === 0) {
    return new Response(JSON.stringify({ committed: 0, note: 'no eligible flags' }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // 4. Active biases
  const { data: biasRows } = await supabase
    .from('ct_biases')
    .select('pattern, instruments, severity')
    .eq('active', true);
  const activeBiases = (biasRows ?? []).filter(b => Number(b.severity ?? 0) >= BIAS_MIN_SEVERITY);

  // 5. Pick first eligible flag that passes all checks
  const skipped: Array<{ flag_id: string; reason: string; detail?: string }> = [];
  let committed = 0;
  let committedTradeId: string | null = null;

  for (const flag of flags) {
    const setup = flag.trade_setup;
    const instrument = (setup?.instrument ?? flag.instruments?.[0] ?? '').toUpperCase();
    if (!instrument) { skipped.push({ flag_id: flag.id, reason: 'no_trade_setup' }); continue; }

    // Whitelist
    if (!watchlistSet.has(instrument)) {
      skipped.push({ flag_id: flag.id, reason: 'instrument_not_whitelisted', detail: instrument });
      continue;
    }

    // Bias block
    const biasBlock = activeBiases.find((b) => {
      const biasInstrs = Array.isArray(b.instruments) ? b.instruments : [];
      const pattern = (b.pattern as string ?? '').toLowerCase();
      const matchesInstrument = biasInstrs.length === 0 || biasInstrs.includes(instrument);
      const matchesDirection = pattern.includes(flag.direction);
      return matchesInstrument && matchesDirection;
    });
    if (biasBlock) {
      skipped.push({ flag_id: flag.id, reason: 'bias_block', detail: String(biasBlock.pattern).slice(0, 80) });
      continue;
    }

    // Price sanity
    const price = await getCurrentPrice(supabase, instrument).catch(() => null);
    if (!price || !Number.isFinite(price)) {
      skipped.push({ flag_id: flag.id, reason: 'price_unavailable', detail: instrument });
      continue;
    }

    // Size
    const side = flag.direction === 'bullish' ? 'long' : 'short';
    const entryPrice = Number(setup?.entry_level ?? price);

    const { data: insertedRows, error: insErr } = await supabase
      .from('ct_trades')
      .insert({
        session_date: sessionDate,
        trader: 'claude',
        source: 'exploratory',
        instrument,
        side,
        size_pct: sizePct,
        size_usd: sizeUsd,
        entry_price: entryPrice,
        stop_price: setup?.stop_level ?? null,
        target_price: setup?.target_level ?? null,
        thesis: (flag.direction === 'bullish' ? (flag.up_case ?? '') : (flag.down_case ?? '')).slice(0, 500) || `exploratory conv-${flag.conviction} ${flag.direction} ${instrument}`,
        horizon: flag.horizon ?? 'intraday',
        conviction: flag.conviction,
        status: 'open',
        opened_at: new Date().toISOString(),
        flag_id: flag.id,
        prompt_version: CT_PROMPT_VERSION,
      })
      .select('id')
      .single();

    if (insErr) {
      // Likely the partial unique index (dedupe guard) fired — same idea
      // committed through another path. Skip silently.
      skipped.push({ flag_id: flag.id, reason: 'insert_rejected', detail: insErr.message.slice(0, 80) });
      continue;
    }

    committedTradeId = (insertedRows?.id as string) ?? null;

    // Back-link the flag to the trade
    if (committedTradeId) {
      await supabase
        .from('ct_flags')
        .update({ committed_trade_id: committedTradeId })
        .eq('id', flag.id);
    }

    committed = 1;
    break; // one flag per tick
  }

  return new Response(JSON.stringify({
    committed,
    committed_trade_id: committedTradeId,
    skipped,
    note: committed === 0 ? 'no flag passed gates' : 'exploratory trade opened',
  }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});
