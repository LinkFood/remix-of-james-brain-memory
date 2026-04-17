/**
 * ct-gex-radar — Co-Trader GEX Radar panel backend.
 *
 * Port of James's TrendSpider "GEX Radar" indicator. Builds a per-ticker
 * strike-level dealer positioning view: spot, king (max |netGex|), queen
 * (2nd-largest on opposite side of spot from king), gamma flip, call wall,
 * put wall, Δ OPEN, plus 30-40 strike rows centered on spot with velocity
 * badges derived from (cOIC + pOIC) / (cOI + pOI).
 *
 * Data sources (both UW endpoints are already wired via _shared/uwClient.ts):
 *  - option-contracts           → per-contract OI, prev_oi, volume, type, strike
 *    (aggregate into cOI / pOI / cOIC / pOIC / cVol / pVol per strike)
 *  - spot-exposures/strike      → dealer gamma per strike + underlying price
 *    (authoritative netGex / cGex / pGex per strike — avoid re-deriving)
 *
 * King / queen / flip / walls are computed from spot-exposures (dealer gamma).
 * The option-contracts feed supplies OI velocity only. James's TrendSpider
 * script builds netGex from OI*gamma*100 directly; we defer to UW's dealer-gamma
 * aggregation (spot-exposures) because that's the same signal the rest of
 * Co-Trader already trusts.
 *
 * No heavy client-side work: the payload is ready-to-render rows.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { getOptionContracts, getSpotGexByStrike } from '../_shared/uwClient.ts';

const DEFAULT_TICKERS = ['SPY', 'QQQ', 'IWM'];
const DEFAULT_WINDOW = 30;   // strikes around spot
const MIN_OI_FOR_VELOCITY = 200;
const VELOCITY_TOP_N = 6;
const VELOCITY_MIN_ABS_PCT = 5;

type OptionContract = {
  option_symbol?: string;
  open_interest?: number | string;
  prev_oi?: number | string;
  prev_open_interest?: number | string;
  volume?: number | string;
  type?: 'C' | 'P' | 'call' | 'put' | string;
  option_type?: string;
  strike?: number | string;
  expiry?: string;
  expiration?: string;
  gamma?: number | string;
};

type SpotGexStrike = {
  strike?: number | string;
  price?: number | string;
  call_gex?: number | string;
  put_gex?: number | string;
  net_gex?: number | string;
  gamma_per_one_percent_move_oi?: number | string;
  [k: string]: unknown;
};

interface StrikeRow {
  strike: number;
  netGex: number;
  cGex: number;
  pGex: number;
  cOI: number;
  pOI: number;
  cOIC: number;
  pOIC: number;
  velocity_pct: number | null;   // signed; + = calls building dominant, - = puts building dominant
  dominant_side: 'C' | 'P' | null;
  show_velocity: boolean;
}

interface TickerPayload {
  ticker: string;
  spot: number | null;
  strikes: StrikeRow[];
  king: number | null;
  queen: number | null;
  gammaFlip: number | null;
  callWall: number | null;
  putWall: number | null;
  deltaOpen: number;
  regime: 'pos' | 'neg' | null;
  errors: string[];
}

// -----------------------------------------------------------------------------
// Symbol parsing
// -----------------------------------------------------------------------------

/**
 * SPY260417C00710000 → { expiry: "2026-04-17", type: "C", strike: 710.00 }
 * Standard OCC: root (1-6 chars), YYMMDD, C/P, 8-digit strike (thousandths).
 */
function parseOccSymbol(sym: string): { expiry: string; type: 'C' | 'P'; strike: number } | null {
  if (!sym || typeof sym !== 'string') return null;
  const m = sym.match(/^([A-Z0-9\.]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
  if (!m) return null;
  const [, , yy, mm, dd, cp, strikeRaw] = m;
  const yearNum = Number(yy);
  // OCC uses 2-digit years; 00-79 = 2000-2079 is the common convention.
  const year = yearNum < 80 ? 2000 + yearNum : 1900 + yearNum;
  const expiry = `${year}-${mm}-${dd}`;
  const strike = Number(strikeRaw) / 1000;
  return { expiry, type: cp as 'C' | 'P', strike };
}

function num(v: unknown, fallback = 0): number {
  if (v === null || v === undefined) return fallback;
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : fallback;
}

// -----------------------------------------------------------------------------
// UW response shape helpers — handles { data: [...] } and raw arrays.
// -----------------------------------------------------------------------------

function unwrap<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    if (Array.isArray(r.data)) return r.data as T[];
  }
  return [];
}

