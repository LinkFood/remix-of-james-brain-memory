/**
 * useColdOpen — aggregates the 5-bullet "what matters right now?" digest
 * rendered by <ColdOpen /> at the very top of the command station.
 *
 * Zero new edge functions, zero new UW calls. Reuses:
 *   - useTodayTrades()           — open trades today
 *   - useLatestHeartbeat()       — current spot prices (snapshot cache)
 *   - useTopAttention()          — top ct_attention_stream row (30min window)
 *   - useGexRadar()              — cached combo verdicts already fetched by GexRadar
 *   - useRegimeInversions()      — today's dealer regime flips
 *   - useSweepClusters()         — 15min window
 *   - useDpClusters()            — 15min window
 *   - ct_uw_usage_latest         — direct supabase read (same one UwUsageBadge uses)
 *
 * Pure rule-based ranking. Ordered by priority score (descending):
 *   90  TRADE       (open trade with |unrealized %| > 1)
 *   85  REGIME      (regime inversion today)
 *   80  COMBO       (non-LEAN combo verdict — URGENT / A+ / SQUEEZE / BATTLEGROUND)
 *   70  ATTENTION   (top attention_score ≥ 50 in last 30min)
 *   60  CLUSTER     (sweep or DP cluster in last 15min)
 *   40  UW_HOT      (UW usage > 85%)
 *   ∞   QUIET       (only when nothing else fires)
 *
 * Collapse rule: if a category has multiple rows, we surface the top one
 * by that category's own ordering (conviction/attention/severity). The
 * outer ColdOpen can render up to 5 bullets after ranking.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  useTodayTrades,
  useLatestHeartbeat,
  useTopAttention,
  useRegimeInversions,
  useSweepClusters,
  useDpClusters,
  type CtTradeRow,
  type Heartbeat,
} from '@/hooks/useCoTraderData';
import {
  useGexRadar,
  type GexComboVerdict,
  type GexRadarTicker,
} from '@/hooks/useGexRadar';

// ──────── types ────────

export type ColdOpenSeverity = 'red' | 'orange' | 'amber' | 'emerald' | 'sky' | 'violet' | 'muted';

export type ColdOpenKind =
  | 'trade'
  | 'regime'
  | 'combo'
  | 'attention'
  | 'cluster'
  | 'uw'
  | 'quiet';

export type ColdOpenAction =
  | { kind: 'scroll'; targetId: string }
  | { kind: 'openDeep'; ticker: string }
  | { kind: 'none' };

export interface ColdOpenBullet {
  id: string;
  kind: ColdOpenKind;
  severity: ColdOpenSeverity;
  /** Priority score — higher bubbles to top; informs the card's border-l color. */
  priority: number;
  /** Main line, one sentence, no HTML. */
  text: string;
  /** Optional secondary metadata, rendered muted on the right. */
  meta?: string;
  /** What clicking the bullet does. */
  action: ColdOpenAction;
}

export interface ColdOpenResult {
  bullets: ColdOpenBullet[];
  topSeverity: ColdOpenSeverity;
  lastUpdated: string;
  isLoading: boolean;
}

// ──────── shared format helpers ────────

