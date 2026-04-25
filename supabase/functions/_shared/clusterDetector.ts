/**
 * clusterDetector — pluggable "did multiple aligned prints land in a tight
 * window on this name?" signal. Reusable: backtest harness uses it to evaluate
 * a candidate cluster_alarm tier; live watcher can adopt it later.
 *
 * The pattern this catches: NVDA 9:32-10:34am 4/24, ten ask-side near-money
 * calls inside one hour. Each individual print may not clear gold/silver/bronze
 * thresholds, but the CLUSTER absolutely should.
 */

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';

export interface ClusterConfig {
  enabled: boolean;
  windowMin: number;          // minutes back to scan from the candidate alert.
  minPrints: number;          // total prints in window required to qualify.
  strikeBandPct: number;      // strikes within this fraction of spot count toward the cluster.
  minUnanimityPct: number;    // fraction of prints sharing the dominant side.
}

export interface FlowAlertLite {
  alert_id: string;
  ticker: string;
  side: string | null;
  strike: number | null;
  executed_at: string | null;
  ingested_at: string;
  underlying_price?: number | null;
}

export interface ClusterMatch {
  ticker: string;
  side: string;             // dominant side
  windowStart: Date;
  windowEnd: Date;
  printCount: number;       // count of prints in band + side
  totalInWindow: number;    // raw count in window before filters (for unanimity calc)
  unanimityPct: number;     // dominant_side_count / totalInWindow
  strikes: number[];
  spot: number | null;
  strikeBandLow: number | null;
  strikeBandHigh: number | null;
}

function resolveTime(a: FlowAlertLite): Date {
  if (a.executed_at) {
    const d = new Date(a.executed_at);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date(a.ingested_at);
}

/**
 * Detects whether `alert` sits at the apex of a qualifying cluster.
 *
 * Algorithm:
 *   1. Fetch ct_flow_alerts for this ticker in [alert.executed_at - windowMin, alert.executed_at].
 *   2. Compute dominant side and unanimity %.
 *   3. Filter to strikes within strikeBandPct * spot of alert.strike.
 *   4. If filtered count >= minPrints AND unanimity >= minUnanimityPct → return ClusterMatch.
 */
export async function detectClusterAt(
  supabase: SupabaseClient,
  alert: FlowAlertLite,
  cfg: ClusterConfig,
): Promise<ClusterMatch | null> {
  if (!cfg.enabled) return null;
  if (!alert.ticker || alert.strike == null || !Number.isFinite(alert.strike)) return null;

  const windowEnd = resolveTime(alert);
  const windowStart = new Date(windowEnd.getTime() - cfg.windowMin * 60_000);

  // Spot resolution: prefer the alert's underlying_price; fallback to strike (band collapses).
  const spot = (alert.underlying_price != null && Number.isFinite(alert.underlying_price))
    ? Number(alert.underlying_price)
    : alert.strike;
  if (!Number.isFinite(spot) || spot <= 0) return null;

  const bandHalf = spot * cfg.strikeBandPct;
  const bandLow = alert.strike - bandHalf;
  const bandHigh = alert.strike + bandHalf;

  // Pull the window. executed_at is NULL on every row (UW shape) — fall back
  // to ingested_at for windowing. resolveTime() picks executed_at when the
  // caller's alert has it (defensive — works either way as data evolves).
  const { data, error } = await supabase
    .from('ct_flow_alerts')
    .select('alert_id, ticker, side, strike, executed_at, ingested_at, underlying_price')
    .eq('ticker', alert.ticker)
    .gte('ingested_at', windowStart.toISOString())
    .lte('ingested_at', windowEnd.toISOString())
    .limit(1000);
  if (error || !data || data.length === 0) return null;

  // Tally side counts + collect in-band strikes.
  let calls = 0, puts = 0;
  const inBand: { side: string; strike: number }[] = [];
  for (const r of data) {
    const side = (r.side ?? '').toLowerCase();
    if (side === 'call') calls += 1;
    else if (side === 'put') puts += 1;
    else continue;
    const k = Number(r.strike);
    if (!Number.isFinite(k)) continue;
    if (k >= bandLow && k <= bandHigh) inBand.push({ side, strike: k });
  }
  const totalInWindow = calls + puts;
  if (totalInWindow === 0) return null;

  const dominantSide = calls >= puts ? 'call' : 'put';
  const dominantCount = dominantSide === 'call' ? calls : puts;
  const unanimity = dominantCount / totalInWindow;

  // Filter in-band to dominant side.
  const matched = inBand.filter((p) => p.side === dominantSide);
  if (matched.length < cfg.minPrints) return null;
  if (unanimity < cfg.minUnanimityPct) return null;

  return {
    ticker: alert.ticker,
    side: dominantSide,
    windowStart,
    windowEnd,
    printCount: matched.length,
    totalInWindow,
    unanimityPct: unanimity,
    strikes: matched.map((m) => m.strike),
    spot,
    strikeBandLow: bandLow,
    strikeBandHigh: bandHigh,
  };
}

/**
 * In-memory variant — same algorithm, but operates over a pre-loaded array
 * of FlowAlertLite (e.g. the records the backtest harness already paginated).
 * Eliminates the per-alert DB round-trip when scanning thousands of candidates.
 *
 * `windowAlerts` should be the full window of alerts for the SAME ticker as
 * `alert`, sorted ascending by time. Caller is responsible for the per-ticker
 * partition; this function does NOT filter by ticker.
 */
export function detectClusterFromContext(
  alert: FlowAlertLite,
  windowAlerts: FlowAlertLite[],
  cfg: ClusterConfig,
): ClusterMatch | null {
  if (!cfg.enabled) return null;
  if (!alert.ticker || alert.strike == null || !Number.isFinite(alert.strike)) return null;

  const windowEnd = resolveTime(alert);
  const windowStart = new Date(windowEnd.getTime() - cfg.windowMin * 60_000);

  const spot = (alert.underlying_price != null && Number.isFinite(alert.underlying_price))
    ? Number(alert.underlying_price)
    : alert.strike;
  if (!Number.isFinite(spot) || spot <= 0) return null;

  const bandHalf = spot * cfg.strikeBandPct;
  const bandLow = alert.strike - bandHalf;
  const bandHigh = alert.strike + bandHalf;

  let calls = 0, puts = 0;
  const inBand: { side: string; strike: number }[] = [];
  for (const r of windowAlerts) {
    const t = resolveTime(r).getTime();
    if (t < windowStart.getTime() || t > windowEnd.getTime()) continue;
    const side = (r.side ?? '').toLowerCase();
    if (side === 'call') calls += 1;
    else if (side === 'put') puts += 1;
    else continue;
    const k = Number(r.strike);
    if (!Number.isFinite(k)) continue;
    if (k >= bandLow && k <= bandHigh) inBand.push({ side, strike: k });
  }
  const totalInWindow = calls + puts;
  if (totalInWindow === 0) return null;

  const dominantSide = calls >= puts ? 'call' : 'put';
  const dominantCount = dominantSide === 'call' ? calls : puts;
  const unanimity = dominantCount / totalInWindow;

  const matched = inBand.filter((p) => p.side === dominantSide);
  if (matched.length < cfg.minPrints) return null;
  if (unanimity < cfg.minUnanimityPct) return null;

  return {
    ticker: alert.ticker,
    side: dominantSide,
    windowStart,
    windowEnd,
    printCount: matched.length,
    totalInWindow,
    unanimityPct: unanimity,
    strikes: matched.map((m) => m.strike),
    spot,
    strikeBandLow: bandLow,
    strikeBandHigh: bandHigh,
  };
}
