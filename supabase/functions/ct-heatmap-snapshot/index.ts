/**
 * ct-heatmap-snapshot — Flow Heatmap snapshot writer.
 *
 * Per ticker in the watchlist, scans recent ct_flow_alerts and aggregates
 * premium by (ticker, expiry_date). Writes one row per (ticker, expiry_date)
 * into ct_flow_heatmap_snapshots with all four math modes precomputed:
 *
 *   A. total_premium                            calls + puts
 *   B. net_signed_premium                       calls - puts (raw, not directional)
 *   C. aggressive_directional_premium_raw       directional via inferDirection
 *   C'. aggressive_directional_premium_decay    same with exp(-age_days/5) weight
 *   D. voi_unusual_score                        Σvol / ΣOI; null if any unknown
 *
 * Body: { lookback_hours?: number = 1, mark_eod?: boolean = false }
 *
 * Auth: service_role only.
 *
 * NOTE on ct_flow_alerts.executed_at: UW stopped emitting executed_at on
 * many rows (see global memory: ct_flow_alerts_executed_at_null). Window
 * by ingested_at — that always exists and is the only timestamp safe to
 * trust for "recent flow" queries. The spec aligns with this.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { inferDirection } from '../_shared/directionInference.ts';
import { getWatchlist } from '../_shared/watchlist.ts';
import { setUwCaller } from '../_shared/uwClient.ts';

setUwCaller('ct-heatmap-snapshot');

const PAGE_SIZE = 1000;
const SCAN_CAP = 8000;
const TOP_ALERT_IDS = 50;
const TOP_STRIKES = 10;

interface FlowAlertRow {
  alert_id: string;
  ticker: string | null;
  side: string | null;
  is_ask: boolean | null;
  is_bid: boolean | null;
  strike: number | null;
  expiry: string | null;
  premium: number | null;
  price: number | null;
  size: number | null;
  volume: number | null;
  open_interest: number | null;
  executed_at: string | null;
  ingested_at: string;
  option_symbol: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw: any;
}

interface BucketAccumulator {
  ticker: string;
  expiry_date: string;
  total_premium: number;
  net_signed_premium: number;
  aggressive_directional_premium_raw: number;
  aggressive_directional_premium_decay: number;
  sum_volume: number;
  sum_oi: number;
  oi_known: boolean;
  source_alert_count: number;
  top_alerts: Array<{ alert_id: string; premium: number }>;
  strike_premium: Map<string, { strike: number; total_premium: number; side: string }>;
}

/**
 * ISO-Friday-of-week — return the Friday of the calendar week containing
 * the given date. Week is Mon-Sun (ISO 8601). Friday = day 5.
 *
 * Implementation: shift to ISO weekday (Mon=1..Sun=7), then add (5 - weekday).
 * For Sat (6) and Sun (7), this returns the *next* Friday by going negative
 * — fix by using modulo: ((5 - weekday + 7) % 7) but we want the Friday OF
 * THIS WEEK, which means Sat/Sun belong to the prior Friday. So subtract 7
 * if the offset would push forward across a weekend boundary. Cleanest
 * formulation: compute Monday-of-week, add 4 days.
 */
function fridayOfWeek(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // ISO weekday: Mon=1..Sun=7
  const isoDay = date.getUTCDay() === 0 ? 7 : date.getUTCDay();
  // Shift back to Monday
  date.setUTCDate(date.getUTCDate() - (isoDay - 1));
  // Add 4 days → Friday
  date.setUTCDate(date.getUTCDate() + 4);
  return date.toISOString().slice(0, 10);
}

function addToTopAlerts(
  bucket: BucketAccumulator,
  alertId: string,
  premium: number,
): void {
  if (!Number.isFinite(premium) || premium <= 0) return;
  bucket.top_alerts.push({ alert_id: alertId, premium });
  if (bucket.top_alerts.length > TOP_ALERT_IDS * 2) {
    // Trim periodically to avoid unbounded growth on large scans.
    bucket.top_alerts.sort((a, b) => b.premium - a.premium);
    bucket.top_alerts.length = TOP_ALERT_IDS;
  }
}

