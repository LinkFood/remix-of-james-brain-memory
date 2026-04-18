/**
 * useEvLadder — portfolio-weighted expected value across live ALERTs.
 *
 * Pulls every ct_alerts row fired in the last 60 minutes whose horizon
 * window is still open (horizon_end > now), computes per-alert R-multiple
 * and win probability using wave 17's `expected_move` payload, and
 * aggregates to a portfolio EV + P(at least 1 wins) + expected drawdown
 * + aggregated Kelly fraction.
 *
 * Calibration discount: `useRiskMetrics('30d').bandAccuracy.hitRate` is
 * joined in. If Claude has been claiming bands he can't hit, confidence
 * gets discounted toward the realized hit rate. Formula lives in
 * `discountConfidence()` below.
 *
 * Pre-v1.3 alerts (no expected_move) are COUNTED but not ladder rows —
 * they surface as `skippedNoMagnitude` so the footer can own the "3
 * alerts lack magnitude, skipped" line instead of silently dropping them.
 *
 * Independence assumption: P(at least 1 win) = 1 - Π(1 - P_i). Real alerts
 * on overlapping tickers are correlated (same tape → same direction), so
 * this is an OPTIMISTIC ceiling. Component shows a footnote.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useRiskMetrics } from '@/hooks/useRiskMetrics';
import type { ExpectedMove, TradeSetup } from '@/hooks/useCoTraderData';

// ──────── types ────────

export interface EvLadderAlert {
  id: string;
  instrument: string;           // first instruments[] element, or '—'
  instruments: string[];
  direction: string | null;     // 'long' | 'short' | 'LONG' | etc.
  conviction: number | null;    // 0..100 or 0..10 (per ct_alerts writer)
  horizonEnd: string | null;
  createdAt: string;
  expectedMove: ExpectedMove;
  tradeSetup: TradeSetup | null;
  /** Midpoint of the band, direction-signed. Positive = move in claimed direction. */
  midpointMovePct: number;
  /** |midpoint_move / stop_distance_pct|. Fallback uses conviction. */
  rMultiple: number;
  /** Raw claimed P(win). confidence_pct / 100. */
  claimedPWin: number;
  /** Post-calibration P(win). Equals claimedPWin when band_accuracy unavailable. */
  adjustedPWin: number;
  /** EV per 1R unit: P_win × R − (1 − P_win) × 1. */
  evPer1R: number;
  /** EV contribution in dollars given dollarsPerR. */
  evDollars: number;
}

export interface EvLadderResult {
  alerts: EvLadderAlert[];
  /** Count of last-60min active alerts with no expected_move (pre-v1.3). */
  skippedNoMagnitude: number;
  /** Total live alerts in window (included + skipped). */
  totalAlertsInWindow: number;
  /** Σ EV_per_1R across included alerts. */
  portfolioEvPer1R: number;
  /** Σ EV_dollars across included alerts. */
  portfolioEvDollars: number;
  /** 1 - Π(1 - P_win_i) — assumes independence. */
  probAtLeastOneWin: number;
  /** Σ (1R) across losers if ALL alerts fail = count × 1R × dollarsPerR. */
  expectedMaxDrawdownDollars: number;
  /** Portfolio-aggregated Kelly: mean P_win / mean (1-P_win) stuff — see below. */
  kellyFraction: number;
  /** Band accuracy used for discounting, when available. */
  bandAccuracy: { hitRate: number; sampleSize: number; meanClaimedConfidence: number } | null;
  /** How much we had to discount (1.0 = no discount, 0.5 = cut in half). */
  discountFactor: number;
  /** $/1R used for dollar math. */
  dollarsPerR: number;
  isLoading: boolean;
  isError: boolean;
}

// ──────── raw row shape from supabase ────────

