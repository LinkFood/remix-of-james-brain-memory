/**
 * ct-linkgex-deep — per-ticker LinkGex V3 drill-down.
 *
 * Port of James's TrendSpider "LinkGex V3" indicator for ONE ticker. Where
 * ct-gex-radar shows a 3-ticker ladder (overview), this function builds the
 * full 10-column matrix + header overlay + 5 directional scores + combo
 * verdict for a single symbol.
 *
 * Data sources (both already wired via _shared/uwClient.ts):
 *  - option-contracts           → per-contract OI, prev_oi, last, volume,
 *                                 IV, option_symbol (parsed for strike + side + DTE)
 *  - spot-exposures/strike      → dealer gamma per strike (netGex / cGex / pGex)
 *
 * Per-contract gamma is NOT available from option-contracts, so the HEDGE
 * score and gammaOIC come from per-strike dealer gamma (spot-exposures),
 * proportionally attributed by OI share. computeTickerScores() in
 * _shared/attentionScore.ts handles the attribution — we pass the strike
 * gamma map and it returns the 5 scores + combo verdict.
 *
 * Rate-limit note: UW Basic is 20k/day. This function makes exactly 2 UW
 * calls per invocation. With a 90s component refresh, a single viewer burns
 * ~960 calls/day (2 calls × 480 90s-windows in 12h of trading). Don't poll
 * when the drill-down isn't on screen.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { getOptionContracts, getSpotGexByStrike } from '../_shared/uwClient.ts';
import { computeTickerScores, type UWContract } from '../_shared/attentionScore.ts';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

type OptionContract = {
  option_symbol?: string;
  open_interest?: number | string;
  prev_oi?: number | string;
  prev_open_interest?: number | string;
  volume?: number | string;
  last_price?: number | string;
  implied_volatility?: number | string;
  dte?: number | string;
  [k: string]: unknown;
};

type SpotGexStrike = {
  strike?: number | string;
  price?: number | string;
  call_gex?: number | string;
  put_gex?: number | string;
  net_gex?: number | string;
  [k: string]: unknown;
};

interface StrikeRow {
  strike: number;
  isSpot: boolean;
  isKing: boolean;
  isQueen: boolean;
  isCallWall: boolean;
  isPutWall: boolean;
  netGex: number;
  cGex: number;
  pGex: number;
  cOI: number;
  pOI: number;
  cOIC: number;
  pOIC: number;
  // Magnitude columns shown in the matrix:
  dollarOIC: number;       // $FLOW: Σ |oic × last × 100| across contracts at this strike (directional net preserved in dollarNetOIC)
  dollarNetOIC: number;    // signed net $OIC (bullish - bearish) — for heat bar direction
  gammaOIC: number;        // HEDGE: per-strike dealer gamma impact of OIC (proxied from spot-exposures ratio scaled by OIC share)
  dteOIC: number;          // NOW: Σ |oic × dteW| at this strike (signed version kept in dteNetOIC)
  dteNetOIC: number;       // signed NOW contribution — tint direction
  cVelPct: number | null;  // calls velocity% = cOIC/cOI × 100, null if cOI < 50
  pVelPct: number | null;  // puts velocity%, null if pOI < 50
  zeroDteGex: number;      // 0DTE: aggregate net gamma contribution at this strike from 0DTE contracts only
  activityDots: 0 | 1 | 2 | 3;
}

interface Payload {
  ticker: string;
  spot: number | null;
  regime: 'pos' | 'neg' | null;
  cPct: number;                 // bias bar: 0..100 call share of totalOI
  pPct: number;                 // bias bar: 0..100 put share of totalOI
  king: number | null;
  queen: number | null;
  gammaFlip: number | null;
  callWall: number | null;
  putWall: number | null;
  deltaOpen: number;            // sum of cOIC + pOIC across visible window
  strikes: StrikeRow[];
  scores: {
    flow: number;
    hedge: number;
    now: number;
    calls: number;
    puts: number;
  };
  totals: {
    dollar: number;
    gamma: number;
    dte: number;
    avgCVel: number;
    avgPVel: number;
  };
  verdicts: {
    combo: string;
    comboLabel: string;
    comboColor: string;
    $flow: string;
    gamma: string;
    dte: string;
    cVel: string;
    pVel: string;
  };
  generated_at: string;
  errors: string[];
  fallback?: boolean;
  fallback_session_date?: string | null;
}

// -----------------------------------------------------------------------------
// DB fallback — when UW live endpoints return empty (weekend / market closed),
// reconstruct the dealer gamma map from the most recent ct_gex_timeseries
// snapshot. OI velocity (cOIC / pOIC) is NOT in this table, so on fallback the
// velocity, $FLOW, NOW, and combo fields are zeroed and their verdict strings
// set to 'n/a'. The UI should show fallback=true badge to explain the gaps.
// -----------------------------------------------------------------------------

async function loadGexFallback(ticker: string): Promise<{
  gexMap: Map<number, { cGex: number; pGex: number; netGex: number }>;
  spot: number | null;
  snapshotAt: string | null;
} | null> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) return null;
  const supabase = createClient(supabaseUrl, serviceKey);

  const { data: latest, error: latestErr } = await supabase
    .from('ct_gex_timeseries')
    .select('snapshot_at')
    .eq('ticker', ticker)
    .order('snapshot_at', { ascending: false })
    .limit(1);
  if (latestErr || !latest || latest.length === 0) return null;
  const snapshotAt = latest[0].snapshot_at as string;

  const { data: rows, error: rowsErr } = await supabase
    .from('ct_gex_timeseries')
    .select('strike, call_gex, put_gex, net_gex, underlying_price')
    .eq('ticker', ticker)
    .eq('snapshot_at', snapshotAt);
  if (rowsErr || !rows || rows.length === 0) return null;

  const gexMap = new Map<number, { cGex: number; pGex: number; netGex: number }>();
  let spot: number | null = null;
  for (const r of rows as Array<{
    strike: number | string;
    call_gex: number | string | null;
    put_gex: number | string | null;
    net_gex: number | string | null;
    underlying_price: number | string | null;
  }>) {
    const strike = num(r.strike, NaN);
    if (!Number.isFinite(strike)) continue;
    const cGex = num(r.call_gex ?? 0);
    const pGex = num(r.put_gex ?? 0);
    const netGex = r.net_gex !== null && r.net_gex !== undefined
      ? num(r.net_gex)
      : cGex + pGex;
    gexMap.set(strike, { cGex, pGex, netGex });
    if (spot === null && r.underlying_price !== null && r.underlying_price !== undefined) {
      const s = num(r.underlying_price, NaN);
      if (Number.isFinite(s) && s > 0) spot = s;
    }
  }
  return { gexMap, spot, snapshotAt };
}

function sessionDateFromSnapshot(snapshotAt: string | null): string | null {
  if (!snapshotAt) return null;
  return snapshotAt.slice(0, 10);
}

// -----------------------------------------------------------------------------
// Parse helpers
// -----------------------------------------------------------------------------

/**
 * SPY260417C00710000 → { expiry: Date, type: 'C'|'P', strike: 710.00 }.
 * Standard OCC: root (1-6 chars), YYMMDD, C/P, 8-digit strike (thousandths).
 */
