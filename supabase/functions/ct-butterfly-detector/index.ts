/**
 * ct-butterfly-detector — Flow Butterfly cross-event capture cron.
 *
 * Per PR #64 design pass § C.2. Fires every 5 min during RTH
 * (cron: every-5-min, hours 13-19 UTC, weekdays). For each watchlist ticker:
 *   1. Pull `ct_net_premium_expiry_split(ticker, p_since=session_bell)` —
 *      same source FlowPulseChart UI + flow_butterfly brain organ read.
 *   2. Compute per-minute cumsums on signed net premium (skip pre-market).
 *   3. Detect cum_all_call vs cum_all_put zero-crossings.
 *   4. UPSERT into ct_butterfly_cross_events with cross-moment fields
 *      populated, outcome columns null. Idempotent via UNIQUE
 *      (ticker, cross_at) — re-detection over the same window is safe.
 *
 * Cost: 10 RPC calls per fire × 84 fires/day RTH = ~840 calls/day. RPC is
 * DB-internal (no UW budget impact). Latency: ~50-200ms per ticker, parallel.
 *
 * What this enables (downstream):
 *   - 30-day grading corpus → live rolling hit-rates → flow_butterfly
 *     brain organ confidence levels switch from static empirical thresholds
 *     to data-driven (PR #78 ships static; this ship builds the data).
 *   - Inline hit-rate per cross on the live chart (UI follow-up once corpus
 *     has ≥30 RTH days).
 *   - Warden hit_rate_drift invariant.
 *
 * Auth: service_role only.
 *
 * Returns: {
 *   ok, tickers_evaluated, crosses_detected, crosses_inserted, duration_ms, errors
 * }
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';

const WATCHLIST: readonly string[] = [
  'NVDA', 'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'TSLA',
  'QQQ', 'SPY', 'IWM',
];

/** Empirical magnitude tertile cutoffs from PR #64 § A.3. */
const TERTILE_MID_CEIL = 164_123;
const TERTILE_LARGE_CEIL = 510_149;

/** RTH bell anchor in UTC minutes (13:30 UTC = 9:30 ET during EDT). */
const RTH_BELL_UTC_MIN = 13 * 60 + 30;

type CrossDirection = 'bullish' | 'bearish';
type CrossTertile = 'small' | 'mid' | 'large';
type SessionPhase = 'open_hour' | 'midday' | 'mid_afternoon' | 'close_hour';

interface NetPremiumRow {
  tick_timestamp: string;
  all_net_call: number | null;
  all_net_put: number | null;
}

interface CumPoint {
  ts: string;
  ms: number;
  cum_all_call: number;
  cum_all_put: number;
}

interface DetectedCross {
  ticker: string;
  ts: string;
  direction: CrossDirection;
  cum_all_call: number;
  cum_all_put: number;
  gap_dollars: number;
  magnitude: number;
  magnitude_tertile: CrossTertile;
  minutes_into_session: number;
  session_phase: SessionPhase;
  order_in_day: number;
}

function classifyTertile(mag: number): CrossTertile {
  if (mag <= TERTILE_MID_CEIL) return 'small';
  if (mag <= TERTILE_LARGE_CEIL) return 'mid';
  return 'large';
}

function classifyPhase(sinceBellMin: number): SessionPhase | null {
  if (sinceBellMin < 0) return null;
  if (sinceBellMin < 60) return 'open_hour';
  if (sinceBellMin < 240) return 'midday';
  if (sinceBellMin < 330) return 'mid_afternoon';
  if (sinceBellMin < 390) return 'close_hour';
  return null;
}

function minutesIntoSession(iso: string): number {
  const d = new Date(iso);
  const utcMin = d.getUTCHours() * 60 + d.getUTCMinutes();
  return utcMin - RTH_BELL_UTC_MIN;
}

function isPreMarket(iso: string): boolean {
  return minutesIntoSession(iso) < 0;
}

function nyDateKey(iso: string): string {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const y = parts.find((p) => p.type === 'year')?.value ?? '0000';
  const m = parts.find((p) => p.type === 'month')?.value ?? '00';
  const day = parts.find((p) => p.type === 'day')?.value ?? '00';
  return `${y}-${m}-${day}`;
}

function buildCumsum(rows: readonly NetPremiumRow[]): CumPoint[] {
  if (rows.length === 0) return [];
  const byTs = new Map<string, { ac: number; ap: number }>();
  for (const r of rows) {
    if (isPreMarket(r.tick_timestamp)) continue;
    const ac = Number.isFinite(r.all_net_call) ? Number(r.all_net_call) : 0;
    const ap = Number.isFinite(r.all_net_put) ? Number(r.all_net_put) : 0;
    const cur = byTs.get(r.tick_timestamp);
    if (cur) {
      cur.ac += ac;
      cur.ap += ap;
    } else {
      byTs.set(r.tick_timestamp, { ac, ap });
    }
  }
  const sorted = Array.from(byTs.entries()).sort(
    (a, b) => Date.parse(a[0]) - Date.parse(b[0]),
  );
  const out: CumPoint[] = [];
  let cumCall = 0;
  let cumPut = 0;
  for (const [ts, v] of sorted) {
    cumCall += v.ac;
    cumPut += v.ap;
    out.push({ ts, ms: Date.parse(ts), cum_all_call: cumCall, cum_all_put: cumPut });
  }
  return out;
}

