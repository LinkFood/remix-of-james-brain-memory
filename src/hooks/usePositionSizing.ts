/**
 * usePositionSizing — pure-math position sizing hook.
 *
 * Given entry, stop, target, book equity, and risk% of book, compute the
 * R-based share/contract count so that a stop-out loses exactly 1R.
 * Also derives Kelly size from historical win-rate + avg_win/avg_loss
 * returned by useGhostPnl aggregates.
 *
 * All math is client-side. No edge functions. Handles divide-by-zero
 * (entry == stop) by returning zeros + a flag; caller shows warnings.
 *
 * Options: current formulas assume underlying shares. If contract_type
 * is "call"/"put" the "shares" output is treated as contract count and
 * risk accounting is a rough premium-based approximation. See the
 * returned `optionsApproximated` flag — real option sizing needs
 * greeks/premium and is deferred to v2.
 */
import { useMemo } from 'react';
import { useTodayBook, useGhostPnl } from './useCoTraderData';

export type Side = 'long' | 'short';
export type ContractType = 'underlying' | 'call' | 'put';

export interface PositionSizingInput {
  instrument: string;
  side: Side;
  entryPrice: number | null;
  stopPrice: number | null;
  targetPrice: number | null;
  /** Override book equity. If null, pulls starting_balance from today's ct_book (fallback $10k). */
  bookEquityOverride: number | null;
  /** Risk per trade as % of book. Default 1%. */
  riskPct: number;
  /** Contract type — 'underlying' by default. Options are v2 (see `optionsApproximated`). */
  contractType?: ContractType;
}

export interface PositionSizingOutput {
  // Inputs resolved
  bookEquity: number;
  riskPct: number;

  // Stop math
  stopDistance: number; // $ distance per share
  stopDistancePct: number; // % of entry
  hasValidStop: boolean;

  // Risk & size
  riskDollars: number; // 1R in $
  shares: number; // shares/contracts to risk exactly 1R
  positionNotional: number; // shares * entry
  positionPctOfBook: number; // notional / bookEquity * 100

  // Reward
  rewardDistance: number; // $ distance to target
  rewardToRisk: number | null; // target_distance / stop_distance

  // Kelly (from historical aggregates)
  kellyPct: number | null; // null if insufficient history
  historicalTrades: number;
  historicalWinRate: number | null;
  historicalAvgWin: number | null;
  historicalAvgLoss: number | null;

  // Recommended: min(R-based size%, kelly%, 40% cap)
  recommendedPct: number;
  recommendedShares: number;
  recommendedNotional: number;

  // Warnings
  warnings: {
    stopTooTight: boolean; // <0.3% of entry
    poorRewardToRisk: boolean; // <1.5
    concentrationRisk: boolean; // computed position >30% of book
    thinKellyEdge: boolean; // kelly <5%
  };

  // Flags
  optionsApproximated: boolean;
  bookEquitySource: 'override' | 'ct_book' | 'fallback_10k';
}

const DEFAULT_STARTING_BALANCE = 10_000;
const SIZE_CAP_PCT = 40; // Matches commit_manual_trade server-side cap
const STOP_TOO_TIGHT_PCT = 0.3;
const MIN_RR = 1.5;
const CONCENTRATION_PCT = 30;
const THIN_KELLY_PCT = 5;

function safeDiv(num: number, den: number): number {
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return 0;
  return num / den;
}

/**
 * Compute Kelly fraction from win-rate and avg win / avg loss magnitudes.
 *
 *   f* = W - (1 - W) / R
 *
 * where W = win_rate, R = avg_win / |avg_loss|. Returns a decimal 0..1
 * (e.g. 0.18 = 18% of book). Clamped to [0, 1]. Returns null if
 * there's not enough data (no wins OR no losses OR fewer than 5 trades).
 *
 * The aggregates arrive from useGhostPnl; avg_win/avg_loss are in
 * percent-of-book units but the ratio is dimensionless so that's fine.
 */
function kellyFraction(
  trades: number,
  winRate: number | null,
  avgWin: number | null,
  avgLoss: number | null,
): number | null {
  if (trades < 5) return null;
  if (winRate == null || avgWin == null || avgLoss == null) return null;
  if (avgWin <= 0) return null;
  if (avgLoss >= 0) return null; // avg_loss is negative in useGhostPnl
  const R = avgWin / Math.abs(avgLoss);
  if (!Number.isFinite(R) || R <= 0) return null;
  const f = winRate - (1 - winRate) / R;
  if (!Number.isFinite(f)) return null;
  return Math.max(0, Math.min(1, f));
}