function parseOccSymbol(sym: string): { expiry: Date; type: 'C' | 'P'; strike: number } | null {
  if (!sym || typeof sym !== 'string') return null;
  const m = sym.match(/^([A-Z0-9\.]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
  if (!m) return null;
  const [, , yy, mm, dd, cp, strikeRaw] = m;
  const yearNum = Number(yy);
  const year = yearNum < 80 ? 2000 + yearNum : 1900 + yearNum;
  const expiry = new Date(Date.UTC(year, Number(mm) - 1, Number(dd)));
  const strike = Number(strikeRaw) / 1000;
  return { expiry, type: cp as 'C' | 'P', strike };
}

function num(v: unknown, fallback = 0): number {
  if (v === null || v === undefined) return fallback;
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : fallback;
}

function unwrap<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    if (Array.isArray(r.data)) return r.data as T[];
  }
  return [];
}

function spotFromGex(raw: unknown): number | null {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const r = raw as Record<string, unknown>;
    const candidates = ['price', 'spot', 'underlying_price', 'last_price'];
    for (const k of candidates) {
      const v = r[k];
      if (v !== undefined && v !== null) {
        const n = num(v, NaN);
        if (Number.isFinite(n) && n > 0) return n;
      }
    }
    if (r.data && typeof r.data === 'object' && !Array.isArray(r.data)) {
      return spotFromGex(r.data);
    }
  }
  return null;
}

