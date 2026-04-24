/**
 * useMarketBreadth — client-side aggregation of watchlist breadth from
 * ct_heartbeats._snapshot.per_ticker[T].price.
 *
 * No new UW calls. Anchors intraday change to the first heartbeat of the
 * session (same pattern as MarketBanner's "Δ since open") and computes:
 *   - advance / decline / flat counts across the 12-ticker watchlist
 *   - average net % change across watchlist
 *   - leader (biggest gain) and laggard (biggest loss)
 *   - per-sector averages (Indexes / Mag7 / Commodities)
 *   - correlation-to-SPY = share of tickers moving the same sign as SPY
 *
 * VIX: captured in _snapshot.vix as { level, change_pct, tier, source } by
 * ct-watcher (see _shared/ctStateCondense.ts). `vix` returns null on
 * heartbeats older than the VIX-capture rollout or when UW refused both
 * VIX and VIXY for the cycle.
 *
 * "Warming up" is handled by the consumer — we return null on leader/laggard
 * and 0 on the counts when there's no anchor yet. The component shows the
 * warming-up state based on whether the latest heartbeat is missing or the
 * anchors map is empty.
 */
import { useMemo } from 'react';
import { useLatestHeartbeat, useSessionHeartbeats, type Heartbeat } from './useCoTraderData';

// ─── watchlist + sector buckets ─────────────────────────────────────────────

export const BREADTH_TICKERS = [
  'SPY', 'QQQ', 'IWM',
  'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'TSLA',
] as const;

export type BreadthTicker = typeof BREADTH_TICKERS[number];

export const SECTORS = {
  Indexes: ['SPY', 'QQQ', 'IWM'] as const,
  Mag7: ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'TSLA'] as const,
} as const;

export type SectorName = keyof typeof SECTORS;

// ─── flat threshold ─────────────────────────────────────────────────────────

const FLAT_EPSILON_PCT = 0.1;

// ─── shape ─────────────────────────────────────────────────────────────────

export interface SectorRead {
  name: SectorName;
  avg_pct: number | null;
  members: Array<{ ticker: string; pct: number | null }>;
}

export interface MarketBreadth {
  advances: number;
  declines: number;
  flat: number;
  net_pct: number | null;
  leader: { ticker: string; pct: number } | null;
  laggard: { ticker: string; pct: number } | null;
  sectors: SectorRead[];
  correlation_to_spy: {
    pct: number | null;                         // % of tickers moving same sign as SPY
    label: 'high' | 'mixed' | 'divergent' | 'n/a';
  };
  vix: {
    level: number;
    change_pct: number | null;
    tier: 'low' | 'mid' | 'elevated' | 'stressed';
    source: 'VIX' | 'VIXY';
  } | null;
  /** Cumulative (advances − declines) per heartbeat across today's session. */
  breadth_trend: Array<{ t: string; net: number }>;
  has_data: boolean;
  ticker_count: number;                         // tickers with a valid change number
  loading: boolean;
}

// ─── snapshot shape (local-only, matches MarketBanner) ──────────────────────

interface SnapshotTicker { price: number | null }
interface SnapshotVix {
  level: number;
  change_pct: number | null;
  tier: 'low' | 'mid' | 'elevated' | 'stressed';
  source: 'VIX' | 'VIXY';
  endpoint?: string;
}
interface Snapshot {
  per_ticker?: Record<string, SnapshotTicker>;
  spx_macro?: { price: number | null };
  vix?: SnapshotVix | null;
}

function snapOf(hb: Heartbeat | null | undefined): Snapshot | undefined {
  if (!hb) return undefined;
  return (hb.current_reads as Record<string, unknown> | undefined)?._snapshot as Snapshot | undefined;
}

function priceOf(snap: Snapshot | undefined, ticker: string): number | null {
  if (!snap) return null;
  return snap.per_ticker?.[ticker]?.price ?? null;
}

// ─── main ──────────────────────────────────────────────────────────────────