interface CtAlertRaw {
  id: string;
  instruments: string[] | null;
  direction: string | null;
  conviction: number | null;
  horizon_end: string | null;
  trade_setup: TradeSetup | null;
  expected_move: ExpectedMove | null;
  entry_prices: Record<string, number | null> | null;
  created_at: string;
}

// ──────── helpers ────────

const LOOKBACK_MIN = 60;
const DEFAULT_DOLLARS_PER_R = 100;   // $100 notional per 1R for UI math

/**
 * Direction-aware midpoint.
 *
 * The band from wave 17 is stored as signed percentages already — e.g.
 * a bullish call produces { low_pct: +0.8, high_pct: +2.2 } and a bearish
 * call produces { low_pct: -2.4, high_pct: -0.6 }. Midpoint is the naive
 * average; we DO NOT re-sign it off `direction` because that would
 * double-count when the writer already signed the band.
 *
 * Safety net: if both bounds are positive and direction is short (or
 * symmetric), flip the sign so EV math doesn't reward a shorting claim
 * for an up move. This handles historical rows where the writer stored
 * the band as magnitude-only.
 */
function midpointMovePct(em: ExpectedMove, direction: string | null): number {
  const raw = (em.low_pct + em.high_pct) / 2;
  if (!Number.isFinite(raw)) return 0;
  const dir = (direction ?? '').toLowerCase();
  const isShort = dir === 'short' || dir === 'bearish' || dir === 'down';
  // Magnitude-only band (both bounds same sign, positive) but direction short →
  // re-sign so the midpoint expresses the claim.
  if (isShort && em.low_pct >= 0 && em.high_pct >= 0) return -raw;
  // Magnitude-only band (both bounds same sign, negative) but direction long →
  // re-sign upward.
  const isLong = dir === 'long' || dir === 'bullish' || dir === 'up';
  if (isLong && em.low_pct <= 0 && em.high_pct <= 0) return -raw;
  return raw;
}

/**
 * R-multiple = |midpoint_move / stop_distance|.
 *
 * Order of preference:
 *   1) trade_setup.stop_level + entry price → true % stop distance
 *   2) conviction-based approximation (higher conviction = tighter stop assumed)
 *   3) hard fallback R = 1
 */
function computeRMultiple(
  midPct: number,
  setup: TradeSetup | null,
  entryPrices: Record<string, number | null> | null,
  instrument: string,
  conviction: number | null,
): number {
  const absMid = Math.abs(midPct);
  if (!Number.isFinite(absMid) || absMid === 0) return 0;

  const stopLevel = Number(setup?.stop_level);
  const entryFromSetup = Number(setup?.entry_level);
  const entryFromPrices = Number(entryPrices?.[instrument]);
  const entry = Number.isFinite(entryFromSetup) && entryFromSetup > 0
    ? entryFromSetup
    : Number.isFinite(entryFromPrices) && entryFromPrices > 0
    ? entryFromPrices
    : NaN;

  if (Number.isFinite(stopLevel) && Number.isFinite(entry) && entry > 0 && stopLevel > 0) {
    const stopDistPct = Math.abs((entry - stopLevel) / entry) * 100;
    if (stopDistPct > 0) return absMid / stopDistPct;
  }

  // Conviction fallback. Assume higher conviction → tighter stop.
  // Conviction schemas vary (0..10 vs 0..100); normalize.
  if (conviction != null && Number.isFinite(conviction)) {
    const c = conviction > 10 ? conviction / 100 : conviction / 10; // → 0..1
    // Assumed stop %: 2% at conviction 0, 0.5% at conviction 1. Linear between.
    const assumedStopPct = Math.max(0.25, 2.0 - 1.5 * c);
    return absMid / assumedStopPct;
  }

  return 1; // last-ditch fallback so row still scores
}

