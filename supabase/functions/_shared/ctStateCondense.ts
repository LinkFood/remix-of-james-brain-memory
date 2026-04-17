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
  call_wall: number | null;           // strike with largest call_gamma_oi
  put_wall: number | null;             // strike with largest absolute put_gamma_oi
  total_call_gamma_oi: number | null;
  total_put_gamma_oi: number | null;
  net_gamma_oi: number | null;         // call + put (put typically negative)
  put_call_volume_ratio: number | null;
  day_put_call_ratio: number | null;
  raw_strike_count: number;
}

export interface CondensedState {
  timestamp_utc: string;
  per_ticker: Record<string, CondensedInstrumentState>;
  spx_macro: {
    price: number | null;
    call_wall: number | null;
    put_wall: number | null;
    total_call_gamma_oi: number | null;
    total_put_gamma_oi: number | null;
    net_gamma_oi: number | null;
    raw_strike_count: number;
  };
  market_tide: {
    net_call_premium: number | null;
    net_put_premium: number | null;
    net_volume: number | null;
    timestamp: string | null;
  };
  errors: Array<{ ticker: string; endpoint: string; error: string }>;
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

/**
 * Extract aggregates from a UW spot-exposures/strike response.
 * Defensive: bad shape → nulls, never throws.
 */
function condenseSpotGex(
  ticker: string,
  raw: unknown
): Omit<CondensedInstrumentState, 'put_call_volume_ratio' | 'day_put_call_ratio'> {
  const empty = {
    ticker,
    price: null as number | null,
    call_wall: null as number | null,
    put_wall: null as number | null,
    total_call_gamma_oi: null as number | null,
    total_put_gamma_oi: null as number | null,
    net_gamma_oi: null as number | null,
    raw_strike_count: 0,
  };
  if (!raw || typeof raw !== 'object') return empty;

  const data = (raw as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length === 0) return empty;

  let price: number | null = null;
  let callWallStrike: number | null = null;
  let maxCallGamma = -Infinity;
  let putWallStrike: number | null = null;
  let minPutGamma = Infinity;             // put gamma typically negative
  let totalCall = 0;
  let totalPut = 0;

  for (const row of data as Array<Record<string, unknown>>) {
    const strike = numOrNull(row.strike);
    const callGamma = numOrNull(row.call_gamma_oi);
    const putGamma = numOrNull(row.put_gamma_oi);
    const rowPrice = numOrNull(row.price);
    if (price === null && rowPrice !== null) price = rowPrice;

    if (callGamma !== null) {
      totalCall += callGamma;
      if (callGamma > maxCallGamma && strike !== null) {
        maxCallGamma = callGamma;
        callWallStrike = strike;
      }
    }
    if (putGamma !== null) {
      totalPut += putGamma;
      if (putGamma < minPutGamma && strike !== null) {
        minPutGamma = putGamma;
        putWallStrike = strike;
      }
    }
  }

  return {
    ticker,
    price,
    call_wall: callWallStrike,
    put_wall: putWallStrike,
    total_call_gamma_oi: totalCall,
    total_put_gamma_oi: totalPut,
    net_gamma_oi: totalCall + totalPut,
    raw_strike_count: data.length,
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
  options_volume: Record<string, unknown>;
  spx_spot_gex: unknown | null;
  market_tide: unknown | null;
  errors: Array<{ ticker: string; endpoint: string; error: string }>;
}, timestampUtc: string): CondensedState {
  const per_ticker: Record<string, CondensedInstrumentState> = {};
  const tickers = new Set<string>([
    ...Object.keys(input.spot_gex),
    ...Object.keys(input.options_volume),
  ]);
  for (const t of tickers) {
    const gex = condenseSpotGex(t, input.spot_gex[t]);
    const vol = condenseOptionsVolume(input.options_volume[t]);
    per_ticker[t] = { ...gex, ...vol };
  }

  const spxCondensed = condenseSpotGex('SPX', input.spx_spot_gex);

  return {
    timestamp_utc: timestampUtc,
    per_ticker,
    spx_macro: {
      price: spxCondensed.price,
      call_wall: spxCondensed.call_wall,
      put_wall: spxCondensed.put_wall,
      total_call_gamma_oi: spxCondensed.total_call_gamma_oi,
      total_put_gamma_oi: spxCondensed.total_put_gamma_oi,
      net_gamma_oi: spxCondensed.net_gamma_oi,
      raw_strike_count: spxCondensed.raw_strike_count,
    },
    market_tide: condenseMarketTide(input.market_tide),
    errors: input.errors,
  };
}
