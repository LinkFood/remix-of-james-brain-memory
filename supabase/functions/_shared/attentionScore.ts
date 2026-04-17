/**
 * attentionScore — 1..100 "how much should James look at this" score
 *
 * Two layers:
 *
 * 1) calcScore(bullish, bearish): directional score in [-100, +100]. This is
 *    James's exact LinkGex V3 formula — do not improvise.
 *
 * 2) computeTickerScores(contracts, spot, gammaByStrike): five LinkGex V3
 *    scores ($flow, hedge, now, calls velocity, puts velocity) + a combo
 *    verdict (URGENT / A+ / SQUEEZE / BATTLEGROUND / LEAN). This mirrors the
 *    TrendSpider indicator's aggregate logic. Output is the 5 directional
 *    scores plus totals used by the combo verdict thresholds.
 *
 * 3) deriveWriteTimeAttention(params) — cheap integer 0..100 for use at
 *    insert time inside ct-watcher when we don't have full options contract
 *    data. Derives from state + conviction + trigger + convergence.
 *
 * The directional LinkGex scores are [-100, +100] — they carry BOTH magnitude
 * and direction. The 0..100 "attention" score on the ct_* tables is the
 * ABSOLUTE value of the strongest directional signal scaled up by combo
 * verdict and state. That's what the UI sorts on.
 *
 * HEDGE score compromise: UW's /api/stock/{ticker}/option-contracts does NOT
 * return per-contract gamma. Per-strike dealer gamma IS available from the
 * already-wrapped getStaticGexByStrike() / getSpotGexByStrike() endpoints,
 * which return call_gex + put_gex per strike (already OI-weighted). So
 * computeTickerScores takes `gammaByStrike` as a Record<number, number>
 * representing the NET gamma-exposure contribution per strike. When computing
 * the HEDGE score we partition the gamma by option type using the
 * contract-side call/put OI at that strike (proportional split of the net
 * exposure). This is a small compromise vs. the ideal per-contract gamma,
 * but it uses UW's authoritative dealer-gamma numbers rather than a
 * home-brew gamma recompute, which would drift.
 */

// ============================================================================
// Types
// ============================================================================

export interface UWContract {
  /** UW option_symbol like "AAPL240621C00200000" — parsed for strike/type/expiry. */
  option_symbol: string;
  open_interest: number;
  /** Previous day OI. OIC = open_interest - prev_oi. */
  prev_oi: number;
  /** Last traded price for the contract. */
  last_price: number | null;
  volume?: number | null;
  implied_volatility?: number | null;
  /** Days to expiration as a number if UW already computed it; otherwise derived from option_symbol. */
  dte?: number | null;
}

export interface TickerScores {
  $flow: number;      // -100..+100 — dollar-weighted OI change
  hedge: number;      // -100..+100 — gamma exposure sign
  now: number;        // -100..+100 — DTE-weighted OI change
  calls: number;      // -100..+100 — call velocity (OIC/OI% sum)
  puts: number;       // -100..+100 — put velocity (negated: bearish)
  combo: 'URGENT' | 'A+ BULLISH' | 'A+ BEARISH' | 'SQUEEZE SETUP' | 'BATTLEGROUND' | 'LEAN BULLISH' | 'LEAN BEARISH' | 'NEUTRAL';
  comboLabel: string;
  comboColor: string;
  totals: {
    totalDollar: number;
    maxDollar: number;
    totalGamma: number;
    maxGamma: number;
    totalDte: number;
    maxDte: number;
    avgCVel: number;
    avgPVel: number;
  };
}

// ============================================================================
// 1) calcScore — James's EXACT LinkGex V3 formula. Do NOT change.
// ============================================================================

export function calcScore(bullish: number, bearish: number): number {
  const total = bullish + bearish;
  if (total === 0) return 0;
  return Math.round(((bullish - bearish) / total) * 100);
}

// ============================================================================
// Helpers for parsing UW option symbols
// ============================================================================