function detectCrosses(ticker: string, points: readonly CumPoint[]): DetectedCross[] {
  if (points.length < 2) return [];
  const out: DetectedCross[] = [];
  let prevDiff = points[0].cum_all_call - points[0].cum_all_put;
  let order = 0;
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    const diff = p.cum_all_call - p.cum_all_put;
    const flipped = (prevDiff <= 0 && diff > 0) || (prevDiff >= 0 && diff < 0);
    const bothZero = prevDiff === 0 && diff === 0;
    if (flipped && !bothZero) {
      const minIntoSession = minutesIntoSession(p.ts);
      const phase = classifyPhase(minIntoSession);
      if (phase === null) {
        // Skip pre/post-market crosses (defensive — shouldn't happen since
        // pre-market filtered upstream, but post-market could).
        prevDiff = diff;
        continue;
      }
      const magnitude = Math.abs(diff);
      order += 1;
      out.push({
        ticker,
        ts: p.ts,
        direction: diff > 0 ? 'bullish' : 'bearish',
        cum_all_call: p.cum_all_call,
        cum_all_put: p.cum_all_put,
        gap_dollars: diff,
        magnitude,
        magnitude_tertile: classifyTertile(magnitude),
        minutes_into_session: minIntoSession,
        session_phase: phase,
        order_in_day: order,
      });
    }
    prevDiff = diff;
  }
  return out;
}

async function fetchNetPremium(
  supabase: SupabaseClient,
  ticker: string,
  sinceIso: string,
): Promise<NetPremiumRow[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb: any = supabase;
  const { data, error } = await sb.rpc('ct_net_premium_expiry_split', {
    p_ticker: ticker,
    p_since: sinceIso,
  });
  if (error || !Array.isArray(data)) return [];
  return data as NetPremiumRow[];
}

async function detectForTicker(
  supabase: SupabaseClient,
  ticker: string,
  sinceMs: number,
): Promise<DetectedCross[]> {
  const sinceIso = new Date(sinceMs).toISOString();
  const rows = await fetchNetPremium(supabase, ticker, sinceIso);
  const cum = buildCumsum(rows);
  return detectCrosses(ticker, cum);
}

interface UpsertResult {
  inserted: number;
  conflicted: number;
}

async function upsertCrosses(
  supabase: SupabaseClient,
  crosses: readonly DetectedCross[],
): Promise<UpsertResult> {
  if (crosses.length === 0) return { inserted: 0, conflicted: 0 };
  const rows = crosses.map((c) => ({
    ticker: c.ticker,
    session_date: nyDateKey(c.ts),
    cross_at: c.ts,
    direction: c.direction,
    cum_all_call: c.cum_all_call,
    cum_all_put: c.cum_all_put,
    gap_dollars: c.gap_dollars,
    magnitude_dollars: c.magnitude,
    magnitude_tertile: c.magnitude_tertile,
    minutes_into_session: c.minutes_into_session,
    session_phase: c.session_phase,
    order_in_day: c.order_in_day,
  }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb: any = supabase;
  const { data, error } = await sb.from('ct_butterfly_cross_events')
    .upsert(rows, { onConflict: 'ticker,cross_at', ignoreDuplicates: true })
    .select('id');
  if (error) {
    console.warn('[ct-butterfly-detector] upsert error:', error.message);
    return { inserted: 0, conflicted: rows.length };
  }
  const inserted = Array.isArray(data) ? data.length : 0;
  return { inserted, conflicted: rows.length - inserted };
}

function todayBellMs(): number {
  // Today's NY-tz session bell at 13:30 UTC. Approximate as 13:30 UTC year-
  // round; pre-market filtering inside the cumsum builder handles drift.
  const now = new Date();
  const todayKey = nyDateKey(now.toISOString());
  return Date.parse(`${todayKey}T13:30:00Z`);
}

interface DetectorStats {
  ok: boolean;
  tickers_evaluated: number;
  crosses_detected: number;
  crosses_inserted: number;
  crosses_conflicted: number;
  duration_ms: number;
  errors: string[];
}

serve(async (request: Request): Promise<Response> => {
  const corsResponse = handleCors(request);
  if (corsResponse) return corsResponse;

  const corsHeaders = getCorsHeaders(request);
  const jsonHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

  if (!isServiceRoleRequest(request)) {
    return new Response(
      JSON.stringify({ ok: false, error: 'unauthorized' }),
      { status: 401, headers: jsonHeaders },
    );
  }

  const startedAt = Date.now();
  const errors: string[] = [];
  let totalDetected = 0;
  let totalInserted = 0;
  let totalConflicted = 0;

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const sinceMs = todayBellMs();

    const perTicker = await Promise.all(
      WATCHLIST.map(async (ticker) => {
        try {
          const crosses = await detectForTicker(supabase, ticker, sinceMs);
          if (crosses.length === 0) return { ticker, detected: 0, inserted: 0, conflicted: 0 };
          const result = await upsertCrosses(supabase, crosses);
          return {
            ticker,
            detected: crosses.length,
            inserted: result.inserted,
            conflicted: result.conflicted,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'unknown_error';
          errors.push(`${ticker}: ${msg}`);
          return { ticker, detected: 0, inserted: 0, conflicted: 0 };
        }
      }),
    );

    for (const t of perTicker) {
      totalDetected += t.detected;
      totalInserted += t.inserted;
      totalConflicted += t.conflicted;
    }

    const stats: DetectorStats = {
      ok: true,
      tickers_evaluated: WATCHLIST.length,
      crosses_detected: totalDetected,
      crosses_inserted: totalInserted,
      crosses_conflicted: totalConflicted,
      duration_ms: Date.now() - startedAt,
      errors,
    };

    return new Response(JSON.stringify(stats), { status: 200, headers: jsonHeaders });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown_error';
    return new Response(
      JSON.stringify({
        ok: false,
        error: msg,
        duration_ms: Date.now() - startedAt,
      }),
      { status: 500, headers: jsonHeaders },
    );
  }
});
