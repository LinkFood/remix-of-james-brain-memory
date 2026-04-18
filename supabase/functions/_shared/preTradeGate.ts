/**
 * preTradeGate — single compliance gate every trade must pass before commit.
 *
 * Three commit paths call preTradeCheck():
 *   - ct-claude-trade-open     (per-trade, inside the 9:26 commit loop)
 *   - ct-alert-book-commit     (per-alert, inside the candidate loop)
 *   - ct-chat (commit command) (once, manual slash-command)
 *
 * Contract:
 *   - Returns { passed, checks[], blockers[] }. `passed` = no block-level checks.
 *     Warns never fail passage. Blockers are always a subset of checks.
 *   - 7 checks, stable order so UIs can render a consistent row list:
 *       1. kill_switch     (block)
 *       2. drawdown_tier   (block)
 *       3. concentration   (block)
 *       4. bias_alignment  (block at/above gate.bias_block_severity)
 *       5. uw_usage        (warn only)
 *       6. cooldown        (block, alert-sourced only)
 *       7. session_context (warn only)
 *   - FAIL-SAFE: any check that throws is coerced to status='warn' with a
 *     detail noting the helper error. Never silently blocks. Never silently
 *     passes without a trace.
 *   - Every blocker cites a specific ct_config threshold in threshold_key so
 *     "this trade was blocked because..." always points at a tunable knob.
 *
 * force=true bypasses WARN-level checks only. Block-level checks (kill,
 * drawdown urgent, concentration, high-severity bias, cooldown) are HARD.
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isKillSwitchActive } from './killSwitch.ts';
import { getConfig } from './configCache.ts';
import { checkConcentration, type ProposedTrade } from './concentration.ts';

// ============================================================================
// Types
// ============================================================================

export type CheckStatus = 'pass' | 'warn' | 'block';
export type CheckName =
  | 'kill_switch'
  | 'drawdown_tier'
  | 'concentration'
  | 'bias_alignment'
  | 'uw_usage'
  | 'cooldown'
  | 'session_context';

export interface Check {
  name: CheckName;
  status: CheckStatus;
  detail: string;
  /** ct_config key a blocker cites. Omitted for pass/warn or checks with no tunable. */
  threshold_key?: string;
}

export interface PreTradeResult {
  passed: boolean;
  checks: Check[];
  blockers: Check[];
}

/**
 * Minimal trade shape the gate needs. Accepts a Partial so frontend drafts
 * and backend row-shaped inserts both work.
 */
export interface TradeLike {
  instrument?: string | null;
  side?: 'long' | 'short' | string | null;
  size_pct?: number | null;
  /** Mark the trade as alert-sourced so cooldown applies. */
  source?: 'claude-trade-open' | 'alert' | 'chat' | 'manual' | string | null;
  session_date?: string | null;
  // Optional concentration inputs. If omitted, checkConcentration uses its
  // own defaults (thesis_theme → 'other', contract_type → 'underlying',
  // size_usd → null).
  thesis_theme?: string | null;
  contract_type?: 'underlying' | 'call' | 'put' | string | null;
  size_usd?: number | null;
}

export interface PreTradeCheckOptions {
  /**
   * When true, warn-level checks are downgraded in the `passed` computation —
   * they still appear in the checklist with status='warn' but don't block.
   * This is always the default, so `force` primarily signals intent to the
   * caller's logs. Block-level checks are NEVER bypassed, with or without.
   */
  force?: boolean;
}

// ============================================================================
// Entry point
// ============================================================================