/** Parse a UW-style OCC option symbol → { strike, isCall, expiryIso }. */
export function parseOptionSymbol(sym: string): { strike: number; isCall: boolean; expiry: Date } | null {
  // OCC format: ROOT + YYMMDD + C|P + STRIKE*1000 (8 digits, padded).
  // UW uses the same shape. Scan from the right: last 8 digits = strike*1000,
  // preceding char = C|P, preceding 6 digits = YYMMDD.
  const m = sym.match(/([A-Z]+)(\d{6})([CP])(\d{8})$/);
  if (!m) return null;
  const [, , yymmdd, cp, strikeStr] = m;
  const yy = parseInt(yymmdd.slice(0, 2), 10);
  const mm = parseInt(yymmdd.slice(2, 4), 10);
  const dd = parseInt(yymmdd.slice(4, 6), 10);
  // 2-digit year: assume 20YY (safe through 2099)
  const expiry = new Date(Date.UTC(2000 + yy, mm - 1, dd));
  const strike = parseInt(strikeStr, 10) / 1000;
  return { strike, isCall: cp === 'C', expiry };
}

/** DTE in days (fractional ok). Uses UTC so cron servers match. */
export function daysToExpiry(expiry: Date, fromMs = Date.now()): number {
  return (expiry.getTime() - fromMs) / 86_400_000;
}

// ============================================================================
// 2) computeTickerScores — five LinkGex V3 scores + combo verdict
// ============================================================================