/**
 * Confidence discount — Bayesian-ish pull toward realized hit rate.
 *
 * formula: adjusted = claimed × (bandHitRate / meanClaimedConfidence)
 *
 * Intuition: if Claude historically claims 70% band confidence but only
 * 50% of those bands actually hit, he's 50/70 = 71% as calibrated as he
 * thinks. A fresh 75% claim becomes 75% × 0.71 ≈ 53%.
 *
 * The discount is CLAMPED to [0.05, 0.95] so even pessimists can win and
 * runaway optimism still counts for something. When band_accuracy is
 * unavailable (new system, sampleSize === 0), we return the claimed
 * confidence unchanged and the UI surfaces "(uncalibrated)".
 */
function discountConfidence(
  claimedPct: number,                  // 0..100
  bandHitRate: number | null,          // 0..1
  meanClaimedConfidence: number | null,// 0..100
): { adjusted: number; discountFactor: number } {
  const claimed = Math.max(0, Math.min(100, claimedPct));
  if (
    bandHitRate == null ||
    !Number.isFinite(bandHitRate) ||
    meanClaimedConfidence == null ||
    !Number.isFinite(meanClaimedConfidence) ||
    meanClaimedConfidence <= 0
  ) {
    return { adjusted: claimed / 100, discountFactor: 1 };
  }
  const realizedFrac = Math.max(0, Math.min(1, bandHitRate));
  const claimedFrac = meanClaimedConfidence / 100;
  const raw = realizedFrac / claimedFrac;
  const discountFactor = Math.max(0.1, Math.min(1.5, raw));
  const adjusted = Math.max(0.05, Math.min(0.95, (claimed / 100) * discountFactor));
  return { adjusted, discountFactor };
}

// ──────── the hook ────────