function fmtPct(n: number | null | undefined, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(digits)}%`;
}

function fmtPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return Math.abs(n) >= 1000 ? n.toFixed(1) : n.toFixed(2);
}

function fmtMoney(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function timeOfDay(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  } catch {
    return '—';
  }
}

// ──────── UW usage (mirrors UwUsageBadge query, kept local to keep deps thin) ────────

interface UwUsageRow {
  session_date: string;
  observed_at: string;
  daily_count: number;
  daily_limit: number;
  pct: number;
}

function useUwUsageLatest() {
  return useQuery<UwUsageRow | null>({
    queryKey: ['uw-usage-latest'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('ct_uw_usage_latest')
        .select('*')
        .order('session_date', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) return null;
      return data as UwUsageRow | null;
    },
    refetchInterval: 60_000,
  });
}

// ──────── per-source builders (each returns 0 or 1 bullet) ────────

function spotPriceFor(heartbeat: Heartbeat | null | undefined, ticker: string): number | null {
  if (!heartbeat) return null;
  const snap = (heartbeat.current_reads as Record<string, unknown> | undefined)?._snapshot as
    | Record<string, unknown>
    | undefined;
  if (!snap) return null;
  const perTicker = (snap.per_ticker as Record<string, { price?: number | null }> | undefined) ?? {};
  return perTicker[ticker]?.price ?? null;
}

function buildTradeBullet(
  trades: CtTradeRow[] | undefined,
  heartbeat: Heartbeat | null | undefined,
): ColdOpenBullet | null {
  if (!trades || trades.length === 0) return null;
  const open = trades.filter(t => t.status === 'open');
  if (open.length === 0) return null;

  // Rank by absolute unrealized % (if spot known) else by recency.
  type Scored = { trade: CtTradeRow; spot: number | null; pnlPct: number | null };
  const scored: Scored[] = open.map(t => {
    const spot = spotPriceFor(heartbeat, t.instrument);
    let pnlPct: number | null = null;
    if (spot != null && Number.isFinite(spot) && t.entry_price && Number.isFinite(t.entry_price)) {
      const raw = ((spot - t.entry_price) / t.entry_price) * 100;
      pnlPct = t.side === 'short' ? -raw : raw;
    }
    return { trade: t, spot, pnlPct };
  });

  // Only care about |pnlPct| > 1 per spec — else skip (no signal worth showing above-the-fold).
  const eligible = scored.filter(s => s.pnlPct != null && Math.abs(s.pnlPct) >= 1);
  if (eligible.length === 0) return null;

  eligible.sort((a, b) => Math.abs(b.pnlPct ?? 0) - Math.abs(a.pnlPct ?? 0));
  const top = eligible[0];
  const t = top.trade;
  const pnl = top.pnlPct as number;
  const sideLabel = t.side === 'short' ? 'short' : 'long';
  const openedAt = t.opened_at ? timeOfDay(t.opened_at) : '—';
  const stopBit = t.stop_price != null ? ` (stop ${fmtPrice(t.stop_price)})` : '';
  const severity: ColdOpenSeverity = pnl >= 0 ? 'emerald' : 'red';

  return {
    id: `trade-${t.id}`,
    kind: 'trade',
    severity,
    priority: 90 + Math.min(10, Math.floor(Math.abs(pnl))), // winners that are really running bubble over regime
    text: `${t.instrument} ${sideLabel} open since ${openedAt}, ${pnl >= 0 ? 'up' : 'down'} ${Math.abs(pnl).toFixed(1)}%${stopBit}`,
    meta: top.spot != null ? `@ ${fmtPrice(top.spot)}` : undefined,
    action: { kind: 'scroll', targetId: 'co-trade-cards' },
  };
}

function buildRegimeBullet(
  inversions:
    | Array<{
        id: string;
        ticker: string;
        prev_regime: string;
        new_regime: string;
        flip_level: number | null;
        spot_at_flip: number | null;
        attention_score: number;
        created_at: string;
        session_date: string;
      }>
    | undefined,
): ColdOpenBullet | null {
  if (!inversions || inversions.length === 0) return null;
  // Only today's session.
  const today = new Date().toISOString().slice(0, 10);
  const todays = inversions.filter(r => r.session_date === today);
  if (todays.length === 0) return null;
  // Most recent first (query already sorted that way).
  const r = todays[0];
  const dir = r.new_regime === 'positive' ? 'pos' : 'neg';
  const flipBit =
    r.flip_level != null ? ` at ${fmtPrice(r.flip_level)}` : '';
  return {
    id: `regime-${r.id}`,
    kind: 'regime',
    severity: 'violet',
    priority: 85,
    text: `${r.ticker} regime flipped ${r.prev_regime} → ${r.new_regime} gamma${flipBit}`,
    meta: `${dir.toUpperCase()} · ${timeOfDay(r.created_at)}`,
    action: { kind: 'scroll', targetId: 'co-market-banner' },
  };
}

const LIVE_COMBO_RANK: Record<GexComboVerdict, number> = {
  URGENT: 6,
  'A+ BULLISH': 5,
  'A+ BEARISH': 5,
  'SQUEEZE SETUP': 4,
  BATTLEGROUND: 3,
  'LEAN BULLISH': 0, // LEAN filtered out per spec
  'LEAN BEARISH': 0,
  NEUTRAL: 0,
};

function buildComboBullet(gexTickers: GexRadarTicker[] | undefined): ColdOpenBullet | null {
  if (!gexTickers || gexTickers.length === 0) return null;
  let best: { ticker: string; verdict: GexComboVerdict; rank: number } | null = null;
  for (const t of gexTickers) {
    const v = t.verdicts?.combo;
    if (!v) continue;
    const rank = LIVE_COMBO_RANK[v] ?? 0;
    if (rank <= 0) continue;
    if (!best || rank > best.rank) best = { ticker: t.ticker, verdict: v, rank };
  }
  if (!best) return null;
  const severity: ColdOpenSeverity =
    best.verdict === 'URGENT'
      ? 'red'
      : best.verdict === 'A+ BEARISH'
      ? 'red'
      : best.verdict === 'A+ BULLISH'
      ? 'emerald'
      : best.verdict === 'SQUEEZE SETUP'
      ? 'orange'
      : 'amber';
  return {
    id: `combo-${best.ticker}-${best.verdict}`,
    kind: 'combo',
    severity,
    priority: 80 + best.rank, // URGENT edges above other non-LEAN combos
    text: `${best.ticker} ${best.verdict}`,
    meta: 'open LinkGex',
    action: { kind: 'openDeep', ticker: best.ticker },
  };
}

function buildAttentionBullet(
  row:
    | { kind: string; id: string; created_at: string; attention_score: number | null; summary: string | null }
    | null
    | undefined,
): ColdOpenBullet | null {
  if (!row) return null;
  const score = row.attention_score ?? 0;
  if (score < 50) return null;
  const kindLabel =
    row.kind === 'alert'
      ? 'ALERT'
      : row.kind === 'flag'
      ? 'FLAG'
      : row.kind === 'observation'
      ? 'OBSERVATION'
      : 'HEARTBEAT';
  const snippet = (row.summary ?? '').trim().slice(0, 110) || `${row.kind} fired`;
  const severity: ColdOpenSeverity =
    row.kind === 'alert' ? 'red' : row.kind === 'flag' ? 'orange' : 'sky';
  return {
    id: `attention-${row.id}`,
    kind: 'attention',
    severity,
    priority: 70 + Math.min(10, Math.max(0, score - 50) / 5),
    text: `${kindLabel} · ${snippet}`,
    meta: `${score} · ${timeOfDay(row.created_at)}`,
    action: { kind: 'scroll', targetId: 'co-event-feed' },
  };
}

function buildClusterBullet(
  sweeps:
    | Array<{
        id: string;
        ticker: string;
        sweep_count: number;
        total_premium: number;
        dominant_side: 'call' | 'put' | 'mixed';
        attention_score: number;
        created_at: string;
      }>
    | undefined,
  dps:
    | Array<{
        id: string;
        ticker: string;
        print_count: number;
        total_notional: number;
        attention_score: number;
        created_at: string;
      }>
    | undefined,
): ColdOpenBullet | null {
  const topSweep = (sweeps ?? [])[0] ?? null;
  const topDp = (dps ?? [])[0] ?? null;
  // Pick whichever has the higher attention_score; ties go to recency.
  const sweepScore = topSweep?.attention_score ?? -1;
  const dpScore = topDp?.attention_score ?? -1;
  if (sweepScore < 0 && dpScore < 0) return null;

  const useSweep =
    sweepScore > dpScore ||
    (sweepScore === dpScore &&
      topSweep &&
      topDp &&
      topSweep.created_at > topDp.created_at);

  if (useSweep && topSweep) {
    const sideLabel =
      topSweep.dominant_side === 'call'
        ? 'calls'
        : topSweep.dominant_side === 'put'
        ? 'puts'
        : 'mixed';
    const severity: ColdOpenSeverity =
      topSweep.dominant_side === 'call'
        ? 'emerald'
        : topSweep.dominant_side === 'put'
        ? 'red'
        : 'violet';
    return {
      id: `sweep-${topSweep.id}`,
      kind: 'cluster',
      severity,
      priority: 60 + Math.min(15, Math.floor(topSweep.attention_score / 10)),
      text: `${topSweep.ticker} sweep cluster · ${topSweep.sweep_count} ${sideLabel} · ${fmtMoney(topSweep.total_premium)}`,
      meta: timeOfDay(topSweep.created_at),
      action: { kind: 'scroll', targetId: 'co-sweep-strip' },
    };
  }
  if (topDp) {
    return {
      id: `dp-${topDp.id}`,
      kind: 'cluster',
      severity: 'sky',
      priority: 60 + Math.min(15, Math.floor(topDp.attention_score / 10)),
      text: `${topDp.ticker} dark-pool cluster · ${topDp.print_count} prints · ${fmtMoney(topDp.total_notional)}`,
      meta: timeOfDay(topDp.created_at),
      action: { kind: 'scroll', targetId: 'co-dp-strip' },
    };
  }
  return null;
}

function buildUwBullet(usage: UwUsageRow | null | undefined): ColdOpenBullet | null {
  if (!usage || !usage.daily_limit) return null;
  if (usage.pct < 85) return null;
  const severity: ColdOpenSeverity = usage.pct >= 95 ? 'red' : 'orange';
  return {
    id: `uw-${usage.session_date}`,
    kind: 'uw',
    severity,
    priority: 40 + (usage.pct >= 95 ? 5 : 0),
    text: `UW quota ${usage.pct}% used (${usage.daily_count.toLocaleString()} / ${usage.daily_limit.toLocaleString()})`,
    meta: `throttle risk`,
    action: { kind: 'none' },
  };
}

function quietBullet(): ColdOpenBullet {
  return {
    id: 'quiet',
    kind: 'quiet',
    severity: 'muted',
    priority: 0,
    text:
      "Tape is quiet — no structural signals, no clusters, no active trades. Heartbeats running normally.",
    action: { kind: 'none' },
  };
}

// ──────── main hook ────────

export function useColdOpen(): ColdOpenResult {
  const tradesQ = useTodayTrades();
  const heartbeatQ = useLatestHeartbeat();
  const attentionQ = useTopAttention(30, 50);
  const regimeQ = useRegimeInversions(5, 24 * 60); // today filter done in builder — generous window
  const sweepQ = useSweepClusters(5, 15);
  const dpQ = useDpClusters(5, 15);
  const uwQ = useUwUsageLatest();
  // Reuses the same query key GexRadar uses — no extra network round trip.
  const gexQ = useGexRadar(['SPY', 'QQQ', 'IWM'], 30);

  const bullets = useMemo<ColdOpenBullet[]>(() => {
    const out: ColdOpenBullet[] = [];
    const tradeB = buildTradeBullet(tradesQ.data, heartbeatQ.data);
    if (tradeB) out.push(tradeB);
    const regimeB = buildRegimeBullet(regimeQ.data);
    if (regimeB) out.push(regimeB);
    const comboB = buildComboBullet(gexQ.data?.tickers);
    if (comboB) out.push(comboB);
    const attentionB = buildAttentionBullet(attentionQ.data);
    if (attentionB) out.push(attentionB);
    const clusterB = buildClusterBullet(sweepQ.data, dpQ.data);
    if (clusterB) out.push(clusterB);
    const uwB = buildUwBullet(uwQ.data);
    if (uwB) out.push(uwB);

    if (out.length === 0) return [quietBullet()];

    out.sort((a, b) => b.priority - a.priority);
    return out.slice(0, 5);
  }, [
    tradesQ.data,
    heartbeatQ.data,
    regimeQ.data,
    gexQ.data,
    attentionQ.data,
    sweepQ.data,
    dpQ.data,
    uwQ.data,
  ]);

  const topSeverity = bullets[0]?.severity ?? 'muted';

  const isLoading =
    tradesQ.isLoading ||
    heartbeatQ.isLoading ||
    attentionQ.isLoading ||
    regimeQ.isLoading ||
    sweepQ.isLoading ||
    dpQ.isLoading ||
    uwQ.isLoading ||
    gexQ.isLoading;

  // Most recent successful fetch across all sources — drives the "Last updated"
  // line so it only ticks when real data actually landed.
  const lastUpdatedMs = Math.max(
    tradesQ.dataUpdatedAt ?? 0,
    heartbeatQ.dataUpdatedAt ?? 0,
    attentionQ.dataUpdatedAt ?? 0,
    regimeQ.dataUpdatedAt ?? 0,
    sweepQ.dataUpdatedAt ?? 0,
    dpQ.dataUpdatedAt ?? 0,
    uwQ.dataUpdatedAt ?? 0,
    gexQ.dataUpdatedAt ?? 0,
  );

  return {
    bullets,
    topSeverity,
    lastUpdated: lastUpdatedMs ? new Date(lastUpdatedMs).toISOString() : '',
    isLoading,
  };
}

// Kept exported for tests / future surfaces.
export { fmtPct, fmtPrice, fmtMoney, timeOfDay };
