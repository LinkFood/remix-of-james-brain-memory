/**
 * ct-custom-rule-eval — evaluates user-authored ct_custom_rules every 5min
 * during RTH and fires Slack / log actions when clauses match.
 *
 * Pipeline:
 *   1. Pull all ACTIVE rules across all users.
 *   2. Build TWO state snapshots per user — `current` and `prior`:
 *        - Heartbeat-derived fields: price, regime, gamma_flip, call_wall,
 *          put_wall for each watchlist ticker (from ct_heartbeats.current_reads).
 *        - NOPE: from ct_nope_minute (latest within ~15min; prior = latest
 *          from `window_min` minutes ago, or the tick before the latest).
 *        - iv_rank: from ct_iv_rank_daily (today vs yesterday).
 *        - VIX.level: from ct_vix_history.
 *      This keeps the evaluator's worldview well-defined and capped: we only
 *      ever read from THIS set of tables, never hit UW.
 *   3. For each rule: evaluateConditions(...). If matches + dedupe window
 *      clear → insert ct_custom_rule_fires, bump fire_count, optionally
 *      push to Slack.
 *   4. Dedupe: no re-fire within 30 min for the same rule (by rule_id +
 *      last_fired_at). The dedupe is per-rule, NOT per-matched-clause —
 *      once a rule fires, that rule is quiet for 30min regardless of what
 *      clauses kept matching. This is intentional: user wants to hear about
 *      a rule hit once, not hammered every cycle while conditions hold.
 *
 * Auth: service-role only (called by pg_cron). Never exposed to frontend.
 *
 * Cadence: every 5min during RTH — scheduled by a separate migration when
 * James chooses to deploy. Function is idempotent; running it off-hours is
 * a no-op (no heartbeats land outside RTH, so current state is null).
 *
 * What this function DOES NOT do:
 *   - Make new UW API calls. Reads ct_heartbeats / ct_nope_minute /
 *     ct_iv_rank_daily / ct_vix_history only.
 *   - Execute trades. Custom rules are alerts-only by contract.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { ctSlackPushDirect } from '../_shared/ctSlack.ts';
import { evaluateConditions, RuleClause } from '../_shared/customRuleEval.ts';

// Dedupe: a rule that fired within this many minutes is silenced.
const DEDUPE_MINUTES = 30;

// For `crosses_*` clauses we need a prior value. We support two lookback modes:
//   (a) If the rule author set `window_min`, compare current vs the value
//       from ~window_min minutes ago.
//   (b) Otherwise, compare current vs the previous heartbeat (or previous
//       NOPE tick).
// `window_min` is clamped to [1, 30] — 30 min is enough for any sensible
// rule; anything longer smells like a daily-cadence watcher, not an alert.
const DEFAULT_LOOKBACK_MIN = 5;

interface CustomRule {
  id: string;
  user_id: string;
  name: string;
  conditions: RuleClause[] | null;
  match_logic: 'all' | 'any';
  action: 'slack' | 'log' | 'both';
  fire_count: number;
  last_fired_at: string | null;
}

interface HeartbeatRow {
  id: string;
  created_at: string;
  current_reads: Record<string, unknown> | null;
}

/**
 * Extract a well-defined state object from a heartbeat row.
 *
 * Heartbeats write condensed per-instrument state under
 * `current_reads._snapshot.per_ticker` and `current_reads._snapshot.vix`
 * (see _shared/ctStateCondense.ts). We surface a flat symbol → metric map
 * keyed by ticker (price, regime, gamma_flip, call_wall, put_wall) plus a
 * `VIX` bucket. All other fields (NOPE, iv_rank) are merged in from
 * dedicated tables downstream.
 */
function stateFromHeartbeat(hb: HeartbeatRow | null): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  if (!hb || !hb.current_reads) return out;
  const reads = hb.current_reads as Record<string, unknown>;
  const snapshot = (reads._snapshot && typeof reads._snapshot === 'object')
    ? reads._snapshot as Record<string, unknown>
    : reads;

  const perTicker = snapshot.per_ticker as Record<string, Record<string, unknown>> | undefined;
  if (perTicker && typeof perTicker === 'object') {
    for (const [tkr, inst] of Object.entries(perTicker)) {
      if (!inst || typeof inst !== 'object') continue;
      out[tkr] = {
        price:       inst.price ?? null,
        regime:      inst.regime ?? null,
        gamma_flip:  inst.gamma_flip ?? null,
        call_wall:   inst.call_wall ?? null,
        put_wall:    inst.put_wall ?? null,
        net_gamma_oi: inst.net_gamma_oi ?? null,
      };
    }
  }
  // SPX — condense writes spx_macro.
  const spx = snapshot.spx_macro as Record<string, unknown> | undefined;
  if (spx && typeof spx === 'object') {
    out.SPX = {
      price:       spx.price ?? null,
      regime:      spx.regime ?? null,
      gamma_flip:  spx.gamma_flip ?? null,
      call_wall:   spx.call_wall ?? null,
      put_wall:    spx.put_wall ?? null,
    };
  }
  // VIX — from condenseVix.
  const vix = snapshot.vix as Record<string, unknown> | undefined;
  if (vix && typeof vix === 'object') {
    out.VIX = {
      level: vix.level ?? null,
      change_pct: vix.change_pct ?? null,
      tier: vix.tier ?? null,
    };
  }
  return out;
}

