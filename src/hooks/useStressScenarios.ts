/**
 * useStressScenarios — client-side stress projection over open ct_trades.
 *
 * Professional risk-desk style "what-if" projection. Given the set of currently
 * open trades, apply three preset % moves (MILD / MODERATE / SEVERE) and one
 * arbitrary custom scenario. Options rows are explicitly deferred: greeks and
 * delta evolution are not modeled here, per the page's posted caveats.
 *
 * Math is intentionally simple (pure projection):
 *   hypothetical_price = entry_price * (1 + move)         (for longs)
 *   hypothetical_price = entry_price * (1 - move)         (for shorts)
 *   pnl_usd            = (hypothetical_price - entry)/entry * size_usd * sign
 *
 * Stop-out / target-hit are deterministic under a given move — either the
 * hypothetical price crosses stop_price / target_price or it does not.
 * "Probability" in this page = 1 if crossed, 0 if not. This is a projection,
 * not a simulation.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { CtTradeRow } from './useCoTraderData';

// ----------------------------------------------------------------------------
// Scenario definitions
// ----------------------------------------------------------------------------

export type ScenarioTier = 'mild' | 'moderate' | 'severe' | 'custom';

export interface ScenarioDef {
  /** Stable id used for React keys and lookups. */
  id: ScenarioTier;
  /** Short title shown in the card header. */
  name: string;
  /** One-line description of the macro move. */
  headline: string;
  /** Sign of the broad tape move — we show both -/+ directions below. */
  spyPct: number;
  qqqPct: number;
  /** Fallback % applied to any trade whose instrument isn't SPY/QQQ. */
  individualPct: number;
  /** Whether to narrate a VIX spike in the card copy. */
  vixSpike: boolean;
}

export const PRESET_SCENARIOS: ScenarioDef[] = [
  {
    id: 'mild',
    name: 'MILD',
    headline: 'SPY ±0.5%, QQQ ±0.5%, individual tickers ±1%',
    spyPct: 0.5,
    qqqPct: 0.5,
    individualPct: 1,
    vixSpike: false,
  },
  {
    id: 'moderate',
    name: 'MODERATE',
    headline: 'SPY ±2%, QQQ ±2%, individual tickers ±3%',
    spyPct: 2,
    qqqPct: 2,
    individualPct: 3,
    vixSpike: false,
  },
  {
    id: 'severe',
    name: 'SEVERE',
    headline: 'SPY ±5%, QQQ ±5%, VIX spike, individual tickers ±7%',
    spyPct: 5,
    qqqPct: 5,
    individualPct: 7,
    vixSpike: true,
  },
];

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/** One trade evaluated under one scenario direction (-/+). */
export interface TradeProjection {
  trade: CtTradeRow;
  /** true for down-move (-%), false for up-move (+%). */
  down: boolean;
  /** The % move applied to this instrument, as a decimal (0.02 = 2%). */
  appliedPct: number;
  /** The hypothetical price after applying the move. Null for options. */
  hypotheticalPrice: number | null;
  /** Projected $ P&L. Null for options (deferred). */
  projectedPnlUsd: number | null;
  /** True if hypothetical price crosses the trade's stop_price. */
  stopOut: boolean;
  /** True if hypothetical price crosses the trade's target_price. */
  targetHit: boolean;
  /** True if this is an option position and was skipped. */
  optionsDeferred: boolean;
}

export interface ScenarioResult {
  scenario: ScenarioDef;
  /** Projections indexed by trade id, for both directions. */
  downLeg: TradeProjection[];
  upLeg: TradeProjection[];
  /** Book P&L summed across all underlying trades (options excluded). */
  totalPnlDown: number;
  totalPnlUp: number;
  /** Count of positions that hit stop under this scenario. */
  stopOutsDown: number;
  stopOutsUp: number;
  /** Count of positions that hit target under this scenario. */
  targetsDown: number;
  targetsUp: number;
  /** Worst-leg total P&L — the "implied max drawdown" dollar number. */
  maxDrawdownUsd: number;
  /** Number of option trades skipped. */
  optionsDeferredCount: number;
}

export interface CustomLeg {
  /** Ticker (uppercased). Empty string = slot not in use. */
  ticker: string;
  /** % move, signed. e.g. -3 = down 3%, +5 = up 5%. */
  pct: number;
}

// ----------------------------------------------------------------------------
// Pure math helpers (exported for unit testing or reuse)
// ----------------------------------------------------------------------------

/** Resolve the % move for a given instrument under a preset scenario. */
export function resolveScenarioPct(
  instrument: string,
  scenario: ScenarioDef,
): number {
  const s = instrument.toUpperCase();
  if (s === 'SPY') return scenario.spyPct;
  if (s === 'QQQ') return scenario.qqqPct;
  return scenario.individualPct;
}

/**
 * Project one trade given a signed decimal move (e.g. -0.02 for down 2%).
 *
 * For underlying trades, we know sign from `side` (long/short) and we know
 * entry_price + size_usd. P&L is linear in the price move.
 *
 * For options, we return optionsDeferred=true and null P&L. A real options
 * stress would need implied vol, greeks, DTE. That's out of scope here.
 */
