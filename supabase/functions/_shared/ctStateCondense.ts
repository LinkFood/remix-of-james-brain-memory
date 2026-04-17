/**
 * Condense raw UW state into a compact per-instrument summary suitable
 * for the Claude prompt. Raw spot-exposures responses are hundreds of
 * strikes with full Greek vectors — we don't send that to Claude. We
 * extract the aggregates that matter: current price, call wall, put
 * wall, rough gamma flip estimate, total gamma, put/call ratio.
 *
 * All field access is defensive — UW response shapes vary by ticker
 * and we don't crash the watcher cycle over a missing field.
 */

export interface CondensedInstrumentState {
  ticker: string;
  price: number | null;
  call_wall: number | null;           // near-ATM strike with largest call_gamma_oi
  put_wall: number | null;             // near-ATM strike with largest absolute put_gamma_oi
  gamma_flip: number | null;           // strike where cumulative gamma crosses zero
  total_call_gamma_oi: number | null;
  total_put_gamma_oi: number | null;
  net_gamma_oi: number | null;         // call + put (put typically negative)
  put_call_volume_ratio: number | null;
  day_put_call_ratio: number | null;
  raw_strike_count: number;
  near_atm_strike_count: number;       // how many strikes in the filter window
  /** ATM-centered strike bars for UI mini-chart. ±8 strikes each side of ATM. */
  near_atm_strikes: Array<{ strike: number; call_gex: number; put_gex: number; net: number }>;
}

export interface CondensedState {
  timestamp_utc: string;
  per_ticker: Record<string, CondensedInstrumentState>;
  spx_macro: {
    price: number | null;
    call_wall: number | null;
    put_wall: number | null;
    gamma_flip: number | null;
    total_call_gamma_oi: number | null;
    total_put_gamma_oi: number | null;
    net_gamma_oi: number | null;
    raw_strike_count: number;
    near_atm_strike_count: number;
  };
  market_tide: {
    net_call_premium: number | null;
    net_put_premium: number | null;
    net_volume: number | null;
    timestamp: string | null;
  };
  errors: Array<{ ticker: string; endpoint: string; error: string }>;
}

// Near-ATM filter window (±10% default, clamped for low-vol instruments).
const ATM_PCT_WINDOW = 0.10;

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

/**
 * Extract aggregates from BOTH UW spot-exposures/strike and greek-exposure/strike.
 *
 * - Price + spot totals come from spot-exposures (has `price`, call_gamma_oi, put_gamma_oi)
 * - Wall detection + gamma flip use greek-exposure/strike (100+ strikes,
 *   full-range coverage with call_gex / put_gex fields).
 *
 * Why two: spot-exposures caps at ~50 strikes, often clustered below ATM
 * for large-cap tickers (e.g. AAPL returns strikes $5-$230 while price
 * is $263). Static greek-exposure covers $5-$550 with 114 strikes — proper
 * wall detection needs that breadth.
 *
 * Wall detection uses ATM ±10% filter, falls back to "closest strike" if
 * nothing in window. Totals use full chain.
 *
 * Defensive: bad shape → nulls, never throws.
 */