function daysToExpiry(expiry: Date, fromMs = Date.now()): number {
  return (expiry.getTime() - fromMs) / 86_400_000;
}

// -----------------------------------------------------------------------------
// Verdict tier labels — James's LinkGex V3 flag multipliers
// -----------------------------------------------------------------------------

function dimensionVerdict(value: number, max: number): string {
  if (max <= 0 || !Number.isFinite(max)) return '—';
  const r = Math.abs(value) / max;
  const dir = value >= 0 ? '▲' : '▼';
  if (r >= 5) return `EXTREME${dir}`;
  if (r >= 3) return `STRONG${dir}`;
  if (r >= 2) return `ELEVATED${dir}`;
  if (r >= 1) return `NORMAL${dir}`;
  return `quiet${dir}`;
}

function velocityVerdict(avg: number): string {
  if (avg >= 25) return 'FRENZY';
  if (avg >= 15) return 'BUILDING';
  if (avg >= 10) return 'ACTIVE';
  if (avg >= 5) return 'STIRRING';
  return 'flat';
}

// -----------------------------------------------------------------------------
// Core build
// -----------------------------------------------------------------------------

async function buildPayload(
  ticker: string,
  maxDte: number,
  strikeWindow: number,
): Promise<Payload> {
  const errors: string[] = [];

  let contractsRaw: unknown = null;
  let gexRaw: unknown = null;

  // Fire both UW calls in parallel.
  const [contractsRes, gexRes] = await Promise.allSettled([
    getOptionContracts(ticker),
    getSpotGexByStrike(ticker),
  ]);
  if (contractsRes.status === 'fulfilled') contractsRaw = contractsRes.value;
  else errors.push(`option-contracts: ${contractsRes.reason instanceof Error ? contractsRes.reason.message : String(contractsRes.reason)}`);
  if (gexRes.status === 'fulfilled') gexRaw = gexRes.value;
  else errors.push(`spot-exposures: ${gexRes.reason instanceof Error ? gexRes.reason.message : String(gexRes.reason)}`);

  // Spot from spot-exposures payload (authoritative).
  let spot = spotFromGex(gexRaw);

  // Dealer gamma map (authoritative netGex / cGex / pGex per strike).
  const gexRows = unwrap<SpotGexStrike>(gexRaw);
  let gexMap = new Map<number, { cGex: number; pGex: number; netGex: number }>();
  for (const row of gexRows) {
    const strike = num(row.strike, NaN);
    if (!Number.isFinite(strike)) continue;
    const cGex = num(row.call_gex ?? (row as Record<string, unknown>).call_gamma ?? 0);
    const pGex = num(row.put_gex ?? (row as Record<string, unknown>).put_gamma ?? 0);
    const netGex = row.net_gex !== undefined ? num(row.net_gex) : cGex + pGex;
    gexMap.set(strike, { cGex, pGex, netGex });
  }

  // Per-strike aggregates from option-contracts. DTE filter applied here —
  // far-dated contracts shouldn't pollute the drill-down view.
  const contracts = unwrap<OptionContract>(contractsRaw);

  // ---- Weekend / market-closed fallback ----
  // UW live endpoints return empty on weekends and holidays. When both
  // spot-exposures AND option-contracts come back empty, reconstruct the
  // gamma map from the most recent ct_gex_timeseries snapshot. OI-derived
  // columns (velocity, $FLOW, NOW, combo) are NOT recoverable and will be
  // zero / 'n/a' — the UI uses `fallback: true` to explain the gaps.
  let fallback = false;
  let fallbackSessionDate: string | null = null;
  // UW on weekends: sometimes returns a stale spot but ZERO strike rows, and
  // sometimes returns nothing. Either case needs the DB fallback — the panel
  // is useless without a strike ladder. Trigger fallback whenever the strike
  // map is empty, regardless of whether spot came back.
  const uwEmpty = gexMap.size === 0 || spot === null;
  if (uwEmpty) {
    try {
      const fb = await loadGexFallback(ticker);
      if (fb && fb.gexMap.size > 0) {
        gexMap = fb.gexMap;
        spot = fb.spot;
        fallback = true;
        fallbackSessionDate = sessionDateFromSnapshot(fb.snapshotAt);
      }
    } catch (e) {
      errors.push(`fallback: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const perStrike = new Map<number, {
    cOI: number; pOI: number; cOIC: number; pOIC: number;
    dollarAbs: number;  dollarNet: number;
    dteAbs: number;     dteNet: number;
    zeroDteAbs: number;
  }>();

  // UWContract[] we'll hand to computeTickerScores — DTE-filtered, matching
  // what the user sees in the matrix.
  const scoringContracts: UWContract[] = [];

  for (const c of contracts) {
    const sym = (c.option_symbol ?? '') as string;
    const parsed = parseOccSymbol(sym);
    if (!parsed) continue;

    const dte = (c.dte !== undefined && c.dte !== null && Number.isFinite(num(c.dte, NaN)))
      ? num(c.dte)
      : daysToExpiry(parsed.expiry);

    if (dte > maxDte) continue;                            // scope filter
    if (dte < -1) continue;                                // stale/expired

    const strike = parsed.strike;
    const isCall = parsed.type === 'C';
    const oi = num(c.open_interest);
    const prev = num(c.prev_oi ?? c.prev_open_interest);
    const oic = oi - prev;
    const last = num(c.last_price);

    const dollarOic = oic * last * 100;                    // $FLOW per-contract
    const safeDte = Math.max(dte, 0.1);
    const dteW = Math.min(10, 1 / safeDte);
    const dteContribution = oic * dteW;                    // NOW per-contract
    const isZeroDte = dte >= 0 && dte < 1;

    const rec = perStrike.get(strike) ?? {
      cOI: 0, pOI: 0, cOIC: 0, pOIC: 0,
      dollarAbs: 0, dollarNet: 0,
      dteAbs: 0, dteNet: 0,
      zeroDteAbs: 0,
    };
    if (isCall) {
      rec.cOI += oi;
      rec.cOIC += oic;
      // Calls: +$ → bullish, -$ → bearish (unwind)
      rec.dollarNet += dollarOic;
      rec.dteNet    += dteContribution;
    } else {
      rec.pOI += oi;
      rec.pOIC += oic;
      // Puts: +$ → bearish (negate for signed net), -$ → bullish (unwind)
      rec.dollarNet -= dollarOic;
      rec.dteNet    -= dteContribution;
    }
    rec.dollarAbs += Math.abs(dollarOic);
    rec.dteAbs    += Math.abs(dteContribution);
    perStrike.set(strike, rec);

    // 0DTE sub-table: per-strike net gamma contribution from 0DTE contracts
    // using dealer gamma for the strike prorated by this contract's OI share
    // of total OI at that strike. We compute the share after all rows — store
    // absolute OI here, finalize in second pass.
    if (isZeroDte) {
      rec.zeroDteAbs += oi;
      perStrike.set(strike, rec);
    }

    scoringContracts.push({
      option_symbol: sym,
      open_interest: oi,
      prev_oi: prev,
      last_price: last,
      volume: num(c.volume),
      implied_volatility: num(c.implied_volatility),
      dte,
    });
  }

  // Build the gammaByStrike map for scoring (net gamma only, not total).
  const gammaByStrike: Record<number, number> = {};
  for (const [k, g] of gexMap) gammaByStrike[k] = g.netGex;

  // ---- Run the LinkGex V3 scorer from _shared/attentionScore.ts ----
  // computeTickerScores implements James's formulas — DO NOT re-implement.
  const scored = computeTickerScores(scoringContracts, spot ?? 0, gammaByStrike);

  // ---- Build the strike rows ----
  const allStrikes = new Set<number>([...perStrike.keys(), ...gexMap.keys()]);
  let rows: StrikeRow[] = Array.from(allStrikes).sort((a, b) => a - b).map(strike => {
    const agg = perStrike.get(strike) ?? {
      cOI: 0, pOI: 0, cOIC: 0, pOIC: 0,
      dollarAbs: 0, dollarNet: 0, dteAbs: 0, dteNet: 0, zeroDteAbs: 0,
    };
    const g = gexMap.get(strike) ?? { cGex: 0, pGex: 0, netGex: 0 };

    // Velocity: OIC/OI × 100, only when OI ≥ 50 (LinkGex V3 rubric).
    const cVelPct = agg.cOI >= 50 ? (agg.cOIC / agg.cOI) * 100 : null;
    const pVelPct = agg.pOI >= 50 ? (agg.pOIC / agg.pOI) * 100 : null;

    // gammaOIC proxy: per-strike dealer gamma × (|OIC| / OI share). When OI is
    // zero we attribute no gamma change. Keeps the "HEDGE" column consistent
    // with the HEDGE score's methodology (dealer gamma × OI share).
    const totalOI = agg.cOI + agg.pOI;
    const totalOIC = agg.cOIC + agg.pOIC;
    const oicShare = totalOI > 0 ? totalOIC / totalOI : 0;
    const gammaOIC = g.netGex * oicShare;

    // 0DTE gamma: dealer gamma at this strike prorated by 0DTE OI share.
    const zeroDteShare = totalOI > 0 ? (agg.zeroDteAbs / totalOI) : 0;
    const zeroDteGex = g.netGex * zeroDteShare;

    // Activity dots 0..3 for magnitude of (|dollarAbs|, |dteAbs|) combined.
    const magnitude = agg.dollarAbs / Math.max(1, scored.totals.maxDollar) +
                      agg.dteAbs    / Math.max(1, scored.totals.maxDte);
    const activityDots: 0 | 1 | 2 | 3 =
      magnitude >= 1.5 ? 3 :
      magnitude >= 0.75 ? 2 :
      magnitude >= 0.25 ? 1 : 0;

    return {
      strike,
      isSpot: false,
      isKing: false,
      isQueen: false,
      isCallWall: false,
      isPutWall: false,
      netGex: g.netGex,
      cGex: g.cGex,
      pGex: g.pGex,
      cOI: agg.cOI,
      pOI: agg.pOI,
      cOIC: agg.cOIC,
      pOIC: agg.pOIC,
      dollarOIC: agg.dollarAbs,
      dollarNetOIC: agg.dollarNet,
      gammaOIC,
      dteOIC: agg.dteAbs,
      dteNetOIC: agg.dteNet,
      cVelPct,
      pVelPct,
      zeroDteGex,
      activityDots,
    };
  });

  // ---- Window around spot ----
  if (spot !== null && rows.length > strikeWindow) {
    let nearestIdx = 0;
    let best = Infinity;
    for (let i = 0; i < rows.length; i++) {
      const d = Math.abs(rows[i].strike - spot);
      if (d < best) { best = d; nearestIdx = i; }
    }
    const half = Math.floor(strikeWindow / 2);
    let start = Math.max(0, nearestIdx - half);
    let end = Math.min(rows.length, start + strikeWindow);
    start = Math.max(0, end - strikeWindow);
    rows = rows.slice(start, end);
  } else if (rows.length > strikeWindow) {
    rows = rows.slice(0, strikeWindow);
  }

  // ---- King / queen / gamma flip / walls (within the window) ----
  let king: number | null = null;
  let queen: number | null = null;
  let gammaFlip: number | null = null;
  let callWall: number | null = null;
  let putWall: number | null = null;

  if (rows.length > 0) {
    let kAbs = -Infinity;
    for (const s of rows) {
      const a = Math.abs(s.netGex);
      if (a > kAbs) { kAbs = a; king = s.strike; }
    }

    if (spot !== null && king !== null) {
      const kingAboveSpot = king > spot;
      let qAbs = -Infinity;
      for (const s of rows) {
        if (s.strike === king) continue;
        const opposite = kingAboveSpot ? s.strike < spot : s.strike > spot;
        if (!opposite) continue;
        const a = Math.abs(s.netGex);
        if (a > qAbs) { qAbs = a; queen = s.strike; }
      }
    }

    if (spot !== null) {
      const lo = spot * 0.93;
      const hi = spot * 1.07;
      const band = rows.filter(s => s.strike >= lo && s.strike <= hi);
      for (let i = 0; i < band.length - 1; i++) {
        const a = band[i];
        const b = band[i + 1];
        if (a.netGex === 0 || b.netGex === 0) continue;
        if ((a.netGex > 0) !== (b.netGex > 0)) {
          const t = a.netGex / (a.netGex - b.netGex);
          gammaFlip = a.strike + t * (b.strike - a.strike);
          break;
        }
      }

      let cwBest = -Infinity;
      let pwBest = -Infinity;
      for (const s of rows) {
        if (s.strike > spot && s.cGex > cwBest) { cwBest = s.cGex; callWall = s.strike; }
        const pAbs = Math.abs(s.pGex);
        if (s.strike < spot && pAbs > pwBest) { pwBest = pAbs; putWall = s.strike; }
      }
    }
  }

  // Mark flags on rows.
  let spotRowStrike: number | null = null;
  if (spot !== null && rows.length > 0) {
    let best = Infinity;
    for (const s of rows) {
      const d = Math.abs(s.strike - spot);
      if (d < best) { best = d; spotRowStrike = s.strike; }
    }
  }
  for (const s of rows) {
    if (spotRowStrike !== null && s.strike === spotRowStrike) s.isSpot = true;
    if (king !== null && s.strike === king) s.isKing = true;
    if (queen !== null && s.strike === queen) s.isQueen = true;
    if (callWall !== null && s.strike === callWall) s.isCallWall = true;
    if (putWall !== null && s.strike === putWall) s.isPutWall = true;
  }

  // ---- Δ OPEN across window, regime, bias bar ----
  const deltaOpen = rows.reduce((acc, s) => acc + s.cOIC + s.pOIC, 0);
  const netSum = rows.reduce((acc, s) => acc + s.netGex, 0);
  const regime: 'pos' | 'neg' | null = rows.length === 0 ? null : (netSum >= 0 ? 'pos' : 'neg');
  const totalCallOI = rows.reduce((acc, s) => acc + s.cOI, 0);
  const totalPutOI  = rows.reduce((acc, s) => acc + s.pOI, 0);
  const totalOI     = totalCallOI + totalPutOI;
  const cPct = totalOI > 0 ? (totalCallOI / totalOI) * 100 : 50;
  const pPct = totalOI > 0 ? (totalPutOI  / totalOI) * 100 : 50;

  // ---- Per-dimension verdicts ----
  // On fallback (market closed), OI-derived dimensions have no fresh data —
  // mark them 'n/a' rather than reporting a stale "quiet" reading.
  const verdicts = fallback
    ? {
        combo: scored.combo,
        comboLabel: 'MARKET CLOSED',
        comboColor: '#6B7280',
        $flow: 'n/a',
        gamma: dimensionVerdict(scored.totals.totalGamma, scored.totals.maxGamma),
        dte:   'n/a',
        cVel:  'n/a',
        pVel:  'n/a',
      }
    : {
        combo: scored.combo,
        comboLabel: scored.comboLabel,
        comboColor: scored.comboColor,
        $flow: dimensionVerdict(scored.totals.totalDollar, scored.totals.maxDollar),
        gamma: dimensionVerdict(scored.totals.totalGamma, scored.totals.maxGamma),
        dte:   dimensionVerdict(scored.totals.totalDte,   scored.totals.maxDte),
        cVel:  velocityVerdict(scored.totals.avgCVel),
        pVel:  velocityVerdict(scored.totals.avgPVel),
      };

  return {
    ticker,
    spot,
    regime,
    cPct,
    pPct,
    king,
    queen,
    gammaFlip,
    callWall,
    putWall,
    deltaOpen,
    strikes: rows,
    scores: {
      flow: scored.$flow,
      hedge: scored.hedge,
      now: scored.now,
      calls: scored.calls,
      puts: scored.puts,
    },
    totals: {
      dollar: scored.totals.totalDollar,
      gamma:  scored.totals.totalGamma,
      dte:    scored.totals.totalDte,
      avgCVel: scored.totals.avgCVel,
      avgPVel: scored.totals.avgPVel,
    },
    verdicts,
    generated_at: new Date().toISOString(),
    errors,
    fallback,
    fallback_session_date: fallbackSessionDate,
  };
}

// -----------------------------------------------------------------------------
// Handler
// -----------------------------------------------------------------------------

serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  const corsHeaders = getCorsHeaders(req);

  try {
    let body: Record<string, unknown> = {};
    if (req.method === 'POST') {
      try { body = await req.json() as Record<string, unknown>; } catch { body = {}; }
    }

    const ticker = String(body.ticker ?? '').trim().toUpperCase();
    if (!ticker) {
      return new Response(
        JSON.stringify({ error: 'ticker is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const maxDte = Math.max(1, Math.min(180, num(body.max_dte, 30)));
    const strikeWindow = Math.max(5, Math.min(80, num(body.strike_window, 30)));

    const payload = await buildPayload(ticker, maxDte, strikeWindow);

    return new Response(
      JSON.stringify(payload),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[ct-linkgex-deep] failure:', msg);
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