export function projectTrade(trade: CtTradeRow, signedPct: number): TradeProjection {
  const isOption =
    trade.contract_type === 'call' || trade.contract_type === 'put';
  const down = signedPct < 0;
  const appliedPct = Math.abs(signedPct);

  if (isOption) {
    return {
      trade,
      down,
      appliedPct,
      hypotheticalPrice: null,
      projectedPnlUsd: null,
      stopOut: false,
      targetHit: false,
      optionsDeferred: true,
    };
  }

  const entry = trade.entry_price;
  const hypoPrice = entry * (1 + signedPct);

  // For shorts, a -move is profitable and a +move hurts. Long is the inverse.
  const sideSign = trade.side === 'short' ? -1 : 1;
  const priceReturn = (hypoPrice - entry) / entry; // signed
  const projectedPnlUsd = priceReturn * sideSign * trade.size_usd;

  // Stop / target crossing is direction-aware.
  // Long:  stop below entry, target above entry.
  // Short: stop above entry, target below entry.
  const stopPrice = trade.stop_price;
  const targetPrice = trade.target_price;
  let stopOut = false;
  let targetHit = false;

  if (stopPrice != null) {
    if (trade.side === 'long' && hypoPrice <= stopPrice) stopOut = true;
    if (trade.side === 'short' && hypoPrice >= stopPrice) stopOut = true;
  }
  if (targetPrice != null) {
    if (trade.side === 'long' && hypoPrice >= targetPrice) targetHit = true;
    if (trade.side === 'short' && hypoPrice <= targetPrice) targetHit = true;
  }

  return {
    trade,
    down,
    appliedPct,
    hypotheticalPrice: hypoPrice,
    projectedPnlUsd,
    stopOut,
    targetHit,
    optionsDeferred: false,
  };
}

/** Run one preset scenario over all trades in both directions. */
export function runPresetScenario(
  scenario: ScenarioDef,
  trades: CtTradeRow[],
): ScenarioResult {
  const downLeg: TradeProjection[] = [];
  const upLeg: TradeProjection[] = [];
  let optionsDeferredCount = 0;

  for (const trade of trades) {
    const pct = resolveScenarioPct(trade.instrument, scenario) / 100;
    const down = projectTrade(trade, -pct);
    const up = projectTrade(trade, pct);
    downLeg.push(down);
    upLeg.push(up);
    if (down.optionsDeferred) optionsDeferredCount += 1;
  }

  const totalPnlDown = downLeg.reduce((s, p) => s + (p.projectedPnlUsd ?? 0), 0);
  const totalPnlUp = upLeg.reduce((s, p) => s + (p.projectedPnlUsd ?? 0), 0);
  const stopOutsDown = downLeg.filter(p => p.stopOut).length;
  const stopOutsUp = upLeg.filter(p => p.stopOut).length;
  const targetsDown = downLeg.filter(p => p.targetHit).length;
  const targetsUp = upLeg.filter(p => p.targetHit).length;
  const maxDrawdownUsd = Math.min(totalPnlDown, totalPnlUp, 0);

  return {
    scenario,
    downLeg,
    upLeg,
    totalPnlDown,
    totalPnlUp,
    stopOutsDown,
    stopOutsUp,
    targetsDown,
    targetsUp,
    maxDrawdownUsd,
    optionsDeferredCount,
  };
}

/** Run a custom scenario from per-ticker inputs (5 slots typical). */
export function runCustomScenario(
  legs: CustomLeg[],
  trades: CtTradeRow[],
): {
  projections: TradeProjection[];
  totalPnlUsd: number;
  stopOuts: number;
  targetsHit: number;
  optionsDeferredCount: number;
  unmatchedTickers: string[];
  matchedCount: number;
} {
  const legMap = new Map<string, number>();
  for (const leg of legs) {
    const t = (leg.ticker ?? '').trim().toUpperCase();
    if (!t) continue;
    if (!Number.isFinite(leg.pct)) continue;
    legMap.set(t, leg.pct / 100);
  }

  const projections: TradeProjection[] = [];
  let optionsDeferredCount = 0;
  let matchedCount = 0;
  const seenTickers = new Set<string>();

  for (const trade of trades) {
    const inst = trade.instrument.toUpperCase();
    const pct = legMap.get(inst);
    if (pct == null) continue;
    seenTickers.add(inst);
    matchedCount += 1;
    const proj = projectTrade(trade, pct);
    projections.push(proj);
    if (proj.optionsDeferred) optionsDeferredCount += 1;
  }

  const unmatchedTickers = Array.from(legMap.keys()).filter(
    t => !seenTickers.has(t),
  );
  const totalPnlUsd = projections.reduce(
    (s, p) => s + (p.projectedPnlUsd ?? 0),
    0,
  );
  const stopOuts = projections.filter(p => p.stopOut).length;
  const targetsHit = projections.filter(p => p.targetHit).length;

  return {
    projections,
    totalPnlUsd,
    stopOuts,
    targetsHit,
    optionsDeferredCount,
    unmatchedTickers,
    matchedCount,
  };
}

// ----------------------------------------------------------------------------
// Hooks
// ----------------------------------------------------------------------------

/** Pull all currently open ct_trades, ordered by opened_at desc. */
export function useOpenTrades() {
  return useQuery<CtTradeRow[]>({
    queryKey: ['ct_trades_open'],
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('ct_trades')
        .select('*')
        .eq('status', 'open')
        .order('opened_at', { ascending: false });
      if (error) throw error;
      return (data ?? []) as CtTradeRow[];
    },
  });
}

/**
 * Run all three preset scenarios over the currently open book.
 *
 * Returns the loading/error state + an array of ScenarioResults. The array is
 * memoized so card components can `useMemo` cheaply on it.
 */
export function useStressScenarios() {
  const { data: trades, isLoading, error } = useOpenTrades();

  const results = useMemo<ScenarioResult[]>(() => {
    if (!trades || trades.length === 0) return [];
    return PRESET_SCENARIOS.map(sc => runPresetScenario(sc, trades));
  }, [trades]);

  return {
    trades: trades ?? [],
    results,
    isLoading,
    error: error instanceof Error ? error.message : null,
    hasOpenPositions: (trades?.length ?? 0) > 0,
  };
}