function condenseInstrumentState(
  ticker: string,
  spotRaw: unknown,
  greekRaw: unknown,
): Omit<CondensedInstrumentState, 'put_call_volume_ratio' | 'day_put_call_ratio'> {
  const empty = {
    ticker,
    price: null as number | null,
    call_wall: null as number | null,
    put_wall: null as number | null,
    gamma_flip: null as number | null,
    total_call_gamma_oi: null as number | null,
    total_put_gamma_oi: null as number | null,
    net_gamma_oi: null as number | null,
    raw_strike_count: 0,
    near_atm_strike_count: 0,
    near_atm_strikes: [] as Array<{ strike: number; call_gex: number; put_gex: number; net: number }>,
  };

  // Extract price + spot totals from spot-exposures
  let price: number | null = null;
  let totalCall = 0;
  let totalPut = 0;
  const spotData = (spotRaw && typeof spotRaw === 'object') ? ((spotRaw as { data?: unknown }).data) : null;
  if (Array.isArray(spotData)) {
    for (const row of spotData as Array<Record<string, unknown>>) {
      const rowPrice = numOrNull(row.price);
      if (price === null && rowPrice !== null) price = rowPrice;
      const cg = numOrNull(row.call_gamma_oi);
      const pg = numOrNull(row.put_gamma_oi);
      if (cg !== null) totalCall += cg;
      if (pg !== null) totalPut += pg;
    }
  }

  // Extract strikes from greek-exposure (uses call_gex / put_gex field names)
  const greekData = (greekRaw && typeof greekRaw === 'object') ? ((greekRaw as { data?: unknown }).data) : null;
  const rows: Array<{ strike: number; call: number; put: number }> = [];
  if (Array.isArray(greekData)) {
    for (const row of greekData as Array<Record<string, unknown>>) {
      const strike = numOrNull(row.strike);
      const call = numOrNull(row.call_gex);
      const put = numOrNull(row.put_gex);
      if (strike !== null) rows.push({ strike, call: call ?? 0, put: put ?? 0 });
    }
  }

  if (price === null || rows.length === 0) {
    return {
      ...empty,
      price,
      raw_strike_count: rows.length || (Array.isArray(spotData) ? spotData.length : 0),
      total_call_gamma_oi: totalCall,
      total_put_gamma_oi: totalPut,
      net_gamma_oi: totalCall + totalPut,
    };
  }

  // Near-ATM window
  const low = price * (1 - ATM_PCT_WINDOW);
  const high = price * (1 + ATM_PCT_WINDOW);
  const inWindow = rows.filter(r => r.strike >= low && r.strike <= high);

  let callWallStrike: number | null = null;
  let putWallStrike: number | null = null;

  if (inWindow.length > 0) {
    let maxCallGamma = -Infinity;
    let minPutGamma = Infinity;
    for (const r of inWindow) {
      if (r.call > maxCallGamma) { maxCallGamma = r.call; callWallStrike = r.strike; }
      if (r.put < minPutGamma) { minPutGamma = r.put; putWallStrike = r.strike; }
    }
  } else {
    // Fallback: use the closest strike to price (should be rare with greek-exposure coverage)
    const sorted = [...rows].sort((a, b) => Math.abs(a.strike - price!) - Math.abs(b.strike - price!));
    if (sorted[0]) { callWallStrike = sorted[0].strike; putWallStrike = sorted[0].strike; }
  }

  // Gamma flip: cumulative net gamma crossing zero. Scan strikes ascending,
  // collect ALL crossovers, pick the one closest to ATM. Deep-ITM and deep-OTM
  // regions can produce spurious early crossovers from noise; the true
  // "zero gamma" level is near ATM.
  const sorted = [...rows].sort((a, b) => a.strike - b.strike);
  const flips: number[] = [];
  {
    let cumulative = 0;
    let prevSign = 0;
    for (let i = 0; i < sorted.length; i++) {
      const r = sorted[i];
      const prevCum = cumulative;
      cumulative += r.call + r.put;
      const sign = Math.sign(cumulative);
      if (prevSign !== 0 && sign !== 0 && sign !== prevSign) {
        let f = r.strike;
        if (i > 0) {
          const prev = sorted[i - 1];
          const span = r.strike - prev.strike;
          const dC = cumulative - prevCum;
          if (dC !== 0) f = prev.strike + (span * (0 - prevCum) / dC);
        }
        flips.push(f);
      }
      if (sign !== 0) prevSign = sign;
    }
  }
  let flipStrike: number | null = null;
  if (flips.length > 0) {
    // Only accept a flip if it's near ATM — spurious deep-ITM crossovers are
    // noise, not meaningful "zero gamma" levels. ±25% window. No fallback.
    const nearWindow = flips.filter(f => f >= price * 0.75 && f <= price * 1.25);
    if (nearWindow.length > 0) {
      flipStrike = nearWindow.reduce((best, f) => Math.abs(f - price!) < Math.abs(best - price!) ? f : best, nearWindow[0]);
    }
  }

  // Select ±8 strikes around ATM for the mini-chart
  const miniStrikes = (() => {
    if (inWindow.length === 0) {
      // Fall back to closest 16 strikes overall
      return [...rows]
        .sort((a, b) => Math.abs(a.strike - price) - Math.abs(b.strike - price))
        .slice(0, 16)
        .sort((a, b) => a.strike - b.strike);
    }
    // Take the 8 closest below and 8 closest above price from the window
    const below = inWindow.filter(r => r.strike <= price).sort((a, b) => b.strike - a.strike).slice(0, 8);
    const above = inWindow.filter(r => r.strike > price).sort((a, b) => a.strike - b.strike).slice(0, 8);
    return [...below, ...above].sort((a, b) => a.strike - b.strike);
  })();
  const near_atm_strikes = miniStrikes.map(r => ({
    strike: r.strike,
    call_gex: r.call,
    put_gex: r.put,
    net: r.call + r.put,
  }));

  return {
    ticker,
    price,
    call_wall: callWallStrike,
    put_wall: putWallStrike,
    gamma_flip: flipStrike,
    total_call_gamma_oi: totalCall,
    total_put_gamma_oi: totalPut,
    net_gamma_oi: totalCall + totalPut,
    raw_strike_count: rows.length,
    near_atm_strike_count: inWindow.length,
    near_atm_strikes,
  };
}