export function useEvLadder(dollarsPerR: number = DEFAULT_DOLLARS_PER_R): EvLadderResult {
  const alertsQ = useQuery<CtAlertRaw[]>({
    queryKey: ['ev_ladder_alerts', LOOKBACK_MIN],
    refetchInterval: 60_000,
    staleTime: 30_000,
    queryFn: async () => {
      const now = new Date();
      const sinceIso = new Date(now.getTime() - LOOKBACK_MIN * 60_000).toISOString();
      const nowIso = now.toISOString();
      // Cast through `unknown` — supabase types.ts doesn't include the
      // ct_* tables (CoTrader schema is newer than the generated types).
      // Matches the pattern already used in useCoTraderData.ts.
      const { data, error } = await supabase
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .from('ct_alerts' as any)
        .select('id, instruments, direction, conviction, horizon_end, trade_setup, expected_move, entry_prices, created_at')
        .gte('created_at', sinceIso)
        .gt('horizon_end', nowIso)
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
      return rows.map(r => ({
        id: r.id as string,
        instruments: (r.instruments as string[] | null) ?? null,
        direction: (r.direction as string | null) ?? null,
        conviction: (r.conviction as number | null) ?? null,
        horizon_end: (r.horizon_end as string | null) ?? null,
        trade_setup: (r.trade_setup as TradeSetup | null) ?? null,
        expected_move: (r.expected_move as ExpectedMove | null) ?? null,
        entry_prices: (r.entry_prices as Record<string, number | null> | null) ?? null,
        created_at: r.created_at as string,
      }));
    },
  });

  // Pull bandAccuracy from the 30d window — shortest horizon that typically
  // has enough samples. All-time would bias toward old rubric; 7d is usually
  // too sparse to discount against.
  const risk = useRiskMetrics('30d');

  return useMemo<EvLadderResult>(() => {
    const rows = alertsQ.data ?? [];
    const totalAlertsInWindow = rows.length;

    const ba = risk.metrics?.bandAccuracy ?? null;
    const bandAccuracy =
      ba && ba.sampleSize > 0 && Number.isFinite(ba.hitRate)
        ? {
            hitRate: ba.hitRate,
            sampleSize: ba.sampleSize,
            meanClaimedConfidence: ba.meanClaimedConfidence,
          }
        : null;

    const alerts: EvLadderAlert[] = [];
    let skippedNoMagnitude = 0;
    let anyDiscount = 1;

    for (const r of rows) {
      const em = r.expected_move;
      if (
        !em ||
        typeof em !== 'object' ||
        !Number.isFinite(em.low_pct) ||
        !Number.isFinite(em.high_pct) ||
        !Number.isFinite(em.confidence_pct)
      ) {
        skippedNoMagnitude += 1;
        continue;
      }
      const instruments = Array.isArray(r.instruments) ? r.instruments.filter(Boolean) : [];
      const instrument = instruments[0] ?? '—';
      const midPct = midpointMovePct(em, r.direction);
      const rMult = computeRMultiple(midPct, r.trade_setup ?? null, r.entry_prices ?? null, instrument, r.conviction);
      const { adjusted: adjustedPWin, discountFactor } = discountConfidence(
        em.confidence_pct,
        bandAccuracy?.hitRate ?? null,
        bandAccuracy?.meanClaimedConfidence ?? null,
      );
      anyDiscount = discountFactor; // same for every row this render

      // EV per 1R = P(win) × R − (1 − P(win)) × 1
      const evPer1R = adjustedPWin * rMult - (1 - adjustedPWin) * 1;
      const evDollars = evPer1R * dollarsPerR;

      alerts.push({
        id: r.id,
        instrument,
        instruments,
        direction: r.direction,
        conviction: r.conviction,
        horizonEnd: r.horizon_end,
        createdAt: r.created_at,
        expectedMove: em,
        tradeSetup: r.trade_setup ?? null,
        midpointMovePct: midPct,
        rMultiple: rMult,
        claimedPWin: em.confidence_pct / 100,
        adjustedPWin,
        evPer1R,
        evDollars,
      });
    }

    // Aggregates
    let portfolioEvPer1R = 0;
    let portfolioEvDollars = 0;
    let prodLosses = 1;
    let sumAdjP = 0;
    let sumAdjQ = 0;
    let sumR = 0;
    for (const a of alerts) {
      portfolioEvPer1R += a.evPer1R;
      portfolioEvDollars += a.evDollars;
      prodLosses *= 1 - a.adjustedPWin;
      sumAdjP += a.adjustedPWin;
      sumAdjQ += 1 - a.adjustedPWin;
      sumR += a.rMultiple;
    }
    const probAtLeastOneWin = alerts.length > 0 ? 1 - prodLosses : 0;
    const expectedMaxDrawdownDollars = alerts.length * dollarsPerR; // all lose 1R each

    // Portfolio-aggregated Kelly.
    //   f* = (p × b − q) / b, where b = mean R across the book.
    // We roll p/q up as means across the active alerts so this is one
    // number for the whole ladder, not per-trade.
    const n = alerts.length;
    let kellyFraction = 0;
    if (n > 0) {
      const meanP = sumAdjP / n;
      const meanQ = sumAdjQ / n;
      const meanR = sumR / n;
      if (meanR > 0) {
        const raw = (meanP * meanR - meanQ) / meanR;
        kellyFraction = Math.max(0, Math.min(1, raw));
      }
    }

    return {
      alerts,
      skippedNoMagnitude,
      totalAlertsInWindow,
      portfolioEvPer1R,
      portfolioEvDollars,
      probAtLeastOneWin,
      expectedMaxDrawdownDollars,
      kellyFraction,
      bandAccuracy,
      discountFactor: anyDiscount,
      dollarsPerR,
      isLoading: alertsQ.isLoading || risk.isLoading,
      isError: alertsQ.isError || risk.isError,
    };
  }, [alertsQ.data, alertsQ.isLoading, alertsQ.isError, risk.metrics, risk.isLoading, risk.isError, dollarsPerR]);
}

// Kept exported for tests and for EvLadder.tsx's detail panel.
export { midpointMovePct, computeRMultiple, discountConfidence };