function bucketKey(ticker: string, expiryDate: string): string {
  return `${ticker}::${expiryDate}`;
}

async function loadFlowAlerts(
  supabase: SupabaseClient,
  ticker: string,
  sinceIso: string,
): Promise<FlowAlertRow[]> {
  const out: FlowAlertRow[] = [];
  let offset = 0;
  while (out.length < SCAN_CAP) {
    const end = offset + PAGE_SIZE - 1;
    const { data, error } = await supabase
      .from('ct_flow_alerts')
      .select(
        'alert_id,ticker,side,is_ask,is_bid,strike,expiry,premium,price,size,volume,open_interest,executed_at,ingested_at,option_symbol,raw',
      )
      .eq('ticker', ticker)
      .gte('ingested_at', sinceIso)
      .order('ingested_at', { ascending: false })
      .range(offset, end);
    if (error) {
      console.warn(`[heatmap] load ${ticker} failed:`, error.message);
      break;
    }
    if (!data || data.length === 0) break;
    out.push(...(data as FlowAlertRow[]));
    if (data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return out;
}

async function snapshotTicker(
  supabase: SupabaseClient,
  ticker: string,
  lookbackHours: number,
  markEod: boolean,
  snapshotAtIso: string,
): Promise<number> {
  const sinceMs = Date.now() - lookbackHours * 3_600_000;
  const sinceIso = new Date(sinceMs).toISOString();
  const rows = await loadFlowAlerts(supabase, ticker, sinceIso);
  if (rows.length === 0) return 0;

  const buckets = new Map<string, BucketAccumulator>();
  const now = new Date(snapshotAtIso).getTime();

  for (const row of rows) {
    if (!row.expiry) continue;
    // expiry is `date` in DB → arrives as 'YYYY-MM-DD'
    const expiryDate = row.expiry.length >= 10 ? row.expiry.slice(0, 10) : row.expiry;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expiryDate)) continue;

    const premium = Number(row.premium);
    if (!Number.isFinite(premium) || premium <= 0) continue;

    const tk = (row.ticker ?? ticker).toUpperCase();
    const key = bucketKey(tk, expiryDate);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        ticker: tk,
        expiry_date: expiryDate,
        total_premium: 0,
        net_signed_premium: 0,
        aggressive_directional_premium_raw: 0,
        aggressive_directional_premium_decay: 0,
        sum_volume: 0,
        sum_oi: 0,
        oi_known: true,
        source_alert_count: 0,
        top_alerts: [],
        strike_premium: new Map(),
      };
      buckets.set(key, bucket);
    }

    const sideStr = (row.side ?? '').toLowerCase();
    const sideKey = sideStr === 'put' ? 'put' : sideStr === 'call' ? 'call' : null;

    // Mode A — total
    bucket.total_premium += premium;

    // Mode B — calls minus puts (raw, NOT direction-aware)
    if (sideKey === 'call') bucket.net_signed_premium += premium;
    else if (sideKey === 'put') bucket.net_signed_premium -= premium;

    // Mode C — direction-aware via inferDirection
    // Convention from feedback memory + directionInference.ts:
    //   ask-aggressive call → bullish (up) → +premium
    //   ask-aggressive put  → bearish (down) → -premium
    //   bid-aggressive call → bearish (down) → -premium
    //   bid-aggressive put  → bullish (up)  → +premium
    // We compute "ask-aggressive call premium minus ask-aggressive put premium"
    // per spec, which is equivalent to: signed by direction (up=+, down=-).
    const dir = inferDirection({
      alert_id: row.alert_id,
      ticker: tk,
      side: row.side,
      is_ask: row.is_ask,
      is_bid: row.is_bid,
      strike: row.strike,
      expiry: row.expiry,
      executed_at: row.executed_at,
      ingested_at: row.ingested_at,
      option_symbol: row.option_symbol,
      price: row.price,
      raw: row.raw,
    });
    if (dir) {
      const signed = dir.direction === 'up' ? premium : -premium;
      bucket.aggressive_directional_premium_raw += signed;

      // Decay weight: exp(-age_days / 5)
      const ts = row.ingested_at ? new Date(row.ingested_at).getTime() : now;
      const ageDays = Math.max(0, (now - ts) / 86_400_000);
      const weight = Math.exp(-ageDays / 5);
      bucket.aggressive_directional_premium_decay += signed * weight;
    }

    // Mode D — VOI: Σvolume / ΣOI; null bucket if ANY row's OI unknown
    const vol = Number(row.volume);
    const oi = Number(row.open_interest);
    if (!Number.isFinite(oi) || oi == null) {
      bucket.oi_known = false;
    } else {
      bucket.sum_oi += oi;
    }
    if (Number.isFinite(vol)) bucket.sum_volume += vol;

    bucket.source_alert_count += 1;
    addToTopAlerts(bucket, row.alert_id, premium);

    if (sideKey && row.strike != null && Number.isFinite(Number(row.strike))) {
      const strikeNum = Number(row.strike);
      const sk = `${strikeNum}|${sideKey}`;
      const cur = bucket.strike_premium.get(sk);
      if (cur) {
        cur.total_premium += premium;
      } else {
        bucket.strike_premium.set(sk, {
          strike: strikeNum,
          total_premium: premium,
          side: sideKey,
        });
      }
    }
  }

  // Build insert rows
  const insertRows = Array.from(buckets.values()).map((b) => {
    // Final top-50 sort
    b.top_alerts.sort((a, x) => x.premium - a.premium);
    const topIds = b.top_alerts.slice(0, TOP_ALERT_IDS).map((a) => a.alert_id);

    // Top-10 strikes
    const topStrikes = Array.from(b.strike_premium.values())
      .sort((a, x) => x.total_premium - a.total_premium)
      .slice(0, TOP_STRIKES);

    const voi =
      b.oi_known && b.sum_oi > 0
        ? b.sum_volume / b.sum_oi
        : null;

    return {
      snapshot_at: snapshotAtIso,
      ticker: b.ticker,
      expiry_date: b.expiry_date,
      expiry_bucket_week: fridayOfWeek(new Date(`${b.expiry_date}T00:00:00Z`)),
      total_premium: b.total_premium,
      net_signed_premium: b.net_signed_premium,
      aggressive_directional_premium_raw: b.aggressive_directional_premium_raw,
      aggressive_directional_premium_decay: b.aggressive_directional_premium_decay,
      voi_unusual_score: voi,
      contributing_alert_ids: topIds,
      top_strikes: topStrikes,
      source_alert_count: b.source_alert_count,
      lookback_hours: lookbackHours,
      is_eod_snapshot: markEod,
    };
  });

  if (insertRows.length === 0) return 0;

  const { error } = await supabase
    .from('ct_flow_heatmap_snapshots')
    .insert(insertRows);
  if (error) {
    console.warn(`[heatmap] insert ${ticker} failed:`, error.message);
    return 0;
  }
  return insertRows.length;
}