function condenseOptionsVolume(raw: unknown): {
  put_call_volume_ratio: number | null;
  day_put_call_ratio: number | null;
} {
  if (!raw || typeof raw !== 'object') return { put_call_volume_ratio: null, day_put_call_ratio: null };
  const data = (raw as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length === 0) return { put_call_volume_ratio: null, day_put_call_ratio: null };
  const first = data[0] as Record<string, unknown>;
  return {
    put_call_volume_ratio: numOrNull(first.avg_30_day_put_call_ratio),
    day_put_call_ratio: numOrNull(first.put_call_ratio),
  };
}

function condenseMarketTide(raw: unknown): CondensedState['market_tide'] {
  const empty = { net_call_premium: null, net_put_premium: null, net_volume: null, timestamp: null };
  if (!raw || typeof raw !== 'object') return empty;
  const data = (raw as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length === 0) return empty;
  const last = data[data.length - 1] as Record<string, unknown>;
  return {
    net_call_premium: numOrNull(last.net_call_premium),
    net_put_premium: numOrNull(last.net_put_premium),
    net_volume: numOrNull(last.net_volume),
    timestamp: typeof last.timestamp === 'string' ? last.timestamp : null,
  };
}

/**
 * Main entry: build a compact state object from pullWatcherState() output.
 */
export function condenseWatcherState(input: {
  spot_gex: Record<string, unknown>;
  greek_exposure: Record<string, unknown>;
  options_volume: Record<string, unknown>;
  spx_spot_gex: unknown | null;
  spx_greek_exposure: unknown | null;
  market_tide: unknown | null;
  errors: Array<{ ticker: string; endpoint: string; error: string }>;
}, timestampUtc: string): CondensedState {
  const per_ticker: Record<string, CondensedInstrumentState> = {};
  const tickers = new Set<string>([
    ...Object.keys(input.spot_gex),
    ...Object.keys(input.greek_exposure),
    ...Object.keys(input.options_volume),
  ]);
  for (const t of tickers) {
    const gex = condenseInstrumentState(t, input.spot_gex[t], input.greek_exposure[t]);
    const vol = condenseOptionsVolume(input.options_volume[t]);
    per_ticker[t] = { ...gex, ...vol };
  }

  const spxCondensed = condenseInstrumentState('SPX', input.spx_spot_gex, input.spx_greek_exposure);

  return {
    timestamp_utc: timestampUtc,
    per_ticker,
    spx_macro: {
      price: spxCondensed.price,
      call_wall: spxCondensed.call_wall,
      put_wall: spxCondensed.put_wall,
      gamma_flip: spxCondensed.gamma_flip,
      total_call_gamma_oi: spxCondensed.total_call_gamma_oi,
      total_put_gamma_oi: spxCondensed.total_put_gamma_oi,
      net_gamma_oi: spxCondensed.net_gamma_oi,
      raw_strike_count: spxCondensed.raw_strike_count,
      near_atm_strike_count: spxCondensed.near_atm_strike_count,
    },
    market_tide: condenseMarketTide(input.market_tide),
    errors: input.errors,
  };
}