export async function preTradeCheck(
  supabase: SupabaseClient,
  trade: TradeLike,
  opts: PreTradeCheckOptions = {},
): Promise<PreTradeResult> {
  const sessionDate = trade.session_date ?? new Date().toISOString().slice(0, 10);

  // Each check is isolated in safeRun — one flaky DB read can't take down the
  // whole gate. Order is stable; callers depend on checks[0]=kill_switch etc.
  const checks: Check[] = [];
  checks.push(await safeRun('kill_switch',     () => checkKillSwitch(supabase)));
  checks.push(await safeRun('drawdown_tier',   () => checkDrawdownTier(supabase, sessionDate)));
  checks.push(await safeRun('concentration',   () => checkConcentrationWrapper(supabase, trade, sessionDate)));
  checks.push(await safeRun('bias_alignment',  () => checkBiasAlignment(supabase, trade)));
  checks.push(await safeRun('uw_usage',        () => checkUwUsage(supabase)));
  checks.push(await safeRun('cooldown',        () => checkCooldown(supabase, trade, sessionDate)));
  checks.push(await safeRun('session_context', () => checkSessionContext()));

  const blockers = checks.filter(c => c.status === 'block');
  const passed = blockers.length === 0;

  // `force` is informational in the result — it doesn't skip block-level
  // checks. Callers that implement --force should drop warn-level rejections
  // themselves; the gate always reports every status so audit rows stay honest.
  void opts.force;

  return { passed, checks, blockers };
}

/**
 * Wrap a check function so throws become warn-status entries. The gate is
 * fail-safe: broken helpers must never silently reject a trade, and must
 * never silently pass either — a warn on audit is the visible breadcrumb.
 */