function spotFromGex(raw: unknown): number | null {
  // spot-exposures/strike typically returns { data: [...], price } or similar.
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
    // Sometimes nested under .data.price when data is object not array
    if (r.data && typeof r.data === 'object' && !Array.isArray(r.data)) {
      return spotFromGex(r.data);
    }
  }
  return null;
}

// -----------------------------------------------------------------------------
// Per-ticker build
// -----------------------------------------------------------------------------

async function buildTickerPayload(ticker: string, windowSize: number): Promise<TickerPayload> {
  const errors: string[] = [];

  let contractsRaw: unknown = null;
  let gexRaw: unknown = null;

  try {
    contractsRaw = await getOptionContracts(ticker);
  } catch (e) {
    errors.push(`option-contracts: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    gexRaw = await getSpotGexByStrike(ticker);
  } catch (e) {
    errors.push(`spot-exposures: ${e instanceof Error ? e.message : String(e)}`);
  }

  // ---- OI aggregation from option-contracts ----
  const contracts = unwrap<OptionContract>(contractsRaw);
  const oiMap = new Map<number, { cOI: number; pOI: number; cOIC: number; pOIC: number }>();

  for (const c of contracts) {
    const sym = c.option_symbol ?? '';
    const parsed = parseOccSymbol(sym);
    if (!parsed) continue;
    const strike = parsed.strike;
    const type = parsed.type; // 'C' | 'P'
    const oi = num(c.open_interest);
    const prev = num(c.prev_oi ?? c.prev_open_interest);
    const oic = oi - prev;
    const rec = oiMap.get(strike) ?? { cOI: 0, pOI: 0, cOIC: 0, pOIC: 0 };
    if (type === 'C') {
      rec.cOI += oi;
      rec.cOIC += oic;
    } else {
      rec.pOI += oi;
      rec.pOIC += oic;
    }
    oiMap.set(strike, rec);
  }

  // ---- Dealer gamma per strike from spot-exposures ----
  const gexRows = unwrap<SpotGexStrike>(gexRaw);
  const gexMap = new Map<number, { cGex: number; pGex: number; netGex: number }>();
  for (const row of gexRows) {
    const strike = num(row.strike, NaN);
    if (!Number.isFinite(strike)) continue;
    const cGex = num(row.call_gex ?? (row as Record<string, unknown>).call_gamma ?? 0);
    const pGex = num(row.put_gex ?? (row as Record<string, unknown>).put_gamma ?? 0);
    const netGex = row.net_gex !== undefined
      ? num(row.net_gex)
      : cGex + pGex; // UW convention: put_gex is already signed negative
    gexMap.set(strike, { cGex, pGex, netGex });
  }

  // ---- Spot price ----
  const spot = spotFromGex(gexRaw);

  // Union of all strikes we have either data source for
  const allStrikes = new Set<number>([...oiMap.keys(), ...gexMap.keys()]);
  let strikes: StrikeRow[] = Array.from(allStrikes).sort((a, b) => a - b).map(strike => {
    const oi = oiMap.get(strike) ?? { cOI: 0, pOI: 0, cOIC: 0, pOIC: 0 };
    const g = gexMap.get(strike) ?? { cGex: 0, pGex: 0, netGex: 0 };
    const tOI = oi.cOI + oi.pOI;
    const tOIC = oi.cOIC + oi.pOIC;
    let velocity_pct: number | null = null;
    let dominant_side: 'C' | 'P' | null = null;
    if (tOI >= MIN_OI_FOR_VELOCITY) {
      velocity_pct = (tOIC / tOI) * 100;
      const cAbs = Math.abs(oi.cOIC);
      const pAbs = Math.abs(oi.pOIC);
      dominant_side = cAbs >= pAbs ? 'C' : 'P';
    }
    return {
      strike,
      netGex: g.netGex,
      cGex: g.cGex,
      pGex: g.pGex,
      cOI: oi.cOI,
      pOI: oi.pOI,
      cOIC: oi.cOIC,
      pOIC: oi.pOIC,
      velocity_pct,
      dominant_side,
      show_velocity: false,
    };
  });

  // ---- Window: 25-40 strikes centered on spot ----
  if (spot !== null && strikes.length > windowSize) {
    // Find the nearest strike index to spot, then slice a window around it.
    let nearestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < strikes.length; i++) {
      const d = Math.abs(strikes[i].strike - spot);
      if (d < bestDist) { bestDist = d; nearestIdx = i; }
    }
    const half = Math.floor(windowSize / 2);
    let start = Math.max(0, nearestIdx - half);
    let end = Math.min(strikes.length, start + windowSize);
    start = Math.max(0, end - windowSize);
    strikes = strikes.slice(start, end);
  } else if (strikes.length > windowSize) {
    strikes = strikes.slice(0, windowSize);
  }

  // ---- Velocity badges: top 6 by |velocity_pct| with floor 5% ----
  const eligibleForBadge = strikes
    .map((s, i) => ({ i, abs: s.velocity_pct !== null ? Math.abs(s.velocity_pct) : -1 }))
    .filter(x => x.abs >= VELOCITY_MIN_ABS_PCT)
    .sort((a, b) => b.abs - a.abs)
    .slice(0, VELOCITY_TOP_N);
  for (const { i } of eligibleForBadge) strikes[i].show_velocity = true;

  // ---- King / queen / flip / walls ----
  let king: number | null = null;
  let queen: number | null = null;
  let gammaFlip: number | null = null;
  let callWall: number | null = null;
  let putWall: number | null = null;

  if (strikes.length > 0) {
    // King = strike with max |netGex| across the window
    let kAbs = -Infinity;
    for (const s of strikes) {
      const a = Math.abs(s.netGex);
      if (a > kAbs) { kAbs = a; king = s.strike; }
    }

    // Queen = 2nd-largest |netGex| on the OPPOSITE side of spot from king
    if (spot !== null && king !== null) {
      const kingAboveSpot = king > spot;
      let qAbs = -Infinity;
      for (const s of strikes) {
        if (s.strike === king) continue;
        const onOppositeSide = kingAboveSpot ? s.strike < spot : s.strike > spot;
        if (!onOppositeSide) continue;
        const a = Math.abs(s.netGex);
        if (a > qAbs) { qAbs = a; queen = s.strike; }
      }
    }

    // Gamma flip = first strike near spot where netGex crosses zero (sign change).
    // Port of TS script's 93-107% spot range check.
    if (spot !== null) {
      const lo = spot * 0.93;
      const hi = spot * 1.07;
      const inBand = strikes.filter(s => s.strike >= lo && s.strike <= hi);
      for (let i = 0; i < inBand.length - 1; i++) {
        const a = inBand[i];
        const b = inBand[i + 1];
        if (a.netGex === 0 || b.netGex === 0) continue;
        if ((a.netGex > 0) !== (b.netGex > 0)) {
          // Linear interp for the crossing strike
          const t = a.netGex / (a.netGex - b.netGex);
          gammaFlip = a.strike + t * (b.strike - a.strike);
          break;
        }
      }
    }

    // Call wall = strike above spot with max cGex
    // Put wall = strike below spot with max |pGex|
    if (spot !== null) {
      let cwBest = -Infinity;
      let pwBest = -Infinity;
      for (const s of strikes) {
        if (s.strike > spot && s.cGex > cwBest) { cwBest = s.cGex; callWall = s.strike; }
        const pAbs = Math.abs(s.pGex);
        if (s.strike < spot && pAbs > pwBest) { pwBest = pAbs; putWall = s.strike; }
      }
    }
  }

  // Δ OPEN across the window
  const deltaOpen = strikes.reduce((acc, s) => acc + s.cOIC + s.pOIC, 0);

  // Regime: sum of netGex across window
  const netSum = strikes.reduce((acc, s) => acc + s.netGex, 0);
  const regime: 'pos' | 'neg' | null = strikes.length === 0 ? null : (netSum >= 0 ? 'pos' : 'neg');

  return {
    ticker,
    spot,
    strikes,
    king,
    queen,
    gammaFlip,
    callWall,
    putWall,
    deltaOpen,
    regime,
    errors,
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

    const rawTickers = body.tickers;
    const tickers: string[] = Array.isArray(rawTickers) && rawTickers.length > 0
      ? (rawTickers as unknown[]).map(t => String(t).toUpperCase()).filter(Boolean)
      : [...DEFAULT_TICKERS];

    const windowSize = Math.max(
      15,
      Math.min(60, num(body.window, DEFAULT_WINDOW)),
    );

    const tickerPayloads = await Promise.all(
      tickers.map(t => buildTickerPayload(t, windowSize)),
    );

    return new Response(
      JSON.stringify({ tickers: tickerPayloads, generated_at: new Date().toISOString() }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[ct-gex-radar] failure:', msg);
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
