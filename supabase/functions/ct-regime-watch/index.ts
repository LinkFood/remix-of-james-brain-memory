/**
 * ct-regime-watch — dealer gamma regime inversion detector.
 *
 * Compares the two most recent ct_heartbeats and emits a ct_regime_inversions
 * row whenever the gamma regime flips (positive <-> negative) for either:
 *   - SPX macro (current_reads.spx_macro.regime)
 *   - any watchlist ticker (current_reads.per_ticker[T].regime)
 *
 * A session-scale regime flip is a structural event — dealers go from
 * damping volatility (long gamma) to amplifying it (short gamma), or vice
 * versa. Rare, high-signal, always-on ALERT-worthy.
 *
 * Dedupe rules (so noisy regime toggles don't spam):
 *   - One row per (ticker, session_date) by default.
 *   - Re-fire allowed if >60min since the last flip for that ticker (so a
 *     mid-session re-flip after a stable interval still alerts).
 *
 * Zero new UW calls — regime is already derived at watcher condense-time and
 * written onto every heartbeat via ctStateCondense.ts.
 *
 * Cadence: pg_cron hits this every 5 min during market hours; heartbeats
 * write every ~15 min, so we catch every new write within 5 min of landing.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { ctSlackPush } from '../_shared/ctSlack.ts';
import { WATCHLIST } from '../_shared/uwClient.ts';

const RE_FIRE_MS = 60 * 60 * 1000; // 60min re-fire exception per ticker per session

type Regime = 'positive' | 'negative' | 'unknown';

interface InstrumentRead {
  ticker?: string;
  price?: number | null;
  gamma_flip?: number | null;
  regime?: Regime;
  net_gamma_oi?: number | null;
}

interface HeartbeatRow {
  id: string;
  created_at: string;
  current_reads: {
    spx_macro?: InstrumentRead;
    per_ticker?: Record<string, InstrumentRead>;
  } | null;
}

interface FlipCandidate {
  ticker: string;
  prev_regime: Exclude<Regime, 'unknown'>;
  new_regime: Exclude<Regime, 'unknown'>;
  prev_net_gamma: number | null;
  new_net_gamma: number | null;
  flip_level: number | null;
  spot_at_flip: number | null;
}

/** Extract instrument state for a ticker (or 'SPX') from a heartbeat row. */
function readForTicker(hb: HeartbeatRow, ticker: string): InstrumentRead | null {
  const reads = hb.current_reads;
  if (!reads || typeof reads !== 'object') return null;
  if (ticker === 'SPX') return reads.spx_macro ?? null;
  const pt = reads.per_ticker;
  if (!pt || typeof pt !== 'object') return null;
  return pt[ticker] ?? null;
}

/** Regime flipped iff both reads are defined AND both are pos/neg AND they differ. */
function detectFlip(
  ticker: string,
  latest: HeartbeatRow,
  prior: HeartbeatRow,
): FlipCandidate | null {
  const lr = readForTicker(latest, ticker);
  const pr = readForTicker(prior, ticker);
  if (!lr || !pr) return null;
  const lReg = lr.regime;
  const pReg = pr.regime;
  if (lReg !== 'positive' && lReg !== 'negative') return null;
  if (pReg !== 'positive' && pReg !== 'negative') return null;
  if (lReg === pReg) return null;
  return {
    ticker,
    prev_regime: pReg,
    new_regime: lReg,
    prev_net_gamma: pr.net_gamma_oi ?? null,
    new_net_gamma: lr.net_gamma_oi ?? null,
    flip_level: lr.gamma_flip ?? null,
    spot_at_flip: lr.price ?? null,
  };
}

/**
 * Dedupe: skip if this ticker already has a flip row today UNLESS the most
 * recent flip was >60min ago (noisy re-flips still alert after a quiet spell).
 */
async function shouldEmit(
  supabase: SupabaseClient,
  ticker: string,
  sessionDate: string,
): Promise<{ emit: boolean; reason: string }> {
  const { data, error } = await supabase
    .from('ct_regime_inversions')
    .select('id, created_at')
    .eq('ticker', ticker)
    .eq('session_date', sessionDate)
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) {
    // On error, fail open (emit) — a duplicate row is less bad than a missed flip.
    return { emit: true, reason: `dedupe_query_error:${error.message.slice(0, 60)}` };
  }
  if (!data || data.length === 0) return { emit: true, reason: 'first_flip_today' };

  const lastTs = new Date(data[0].created_at as string).getTime();
  const ageMs = Date.now() - lastTs;
  if (ageMs > RE_FIRE_MS) {
    return { emit: true, reason: `re_fire_after_${Math.round(ageMs / 60000)}min` };
  }
  return { emit: false, reason: `already_flipped_today_${Math.round(ageMs / 60000)}min_ago` };
}