export function useMarketBreadth(): MarketBreadth {
  const { data: latest, isLoading: loadingLatest } = useLatestHeartbeat();
  const { data: session, isLoading: loadingSession } = useSessionHeartbeats();

  return useMemo<MarketBreadth>(() => {
    const loading = loadingLatest || loadingSession;
    const latestSnap = snapOf(latest);

    // 1) Anchor each ticker to its first-of-session price.
    const anchors: Record<string, number> = {};
    for (const hb of session ?? []) {
      const s = snapOf(hb);
      if (!s) continue;
      for (const t of BREADTH_TICKERS) {
        if (anchors[t] === undefined) {
          const p = priceOf(s, t);
          if (p != null && Number.isFinite(p) && p > 0) anchors[t] = p;
        }
      }
    }

    // 2) Compute Δ% per ticker vs anchor using the latest price.
    const changes: Record<string, number | null> = {};
    for (const t of BREADTH_TICKERS) {
      const cur = priceOf(latestSnap, t);
      const anc = anchors[t];
      if (cur != null && Number.isFinite(cur) && anc != null && anc > 0) {
        changes[t] = ((cur - anc) / anc) * 100;
      } else {
        changes[t] = null;
      }
    }

    // 3) Advance / decline / flat + net %.
    let advances = 0, declines = 0, flat = 0, sumPct = 0, counted = 0;
    let leader: { ticker: string; pct: number } | null = null;
    let laggard: { ticker: string; pct: number } | null = null;
    for (const t of BREADTH_TICKERS) {
      const pct = changes[t];
      if (pct == null || !Number.isFinite(pct)) continue;
      counted += 1;
      sumPct += pct;
      if (Math.abs(pct) < FLAT_EPSILON_PCT) flat += 1;
      else if (pct > 0) advances += 1;
      else declines += 1;
      if (!leader || pct > leader.pct) leader = { ticker: t, pct };
      if (!laggard || pct < laggard.pct) laggard = { ticker: t, pct };
    }
    const net_pct = counted > 0 ? sumPct / counted : null;

    // 4) Sector rollups.
    const sectors: SectorRead[] = (Object.keys(SECTORS) as SectorName[]).map(name => {
      const members = SECTORS[name].map(t => ({ ticker: t, pct: changes[t] ?? null }));
      const valid = members.filter(m => m.pct != null && Number.isFinite(m.pct)) as Array<{ ticker: string; pct: number }>;
      const avg_pct = valid.length > 0 ? valid.reduce((a, b) => a + b.pct, 0) / valid.length : null;
      return { name, avg_pct, members };
    });

    // 5) Correlation to SPY — share of tickers moving the SAME sign as SPY,
    //    excluding SPY itself and flat tickers (they don't agree or disagree).
    const spyPct = changes['SPY'];
    let correlation_pct: number | null = null;
    let corrLabel: 'high' | 'mixed' | 'divergent' | 'n/a' = 'n/a';
    if (spyPct != null && Math.abs(spyPct) >= FLAT_EPSILON_PCT) {
      const spySign = spyPct > 0 ? 1 : -1;
      let same = 0, compared = 0;
      for (const t of BREADTH_TICKERS) {
        if (t === 'SPY') continue;
        const p = changes[t];
        if (p == null || !Number.isFinite(p)) continue;
        if (Math.abs(p) < FLAT_EPSILON_PCT) continue;
        compared += 1;
        if ((p > 0 ? 1 : -1) === spySign) same += 1;
      }
      if (compared > 0) {
        correlation_pct = (same / compared) * 100;
        corrLabel = correlation_pct >= 75 ? 'high' : correlation_pct >= 50 ? 'mixed' : 'divergent';
      }
    }

    // 6) Breadth trend — (advances − declines) across today's heartbeats.
    //    Anchor each ticker once (same rule), then walk forward computing
    //    the breadth score at every heartbeat. Keep the last 30 points.
    const trend: Array<{ t: string; net: number }> = [];
    const rollingAnchors: Record<string, number> = {};
    for (const hb of session ?? []) {
      const s = snapOf(hb);
      if (!s) continue;
      let adv = 0, dec = 0;
      for (const ticker of BREADTH_TICKERS) {
        const p = priceOf(s, ticker);
        if (p == null || !Number.isFinite(p) || p <= 0) continue;
        if (rollingAnchors[ticker] === undefined) rollingAnchors[ticker] = p;
        const anc = rollingAnchors[ticker];
        const pct = ((p - anc) / anc) * 100;
        if (Math.abs(pct) < FLAT_EPSILON_PCT) continue;
        if (pct > 0) adv += 1;
        else dec += 1;
      }
      trend.push({ t: hb.created_at, net: adv - dec });
    }
    const breadth_trend = trend.slice(-30);

    const has_data = counted > 0;

    // 7) VIX pull-through from latest heartbeat's _snapshot.vix.
    //    null when UW refused both VIX and VIXY for the cycle or the heartbeat
    //    predates the capture rollout. Shape mirrors CondensedVix from
    //    _shared/ctStateCondense.ts.
    const rawVix = latestSnap?.vix ?? null;
    const vix = rawVix && Number.isFinite(rawVix.level) && rawVix.level > 0
      ? {
          level: rawVix.level,
          change_pct: rawVix.change_pct,
          tier: rawVix.tier,
          source: rawVix.source,
        }
      : null;

    return {
      advances,
      declines,
      flat,
      net_pct,
      leader,
      laggard,
      sectors,
      correlation_to_spy: { pct: correlation_pct, label: corrLabel },
      vix,
      breadth_trend,
      has_data,
      ticker_count: counted,
      loading,
    };
  }, [latest, session, loadingLatest, loadingSession]);
}