serve(async (req: Request) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'service_role required' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json', ...getCorsHeaders(req) },
    });
  }

  let body: { lookback_hours?: number; mark_eod?: boolean } = {};
  try {
    const text = await req.text();
    if (text && text.length > 0) body = JSON.parse(text);
  } catch (_e) {
    body = {};
  }

  const lookbackHours =
    typeof body.lookback_hours === 'number' && body.lookback_hours > 0
      ? body.lookback_hours
      : 1;
  const markEod = body.mark_eod === true;

  const t0 = Date.now();
  const snapshotAtIso = new Date().toISOString();

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const watchlist = await getWatchlist(supabase);
  let tickersProcessed = 0;
  let rowsInserted = 0;

  for (const ticker of watchlist) {
    try {
      const inserted = await snapshotTicker(
        supabase,
        ticker,
        lookbackHours,
        markEod,
        snapshotAtIso,
      );
      rowsInserted += inserted;
      tickersProcessed += 1;
    } catch (e) {
      console.warn(`[heatmap] ${ticker} threw:`, (e as Error).message);
    }
  }

  return new Response(
    JSON.stringify({
      ok: true,
      tickers_processed: tickersProcessed,
      rows_inserted: rowsInserted,
      duration_ms: Date.now() - t0,
      lookback_hours: lookbackHours,
      mark_eod: markEod,
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...getCorsHeaders(req) },
    },
  );
});