/** Session date = UTC date of latest heartbeat. */
function sessionDateFor(iso: string): string {
  return iso.slice(0, 10);
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

  try {
    // Pull the two most recent heartbeats ordered desc — [0] = latest, [1] = prior.
    const { data: hbRows, error: hbErr } = await supabase
      .from('ct_heartbeats')
      .select('id, created_at, current_reads')
      .order('created_at', { ascending: false })
      .limit(2);

    if (hbErr) {
      return new Response(JSON.stringify({ error: `heartbeat_read:${hbErr.message}` }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    if (!hbRows || hbRows.length < 2) {
      return new Response(JSON.stringify({
        skipped: 'not_enough_heartbeats',
        count: hbRows?.length ?? 0,
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const latest = hbRows[0] as HeartbeatRow;
    const prior  = hbRows[1] as HeartbeatRow;
    const sessionDate = sessionDateFor(latest.created_at);

    // Candidate set: SPX macro + every watchlist ticker.
    const targets: string[] = ['SPX', ...WATCHLIST];
    const flips: FlipCandidate[] = [];
    for (const t of targets) {
      const f = detectFlip(t, latest, prior);
      if (f) flips.push(f);
    }

    // Per-ticker counts for the response (so we can see who was scanned
    // even when there were no flips).
    const perTicker: Record<string, { scanned: boolean; flipped: boolean; emitted: boolean; reason?: string }> = {};
    for (const t of targets) perTicker[t] = { scanned: true, flipped: false, emitted: false };
    for (const f of flips) perTicker[f.ticker].flipped = true;

    // Pull James's user_id for Slack push (same pattern as ct-watcher).
    const { data: users } = await supabase.from('profiles').select('id').limit(1);
    const userId = (users?.[0]?.id as string | undefined) ?? null;

    let emitted = 0;
    for (const f of flips) {
      const { emit, reason } = await shouldEmit(supabase, f.ticker, sessionDate);
      perTicker[f.ticker].reason = reason;
      if (!emit) continue;

      const { error: insErr } = await supabase.from('ct_regime_inversions').insert({
        session_date:   sessionDate,
        ticker:         f.ticker,
        prev_regime:    f.prev_regime,
        new_regime:     f.new_regime,
        prev_net_gamma: f.prev_net_gamma,
        new_net_gamma:  f.new_net_gamma,
        flip_level:     f.flip_level,
        spot_at_flip:   f.spot_at_flip,
        heartbeat_id:   latest.id,
        attention_score: 80,
      });
      if (insErr) {
        console.warn('[ct-regime-watch] insert failed:', insErr.message);
        perTicker[f.ticker].reason = `insert_error:${insErr.message.slice(0, 60)}`;
        continue;
      }
      perTicker[f.ticker].emitted = true;
      emitted++;

      // Slack push — ALERT state, attention 80, always push.
      if (userId) {
        const dirShort = `${f.prev_regime.toUpperCase().slice(0,3)}→${f.new_regime.toUpperCase().slice(0,3)}`;
        const levelStr = f.flip_level !== null ? `@${f.flip_level.toFixed(0)}` : '';
        const spotStr  = f.spot_at_flip !== null ? ` (spot ${f.spot_at_flip.toFixed(2)})` : '';
        await ctSlackPush(supabase, userId, {
          state: 'ALERT',
          instruments: [f.ticker],
          glance: [
            `${f.ticker} γ-FLIP ${dirShort} ${levelStr}${spotStr}`.trim(),
            `dealers flipped from ${f.prev_regime} to ${f.new_regime} gamma — ${f.new_regime === 'negative' ? 'expect amplified moves / trending' : 'expect damped vol / pinning'}`,
          ],
          conviction: 5,
          horizon: 'session',
          alert_trigger: 'regime_shift',
          direction: f.new_regime === 'negative' ? 'bearish_vol' : 'bullish_vol',
        });
      }
    }

    return new Response(JSON.stringify({
      session_date: sessionDate,
      latest_heartbeat_id: latest.id,
      prior_heartbeat_id: prior.id,
      flips_detected: flips.length,
      flips_emitted: emitted,
      per_ticker: perTicker,
      duration_ms: Date.now() - startedAt,
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[ct-regime-watch] fatal:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'failed',
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