export function computeTickerScores(
  contracts: UWContract[],
  spot: number,
  gammaByStrike: Record<number, number>,
): TickerScores {
  // Zero-sum defaults for each score's (bullish, bearish) buckets.
  let dollarBullish = 0, dollarBearish = 0;
  let hedgeBullish = 0, hedgeBearish = 0;
  let dteBullish = 0, dteBearish = 0;
  let velCallPos = 0, velCallNeg = 0;
  let velPutPos = 0, velPutNeg = 0;
  let cVelCount = 0, cVelSum = 0;
  let pVelCount = 0, pVelSum = 0;

  // Per-strike call/put OI totals for proportional gamma attribution.
  const callOiByStrike: Record<number, number> = {};
  const putOiByStrike: Record<number, number> = {};
  for (const c of contracts) {
    const parsed = parseOptionSymbol(c.option_symbol);
    if (!parsed) continue;
    const oi = Number(c.open_interest) || 0;
    if (parsed.isCall) callOiByStrike[parsed.strike] = (callOiByStrike[parsed.strike] || 0) + oi;
    else                putOiByStrike[parsed.strike]  = (putOiByStrike[parsed.strike]  || 0) + oi;
  }

  for (const c of contracts) {
    const parsed = parseOptionSymbol(c.option_symbol);
    if (!parsed) continue;
    const { strike, isCall, expiry } = parsed;

    const oi = Number(c.open_interest) || 0;
    const prev = Number(c.prev_oi) || 0;
    const oic = oi - prev;                                    // open interest change
    const last = Number(c.last_price) || 0;
    const dte = (typeof c.dte === 'number' && Number.isFinite(c.dte))
      ? c.dte
      : daysToExpiry(expiry);

    // ---- $FLOW score: dollar value of OI change ----
    // dollarOIC = OIC × last_price × 100 (contract multiplier)
    const dollarOic = oic * last * 100;
    if (isCall) {
      // calls: positive OIC = bullish add, negative OIC = bullish close
      if (dollarOic > 0)      dollarBullish += Math.abs(dollarOic);
      else if (dollarOic < 0) dollarBearish += Math.abs(dollarOic);   // unwind — slight bearish weight
    } else {
      // puts: positive OIC = bearish add
      if (dollarOic > 0)      dollarBearish += Math.abs(dollarOic);
      else if (dollarOic < 0) dollarBullish += Math.abs(dollarOic);
    }

    // ---- HEDGE score: gamma exposure from OI ----
    // Proportionally attribute the strike's net gamma exposure to calls vs puts
    // by open-interest share at that strike. gammaByStrike is the UW per-strike
    // net gamma-exposure (already OI × gamma × 100 × spot on UW's side).
    const gNet = gammaByStrike[strike] ?? 0;
    if (gNet !== 0) {
      const callOi = callOiByStrike[strike] || 0;
      const putOi  = putOiByStrike[strike]  || 0;
      const totalOi = callOi + putOi;
      if (totalOi > 0) {
        // Gamma contribution proportional to this contract's OI share.
        const share = oi / totalOi;
        const contribution = Math.abs(gNet) * share * (gNet >= 0 ? 1 : -1);
        if (isCall) hedgeBullish += Math.abs(contribution);
        else         hedgeBearish += Math.abs(contribution);
      }
    }

    // ---- NOW score: DTE-weighted OIC ----
    // dteW = min(10, 1/max(dte, 0.1)). Same-day (0DTE) clamps to 10; far-dated
    // contracts get tiny weight. Short-dated positioning is what matters NOW.
    const safeDte = Math.max(dte, 0.1);
    const dteW = Math.min(10, 1 / safeDte);
    const weightedOic = oic * dteW;
    if (isCall) {
      if (weightedOic > 0)      dteBullish += Math.abs(weightedOic);
      else if (weightedOic < 0) dteBearish += Math.abs(weightedOic);
    } else {
      if (weightedOic > 0)      dteBearish += Math.abs(weightedOic);
      else if (weightedOic < 0) dteBullish += Math.abs(weightedOic);
    }

    // ---- CALLS / PUTS velocity: sum OIC/OI% ----
    // Skip strikes with OI < 50 (noise threshold per James's rubric).
    if (oi >= 50) {
      const pct = (oic / oi) * 100;
      if (isCall) {
        cVelCount++;
        cVelSum += Math.abs(pct);
        if (pct > 0)      velCallPos += pct;
        else if (pct < 0) velCallNeg += Math.abs(pct);
      } else {
        pVelCount++;
        pVelSum += Math.abs(pct);
        if (pct > 0)      velPutPos += pct;
        else if (pct < 0) velPutNeg += Math.abs(pct);
      }
    }
  }

  // The five directional scores.
  const $flow = calcScore(dollarBullish, dollarBearish);
  const hedge = calcScore(hedgeBullish, hedgeBearish);
  const nowS  = calcScore(dteBullish, dteBearish);
  const calls = calcScore(velCallPos, velCallNeg);
  // Puts building = bearish, so negate the final score (James's rubric).
  const puts  = -calcScore(velPutPos, velPutNeg);

  // Totals for combo verdict.
  const totalDollar = dollarBullish + dollarBearish;
  const totalGamma  = hedgeBullish - hedgeBearish;            // signed net
  const totalDte    = dteBullish - dteBearish;                // signed net
  // "max" baselines — use largest single-contract magnitude observed, so the
  // combo thresholds scale with the ticker's own distribution.
  let maxDollar = 0, maxGamma = 0, maxDte = 0;
  for (const c of contracts) {
    const parsed = parseOptionSymbol(c.option_symbol);
    if (!parsed) continue;
    const oi = Number(c.open_interest) || 0;
    const prev = Number(c.prev_oi) || 0;
    const oic = oi - prev;
    const last = Number(c.last_price) || 0;
    const dte = (typeof c.dte === 'number' && Number.isFinite(c.dte))
      ? c.dte
      : daysToExpiry(parsed.expiry);
    const dollarOic = Math.abs(oic * last * 100);
    const gNet = Math.abs(gammaByStrike[parsed.strike] ?? 0);
    const dteOic = Math.abs(oic * Math.min(10, 1 / Math.max(dte, 0.1)));
    if (dollarOic > maxDollar) maxDollar = dollarOic;
    if (gNet      > maxGamma)  maxGamma  = gNet;
    if (dteOic    > maxDte)    maxDte    = dteOic;
  }
  const avgCVel = cVelCount ? cVelSum / cVelCount : 0;
  const avgPVel = pVelCount ? pVelSum / pVelCount : 0;

  // ---- Combo verdict (always-on flag patterns) ----
  // Thresholds are James's LinkGex V3 multipliers.
  let combo: TickerScores['combo'] = 'NEUTRAL';
  const absTotalDte = Math.abs(totalDte);
  const absTotalGamma = Math.abs(totalGamma);
  const absTotalDollar = Math.abs(totalDollar);

  if (absTotalDte > maxDte * 5 && absTotalGamma > maxGamma * 3) {
    combo = 'URGENT';
  } else if (absTotalDollar > maxDollar * 3 && absTotalGamma > maxGamma * 3) {
    combo = totalGamma >= 0 ? 'A+ BULLISH' : 'A+ BEARISH';
  } else if (absTotalDollar < maxDollar * 2 && absTotalGamma > maxGamma * 3) {
    combo = 'SQUEEZE SETUP';
  } else if (avgCVel > 10 && avgPVel > 10) {
    combo = 'BATTLEGROUND';
  } else {
    // LEAN fallback — direction from summed positional lean.
    const lean = $flow + hedge + nowS + calls + puts;
    combo = lean > 0 ? 'LEAN BULLISH' : lean < 0 ? 'LEAN BEARISH' : 'NEUTRAL';
  }

  const comboMeta: Record<TickerScores['combo'], { label: string; color: string }> = {
    'URGENT':          { label: 'URGENT',          color: '#ff2d2d' },
    'A+ BULLISH':      { label: 'A+ BULLISH',      color: '#00c853' },
    'A+ BEARISH':      { label: 'A+ BEARISH',      color: '#ff1744' },
    'SQUEEZE SETUP':   { label: 'SQUEEZE SETUP',   color: '#ff9800' },
    'BATTLEGROUND':    { label: 'BATTLEGROUND',    color: '#ab47bc' },
    'LEAN BULLISH':    { label: 'lean bullish',    color: '#66bb6a' },
    'LEAN BEARISH':    { label: 'lean bearish',    color: '#ef5350' },
    'NEUTRAL':         { label: 'neutral',         color: '#9e9e9e' },
  };

  return {
    $flow,
    hedge,
    now: nowS,
    calls,
    puts,
    combo,
    comboLabel: comboMeta[combo].label,
    comboColor: comboMeta[combo].color,
    totals: {
      totalDollar,
      maxDollar,
      totalGamma,
      maxGamma,
      totalDte,
      maxDte,
      avgCVel,
      avgPVel,
    },
  };
}