async function safeRun(
  name: CheckName,
  fn: () => Promise<Omit<Check, 'name'>>,
): Promise<Check> {
  try {
    const out = await fn();
    return { name, ...out };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[preTradeGate] ${name} threw, coercing to warn:`, msg);
    return { name, status: 'warn', detail: `check error: ${msg.slice(0, 200)}` };
  }
}

// ============================================================================
// (a) Kill switch
// ============================================================================

async function checkKillSwitch(supabase: SupabaseClient): Promise<Omit<Check, 'name'>> {
  const active = await isKillSwitchActive(supabase);
  if (active) {
    return {
      status: 'block',
      detail: 'ct_kill_switch is engaged — all trade commits blocked',
      threshold_key: 'ct_kill_switch.active',
    };
  }
  return { status: 'pass', detail: 'kill switch inactive' };
}

// ============================================================================
// (b) Drawdown tier
//   Blocks when the current session has an URGENT ct_drawdown_alerts row.
//   The watch function writes that row only when book.drawdown.urgent_pct
//   or book.drawdown.hwm_urgent_pct is breached. Existence = breach.
// ============================================================================

async function checkDrawdownTier(
  supabase: SupabaseClient,
  sessionDate: string,
): Promise<Omit<Check, 'name'>> {
  const { data, error } = await supabase
    .from('ct_drawdown_alerts')
    .select('tier, intraday_pnl_pct, drawdown_from_hwm_pct')
    .eq('session_date', sessionDate)
    .eq('tier', 'urgent')
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`ct_drawdown_alerts read failed: ${error.message}`);

  if (data) {
    return {
      status: 'block',
      detail: `URGENT drawdown tier today — intraday ${data.intraday_pnl_pct}%, HWM ${data.drawdown_from_hwm_pct}%`,
      threshold_key: 'book.drawdown.urgent_pct',
    };
  }

  // Not urgent. We still surface a warn if a `warn` tier alert exists.
  const { data: warnRow } = await supabase
    .from('ct_drawdown_alerts')
    .select('tier, intraday_pnl_pct')
    .eq('session_date', sessionDate)
    .eq('tier', 'warn')
    .limit(1)
    .maybeSingle();

  if (warnRow) {
    return {
      status: 'warn',
      detail: `warn-tier drawdown active today (intraday ${warnRow.intraday_pnl_pct}%) — urgent not yet breached`,
    };
  }

  return { status: 'pass', detail: 'no drawdown alerts this session' };
}

// ============================================================================
// (c) Concentration
//   Delegates to checkConcentration from _shared/concentration.ts (wave 20).
//   Its reason strings already cite "max_ticker_pct" / "max_theme_pct" /
//   "max_direction_pct" / "max_concurrent_options_trades" — we map those to
//   the matching ct_config keys so blockers always point at a tunable knob.
// ============================================================================

function thresholdKeyFromConcentrationReason(reason: string): string {
  if (reason.includes('max_concurrent_options_trades')) return 'concentration.max_concurrent_options_trades';
  if (reason.includes('max_ticker_pct'))                return 'concentration.max_ticker_pct';
  if (reason.includes('max_theme_pct'))                 return 'concentration.max_theme_pct';
  if (reason.includes('max_direction_pct'))             return 'concentration.max_direction_pct';
  return 'concentration';
}

async function checkConcentrationWrapper(
  supabase: SupabaseClient,
  trade: TradeLike,
  _sessionDate: string,
): Promise<Omit<Check, 'name'>> {
  const instrument = (trade.instrument ?? '').toUpperCase();
  const side = (trade.side ?? '').toLowerCase();
  if (!instrument || (side !== 'long' && side !== 'short')) {
    return { status: 'pass', detail: 'concentration skipped — instrument/side not specified' };
  }

  const proposed: ProposedTrade = {
    instrument,
    side: side as 'long' | 'short',
    size_pct: Number(trade.size_pct ?? 0),
    thesis_theme: trade.thesis_theme ?? null,
    contract_type: (trade.contract_type as ProposedTrade['contract_type']) ?? 'underlying',
    size_usd: trade.size_usd ?? null,
  };

  const report = await checkConcentration(supabase, proposed);
  if (!report.passed) {
    const reason = report.reason ?? 'concentration breach';
    return {
      status: 'block',
      detail: reason,
      threshold_key: thresholdKeyFromConcentrationReason(reason),
    };
  }
  return { status: 'pass', detail: 'within all concentration limits (ticker/theme/direction/options)' };
}

// ============================================================================
// (d) Bias alignment
//   Query active biases with severity >= gate.bias_block_severity. Match on
//   (direction matches trade.side) AND (instruments list empty OR contains
//   trade.instrument). A match blocks.
// ============================================================================

async function checkBiasAlignment(
  supabase: SupabaseClient,
  trade: TradeLike,
): Promise<Omit<Check, 'name'>> {
  const instrument = (trade.instrument ?? '').toUpperCase();
  const side = (trade.side ?? '').toLowerCase();
  if (!instrument || (side !== 'long' && side !== 'short')) {
    return { status: 'pass', detail: 'bias check skipped — instrument/side not specified' };
  }

  const minSeverity = await getConfig<number>('gate.bias_block_severity', 4);

  const { data, error } = await supabase
    .from('ct_biases')
    .select('id, pattern, instruments, severity')
    .eq('active', true)
    .gte('severity', minSeverity);

  if (error) throw new Error(`ct_biases read failed: ${error.message}`);

  const biases = data ?? [];
  const direction = side === 'long' ? 'bullish' : 'bearish';

  const hit = biases.find(b => {
    const pattern = ((b.pattern as string | null) ?? '').toLowerCase();
    const instList = (b.instruments as string[] | null) ?? [];
    const universalOrMatching = instList.length === 0 || instList.includes(instrument);
    if (!universalOrMatching) return false;
    // Pattern is free-text. Match on direction OR instrument mention — same
    // heuristic ct-alert-book-commit uses so the two paths stay symmetric.
    return pattern.includes(direction) || pattern.includes(side) || pattern.includes(instrument.toLowerCase());
  });

  if (hit) {
    return {
      status: 'block',
      detail: `bias ${hit.id} (sev ${hit.severity}) matches: "${((hit.pattern as string) ?? '').slice(0, 140)}"`,
      threshold_key: 'gate.bias_block_severity',
    };
  }
  return { status: 'pass', detail: `no active bias (severity >= ${minSeverity}) matches` };
}

// ============================================================================
// (e) UW usage — warn only, never blocks
// ============================================================================

async function checkUwUsage(supabase: SupabaseClient): Promise<Omit<Check, 'name'>> {
  const warnPct = await getConfig<number>('gate.uw_warn_pct', 90);

  const { data, error } = await supabase
    .from('ct_uw_usage_latest')
    .select('daily_count, daily_limit, pct')
    .order('session_date', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`ct_uw_usage_latest read failed: ${error.message}`);
  if (!data || data.pct == null) {
    return { status: 'pass', detail: 'UW usage not yet reported today' };
  }

  const pct = Number(data.pct);
  if (pct >= warnPct) {
    return {
      status: 'warn',
      detail: `UW daily usage ${pct}% (${data.daily_count}/${data.daily_limit}) >= ${warnPct}% warn threshold`,
    };
  }
  return { status: 'pass', detail: `UW usage ${pct}% of daily limit` };
}

// ============================================================================
// (f) Cooldown — alert-sourced trades only
// ============================================================================

async function checkCooldown(
  supabase: SupabaseClient,
  trade: TradeLike,
  sessionDate: string,
): Promise<Omit<Check, 'name'>> {
  const isAlert = trade.source === 'alert';
  if (!isAlert) {
    return { status: 'pass', detail: 'cooldown not applicable — non-alert trade' };
  }

  const cooldownMin = await getConfig<number>('gate.alert_cooldown_min', 60);
  const cooldownIso = new Date(Date.now() - cooldownMin * 60_000).toISOString();

  const { data, error } = await supabase
    .from('ct_trades')
    .select('id, created_at, instrument')
    .eq('session_date', sessionDate)
    .eq('source', 'alert')
    .gte('created_at', cooldownIso)
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`ct_trades cooldown read failed: ${error.message}`);
  if (data) {
    return {
      status: 'block',
      detail: `alert-sourced trade within cooldown window (${cooldownMin}min): trade=${data.id} instrument=${data.instrument}`,
      threshold_key: 'gate.alert_cooldown_min',
    };
  }
  return { status: 'pass', detail: `no alert-sourced trade within ${cooldownMin}min` };
}

// ============================================================================
// (g) Session context — warn on whipsaw / EOD pin risk
//   America/New_York timezone. Midnight-safe math via explicit locale parts.
// ============================================================================

async function checkSessionContext(): Promise<Omit<Check, 'name'>> {
  const openWarnMin = await getConfig<number>('gate.session_open_warn_min', 5);
  const closeWarnMin = await getConfig<number>('gate.session_close_warn_min', 15);

  // Pull H:M in ET without brittle UTC offset math (DST-safe).
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  }).formatToParts(new Date());
  const getPart = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  const hour = parseInt(getPart('hour'), 10);
  const minute = parseInt(getPart('minute'), 10);
  const weekday = getPart('weekday'); // Mon..Sun

  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    return { status: 'pass', detail: 'session context unavailable — clock read failed' };
  }

  const isWeekend = weekday === 'Sat' || weekday === 'Sun';
  if (isWeekend) {
    return { status: 'pass', detail: `weekend session (${weekday}) — no whipsaw/EOD warn` };
  }

  const minutesFromOpen = (hour - 9) * 60 + (minute - 30); // negative pre-open
  const minutesToClose = (16 - hour) * 60 - minute;         // negative after close

  if (minutesFromOpen >= 0 && minutesFromOpen < openWarnMin) {
    return {
      status: 'warn',
      detail: `first ${openWarnMin}min of session (whipsaw zone) — ${minutesFromOpen}min from open`,
    };
  }
  if (minutesToClose > 0 && minutesToClose <= closeWarnMin) {
    return {
      status: 'warn',
      detail: `last ${closeWarnMin}min of session (EOD pin risk) — ${minutesToClose}min to close`,
    };
  }
  return { status: 'pass', detail: `session mid-window (${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')} ET)` };
}

// ============================================================================
// Helpers for callers
// ============================================================================

/**
 * Serialize a PreTradeResult to the shape stored in ct_trade_audit.pre_trade_checks.
 * Always returns an array (empty if result is null), so writers can pass the
 * output directly without null-guards.
 */
export function checksForAudit(result: PreTradeResult | null | undefined): Check[] {
  return result?.checks ?? [];
}