/** Merge b into a non-destructively for the symbols it touches. */
function mergeState(
  a: Record<string, Record<string, unknown>>,
  b: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = { ...a };
  for (const [sym, fields] of Object.entries(b)) {
    out[sym] = { ...(out[sym] ?? {}), ...fields };
  }
  return out;
}

/**
 * Build merged `current` and `prior` state objects for the evaluator.
 * Pulls the two most recent heartbeats (prior defaults to ~5min ago),
 * then folds in NOPE + iv_rank + VIX from their own tables.
 *
 * We pass the largest `window_min` across all rules as the lookback — one
 * read that satisfies every rule.
 */
async function buildState(
  supabase: SupabaseClient,
  lookbackMin: number,
): Promise<{
  current: Record<string, Record<string, unknown>>;
  prior: Record<string, Record<string, unknown>>;
  snapshot_ts: string | null;
}> {
  // Last 2 heartbeats.
  const { data: hbs } = await supabase
    .from('ct_heartbeats')
    .select('id, created_at, current_reads')
    .order('created_at', { ascending: false })
    .limit(2);

  const currentHb = (hbs?.[0] ?? null) as HeartbeatRow | null;
  const priorHb   = (hbs?.[1] ?? null) as HeartbeatRow | null;

  let current = stateFromHeartbeat(currentHb);
  let prior   = stateFromHeartbeat(priorHb);

  // NOPE — one query across all tickers in the last 2h; group client-side.
  const nopeSince = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
  const { data: nopeRows } = await supabase
    .from('ct_nope_minute')
    .select('ticker, nope, tick_timestamp')
    .gte('tick_timestamp', nopeSince)
    .order('tick_timestamp', { ascending: false })
    .limit(2000);
  const lookbackCutoffMs = Date.now() - lookbackMin * 60_000;
  if (Array.isArray(nopeRows)) {
    const byTicker = new Map<string, Array<{ nope: number; ts: number }>>();
    for (const r of nopeRows as Array<{ ticker: string; nope: number | null; tick_timestamp: string }>) {
      if (r.nope === null || r.nope === undefined) continue;
      const arr = byTicker.get(r.ticker) ?? [];
      arr.push({ nope: r.nope, ts: new Date(r.tick_timestamp).getTime() });
      byTicker.set(r.ticker, arr);
    }
    for (const [tkr, list] of byTicker.entries()) {
      // list is already desc.
      const latest = list[0];
      // Prior: oldest value still newer than lookbackCutoffMs, fallback second-latest.
      const priorPick = list.find((x) => x.ts <= lookbackCutoffMs) ?? list[1] ?? null;
      current = mergeState(current, { [tkr]: { NOPE: latest.nope } });
      if (priorPick) {
        prior = mergeState(prior, { [tkr]: { NOPE: priorPick.nope } });
      }
    }
  }

  // IV rank — latest two distinct dates per ticker.
  const ivSince = new Date(Date.now() - 10 * 86400_000).toISOString().slice(0, 10);
  const { data: ivRows } = await supabase
    .from('ct_iv_rank_daily')
    .select('ticker, date, iv_rank')
    .gte('date', ivSince)
    .order('ticker', { ascending: true })
    .order('date', { ascending: false })
    .limit(1000);
  if (Array.isArray(ivRows)) {
    const byTicker = new Map<string, Array<{ date: string; iv_rank: number }>>();
    for (const r of ivRows as Array<{ ticker: string; date: string; iv_rank: number | null }>) {
      if (r.iv_rank === null || r.iv_rank === undefined) continue;
      const arr = byTicker.get(r.ticker) ?? [];
      arr.push({ date: r.date, iv_rank: r.iv_rank });
      byTicker.set(r.ticker, arr);
    }
    for (const [tkr, list] of byTicker.entries()) {
      const latest = list[0];
      const prev = list[1] ?? null;
      current = mergeState(current, { [tkr]: { iv_rank: latest.iv_rank } });
      if (prev) prior = mergeState(prior, { [tkr]: { iv_rank: prev.iv_rank } });
    }
  }

  // VIX level — pick latest two from ct_vix_history.
  const { data: vixRows } = await supabase
    .from('ct_vix_history')
    .select('date, close')
    .order('date', { ascending: false })
    .limit(2);
  if (Array.isArray(vixRows) && vixRows.length > 0) {
    const latestVix = (vixRows[0] as { close: number | null }).close;
    const priorVix = (vixRows[1] as { close: number | null } | undefined)?.close ?? null;
    if (latestVix !== null && latestVix !== undefined) {
      current = mergeState(current, { VIX: { level: latestVix } });
    }
    if (priorVix !== null && priorVix !== undefined) {
      prior = mergeState(prior, { VIX: { level: priorVix } });
    }
  }

  return {
    current,
    prior,
    snapshot_ts: currentHb?.created_at ?? null,
  };
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
    // 1) Active rules — service role bypasses RLS, scoped by user_id in each row.
    const { data: rulesRaw, error: rulesErr } = await supabase
      .from('ct_custom_rules')
      .select('id, user_id, name, conditions, match_logic, action, fire_count, last_fired_at')
      .eq('active', true)
      .limit(500);
    if (rulesErr) {
      return new Response(JSON.stringify({ error: `rules_read:${rulesErr.message}` }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const rules = (rulesRaw ?? []) as CustomRule[];
    if (rules.length === 0) {
      return new Response(JSON.stringify({
        ok: true, rules_scanned: 0, fired: 0, duration_ms: Date.now() - startedAt,
      }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // 2) Figure out max lookback across rules (for crosses_* prior lookup).
    let maxLookback = DEFAULT_LOOKBACK_MIN;
    for (const r of rules) {
      const conds = Array.isArray(r.conditions) ? r.conditions : [];
      for (const c of conds) {
        if (typeof c.window_min === 'number' && c.window_min > maxLookback && c.window_min <= 30) {
          maxLookback = c.window_min;
        }
      }
    }

    // 3) Build state ONCE — same snapshot for every rule.
    const { current, prior, snapshot_ts } = await buildState(supabase, maxLookback);

    // 4) Evaluate each rule.
    const dedupeCutoff = new Date(Date.now() - DEDUPE_MINUTES * 60_000);
    let fired = 0;
    let slackPushed = 0;
    const perRule: Array<{
      rule_id: string;
      name: string;
      matched: boolean;
      fired: boolean;
      reason?: string;
    }> = [];

    for (const rule of rules) {
      // Dedupe
      if (rule.last_fired_at) {
        const lastFired = new Date(rule.last_fired_at);
        if (lastFired > dedupeCutoff) {
          perRule.push({
            rule_id: rule.id,
            name: rule.name,
            matched: false,
            fired: false,
            reason: 'dedupe_30min',
          });
          continue;
        }
      }

      const result = evaluateConditions(
        rule.conditions ?? [],
        rule.match_logic,
        current,
        prior,
      );
      if (!result.matches) {
        perRule.push({
          rule_id: rule.id,
          name: rule.name,
          matched: false,
          fired: false,
          reason: 'no_match',
        });
        continue;
      }

      // Fire: log + optional Slack.
      const firedAt = new Date().toISOString();
      const { error: insErr } = await supabase.from('ct_custom_rule_fires').insert({
        rule_id: rule.id,
        user_id: rule.user_id,
        fired_at: firedAt,
        matched_clauses: result.matched_clauses,
        matched_snapshot: {
          current,
          prior,
          snapshot_ts,
          evaluations: result.evaluations,
        },
        slack_pushed: false, // will update after slack call
      });
      if (insErr) {
        perRule.push({
          rule_id: rule.id, name: rule.name, matched: true, fired: false,
          reason: `insert_err:${insErr.message.slice(0, 80)}`,
        });
        continue;
      }

      // Bump fire_count + last_fired_at on the rule row.
      await supabase
        .from('ct_custom_rules')
        .update({ fire_count: rule.fire_count + 1, last_fired_at: firedAt })
        .eq('id', rule.id);

      fired++;

      // Slack push (best-effort, never throws).
      if (rule.action === 'slack' || rule.action === 'both') {
        const clauseList = result.matched_clauses.slice(0, 5).map((c) => `• ${c}`).join('\n');
        const text = `:rotating_light: *CUSTOM RULE* · ${rule.name}\n${clauseList}`;
        try {
          await ctSlackPushDirect(supabase, rule.user_id, text, 'custom_rule');
          slackPushed++;
          await supabase
            .from('ct_custom_rule_fires')
            .update({ slack_pushed: true })
            .eq('rule_id', rule.id)
            .eq('fired_at', firedAt);
        } catch (slackErr) {
          console.warn('[ct-custom-rule-eval] slack push failed:', slackErr instanceof Error ? slackErr.message : slackErr);
        }
      }

      perRule.push({
        rule_id: rule.id, name: rule.name, matched: true, fired: true,
      });
    }

    return new Response(JSON.stringify({
      ok: true,
      rules_scanned: rules.length,
      fired,
      slack_pushes: slackPushed,
      snapshot_ts,
      per_rule: perRule,
      duration_ms: Date.now() - startedAt,
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[ct-custom-rule-eval] fatal:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'failed',
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
