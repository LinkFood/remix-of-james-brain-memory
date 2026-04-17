/**
 * ct-net-prem-cumulative — cumulative-from-the-bell call/put net premium per ticker.
 *
 * Pulls UW `/api/stock/{ticker}/net-prem-ticks` for each watched ticker, filters
 * to today's session rows (by the row's `date` field), sorts ascending by
 * `tape_time`, and returns running sums from the first tick of the session
 * forward. This is the *true* "from the opening bell" cumulative net premium
 * view — call premium and put premium each get their own running total, so the
 * user can see not just net-net, but which side is accumulating conviction.
 *
 * Additive to the existing NetPremiumLine (which shows call − put delta as a
 * single series). Frontend renders this as a 3×4 grid of mini-lines.
 *
 * Auth: accepts JWT (frontend) OR service role (agent internals). CORS dynamic.
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { extractUserIdWithServiceRole } from '../_shared/auth.ts';
import { getNetPremiumTicks } from '../_shared/uwClient.ts';

const DEFAULT_TICKERS = [
  'SPY', 'QQQ', 'IWM',
  'NVDA', 'AAPL', 'MSFT', 'META', 'GOOGL', 'AMZN', 'TSLA',
  'GLD', 'USO',
];

interface NetPremTickRow {
  date?: string;
  tape_time?: string;
  net_call_premium?: string | number;
  net_put_premium?: string | number;
  net_call_volume?: number;
  net_put_volume?: number;
  call_volume?: number;
  put_volume?: number;
  net_delta?: string | number;
  call_volume_ask_side?: number;
  call_volume_bid_side?: number;
  put_volume_ask_side?: number;
  put_volume_bid_side?: number;
}

interface CumPoint {
  t: string;                       // minute ISO (tape_time)
  cum_call_prem: number;
  cum_put_prem: number;
  cum_net_delta: number;
  cum_call_ask_minus_bid: number;  // call buy-side pressure, cumulative
  cum_put_ask_minus_bid: number;   // put  buy-side pressure, cumulative
}

interface TickerResult {
  ticker: string;
  start_time: string | null;
  end_time: string | null;
  points: CumPoint[];
  error?: string;
}

function num(v: unknown): number {
  if (v == null) return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * UW sometimes returns `[...]` directly, sometimes `{ data: [...] }`.
 * Normalize both shapes to an array.
 */
function unwrapRows(raw: unknown): NetPremTickRow[] {
  if (Array.isArray(raw)) return raw as NetPremTickRow[];
  if (raw && typeof raw === 'object' && Array.isArray((raw as { data?: unknown }).data)) {
    return (raw as { data: NetPremTickRow[] }).data;
  }
  return [];
}

/**
 * Determine "today's session" date from the latest row in the response,
 * not from the server clock. UW is the source of truth for what counts as
 * "today" — handles weekends/holidays/pre-market correctly.
 */
function latestSessionDate(rows: NetPremTickRow[]): string | null {
  let latest: string | null = null;
  for (const r of rows) {
    if (r.date && (!latest || r.date > latest)) latest = r.date;
  }
  return latest;
}

function cumulate(rows: NetPremTickRow[]): CumPoint[] {
  const points: CumPoint[] = [];
  let call = 0, put = 0, delta = 0, callAB = 0, putAB = 0;
  for (const r of rows) {
    if (!r.tape_time) continue;
    call += num(r.net_call_premium);
    put  += num(r.net_put_premium);
    delta += num(r.net_delta);
    callAB += num(r.call_volume_ask_side) - num(r.call_volume_bid_side);
    putAB  += num(r.put_volume_ask_side)  - num(r.put_volume_bid_side);
    points.push({
      t: r.tape_time,
      cum_call_prem: call,
      cum_put_prem: put,
      cum_net_delta: delta,
      cum_call_ask_minus_bid: callAB,
      cum_put_ask_minus_bid: putAB,
    });
  }
  return points;
}

async function cumulativeForTicker(ticker: string): Promise<TickerResult> {
  try {
    const raw = await getNetPremiumTicks(ticker);
    const all = unwrapRows(raw);
    if (all.length === 0) {
      return { ticker, start_time: null, end_time: null, points: [] };
    }

    // Filter to the latest trading session (by `date` field in the row itself).
    const sessionDate = latestSessionDate(all);
    const session = sessionDate ? all.filter(r => r.date === sessionDate) : all;

    // Sort ascending by tape_time so the running sum reflects real-time order.
    session.sort((a, b) => {
      const ta = a.tape_time ?? '';
      const tb = b.tape_time ?? '';
      return ta.localeCompare(tb);
    });

    const points = cumulate(session);
    return {
      ticker,
      start_time: points[0]?.t ?? null,
      end_time: points[points.length - 1]?.t ?? null,
      points,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[ct-net-prem-cumulative] ${ticker} failed:`, msg);
    return { ticker, start_time: null, end_time: null, points: [], error: msg };
  }
}

serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  const corsHeaders = getCorsHeaders(req);
  const jsonHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

  let body: Record<string, unknown> = {};
  if (req.method === 'POST') {
    try { body = await req.json(); } catch { body = {}; }
  }

  const { userId, error: authErr } = await extractUserIdWithServiceRole(req, body);
  if (authErr || !userId) {
    return new Response(JSON.stringify({ error: authErr ?? 'Unauthorized' }), {
      status: 401,
      headers: jsonHeaders,
    });
  }

  const reqTickers = body.tickers;
  const tickers: string[] = Array.isArray(reqTickers) && reqTickers.length > 0
    ? (reqTickers as unknown[]).filter((t): t is string => typeof t === 'string' && t.length > 0)
    : DEFAULT_TICKERS;

  // UW API allows 120 req/min — 12 tickers in parallel is safe. Serial pacing
  // would leave most of the cycle idle for a user-facing endpoint that needs
  // sub-5s response times during market hours.
  const results = await Promise.all(tickers.map(t => cumulativeForTicker(t.toUpperCase())));

  return new Response(JSON.stringify({ tickers: results }), {
    status: 200,
    headers: jsonHeaders,
  });
});