export function usePositionSizing(input: PositionSizingInput): PositionSizingOutput {
  const { data: todayBook } = useTodayBook();
  const { data: ghost } = useGhostPnl(60); // 60-day history for expectancy

  return useMemo(() => {
    const {
      side,
      entryPrice,
      stopPrice,
      targetPrice,
      bookEquityOverride,
      riskPct: rawRiskPct,
      contractType = 'underlying',
    } = input;

    // Resolve book equity
    let bookEquity: number;
    let bookEquitySource: PositionSizingOutput['bookEquitySource'];
    if (bookEquityOverride != null && bookEquityOverride > 0) {
      bookEquity = bookEquityOverride;
      bookEquitySource = 'override';
    } else if (todayBook?.starting_balance) {
      bookEquity = todayBook.starting_balance;
      bookEquitySource = 'ct_book';
    } else {
      bookEquity = DEFAULT_STARTING_BALANCE;
      bookEquitySource = 'fallback_10k';
    }

    const riskPct = Math.max(0, Number.isFinite(rawRiskPct) ? rawRiskPct : 1);
    const riskDollars = bookEquity * (riskPct / 100);

    // Stop math — direction aware. A "long" stop should be below entry; a "short" stop above.
    const entry = Number.isFinite(entryPrice ?? NaN) ? (entryPrice as number) : 0;
    const stop = Number.isFinite(stopPrice ?? NaN) ? (stopPrice as number) : 0;
    const target = Number.isFinite(targetPrice ?? NaN) ? (targetPrice as number) : 0;

    const stopDistance = entry > 0 && stop > 0 ? Math.abs(entry - stop) : 0;
    const stopDistancePct = entry > 0 ? (stopDistance / entry) * 100 : 0;
    // Valid stop: non-zero distance AND on the correct side of entry
    const stopOnCorrectSide =
      entry > 0 && stop > 0
        ? side === 'long'
          ? stop < entry
          : stop > entry
        : false;
    const hasValidStop = stopDistance > 0 && stopOnCorrectSide;

    // Shares to risk exactly 1R
    const shares = hasValidStop ? Math.floor(safeDiv(riskDollars, stopDistance)) : 0;
    const positionNotional = shares * entry;
    const positionPctOfBook = safeDiv(positionNotional, bookEquity) * 100;

    // Reward
    const rewardDistance =
      entry > 0 && target > 0
        ? side === 'long'
          ? Math.max(0, target - entry)
          : Math.max(0, entry - target)
        : 0;
    const rewardToRisk = stopDistance > 0 && rewardDistance > 0 ? rewardDistance / stopDistance : null;

    // Kelly from ghost P&L aggregates
    const agg = ghost?.aggregates;
    const kellyFrac = kellyFraction(
      agg?.trades ?? 0,
      agg?.win_rate ?? null,
      agg?.avg_win ?? null,
      agg?.avg_loss ?? null,
    );
    const kellyPct = kellyFrac == null ? null : kellyFrac * 100;

    // Recommended size % = min(R-based%, kelly%, cap)
    // If kelly is null, defaults to min(R-based, cap).
    const rBasedPct = positionPctOfBook;
    const candidates = [rBasedPct, SIZE_CAP_PCT];
    if (kellyPct != null) candidates.push(kellyPct);
    const recommendedPct = Math.max(0, Math.min(...candidates));
    const recommendedNotional = bookEquity * (recommendedPct / 100);
    const recommendedShares = entry > 0 ? Math.floor(recommendedNotional / entry) : 0;

    const warnings = {
      stopTooTight: hasValidStop && stopDistancePct > 0 && stopDistancePct < STOP_TOO_TIGHT_PCT,
      poorRewardToRisk: rewardToRisk != null && rewardToRisk < MIN_RR,
      concentrationRisk: positionPctOfBook > CONCENTRATION_PCT,
      thinKellyEdge: kellyPct != null && kellyPct < THIN_KELLY_PCT,
    };

    return {
      bookEquity,
      riskPct,
      stopDistance,
      stopDistancePct,
      hasValidStop,
      riskDollars,
      shares,
      positionNotional,
      positionPctOfBook,
      rewardDistance,
      rewardToRisk,
      kellyPct,
      historicalTrades: agg?.trades ?? 0,
      historicalWinRate: agg?.win_rate ?? null,
      historicalAvgWin: agg?.avg_win ?? null,
      historicalAvgLoss: agg?.avg_loss ?? null,
      recommendedPct,
      recommendedShares,
      recommendedNotional,
      warnings,
      optionsApproximated: contractType !== 'underlying',
      bookEquitySource,
    };
  }, [
    input,
    todayBook?.starting_balance,
    ghost?.aggregates,
  ]);
}

/** Localstorage key for persisting risk%. */
export const RISK_PCT_STORAGE_KEY = 'ct.sizing.risk_pct';

export function loadPersistedRiskPct(fallback = 1): number {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(RISK_PCT_STORAGE_KEY);
    if (raw == null) return fallback;
    const n = parseFloat(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  } catch {
    return fallback;
  }
}

export function persistRiskPct(pct: number): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(RISK_PCT_STORAGE_KEY, String(pct));
  } catch {
    // no-op
  }
}