// ============================================================================
// 3) deriveWriteTimeAttention — cheap 0..100 integer for ct_* inserts
// ============================================================================

/**
 * Cheap attention score derived from state + conviction + trigger + convergence.
 * Used by ct-watcher when we don't have the full contract snapshot in hand.
 * Clamped 1..100.
 *
 * Base rates (the "fyi vs drop-what-you're-doing" ladder):
 *   heartbeat:                5
 *   observation:             15
 *   observation + invalidation: 50 (silent but actionable)
 *   flag conv 2:             40
 *   flag conv 3:             55
 *   flag conv 4:             70
 *   alert (base):            85
 *   alert + convergence_count>=3: +5
 *   alert + thesis_invalidation: +3
 *   alert + trade_setup present: +5   → caps at 95-100 range
 *
 * Convergence adds up to +10 across states: bullish+bearish signals don't count,
 * only directional ones (count>=3).
 */
export function deriveWriteTimeAttention(params: {
  state: 'HEARTBEAT' | 'OBSERVATION' | 'FLAG' | 'ALERT';
  conviction?: number | null;
  alertTrigger?: string | null;
  convergenceCount?: number | null;
  hasTradeSetup?: boolean;
  isInvalidation?: boolean;
}): number {
  const { state, conviction, alertTrigger, convergenceCount, hasTradeSetup, isInvalidation } = params;
  let score = 0;

  switch (state) {
    case 'HEARTBEAT':
      score = 5;
      break;
    case 'OBSERVATION':
      score = isInvalidation ? 50 : 15;
      break;
    case 'FLAG': {
      const c = Math.max(1, Math.min(4, Number(conviction) || 2));
      score = { 1: 25, 2: 40, 3: 55, 4: 70 }[c as 1 | 2 | 3 | 4];
      if (hasTradeSetup) score += 5;
      break;
    }
    case 'ALERT':
      score = 85;
      if (alertTrigger === 'thesis_invalidation') score += 3;
      if (hasTradeSetup) score += 5;
      break;
  }

  // Convergence boost (all states): +5 at 3 signals, +10 at 5+
  const conv = Math.max(0, Number(convergenceCount) || 0);
  if (conv >= 5)      score += 10;
  else if (conv >= 3) score += 5;

  return Math.max(1, Math.min(100, Math.round(score)));
}
